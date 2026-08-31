/**
 * A test's scratch directory belongs in `tmpdir()`, never in the repo (#880).
 *
 * ## What this is cleaning up after
 *
 * The working tree accumulated **2877 leftover fixture directories** in the
 * repo root — `knext-assets-*`, `knext-root-*`, `knext-bytecode-*`,
 * `blocking-gate-*`, `coldattr-*`, `prewarm-sigint-*` and about 150 other
 * families — because the tests that made them rooted their scratch space at the
 * process CWD rather than at `tmpdir()`. Running the suite from the repo root
 * put every one of them in the repo.
 *
 * The call sites were later fixed, and the evidence that they were is direct: a
 * full 332-file run today created **zero** new ones, and the newest surviving
 * stray is weeks old. So this guard is not fixing a live leak. It exists
 * because nothing asserted the invariant, which is precisely how it was lost
 * the first time and exactly how it would be lost again.
 *
 * ## Why the .gitignore entry is not the fix
 *
 * `.gitignore` carries a `knext-*` directory pattern, which is why those families were
 * invisible: 2861 of the 2877 never appeared in `git status` at all. They were
 * hidden, not absent — several gigabytes of them. The four families NOT covered
 * by that pattern are the only reason anyone noticed.
 *
 * That is the trap worth naming: adding the missing families to `.gitignore`
 * would have made the remaining evidence disappear too, and would have been
 * recorded as a fix. Ignoring output is not the same as not producing it.
 *
 * ## What is actually checked
 *
 * That every `mkdtemp`/`mkdtempSync` call roots its prefix at the temp
 * directory. This scans rather than enumerating known-bad files, because an
 * enumerated list is how the second call site gets missed.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Accepts `tmpdir()` under any local alias — `osTmpdir()` and `loaderTmpRoot`
 * are both already in use here — since several call sites hoist the root into a
 * constant. Matching the alias rather than the exact import keeps the guard from
 * failing on a rename that changes nothing.
 *
 * Deliberately NO leading word boundary: an alias is camelCase-prefixed
 * (`osTmpdir`, `loaderTmpRoot`), so `\btmpdir\b` matches neither. Written with
 * boundaries first, this reported all five aliased call sites as offenders —
 * five findings, none real, which is how a guard trains people to edit it.
 * Over-matching is safe here because the scan runs on BLANKED source, so a
 * literal `'tmpdir'` in a string cannot launder a bad call.
 */
const TMP_ROOTED = /tmpdir|tmp_?root|\bTMP\b/i;

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs', '*.js', '*.cjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

/** `mkdtemp(...)` call sites whose prefix is not rooted at the temp directory. */
function cwdRootedTempDirs(source: string): string[] {
  // Blanked, so the family names listed in this file's own header — and any
  // fixture string elsewhere that spells `mkdtempSync` — cannot be reported.
  const code = blankNonCode(source);
  const found: string[] = [];
  for (const m of code.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    // The first argument, bounded at the statement end. Bounded rather than
    // paren-matched: the root appears at the very front of the argument, and an
    // unbounded read would reach into the next statement and find a `tmpdir`
    // that has nothing to do with this call.
    const arg = code.slice(m.index + m[0].length, m.index + m[0].length + 140).split(';')[0];
    if (!TMP_ROOTED.test(arg)) found.push(arg.replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  return found;
}

describe('scratch directories live in tmpdir(), not the repo (#880)', () => {
  it('finds source files at all — the guard must not pass vacuously', () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('every mkdtemp call is rooted at the temp directory', () => {
    const offenders = sourceFiles()
      .flatMap((f) =>
        cwdRootedTempDirs(readFileSync(resolve(repoRoot, f), 'utf8')).map(
          (arg) => `${f}: mkdtemp(${arg}`,
        ),
      )
      .sort();
    expect(
      offenders,
      'a prefix with no directory is resolved against the process CWD, which for the ' +
        'suite is the repo root. That is how 2877 fixture directories ended up in the ' +
        'working tree — and `.gitignore` hid all but 16 of them, so nothing reported it. ' +
        'Root the prefix at `tmpdir()`.',
    ).toEqual([]);
  });

  it('recognises a CWD-rooted call when it is present', () => {
    // Self-proving: a regex that matched nothing would satisfy the assertion
    // above forever.
    expect(cwdRootedTempDirs("const d = mkdtempSync('knext-assets-');")).toHaveLength(1);
    expect(cwdRootedTempDirs("await mkdtemp('coldattr-');")).toHaveLength(1);
  });

  it('accepts the tmpdir-rooted forms already in use', () => {
    expect(cwdRootedTempDirs("mkdtempSync(join(tmpdir(), 'knext-assets-'));")).toEqual([]);
    // `osTmpdir` is a real alias in this repo; a rename must not red the guard.
    expect(cwdRootedTempDirs("mkdtempSync(join(osTmpdir(), 'knext-doctor-'));")).toEqual([]);
    expect(cwdRootedTempDirs("mkdtempSync(join(TMP, 'blocking-gate-'));")).toEqual([]);
    expect(cwdRootedTempDirs("mkdtempSync(join(loaderTmpRoot, 'x-'));")).toEqual([]);
  });
});
