import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { testBlocks } from '../scripts/scan-half-scan-candidates.mjs';

/**
 * The tokenizer's own spec.
 *
 * It had none: its behaviour was asserted only through its callers
 * (`tests/compat-matrix.test.ts`, `declaredTestTitles`, and since #689 the
 * half-a-scan reporter), so a region no caller happened to exercise went
 * uncovered. A SHEBANG was exactly that region
 * — in `#!/usr/bin/env node` the character before the first `/` is `!`, which
 * `regexAllowedAfter` reads as "a value may start here", so `usr` was blanked as
 * a regex literal in every `scripts/*.mjs` (#684 item 1).
 *
 * Bounded today — a regex scan stops at the first newline, so the damage could
 * not leave line 1 — but a shebang line is arbitrary text, not JavaScript, and
 * the tokenizer is on its third reuse. Each reuse widens the file set it runs
 * against, which is precisely how #665's "no regex with an odd quote count
 * exists in the runner today" caveat became a live defect in #682.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Is every character of `line` blank (a space)? */
const isBlank = (line: string) => line.length > 0 && /^ *$/.test(line);

describe('blankNonCode treats a leading shebang as non-code', () => {
  it('blanks the whole `#!` line instead of reading `/usr/` as a regex literal', () => {
    const src = '#!/usr/bin/env node\nconst usr = 1;\n';
    const out = blankNonCode(src);

    // Length and line structure are the tokenizer's contract — every offset in
    // the output must still address the same character of the input.
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);

    const [first, second] = out.split('\n');
    // The whole shebang is non-code, so ALL of it is blank — not just the `usr`
    // the regex branch happened to eat.
    expect(isBlank(first)).toBe(true);
    // ...and the real code on the next line is untouched.
    expect(second).toBe('const usr = 1;');
  });

  it('a shebang cannot change how the code below it tokenizes', () => {
    // A shebang line is a KERNEL directive, not JavaScript: it may legally
    // contain a quote, a slash, or a backtick. Skipping it before tokenizing is
    // what makes that true here — asserted as an equivalence rather than by
    // enumerating the characters that used to break it.
    const body = ["const s = 'kept';", "it('after the shebang', () => {});", ''].join('\n');
    for (const shebang of [
      '#!/usr/bin/env node',
      '#!/usr/bin/env -S node --title="knext"',
      '#!/bin/sh -c \'exec node "$0"\'',
      '#!/usr/bin/env node // not a comment, just text',
    ]) {
      const out = blankNonCode(`${shebang}\n${body}`);
      const [first, ...rest] = out.split('\n');
      expect(isBlank(first), `shebang not fully blanked: ${shebang}`).toBe(true);
      expect(rest.join('\n'), `body desynced under: ${shebang}`).toBe(blankNonCode(body));
    }
  });

  it('only a LEADING `#!` is special — a `#` elsewhere is left to the tokenizer', () => {
    // Narrow by construction, in the direction the guard can actually be
    // widened: the test for the skip is `src.startsWith('#!')`, so the mutation
    // to defend against is dropping the `!` — NOT moving the `#` down a line.
    // A `#` behind indentation on line 2 never reaches `startsWith` at all, so
    // the class fixture below passes under `startsWith('#')` too; only a `#`
    // at OFFSET 0 that is not a shebang discriminates the two.
    expect(blankNonCode('#n = 1;\nconst usr = 2;\n')).toBe('#n = 1;\nconst usr = 2;\n');

    // Kept for what it does assert: the tokenizer proper leaves a private
    // field alone, independently of the shebang skip.
    const src = ['class A {', '  #n = 1;', '}'].join('\n');
    expect(blankNonCode(src)).toBe(src);
  });

  it('every shebanged script under scripts/ has its first line blanked, and no other', () => {
    // The measured blast radius of the bug, asserted over the real file set
    // rather than a fixture: `usr` was blanked in every one of these.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(m?[jt]s)$/.test(entry.name)) files.push(full);
      }
    };
    walk(join(REPO_ROOT, 'scripts'));

    const shebanged = files.filter((f) => readFileSync(f, 'utf8').startsWith('#!'));
    // If this ever hits zero the assertion below is vacuous, and a vacuous guard
    // is the failure mode this repo keeps closing.
    expect(shebanged.length).toBeGreaterThan(0);

    for (const file of shebanged) {
      const src = readFileSync(file, 'utf8');
      const firstLine = blankNonCode(src).split('\n')[0];
      expect(
        isBlank(firstLine),
        `${file}: shebang line survived as ${JSON.stringify(firstLine)}`,
      ).toBe(true);
    }
  });
});

/**
 * The second consumer's half of the merged contract (#689).
 *
 * `scripts/scan-half-scan-candidates.mjs` used to carry `maskLiterals`, an
 * independently written length-preserving blanker with the SAME shebang defect
 * #684 fixed here. Consolidating deleted it, so this spec now has to cover what
 * that consumer needs as well — otherwise the merge moves behaviour into a
 * function whose spec was written for someone else, which is how the shebang
 * region went uncovered through three reuses in the first place.
 *
 * `testBlocks` is the reporter's observable: it finds brace/paren-balanced
 * `it()`/`test()` blocks in the BLANKED view, so any blanker mistake that eats a
 * `)` or desyncs a quote shows up as a lost block.
 */
