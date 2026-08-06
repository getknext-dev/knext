import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';

/**
 * The tokenizer's own spec.
 *
 * It had none: its behaviour was asserted only through its two callers
 * (`tests/compat-matrix.test.ts` and `declaredTestTitles`), so a region neither
 * caller happened to exercise went uncovered. A SHEBANG was exactly that region
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
    // Narrow by construction: the skip must not become "ignore any line starting
    // with #", which would blank a real line of code containing a private field.
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
