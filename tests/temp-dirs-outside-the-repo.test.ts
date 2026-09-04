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
 * Three things, and the second and third were added by #918 and D9 after the
 * first one — alone — stayed green through a live instance of the very bug it
 * names:
 *
 *  1. LOCATION of `mkdtemp` — every `mkdtemp`/`mkdtempSync` call roots its
 *     prefix at the temp directory.
 *
 *  2. LOCATION of WRITES (#918). `tests/tomatchobject-mutation-guard.test.ts`
 *     wrote two transient dot-prefixed `.ts` files into the repo's `tests/`
 *     directory — through `node -e`, so not a `mkdtemp` at all — and because
 *     the bun suite runs files concurrently while TypeScript's `**\/*.ts`
 *     include never matches a dot-prefixed name, `root-typecheck-gate` went red
 *     whenever its walk overlapped their lifetime. Rule 1 had nothing to say
 *     about it. The class of bug this file exists to prevent shipped underneath
 *     it, twice deterministic in CI and green on main.
 *
 *  3. LIFETIME (D9). A `mkdtemp` rooted correctly and never removed is still a
 *     leak — one directory per run, forever, on every machine that runs the
 *     suite. Asserting WHERE a directory is created and never WHETHER it is
 *     removed is half a guard, which is this repo's #639 class.
 *
 * All three SCAN rather than enumerate known-bad files, because an enumerated
 * list is how the second call site gets missed. The two exception sets in
 * `tests/scratch-space-exceptions.json` are the deliberate opposite — a
 * ratchet over a measured population, asserted in BOTH directions so an entry
 * that stops being needed reds the guard instead of rotting in place.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import {
  countTempDirSites,
  repoRootedWrites,
  unpairedTempDirs,
} from '../scripts/lib/scratch-space-scan.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Exceptions = {
  repoRootedWrites: Record<string, string>;
  unremovedTempDirs: { recordedOn: string; note: string; files: Record<string, number> };
};

const exceptions: Exceptions = JSON.parse(
  readFileSync(resolve(repoRoot, 'tests/scratch-space-exceptions.json'), 'utf8'),
);

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

/** The spec corpus — the population #918 says to scan. */
function specFiles(): string[] {
  return sourceFiles().filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f) || f.includes('__tests__/'));
}

/**
 * The #918 shape, reconstructed from the commit that fixed it (c3a8ca51). Both
 * halves matter and neither is visible to rule 1: the destination is built from
 * the repo root, and the write itself happens inside a `node -e` STRING, where
 * a scan of blanked code cannot see a call at all.
 */
const SHAPE_918 = [
  "const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');",
  "const tmp = resolve(repoRoot, 'tests/.tomatchobject-guard-sample.tmp.ts');",
  "execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(sample)})`]);",
].join('\n');

/** The same test after c3a8ca51 moved its scratch to `tmpdir()`. */
const SHAPE_918_FIXED = [
  "const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');",
  "const tmp = join(tmpdir(), 'knext-tomatchobject-guard-sample.tmp.ts');",
  "execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(sample)})`]);",
].join('\n');

