#!/usr/bin/env node
/**
 * ADVISORY — "half a scan" candidate reporter (#639). **Never a gate.**
 *
 * WHAT THIS IS
 * ------------
 * Issue #639 asks whether the recurring "half a scan" defect can be caught
 * mechanically, and proposes "a lint that flags `expect(source).toContain(...)`
 * -style assertions in tests that have no paired negative assertion". This file
 * IS that lint, implemented in its most favourable form so the question could be
 * answered with a measurement instead of an opinion.
 *
 * The measurement said no. `docs/testing/half-a-scan-tractability.md` carries the
 * numbers; the short version is that it reaches one of three defect families and
 * flags dozens of correct, shipped assertions to do it. So it is kept as a
 * REPORTER — it always exits 0, no workflow runs it, and
 * `tests/half-a-scan-tractability.test.ts` asserts both of those. Its job is to
 * make the finding reproducible for whoever next proposes the lint, not to police
 * anything.
 *
 * If you are about to wire this into CI: read the doc first, then re-run the
 * measurement. The reason it is not a gate is empirical, so it can change — but
 * it has to be re-measured, not assumed.
 *
 * WHAT IT LOOKS FOR
 * -----------------
 * Inside each brace-balanced `it()`/`test()` body that contains NO negative
 * assertion at all, an `expect(X).toContain(...)` / `.toMatch(...)` whose receiver
 * `X` is named like file text (`source`, `html`, `workflow`, `md`, …) AND is bound
 * to a `readFileSync`/`readFile` in the same file. Those last two narrowings are
 * not in the issue's wording; they were added because without them the flag count
 * is over eight hundred.
 *
 * Usage:  node scripts/scan-half-scan-candidates.mjs [root] [--variant=broad|sourcey|read]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Matchers that make a block "already negative". Deliberately generous: an
 * emptiness assertion (`toEqual([])`, `toHaveLength(0)`) IS the paired negative
 * half in this repo's idiom, and treating it as one is what the proposed lint
 * would have to do to avoid flagging every scan in the tree.
 *
 * Being generous here is also why three of the corpus instances are invisible:
 * they carry one of these and are still half a scan. That is the finding.
 */
const NEGATIVE =
  /\.not\.|\btoEqual\(\s*\[\s*\]\s*\)|\btoHaveLength\(\s*0\s*\)|\btoBe\(\s*false\s*\)|\btoBeFalsy\(|\btoThrow|\brejects\./;

/** Receiver names that read as "the text of a file", per the issue's `expect(source)`. */
const SOURCEY =
  /^(.*_)?(source|src|text|content|contents|body|html|md|markdown|yaml|yml|json|file|raw|doc|out|stdout|output|workflow|manifest|matrix|readme|script)([A-Z_].*)?$/i;

const VARIANTS = new Set(['broad', 'sourcey', 'read']);

/**
 * A copy of `source` with the CONTENTS of every string, template literal, regex
 * literal and comment replaced by spaces, offsets preserved.
 *
 * Required, not cosmetic: paren-balancing over raw text is defeated by a regex
 * literal carrying an unbalanced escaped paren — `/\bquery(?:Instant|Range)\(/`
 * is one line of the #636 corpus entry, and without masking it swallows the rest
 * of the block and the scan reports a MISS for a reason that has nothing to do
 * with the heuristic being measured. A false negative arrived at by accident is
 * still a false measurement.
 *
 * KNOWN BUG, deliberately not fixed here: this carries the identical shebang
 * defect `scripts/lib/blank-non-code.mjs` was fixed for in #684 — `!` is in
 * `regexAllowedAfter` above, so `maskLiterals('#!/usr/bin/env node\n…')` masks
 * `usr` as a regex literal and yields `#!/   /bin/env node`. Harmless today (this
 * is an advisory reporter, it always exits 0, no workflow runs it, and the mangle
 * introduces no bracket imbalance so the paren heuristic is unaffected) — but it
 * is a SECOND blanker with the SAME open bug, not merely a second blanker.
 * Consolidating the two, and fixing this, is #689.
 */
export function maskLiterals(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // A `/` opens a regex only where a VALUE may start; after an identifier,
  // literal or `)`/`]` it is division. This is the standard lexical rule.
  const regexAllowedAfter =
    /[([{,;:!&|?+\-*%~^=<>]$|\b(?:return|typeof|case|in|of|new|delete|void|do|else)$/;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i + 2, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i + 2, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '/') {
      const before = source.slice(0, i).replace(/\s+$/, '');
      if (before === '' || regexAllowedAfter.test(before)) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length && source[j] !== '\n') {
          if (source[j] === '\\') j += 2;
          else if (source[j] === '[') {
            inClass = true;
            j++;
          } else if (source[j] === ']') {
            inClass = false;
            j++;
          } else if (source[j] === '/' && !inClass) break;
          else j++;
        }
        blank(i + 1, j);
        i = j + 1;
      } else i++;
    } else i++;
  }
  return out.join('');
}

