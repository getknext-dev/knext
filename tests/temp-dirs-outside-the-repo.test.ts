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
 * that stops being needed reds the guard instead of rotting in place. The write
 * licence is a MULTISET of destinations — a count alone licences "three writes
 * in this file", which substitution satisfies, and a destination set alone
 * licences a spelling however many times it appears, so duplication rode free —
 * and the leak ceiling is per file and per count, so a new leak inside an
 * already-listed file, including one reusing a binding name already there, reds. A
 * file-global exception would make the one file already allowed to write into
 * the checkout the safest place in the repo to put the next such write.
 * The `unremovedTempDirs` burn-down is tracked in #939.
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
  repoRootedWrites: Record<string, { writes: string[]; reason: string }>;
  unremovedTempDirs: { recordedOn: string; note: string; files: Record<string, number> };
};

/** How a finding is named, in the offender report AND in the licence. */
function render(w: { call: string; target: string; embedded: boolean }): string {
  return `${w.call}(${w.target})${w.embedded ? ' [inside a command string]' : ''}`;
}

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
      .flatMap((f) => {
        // A MULTISET of destinations — both halves, because each alone has a
        // hole. A COUNT alone licences "three writes in this file", which
        // SUBSTITUTION satisfies: swapping the three legitimate fixture writes
        // for three `tests/.a.tmp.ts` writes stayed green. A destination SET
        // alone licences a spelling however many times it appears, so
        // DUPLICATING a licensed write rode free. Pin both.
        const budget = new Map<string, number>();
        for (const w of exceptions.repoRootedWrites[f]?.writes ?? []) {
          budget.set(w, (budget.get(w) ?? 0) + 1);
        }
        return repoRootedWrites(readFileSync(resolve(repoRoot, f), 'utf8'))
          .map(render)
          .filter((w) => {
            const left = budget.get(w) ?? 0;
            if (left === 0) return true;
            budget.set(w, left - 1);
            return false;
          })
          .map((w) => `${f}: ${w}`);
      })
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

  it('recognises a BACKTICK destination, with and without an unresolvable hole', () => {
    // A template literal is what a spec reaches for when the scratch name needs
    // to be unique, so the interpolated form is the LIKELIER spelling of the
    // bug — and the scan read only quotes, which made both of these silent
    // while their single-quoted twin above was the unit-tested case.
    expect(repoRootedWrites('writeFileSync(`tests/.scratch.tmp.ts`, body);')).toHaveLength(1);
    expect(
      repoRootedWrites('writeFileSync(`tests/.scratch-${process.pid}.tmp.ts`, body);'),
      'the hole does not resolve to a root, but `tests/` already is one — an unresolvable ' +
        'suffix must not buy silence',
    ).toHaveLength(1);
  });

  it('is not defeated by a `$` in the binding name', () => {
    // `$` is a legal identifier character AND a regex anchor. Interpolated raw,
    // `\btmp$\b` anchors at end-of-line, the declaration never resolves, and the
    // binding is acquitted — so this exact #918 shape reported nothing, purely
    // because of what the variable was called.
    expect(
      repoRootedWrites(
        "const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n" +
          "const tmp$ = resolve(repoRoot, 'tests/.x.tmp.ts');\nwriteFileSync(tmp$, body);",
      ),
    ).toHaveLength(1);
    expect(
      repoRootedWrites(
        "const tmp$ = join(tmpdir(), 'knext-x.tmp.ts');\nwriteFileSync(tmp$, body);",
      ),
    ).toEqual([]);
  });

  it('acquits a template whose ROOT is the hole', () => {
    expect(
      repoRootedWrites(
        "const dir = mkdtempSync(join(tmpdir(), 'x-'));\nwriteFileSync(`${dir}/x.ts`, body);",
      ),
    ).toEqual([]);
  });

  it('distinguishes an absolute segment under join() from one under resolve()', () => {
    const repoRootDecl = "const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n";
    // `join(root, '/tests/x')` is `root/tests/x` — the leading slash is a
    // separator, not a new root. Treating any absolute-looking literal as
    // "somewhere deliberate" acquits every repo write spelled this way.
    expect(
      repoRootedWrites(`${repoRootDecl}writeFileSync(join(root, '/tests/x.tmp.ts'), body);`),
    ).toHaveLength(1);
    // Under `resolve`, an absolute argument really does take over.
    expect(
      repoRootedWrites(`${repoRootDecl}writeFileSync(resolve(root, '/tmp/x'), body);`),
    ).toEqual([]);
    expect(repoRootedWrites("writeFileSync(join('/tmp', 'x'), body);")).toEqual([]);
    // …and only a TOP-LEVEL argument of `resolve` can take over. A slash on a
    // literal nested inside a subpath is the same mistake one level down.
    expect(
      repoRootedWrites(
        "const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n" +
          "writeFileSync(resolve(root, join(x, '/seg')), body);",
      ),
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

  it('every licensed write still exists — a licence outliving its subject reds', () => {
    for (const [file, { writes, reason }] of Object.entries(exceptions.repoRootedWrites)) {
      expect(existsSync(resolve(repoRoot, file)), `${file} is gone; drop its exception`).toBe(true);
      expect(reason.length, `${file}'s exception carries no reason`).toBeGreaterThan(40);
      const live = repoRootedWrites(readFileSync(resolve(repoRoot, file), 'utf8')).map(render);
      // Both directions, and as a MULTISET. The offender check above catches a
      // write the licence does not cover; this catches a licence the file no
      // longer contains — which is what a SUBSTITUTION looks like from the other
      // side — and, by consuming one live write per licensed entry, a licence
      // that claims more copies than the file actually has.
      const remaining = [...live];
      expect(
        writes.filter((w) => {
          const i = remaining.indexOf(w);
          if (i === -1) return true;
          remaining.splice(i, 1);
          return false;
        }),
        `${file} no longer performs these licensed write(s). Delete them from the exception ` +
          'rather than leaving a licence nobody needs — a stale entry is a free pass for the ' +
          'next write that happens to be spelled the same way',
      ).toEqual([]);
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

  it('counts pairing rather than asking whether a removal EXISTS', () => {
    // One `rmSync(dir)` cannot discharge two `mkdtempSync` bound to `dir`.
    // Existential pairing is what shipped first, and `cli-node-runtime.test.ts`
    // — nine creations named `dir`, one removal — reported ZERO leaks under it,
    // which also meant a tenth same-named leak stayed green.
    expect(
      unpairedTempDirs(
        "let dir = mkdtempSync(join(tmpdir(), 'a-'));\nrmSync(dir, { recursive: true });\n" +
          "dir = mkdtempSync(join(tmpdir(), 'b-'));",
      ),
    ).toHaveLength(1);
    expect(
      unpairedTempDirs(
        "const dir = mkdtempSync(join(tmpdir(), 'a-'));\nrmSync(dir, { recursive: true });\n" +
          "const dir2 = mkdtempSync(join(tmpdir(), 'b-'));\nrmSync(dir2, { recursive: true });",
      ),
    ).toEqual([]);
  });

  it('enrols in a registry PER SITE, on a real registry file, under the COLLIDING name', () => {
    // Asserted against the tree, not a synthetic string: the synthetic vectors
    // below all passed while the file-global exemption was live, because they
    // never contained an UNREGISTERED sibling.
    //
    // And the appended name is the DRAIN ELEMENT's name on purpose. This file
    // drains with `for (const d of tempDirs) rmSync(d, …)`, so `d` is the one
    // name whose leak the drain body's own `rmSync` could credit as a direct
    // removal — and the earlier version of this check appended `dir`, the single
    // name that could not expose it. Measured against the pre-fix scan by
    // appending a probe leak under every loop-element name in the corpus:
    // 12 (file, name) pairs sat on that collision, 8 closed by excluding drain
    // bodies from direct credit and 4 by widening that exclusion to loops over a
    // non-identifier iterable; 0 remain.
    const file = 'tests/e2e-deploy.port-ownership.test.ts';
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    expect(
      source,
      `${file} is the real drained-registry fixture for this check — if it stopped draining ` +
        'with `for (const d of tempDirs) rmSync(d, …)`, repoint the check and the name below',
    ).toContain('for (const d of tempDirs) rmSync(d,');
    expect(unpairedTempDirs(source)).toEqual([]);

    for (const name of ['d', 'dir']) {
      const appended = Array.from(
        { length: 5 },
        (_, i) => `const ${name} = mkdtempSync(join(tmpdir(), 'knext-unregistered-${i}-'));`,
      ).join('\n');
      expect(
        unpairedTempDirs(`${source}\n${appended}\n`),
        `five unregistered creations named \`${name}\` — one enrolment cannot discharge them, ` +
          "and the drain's own rm is credited per enrolment, not per name",
      ).toHaveLength(5);
    }
  });

  it("does not let the drain's own rm double as a direct removal", () => {
    const drain = 'afterAll(() => { for (const d of temps) rmSync(d, { recursive: true }); });';
    // `d` is the drain element's name. Its `rmSync(d)` is credited ONCE per
    // enrolment; counting it again here would acquit an unenrolled creation
    // that merely shares the name.
    expect(
      unpairedTempDirs(`const temps = [];\nconst d = mkdtempSync(join(tmpdir(), 'x-'));\n${drain}`),
    ).toHaveLength(1);
    // …while a real removal OUTSIDE the drain body still credits.
    expect(
      unpairedTempDirs(
        `const temps = [];\nconst d = mkdtempSync(join(tmpdir(), 'x-'));\n` +
          `rmSync(d, { recursive: true });\n${drain}`,
      ),
    ).toEqual([]);
  });

  it('is not defeated by a `$` in the binding name, on the lifetime half either', () => {
    // Same defeat, both other interpolation sites: removal credit and enrolment.
    expect(unpairedTempDirs("const dir$ = mkdtempSync(join(tmpdir(), 'x-'));")).toHaveLength(1);
    expect(
      unpairedTempDirs(
        "const dir$ = mkdtempSync(join(tmpdir(), 'x-'));\nrmSync(dir$, { recursive: true });",
      ),
    ).toEqual([]);
    expect(
      unpairedTempDirs(
        'const temps = [];\n' +
          "const a$ = mkdtempSync(join(tmpdir(), 'x-'));\ntemps.push(a$);\n" +
          'afterAll(() => { for (const d of temps) rmSync(d, { recursive: true }); });',
      ),
    ).toEqual([]);
  });

  it('sees a drain over a non-identifier iterable, in both directions', () => {
    // `of [appDir]` (live in `e2e-deploy.contract.test.ts`) and
    // `of dirs.splice(0)` (live in `doctor.test.ts`). The first has no registry
    // to enrol into, so its rm must only be EXCLUDED from direct credit; the
    // second must still enrol, or a correctly-cleaned directory becomes a false
    // finding. Requiring a bare identifier got each of these wrong in turn.
    expect(
      unpairedTempDirs(
        "const appDir = mkdtempSync(join(tmpdir(), 'x-'));\n" +
          "const d = mkdtempSync(join(tmpdir(), 'y-'));\n" +
          'afterAll(() => { for (const d of [appDir]) rmSync(d, { recursive: true }); });',
      ).map((u) => u.binding),
      // TWO, and the second is a deliberate over-report: `appDir` really is
      // removed, but only by being named inside an array literal, which is not
      // an enrolment the scan can count. Fail-closed is the direction this scan
      // takes wherever it cannot be certain — an uncredited cleanup costs one
      // baseline entry, an uncounted leak costs the guard. What must NOT happen
      // is the loop element `d` picking up credit from that same rm.
      'the array-literal drain must not credit the unrelated `d`',
    ).toEqual(['appDir', 'd']);
    expect(
      unpairedTempDirs(
        'const dirs = [];\n' +
          "function make() { const d = mkdtempSync(join(tmpdir(), 'x-')); dirs.push(d); return d; }\n" +
          'afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });',
      ),
    ).toEqual([]);
  });

  it('does not treat an unrelated rm as draining the registry', () => {
    expect(
      unpairedTempDirs(
        'const temps = [];\n' +
          "const dir = mkdtempSync(join(tmpdir(), 'x-'));\ntemps.push(dir);\n" +
          'afterAll(() => { rmSync(someOtherFile, { force: true }); });',
      ),
    ).toHaveLength(1);
  });

  it('does not credit removing a FILE INSIDE the directory', () => {
    // `asset-upload.test.ts` removes `join(root, '.next', 'BUILD_ID')` and never
    // removes `root`; a substring match read that as a cleanup.
    expect(
      unpairedTempDirs(
        "const root = mkdtempSync(join(tmpdir(), 'x-'));\n" +
          "await fs.rm(join(root, '.next', 'BUILD_ID'), { force: true });",
      ),
    ).toHaveLength(1);
    expect(
      unpairedTempDirs(
        "const root = mkdtempSync(join(tmpdir(), 'x-'));\nrmSync(root, { recursive: true });",
      ),
    ).toEqual([]);
  });

  it('accepts a registry that discharges every directory at once', () => {
    // Real pattern, `compat-window-fingerprint.test.ts`: push each scratch dir
    // onto an array and empty it in `afterAll`. Counting removals naively would
    // report one leak per creation — a guard reporting the correct pattern.
    expect(
      unpairedTempDirs(
        'const temps = [];\n' +
          "function t() { const dir = mkdtempSync(join(tmpdir(), 'x-')); temps.push(dir); return dir; }\n" +
          'afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });',
      ),
    ).toEqual([]);
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
