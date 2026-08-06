/**
 * The repo's single non-code blanker.
 *
 * Lifted verbatim out of `tests/compat-matrix.test.ts` (#680) so the second
 * caller — `declaredTestTitles` in `./ci-blocking-gate-proof.mjs` — reuses it
 * instead of becoming the third hand-rolled tokenizer in the tree. It lives in
 * `scripts/lib/*.mjs` rather than a `.ts` test helper because one of its callers
 * is a plain `node` script, not a vitest module.
 *
 * `tests/ci-blocking-gate-proof-diagnosis.test.ts` scans `tests/` and `scripts/`
 * for any other definition of this function and fails on one, so "reuse it" is
 * enforced rather than requested.
 */

/**
 * Keywords after which a `/` can only begin a REGEX, never a division.
 *
 * The rest of the decision is positional: after a value (identifier, number,
 * `)`, `]`, or a literal's closing delimiter) a `/` divides; after anything else
 * — an operator, `(`, `,`, `=`, `:`, `{`, `;`, or the start of input — it opens a
 * regex. This is the standard lexical heuristic and it is deliberately biased
 * toward DIVISION when ambiguous, because misreading a division as a regex would
 * blank real code, and blanking real code is how a scan produces a false
 * negative.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Can a `/` at `i` start a regex literal, given the code already scanned?
 *
 * Looks backwards over the BLANKED output, where comments and literal contents
 * are already spaces, so the "previous significant character" is a real token
 * character rather than something inside a comment.
 *
 * @param {string} src
 * @param {string[]} out
 * @param {number} i
 */
function regexAllowedAfter(src, out, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  const prev = out[k];
  if (prev === ')' || prev === ']' || prev === '`' || prev === "'" || prev === '"') return false;
  if (/[\w$]/.test(prev)) {
    let s = k;
    while (s >= 0 && /[\w$]/.test(out[s])) s--;
    const word = src.slice(s + 1, k + 1);
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return true;
}

/**
 * Blank everything in `src` that is NOT code, preserving length and line structure so every
 * offset in the result still addresses the same character of the original.
 *
 * This is what makes an occurrence check CODE-ONLY: comment bodies (line AND block,
 * delimiters included) and the CONTENTS of string and template literals become spaces, so a
 * `check(` — or an `it('…')` — written inside a comment or a string is simply not there when
 * the scan runs. #665 closed only the case where such an occurrence REDEFINED a real id
 * (repeated-id ⇒ ambiguous); a declaration commented OUT still read as present, and both
 * derivations agreed on that wrong answer because the count regex matched the commented line
 * too.
 *
 * Quote characters and backticks are KEPT so the bracket/comma structure a call's argument
 * split needs survives, and so a caller can still locate a literal's delimiters and slice the
 * ORIGINAL source between them; `${…}` holes stay code, since they are.
 *
 * @param {string} src
 * @returns {string}
 */
export function blankNonCode(src) {
  const out = [...src];
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = Math.max(from, 0); k < Math.min(to, src.length); k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  /**
   * Template-literal nesting: a template, or a `${…}` hole with its own brace depth.
   * @type {Array<{ kind: 'tmpl' } | { kind: 'hole'; depth: number }>}
   */
  const stack = [];
  let i = 0;
  // A leading `#!` line is a KERNEL directive, not JavaScript, so it is blanked
  // wholesale before tokenizing rather than tokenized as code.
  //
  // Not cosmetic: in `#!/usr/bin/env node` the character before the first `/` is
  // `!`, which `regexAllowedAfter` reads as "a value may start here", so `usr`
  // was blanked as a REGEX LITERAL in every shebanged `scripts/*.mjs` (#684).
  // That was bounded — the regex scan breaks at the first newline — but a
  // shebang may legally contain a quote or a backtick, and this tokenizer is on
  // its third caller. Each reuse widens the file set it runs against, which is
  // how #665's "no regex with an odd quote count exists today" caveat became a
  // live defect in #682.
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    i = nl === -1 ? src.length : nl;
    blank(0, i);
  }
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const n = src[i + 1];
    if (top?.kind === 'tmpl') {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && n === '{') {
        stack.push({ kind: 'hole', depth: 0 });
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }
    // An escape in code position only occurs inside a regex literal, e.g. `/^\//` —
    // whose trailing `\/` + `/` would otherwise read as the start of a line comment.
    if (c === '\\') {
      i += 2;
      continue;
    }
    // A REGEX LITERAL, blanked like any other literal.
    //
    // Not cosmetic: without this, `/KNEXT_REQUIRE_BUN:\s*['"]?1['"]?/` (real, in
    // tests/compile-cache-health-bun-ci.test.ts) opened a single-quoted string
    // that ran to the next apostrophe hundreds of characters later, blanking the
    // CODE in between. Measured: two of the five blocking-gate specs then
    // reported no declared test titles at all (#680). A tokenizer that desyncs
    // produces false negatives, which is the failure mode a guard cannot afford.
    if (c === '/' && n !== '/' && n !== '*' && regexAllowedAfter(src, out, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\\') {
          j++;
          continue;
        }
        if (d === '\n') break; // unterminated — treat the `/` as division after all
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      if (j < src.length && src[j] === '/') {
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'tmpl' });
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (top?.kind === 'hole') {
      if (c === '{') {
        top.depth++;
        i++;
        continue;
      }
      if (c === '}') {
        if (top.depth === 0) stack.pop();
        else top.depth--;
        i++;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}