describe('the half-a-scan reporter shares the one blanker', () => {
  it('a quote in a shebang cannot swallow the file below it', () => {
    // Measured on `maskLiterals` before deletion: `!` was in its
    // `regexAllowedAfter` class, so the `/` after `#!` opened a regex; and a
    // shebang is arbitrary kernel text, so an apostrophe in it opened a STRING
    // that ran to the next apostrophe far below — here the one in `it('…`,
    // which desyncs every literal after it and loses the block entirely.
    const src = [
      "#!/usr/bin/env node --title=don't",
      "it('a title', () => { const x = 1; });",
      '',
    ].join('\n');
    expect(testBlocks(src).map((b) => b.body)).toEqual(["'a title', () => { const x = 1; }"]);
  });

  it('an unterminated regex is division, not a literal that eats the rest of the line', () => {
    // The SECOND bug consolidation removes, found by diffing the two blankers
    // over the real corpus: `maskLiterals` blanked from `/` to end-of-line even
    // when no closing `/` arrived, so a JSX close tag `</Button>);` lost its
    // `)` and the enclosing block stopped balancing. Measured cost: one real
    // finding in `packages/ui/src/components/ui/button.test.tsx` that the
    // reporter silently never saw.
    const jsx = 'const { getByRole } = render(<Button>Default</Button>);';
    expect(blankNonCode(`${jsx}\n`)).toBe(`${jsx}\n`);
    const src = [`it('renders', () => {`, `  ${jsx}`, `  expect(1).toBe(1);`, `});`, ''].join('\n');
    expect(testBlocks(src)).toHaveLength(1);
  });

  it('blanks the comment MARKER too, and leaves template holes as the code they are', () => {
    // The two deliberate behaviour changes for this consumer, stated rather
    // than discovered. `maskLiterals` kept `//`, `/*` and `*/` and blanked from
    // `i + 2`; `blankNonCode` includes the marker. And `maskLiterals` treated a
    // backtick like a plain quote, blanking template HOLES — real code, whose
    // parens `testBlocks` needs. Measured over the reporter's real input (every
    // tracked `.test`/`.spec` file, 272 of them — NOT the `tests/` + `scripts/`
    // subset), neither difference moves a single reported finding in the `read`
    // (default) or `sourcey` variants: 80 and 352, byte-identical finding sets.
    //
    // A FOURTH difference existed and was a regression, not a trade — the
    // code-point accumulator covered by the offset-contract spec below. It is
    // fixed rather than accepted, which is what lets the paragraph above stand
    // as written.
    expect(blankNonCode('a; // note\n')).toBe(`a; ${' '.repeat('// note'.length)}\n`);
    expect(blankNonCode('a; /* note */ b;\n')).toBe(`a; ${' '.repeat('/* note */'.length)} b;\n`);
    // Built rather than written literally: a template hole inside a single-quoted
    // fixture is what `noTemplateCurlyInString` exists to catch, and suppressing
    // the rule is a worse trade than assembling the two characters.
    const hole = `$${'{'} f(1) ${'}'}`;
    expect(blankNonCode(`\`x${hole}y\`;\n`)).toBe(`\` ${hole} \`;\n`);
  });
});

/**
 * The contract itself, asserted over the corpus the consumer actually reads.
 *
 * `blankNonCode`'s docstring promises a length- and offset-preserving result:
 * "every offset in the result still addresses the same character of the
 * original". Every caller depends on that — `testBlocks` slices the ORIGINAL
 * source at offsets found in the BLANKED one — and until now nothing asserted
 * it, which is exactly why a desync could be live and invisible.
 *
 * It was live. The accumulator was built with `[...src]`, which iterates CODE
 * POINTS, while every index driving it (`src.indexOf`, `src.length`, `i`, `j`,
 * `blank(from, to)`) is a UTF-16 OFFSET. One astral character — an emoji — put
 * the two out of step for the whole rest of the file: measured on
 * `packages/kn-next/src/__tests__/excerpt.test.ts` (6 of them), the output came
 * back 5 characters short with 15 newlines displaced, and `testBlocks` found 7
 * of its 9 `it()` blocks. The DELETED `maskLiterals` used `split('')` and found
 * all 9, so consolidation was not a strict improvement until this was fixed.
 *
 * Scanning the real corpus is the point rather than an embellishment: the
 * regression is invisible on any fixture nobody thought to write, and #689's own
 * argument is that each reuse widens the file set. The reporter's file set is
 * all 272 tracked `.test`/`.spec` files, not the 98 under `tests/` + `scripts/`
 * the consolidation was measured over — and the one file that breaks the
 * contract is outside those 98.
 */
describe('blankNonCode preserves length and offsets', () => {
  /** The reporter's own file predicate — see `scanRepo` in the reporter. */
  const corpus = () =>
    execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter((f) => /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(f));

  /** Every UTF-16 offset holding a `\n`. Equal arrays ⇒ line structure survived. */
  const newlineOffsets = (s: string) => {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i);
    return out;
  };

  it('holds for every file the reporter actually scans', () => {
    const files = corpus();
    // A corpus that shrank to nothing would make the loop below vacuous.
    expect(files.length).toBeGreaterThan(200);

    for (const file of files) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      const out = blankNonCode(src);
      expect(out.length, `${file}: length changed`).toBe(src.length);
      expect(newlineOffsets(out), `${file}: newline offsets moved`).toEqual(newlineOffsets(src));
    }
  });

  it('holds when the source contains an astral character', () => {
    // The corpus case above is real, but it depends on one file keeping its
    // emoji. This fixture is what makes the guard discriminate unconditionally:
    // a surrogate pair ahead of the code, so a code-point accumulator desyncs
    // from the UTF-16 offsets for everything after it.
    const src = ["const label = '😀 hi';", "it('finds this block', () => { f(1); });", ''].join(
      '\n',
    );
    const out = blankNonCode(src);

    expect(out.length).toBe(src.length);
    expect(newlineOffsets(out)).toEqual(newlineOffsets(src));
    // The consumer's observable: a desync loses the block outright.
    expect(testBlocks(src).map((b) => b.body)).toEqual(["'finds this block', () => { f(1); }"]);
  });
});