describe('a spec writes its scratch OUTSIDE the checkout (#918)', () => {
  it('finds spec files at all — the scan must not pass vacuously', () => {
    expect(specFiles().length).toBeGreaterThan(200);
  });

  it('no spec writes into the checkout', () => {
    const offenders = specFiles()
      .filter((f) => !(f in exceptions.repoRootedWrites))
      .flatMap((f) =>
        repoRootedWrites(readFileSync(resolve(repoRoot, f), 'utf8')).map(
          (w) => `${f}: ${w.call}(${w.target}${w.embedded ? '  [inside a command string]' : ''}`,
        ),
      )
      .sort();
    expect(
      offenders,
      'a transient file written inside the checkout races every other spec that walks the ' +
        'tree — that is #914, deterministic in CI and green on main, and rule 1 could not ' +
        'see it because the write was not a mkdtemp. Root the destination at `tmpdir()`, or ' +
        'add a justified entry to tests/scratch-space-exceptions.json.',
    ).toEqual([]);
  });

  it('recognises the #918 shape — a repo-rooted write through `node -e`', () => {
    // Self-proving: a scan that saw nothing would satisfy the assertion above
    // forever, and this exact shape is the one that shipped under it.
    expect(repoRootedWrites(SHAPE_918)).toHaveLength(1);
    expect(repoRootedWrites(SHAPE_918)[0]?.embedded).toBe(true);
  });

  it('recognises a bare relative destination, which resolves against the repo root', () => {
    expect(repoRootedWrites("writeFileSync('tests/.scratch.tmp.ts', body);")).toHaveLength(1);
    expect(
      repoRootedWrites("mkdirSync(resolve(dirname(fileURLToPath(import.meta.url)), 'out'));"),
    ).toHaveLength(1);
  });

  it('accepts the tmpdir rewrite that actually fixed #918', () => {
    expect(repoRootedWrites(SHAPE_918_FIXED)).toEqual([]);
  });

  it('accepts reading a TRACKED file into scratch — the destination is argument 2', () => {
    // `copyFileSync(<repo>, <tmp>)` is the correct direction and two live call
    // sites use it. Judging argument 0 would report both.
    expect(
      repoRootedWrites(
        "const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n" +
          "const dir = mkdtempSync(join(tmpdir(), 'x-'));\n" +
          "copyFileSync(resolve(REPO_ROOT, 'action.yml'), join(dir, 'action.yml'));",
      ),
    ).toEqual([]);
  });

  it('accepts the mutate-then-git-restore provers, which write tracked files on purpose', () => {
    // The harness rewrites a TRACKED file in place and restores it from a
    // content snapshot. That is not scratch space, and reporting it is how a
    // guard gets an exemption it does not need.
    for (const prover of [
      'tests/mutation-harness.test.ts',
      'tests/mutation-prover-lane.test.ts',
      'tests/action-pin-sha-tag-nightly.test.ts',
    ]) {
      expect(existsSync(resolve(repoRoot, prover)), `${prover} moved — repoint this check`).toBe(
        true,
      );
      expect(repoRootedWrites(readFileSync(resolve(repoRoot, prover), 'utf8')), prover).toEqual([]);
    }
  });

  it('every write exception is still needed — a stale entry reds', () => {
    for (const [file, reason] of Object.entries(exceptions.repoRootedWrites)) {
      expect(existsSync(resolve(repoRoot, file)), `${file} is gone; drop its exception`).toBe(true);
      expect(reason.length, `${file}'s exception carries no reason`).toBeGreaterThan(40);
      expect(
        repoRootedWrites(readFileSync(resolve(repoRoot, file), 'utf8')).length,
        `${file} no longer writes into the checkout — delete its exception rather than ` +
          'leaving a licence nobody needs',
      ).toBeGreaterThan(0);
    }
  });
});

describe('a temp directory is REMOVED, not just correctly placed (D9, #880)', () => {
  const perFile = (): Map<string, number> => {
    const out = new Map<string, number>();
    for (const f of sourceFiles()) {
      const n = unpairedTempDirs(readFileSync(resolve(repoRoot, f), 'utf8')).length;
      if (n > 0) out.set(f, n);
    }
    return out;
  };

  it('finds mkdtemp call sites at all — the scan must not pass vacuously', () => {
    const sites = sourceFiles().reduce(
      (n, f) => n + countTempDirSites(readFileSync(resolve(repoRoot, f), 'utf8')),
      0,
    );
    expect(sites).toBeGreaterThan(100);
  });

  it('no file leaks more temp directories than its recorded baseline', () => {
    const baseline = exceptions.unremovedTempDirs.files;
    const regressions = [...perFile()]
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} unremoved mkdtemp (baseline ${baseline[f] ?? 0})`)
      .sort();
    expect(
      regressions,
      'a mkdtemp with no paired removal leaks one directory per run on every machine that ' +
        'runs the suite — 2877 of them once accumulated in the checkout itself (#880), and ' +
        'moving them to `tmpdir()` moved the leak out of sight rather than fixing it. Pair ' +
        'the creation with an `rmSync` in a `finally` or an `afterAll`.',
    ).toEqual([]);
  });

  it('no baseline entry is stale — a file that stopped leaking must leave the list', () => {
    const live = perFile();
    const { recordedOn, note, files } = exceptions.unremovedTempDirs;
    expect(recordedOn, 'an undated baseline is a permanent one').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      note.length,
      'a baseline with no argument for itself is just a mute list',
    ).toBeGreaterThan(120);
    for (const [file, sites] of Object.entries(files)) {
      expect(existsSync(resolve(repoRoot, file)), `${file} is gone; drop its baseline entry`).toBe(
        true,
      );
      expect(sites, `${file}'s baseline records no sites`).toBeGreaterThan(0);
      expect(
        live.get(file) ?? 0,
        `${file} no longer leaks — remove its baseline entry so the ratchet keeps ratcheting`,
      ).toBeGreaterThan(0);
    }
  });

  it('recognises a mkdtemp with no removal anywhere in the file', () => {
    expect(unpairedTempDirs("const dir = mkdtempSync(join(tmpdir(), 'knext-x-'));")).toHaveLength(
      1,
    );
  });

  it('accepts a try/finally and an afterAll cleanup', () => {
    expect(
      unpairedTempDirs(
        "const dir = mkdtempSync(join(tmpdir(), 'knext-x-'));\n" +
          'try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }',
      ),
    ).toEqual([]);
    expect(
      unpairedTempDirs(
        "let dir = '';\n" +
          "beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'knext-x-')); });\n" +
          'afterAll(() => { rmSync(dir, { recursive: true, force: true }); });',
      ),
    ).toEqual([]);
  });
});
