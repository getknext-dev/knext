#!/usr/bin/env node
/**
 * Shared shell frame-stack scanner (#1444, step 1 of 2).
 *
 * `scripts/lib/apply-safety-scan.mjs` (#1410) and
 * `tests/helpers/shell-statements.ts` (#1415) each grew their own hand-written
 * shell lexer, closing quoting-desync review findings independently — a fix
 * in one never carried over to the other. This module is the CORE primitive
 * both need: a frame-stack walk over bash's quoting CONTEXTS (`'…'`, `"…"`
 * with nesting, `$'…'`, `${…}`, `$(…)`/backtick command substitution), not a
 * flat quote toggle — so `"$(printf 'a "b')"` is read as one word rather than
 * desyncing on the apostrophe inside the substitution.
 *
 * `scanFrames(text, visit)` calls `visit(i, depth, frameType)` for every
 * index, where `depth` 0 is top-level code (outside every quote/substitution)
 * and `frameType` is `'code' | 'dq' | 'sq' | 'sqa' | 'bq' | 'brace'`. `visit`
 * may return an index to jump the scan to. The return value is the final
 * frame-stack height (1 when the text is balanced) — used to fail closed on
 * unbalanced quoting/substitution.
 *
 * `scripts/lib/apply-safety-scan.mjs` imports this rather than defining its
 * own copy (done — see its `export { scanFrames }` re-export below for
 * backward compatibility with existing importers). Porting
 * `tests/helpers/shell-statements.ts`'s `splitSourceIntoStatements` onto this
 * primitive — so BOTH consumers stop carrying their own quote/comment
 * handling, the full #1444 exit criterion — is TODO(#1444): that function's
 * per-index side effects (line tracking, heredoc-body extraction cut out by
 * LINE, command/process substitutions re-emitted as their own top-level
 * statements) are tightly coupled to its own walk, and porting them onto a
 * shared `visit` callback without changing its output for either consumer's
 * existing fixture set needs its own careful pass — deferred rather than
 * risked in the same change that closes #1466/#1512.
 */

export function scanFrames(text, visit) {
  const stack = [{ t: 'code', paren: 0 }];
  const depthOf = () => {
    let d = stack.length - 1;
    for (const f of stack) if (f.t === 'code') d += f.paren;
    return d;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = stack.at(-1);
    const d = depthOf();
    const jump = visit(i, d, top.t);
    if (typeof jump === 'number') {
      i = jump;
      continue;
    }
    // The second char of a `$(`/`${`/`$'` opener is visited (inside the new
    // frame) but is not itself a paren/brace/quote.
    if (top.opening) {
      top.opening = false;
      i++;
      continue;
    }
    if (top.t === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top.t === 'sqa' || top.t === 'bq') {
      if (c === '\\') i += 2;
      else {
        if ((top.t === 'sqa' && c === "'") || (top.t === 'bq' && c === '`')) stack.pop();
        i++;
      }
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (top.t === 'dq') {
      if (c === '"') stack.pop();
      else if (c === '$' && text[i + 1] === '(') {
        stack.push({ t: 'code', paren: 0, opening: true });
        i++;
        continue;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push({ t: 'brace', n: 1, opening: true });
        i++;
        continue;
      } else if (c === '`') stack.push({ t: 'bq' });
      i++;
      continue;
    }
    if (top.t === 'brace') {
      if (c === '{') top.n++;
      else if (c === '}') {
        top.n--;
        if (top.n === 0) stack.pop();
      } else if (c === '"') stack.push({ t: 'dq' });
      else if (c === "'") stack.push({ t: 'sq' });
      i++;
      continue;
    }
    // code frame
    if (c === '$' && text[i + 1] === "'") {
      stack.push({ t: 'sqa', opening: true });
      i++;
      continue;
    }
    if (c === "'") stack.push({ t: 'sq' });
    else if (c === '"') stack.push({ t: 'dq' });
    else if (c === '`') stack.push({ t: 'bq' });
    else if (c === '$' && text[i + 1] === '(') {
      stack.push({ t: 'code', paren: 0, opening: true });
      i++;
      continue;
    } else if (c === '$' && text[i + 1] === '{') {
      stack.push({ t: 'brace', n: 1, opening: true });
      i++;
      continue;
    } else if (c === '(') top.paren++;
    else if (c === ')') {
      if (top.paren > 0) top.paren--;
      else if (stack.length > 1) stack.pop();
    }
    i++;
  }
  return stack.length;
}