/** The `(`-balanced argument span of a call whose `(` sits at `open`. */
function balanced(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Brace-balanced `it()`/`test()` blocks as `{ start, body }`.
 *
 * Structure is found in the MASKED text (so a regex literal's escaped paren
 * cannot swallow the block) while `body` is sliced from the original, because
 * the negative-assertion and receiver checks need the real characters.
 */
export function testBlocks(source, masked = maskLiterals(source)) {
  const blocks = [];
  const re = /\b(?:it|test)(?:\.each\(|\.(?:only|skip|concurrent|todo|failing))?\s*\(/g;
  for (const m of masked.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = balanced(masked, open);
    if (close === -1) continue;
    blocks.push({
      start: m.index,
      bodyStart: open + 1,
      body: source.slice(open + 1, close),
      maskedBody: masked.slice(open + 1, close),
    });
  }
  return blocks;
}

/** `expect(<receiver>).toContain|toMatch|toContainEqual(...)` sites inside a block. */
function positiveSubstringAssertions(body, maskedBody) {
  const out = [];
  for (const m of maskedBody.matchAll(/\bexpect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = balanced(maskedBody, open);
    if (close === -1) continue;
    const matcher = maskedBody
      .slice(close + 1, close + 40)
      .match(/^\s*\.\s*(toContain|toMatch|toContainEqual)\b/);
    if (!matcher) continue;
    // vitest allows `expect(value, message)`; the receiver is the first argument.
    // Split on the masked text (a comma inside a string is not an argument
    // separator) but take the receiver's characters from the real text.
    const cut = maskedBody.slice(open + 1, close).split(/,(?![^()[\]{}]*[)\]}])/)[0].length;
    const receiver = body.slice(open + 1, open + 1 + cut).trim();
    out.push({ receiver, matcher: matcher[1], offset: m.index });
  }
  return out;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

/** The bare identifier a receiver expression starts from, e.g. `a?.b(c)` -> `a`. */
function rootIdentifier(receiver) {
  const m = receiver.replace(/^await\s+/, '').match(/^[A-Za-z_$][\w$]*/);
  return m ? m[0] : '';
}

/**
 * Findings for one test file's text. Exported so the tractability test can put
 * the corpus through it without touching disk.
 */
export function scanSource(source, file, variant = 'read') {
  if (!VARIANTS.has(variant)) throw new Error(`unknown variant "${variant}"`);
  const findings = [];
  const masked = maskLiterals(source);
  for (const block of testBlocks(source, masked)) {
    // Masked: a doc comment mentioning "not" is not a negative assertion.
    if (NEGATIVE.test(block.maskedBody)) continue;
    for (const a of positiveSubstringAssertions(block.body, block.maskedBody)) {
      const root = rootIdentifier(a.receiver);
      if (variant !== 'broad' && !SOURCEY.test(root)) continue;
      if (variant === 'read') {
        if (!root) continue;
        const bound = new RegExp(
          `\\b(?:const|let|var)\\s+${root}\\b[\\s\\S]{0,200}?read(?:File|FileSync)\\b`,
        );
        if (!bound.test(source)) continue;
      }
      findings.push({
        file,
        line: lineOf(source, block.bodyStart + a.offset),
        receiver: a.receiver,
        matcher: a.matcher,
      });
    }
  }
  return findings;
}

/** Every tracked test file under `root`, scanned. */
export function scanRepo(root, variant = 'read') {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter((f) => /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(f));
  const findings = [];
  for (const f of files)
    findings.push(...scanSource(readFileSync(join(root, f), 'utf8'), f, variant));
  return findings;
}

/** Always 0. This is a reporter; see the header. */
export function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const variantArg = argv.find((a) => a.startsWith('--variant='));
  const variant = variantArg ? variantArg.slice('--variant='.length) : 'read';
  const root = resolve(args[0] ?? process.cwd());
  const findings = scanRepo(root, variant);
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line}  expect(${f.receiver}).${f.matcher}(…)\n`);
  }
  process.stdout.write(
    `\nhalf-a-scan candidates (variant=${variant}): ${findings.length} across ` +
      `${new Set(findings.map((f) => f.file)).size} files — ADVISORY ONLY, exit 0.\n` +
      'Most of these are ordinary presence checks and are correct as written; see ' +
      'docs/testing/half-a-scan-tractability.md before treating any of them as a defect.\n',
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
