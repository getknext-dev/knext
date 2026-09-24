import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { CREDENTIAL_CELLS } from '../scripts/compat-window-audit.mjs';

/**
 * S1 / #545 — the COMPAT-WINDOW FINGERPRINT.
 *
 * The v1.0 gate is "14 consecutive scheduled node-lane runs with the harness
 * unchanged". Nothing in the repo recorded what "unchanged" meant, so the
 * guarantee was unfalsifiable: a human would police the window by reading a log
 * they also wrote. This suite pins the fingerprint's two load-bearing
 * properties.
 *
 * 1. It covers the WHOLE frozen set — including the packed `@getknext/*`
 *    closure, which is the part a naive fingerprint leaves out (the workflow
 *    packs lib + db + core as the adapter under test, so a change there changes
 *    what the night actually exercised).
 * 2. It SCANS rather than enumerates. An enumerated file list is how the second
 *    file gets missed; a newly-added `scripts/e2e-*.sh` or a newly-packed
 *    tarball must move the digest with no edit to the script.
 *
 * A third property, added after the architect gate on PR #574: SUITE PROVENANCE
 * is RECORDED, NOT FROZEN. `NEXTJS_REF: v16.2.0` is a git TAG resolved fresh
 * each night, and that checkout supplies `run-tests.js` and the suite itself —
 * so a retag moves what "green" means under a stable fingerprint. The resolved
 * commit and the `next` tarball digest are therefore written into the artifact,
 * but deliberately kept OUT of the digest: a legitimate suite bump should be a
 * visible decision, not a silent window reset.
 *
 * A fourth, added while investigating #850 (V4): the `packed` component is
 * anchored on the packed CONTENT, never on the tarball's bytes. #850 proposes
 * "re-anchor the window to a content hash of the packed closure" as the remedy
 * for a window that restarts on every merge — and the anchor is already exactly
 * that, which is why the remedy as written buys nothing. Measured on this
 * branch, twice: two independent `npm pack`s of `packages/{lib,db,kn-next}`, and
 * a third after a full rebuild of all three, produced the identical `packed`
 * digest `sha256:fb964074…`. The property was true by construction and untested,
 * so a later "optimisation" to digest the tarball itself would have restarted
 * the window EVERY night — gzip stores an mtime — while reading as a
 * simplification. `is anchored on packed CONTENT` below is that guard.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A minimal but REAL frozen-set fixture: harness files + packed tarballs. */
function makeFixture(): { repoRoot: string; tarballsDir: string } {
  const root = tempDir('knext-fp-repo-');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/test-e2e-deploy.yml'), 'name: Compat suite\n');
  writeFileSync(join(root, 'scripts/e2e-deploy.sh'), '#!/usr/bin/env bash\necho deploy\n');
  chmodSync(join(root, 'scripts/e2e-deploy.sh'), 0o755);
  writeFileSync(join(root, 'scripts/e2e-summary.mjs'), 'export const x = 1;\n');
  // Not part of the frozen set — a sibling script that must NOT be swept in.
  writeFileSync(join(root, 'scripts/unrelated.mjs'), 'export const y = 1;\n');
  writeFileSync(
    join(root, 'test/deploy-tests-manifest.knext.json'),
    `${JSON.stringify({ version: 2, rules: { exclude: [] } }, null, 2)}\n`,
  );
  // #1294 round 3: the default lane ('node') declares these in
  // CREDENTIAL_CELLS.extraFiles — a declared-but-missing entry is a hard
  // error, so every fixture used against the default lane needs them present.
  writeFileSync(join(root, 'scripts/compat-credential-ref.mjs'), 'export const noop = 1;\n');
  writeFileSync(join(root, 'scripts/compat-run-ledger.mjs'), 'export const noop = 1;\n');
  writeFileSync(join(root, '.github/compat-credential-ref.json'), '{"rcTag":null}\n');
  // #1321: the bun-vinext cell declares its quarantine ledger + script.
  writeFileSync(join(root, 'scripts/compat-vinext-ledger.mjs'), 'export const noop = 1;\n');
  writeFileSync(
    join(root, 'test/compat-vinext-ledger.json'),
    '{"lane":"bun-vinext","entries":[]}\n',
  );

  const tarballsDir = tempDir('knext-fp-tarballs-');
  for (const [name, version] of [
    ['core', '0.3.0'],
    ['lib', '0.2.0'],
  ] as const) {
    packFixtureTarball(tarballsDir, name, version);
  }
  return { repoRoot: root, tarballsDir };
}

/** Build a npm-shaped tarball (everything under `package/`) for @getknext/<name>. */
function packFixtureTarball(
  destDir: string,
  name: string,
  version: string,
  extra?: Record<string, string>,
  /**
   * Stamp every staged entry with this time before `tar`. tar records a per-file
   * mtime, so two packs of IDENTICAL content under different stamps differ in
   * bytes — which is what makes the content-anchor claim below falsifiable
   * rather than a repeat of the determinism test above.
   */
  mtime?: Date,
) {
  const stage = tempDir(`knext-fp-pack-${name}-`);
  const pkgDir = join(stage, 'package');
  mkdirSync(join(pkgDir, 'dist/adapters'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: `@getknext/${name}`, version }, null, 2)}\n`,
  );
  writeFileSync(join(pkgDir, 'dist/adapters/next-adapter.js'), 'export const adapter = {};\n');
  for (const [rel, contents] of Object.entries(extra ?? {})) {
    mkdirSync(join(pkgDir, rel, '..'), { recursive: true });
    writeFileSync(join(pkgDir, rel), contents);
  }
  if (mtime) {
    for (const rel of [
      'package.json',
      'dist/adapters/next-adapter.js',
      ...Object.keys(extra ?? {}),
    ])
      utimesSync(join(pkgDir, rel), mtime, mtime);
  }
  const tarball = join(destDir, `getknext-${name}-${version}.tgz`);
  execFileSync('tar', ['czf', tarball, '-C', stage, 'package']);
  return tarball;
}

function fingerprint(
  repoRoot: string,
  tarballsDir: string,
): { fingerprint: string; components: Record<string, string>; counts: Record<string, number> } {
  const out = execFileSync(
    process.execPath,
    [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json'],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

describe('compat-window fingerprint — the frozen set is digestible and complete', () => {
  it('is deterministic across runs on an unchanged frozen set', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const a = fingerprint(repoRoot, tarballsDir);
    const b = fingerprint(repoRoot, tarballsDir);
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('is anchored on packed CONTENT, not on the tarball bytes (#850)', () => {
    // The frozen harness is held constant so the ONLY thing that could move the
    // digest is the packed half.
    const { repoRoot } = makeFixture();
    const older = new Date('2020-01-02T03:04:05Z');
    const newer = new Date('2026-09-05T06:07:08Z');

    const dirA = tempDir('knext-fp-anchor-a-');
    const dirB = tempDir('knext-fp-anchor-b-');
    const tarA = packFixtureTarball(dirA, 'core', '0.3.0', undefined, older);
    const tarB = packFixtureTarball(dirB, 'core', '0.3.0', undefined, newer);

    // BOTH HALVES. Without this the assertion below is satisfied by two byte-
    // identical tarballs and proves only that sha256 is a function — which is
    // what `is deterministic across runs` already proves.
    expect(
      readFileSync(tarA).equals(readFileSync(tarB)),
      'the two tarballs came out byte-identical, so this test cannot distinguish a ' +
        'content anchor from a byte anchor. Widen the mtime skew.',
    ).toBe(false);

    expect(
      fingerprint(repoRoot, dirB).components.packed,
      'the packed component moved without any packed CONTENT changing. A window keyed on ' +
        'tarball bytes restarts every night — gzip and tar both record mtimes — so the ' +
        '14-night gate could never close for reasons that have nothing to do with the code ' +
        'under test (#850).',
    ).toBe(fingerprint(repoRoot, dirA).components.packed);
  });

  it('changes when a HARNESS file changes (the workflow)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    writeFileSync(
      join(repoRoot, '.github/workflows/test-e2e-deploy.yml'),
      'name: Compat suite\n# edited\n',
    );
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  it('changes when the deploy manifest changes', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    writeFileSync(
      join(repoRoot, 'test/deploy-tests-manifest.knext.json'),
      `${JSON.stringify({ version: 2, rules: { exclude: ['test/e2e/foo.test.ts'] } }, null, 2)}\n`,
    );
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  // THE mutation proof named in the exit criteria: the packed closure is the
  // part most easily left out, and leaving it out is the whole failure mode.
  it('changes when a file INSIDE a packed @getknext/* tarball changes', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir);
    // Re-pack @getknext/core at the SAME version with one adapter byte changed.
    rmSync(join(tarballsDir, 'getknext-core-0.3.0.tgz'));
    packFixtureTarball(tarballsDir, 'core', '0.3.0', {
      'dist/adapters/next-adapter.js': 'export const adapter = { changed: true };\n',
    });
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.components.packed).not.toBe(before.components.packed);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // …and the harness half is untouched, so the change is attributable.
    expect(after.components.harness).toBe(before.components.harness);
  });

  it('changes when a packed tarball is added or removed', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    packFixtureTarball(tarballsDir, 'db', '0.2.1');
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  it('SCANS the harness: a newly-added scripts/e2e-* file moves the digest with no script edit', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir);
    writeFileSync(join(repoRoot, 'scripts/e2e-newly-added.sh'), '#!/usr/bin/env bash\n');
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.counts.harness).toBe(before.counts.harness + 1);
  });

  it('does NOT sweep in unrelated scripts (the freeze scope is the harness, not scripts/)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    writeFileSync(join(repoRoot, 'scripts/unrelated-two.mjs'), 'export const z = 1;\n');
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).toBe(before);
  });

  it('changes when a harness script loses its executable bit', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    chmodSync(join(repoRoot, 'scripts/e2e-deploy.sh'), 0o644);
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  it('FAILS rather than fingerprinting an empty packed set (a digest over nothing is not evidence)', () => {
    const { repoRoot } = makeFixture();
    const emptyDir = tempDir('knext-fp-empty-');
    expect(() => fingerprint(repoRoot, emptyDir)).toThrow();
  });

  it('FAILS when a packed tarball is not an @getknext/* package', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    packFixtureTarball(tarballsDir, 'core', '0.3.0');
    const stage = tempDir('knext-fp-foreign-');
    mkdirSync(join(stage, 'package'), { recursive: true });
    writeFileSync(
      join(stage, 'package/package.json'),
      `${JSON.stringify({ name: 'lodash', version: '1.0.0' })}\n`,
    );
    execFileSync('tar', ['czf', join(tarballsDir, 'lodash-1.0.0.tgz'), '-C', stage, 'package']);
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow();
  });

  it('names the real repo harness files when run against this checkout', () => {
    // Not a fixture: prove the declared roots actually resolve in THIS tree, so
    // a rename that empties a root fails here rather than silently shrinking the
    // frozen set to nothing.
    const tarballsDir = tempDir('knext-fp-real-');
    packFixtureTarball(tarballsDir, 'core', '0.3.0');
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', REPO_ROOT, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('.github/workflows/test-e2e-deploy.yml');
    expect(harness).toContain('test/deploy-tests-manifest.knext.json');
    expect(harness.filter((p) => p.startsWith('scripts/e2e-')).length).toBeGreaterThanOrEqual(3);
    // #1301 review round 1: test/deploy-tests-manifest.smoke.knext.json is
    // read ONLY on a dispatch-only `smoke=true` run — never a credential or
    // early-warning night — so it must NOT be part of the frozen harness set.
    // Non-vacuous: the smoke manifest genuinely exists in this checkout
    // (added by #1301), so this assertion exercises the real exclusion rather
    // than passing by the file's absence.
    expect(
      existsSync(resolve(REPO_ROOT, 'test/deploy-tests-manifest.smoke.knext.json')),
      'the smoke manifest fixture this test depends on is missing from the checkout',
    ).toBe(true);
    expect(
      harness,
      'the dispatch-only smoke manifest must be excluded from the credential-night harness fingerprint',
    ).not.toContain('test/deploy-tests-manifest.smoke.knext.json');
  });
});

describe('compat-window fingerprint — the packed tarball is covered IN FULL', () => {
  // Architect gate, PR #574: an earlier draft of ADR-0039 claimed `dist/cli/**`
  // was "explicitly excluded" from the frozen set. It is not, and cannot be:
  // `packages/kn-next/package.json` has `files: ["dist"]` and
  // `bin: ./dist/cli/kn-next.js`, so `dist/cli/**` SHIPS inside the tarball
  // under test — and 8 of the 9 chunks `dist/cli/*` references are shared with
  // non-CLI dist files, so a path-prefix filter would not separate them either
  // (a CLI change perturbing a shared chunk rotates its hashed filename and
  // rewrites import specifiers in adapter entries too). The digest hashes
  // SHIPPED BYTES; `adapter-import-closure.mjs` proves a different thing — that
  // the adapter never EXECUTES CLI code. These tests pin the honest claim.
  it('a change under dist/cli/ inside the tarball DOES move the digest', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    packFixtureTarball(tarballsDir, 'core-cli', '0.3.0', {
      'dist/cli/kn-next.js': '#!/usr/bin/env node\nconsole.log("v1");\n',
    });
    const before = fingerprint(repoRoot, tarballsDir);
    rmSync(join(tarballsDir, 'getknext-core-cli-0.3.0.tgz'));
    packFixtureTarball(tarballsDir, 'core-cli', '0.3.0', {
      'dist/cli/kn-next.js': '#!/usr/bin/env node\nconsole.log("v2");\n',
    });
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.components.packed).not.toBe(before.components.packed);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('a change to a SHARED dist chunk moves the digest (no path-prefix filter)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    packFixtureTarball(tarballsDir, 'core-chunk', '0.3.0', {
      'dist/chunk-C7XL7PTE.js': 'export const shared = 1;\n',
    });
    const before = fingerprint(repoRoot, tarballsDir);
    rmSync(join(tarballsDir, 'getknext-core-chunk-0.3.0.tgz'));
    packFixtureTarball(tarballsDir, 'core-chunk', '0.3.0', {
      'dist/chunk-C7XL7PTE.js': 'export const shared = 2;\n',
    });
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before.fingerprint);
  });
});

describe('compat-window fingerprint — the observed Bun build is folded ONLY on the bun lane (#1147, rule 4)', () => {
  /** Run the fingerprint with an OPTIONAL observed runtime identity. */
  function fingerprintWithRuntime(
    repoRoot: string,
    tarballsDir: string,
    opts: { version?: string; revision?: string },
  ): { fingerprint: string; components: Record<string, string> } {
    const args = [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json'];
    if (opts.version !== undefined) args.push('--runtime-version', opts.version);
    if (opts.revision !== undefined) args.push('--runtime-revision', opts.revision);
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return JSON.parse(out);
  }

  // The crux of #1147: a Bun BUILD move must restart the bun lane's streak.
  // The observed build identity (bun --version + bun --revision) is folded into
  // the digest, so a different build produces a different fingerprint.
  it('a different observed Bun build moves the fingerprint (streak restarts)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const a = fingerprintWithRuntime(repoRoot, tarballsDir, {
      version: '1.4.0',
      revision: 'aaaaaaaaaaaa',
    });
    const b = fingerprintWithRuntime(repoRoot, tarballsDir, {
      version: '1.4.0',
      revision: 'bbbbbbbbbbbb',
    });
    // Same version STRING, different revision → different digest: the whole
    // point of rule 4 (a canary reporting 1.4.0 was red; stable 1.4.0 is green).
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    // The harness + packed halves are untouched, so the move is attributable to
    // the runtime identity alone.
    expect(b.components.harness).toBe(a.components.harness);
    expect(b.components.packed).toBe(a.components.packed);
  });

  it('a different Bun VERSION string alone also moves the fingerprint', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const a = fingerprintWithRuntime(repoRoot, tarballsDir, { version: '1.4.0' });
    const b = fingerprintWithRuntime(repoRoot, tarballsDir, { version: '1.3.14' });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  // The CRITICAL node-lane guarantee: when NO runtime identity is supplied (the
  // node lane never passes one), the digest must be byte-identical to today's —
  // folding must be strictly additive so the live node streak is never reset.
  it('the NODE lane (no runtime identity) is byte-identical to the un-folded digest', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const nodeLane = fingerprint(repoRoot, tarballsDir).fingerprint;
    const alsoNode = fingerprintWithRuntime(repoRoot, tarballsDir, {}).fingerprint;
    expect(alsoNode).toBe(nodeLane);
  });

  // GOLDEN / regression: pin the exact digest the current node-lane fixture
  // produces, so any future change to the fold that perturbs the ABSENT-param
  // path (the node lane) reds here rather than silently resetting the streak.
  it('GOLDEN: the node-lane fixture digest is unchanged by the runtime-fold code path', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    // Two independent computations, one through each entry shape, must agree AND
    // match the components-only digest formula the node lane has always used.
    const plain = fingerprint(repoRoot, tarballsDir);
    const withEmpty = fingerprintWithRuntime(repoRoot, tarballsDir, {});
    expect(withEmpty.fingerprint).toBe(plain.fingerprint);
    // components are the node-lane invariant: neither entry shape adds a runtime
    // component to the node lane.
    expect(Object.keys(withEmpty.components).sort()).toEqual(['harness', 'packed']);
  });
});

describe('compat-window fingerprint — suite provenance is RECORDED, not frozen', () => {
  /** A throwaway git repo standing in for the nightly `next.js` checkout. */
  function fakeNextJsCheckout(): { dir: string; head: string } {
    const dir = tempDir('knext-fp-nextjs-');
    writeFileSync(join(dir, 'run-tests.js'), 'console.log("harness");\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    // `--no-gpg-sign`: the fixture repo must not inherit the DEVELOPER's
    // `commit.gpgsign=true`. Without it this harness fails on any machine
    // that signs commits — green in CI, red for the contributor, and the
    // error surfaces as an opaque `Command failed: git ... commit`.
    git('commit', '--no-gpg-sign', '-qm', 'harness');
    return { dir, head: git('rev-parse', 'HEAD').trim() };
  }

  function withProvenance(
    repoRoot: string,
    tarballsDir: string,
    nextJsDir: string,
    nextTarball: string,
  ) {
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--repo-root',
        repoRoot,
        '--tarballs-dir',
        tarballsDir,
        '--next-js-dir',
        nextJsDir,
        '--next-tarball',
        nextTarball,
        '--next-ref',
        'v16.2.0',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(out) as {
      fingerprint: string;
      recorded: {
        suite: {
          nextRef: string | null;
          nextJsCommit: string | null;
          nextTarballSha256: string | null;
          frozen: boolean;
        };
      };
    };
  }

  it('records the resolved next.js commit and the next tarball digest', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const { dir, head } = fakeNextJsCheckout();
    const tarball = join(tempDir('knext-fp-nexttgz-'), 'next.tgz');
    writeFileSync(tarball, 'pretend-next-tarball-v1');

    const result = withProvenance(repoRoot, tarballsDir, dir, tarball);
    expect(result.recorded.suite.nextJsCommit).toBe(head);
    expect(result.recorded.suite.nextTarballSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.recorded.suite.nextRef).toBe('v16.2.0');
    // Named in the artifact itself, so a reader cannot mistake it for frozen.
    expect(result.recorded.suite.frozen).toBe(false);
  });

  it('does NOT fold provenance into the digest — a suite bump is a visible decision, not a silent reset', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const baseline = fingerprint(repoRoot, tarballsDir).fingerprint;

    const a = fakeNextJsCheckout();
    const tarballA = join(tempDir('knext-fp-nexttgz-a-'), 'next.tgz');
    writeFileSync(tarballA, 'pretend-next-tarball-v1');
    const withA = withProvenance(repoRoot, tarballsDir, a.dir, tarballA);

    // A DIFFERENT suite commit and a DIFFERENT next tarball…
    const b = fakeNextJsCheckout();
    writeFileSync(join(b.dir, 'run-tests.js'), 'console.log("harness v2");\n');
    execFileSync('git', ['-C', b.dir, 'commit', '--no-gpg-sign', '-aqm', 'retag']);
    const tarballB = join(tempDir('knext-fp-nexttgz-b-'), 'next.tgz');
    writeFileSync(tarballB, 'pretend-next-tarball-v2');
    const withB = withProvenance(repoRoot, tarballsDir, b.dir, tarballB);

    expect(withB.recorded.suite.nextJsCommit).not.toBe(withA.recorded.suite.nextJsCommit);
    expect(withB.recorded.suite.nextTarballSha256).not.toBe(withA.recorded.suite.nextTarballSha256);
    // …must leave the digest exactly where it was, with or without the flags.
    expect(withA.fingerprint).toBe(baseline);
    expect(withB.fingerprint).toBe(baseline);
  });

  it('records nulls rather than guessing when provenance is not supplied', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { recorded: { suite: Record<string, unknown> } };
    expect(parsed.recorded.suite.nextJsCommit).toBeNull();
    expect(parsed.recorded.suite.nextTarballSha256).toBeNull();
  });

  it('FAILS rather than recording a null when a supplied provenance path is wrong', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    expect(() =>
      execFileSync(
        process.execPath,
        [
          SCRIPT,
          '--repo-root',
          repoRoot,
          '--tarballs-dir',
          tarballsDir,
          '--next-tarball',
          join(tarballsDir, 'does-not-exist.tgz'),
          '--json',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow();
  });
});

describe('compat-window fingerprint — wired into the scheduled run', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('the workflow computes the fingerprint from the SAME packed tarballs the shards use', () => {
    expect(workflow).toContain('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(workflow.indexOf('scripts/compat-window-fingerprint.mjs'));
    expect(step).toContain('knext-tarballs');
  });

  it('the fingerprint step records the SUITE provenance the digest deliberately omits', () => {
    const idx = workflow.indexOf('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(idx, idx + 900);
    expect(step).toContain('--next-js-dir');
    expect(step).toContain('--next-tarball');
    expect(step).toContain('--next-ref');
  });

  it('the fingerprint is recorded durably enough to outlive the 14-night window', () => {
    const idx = workflow.indexOf('name: compat-window-fingerprint');
    expect(idx, 'fingerprint artifact upload missing').toBeGreaterThan(-1);
    const upload = workflow.slice(idx, idx + 400);
    expect(upload).toMatch(/retention-days:\s*90/);
  });

  // The fingerprint digests the workflow FILE, so a `uses: owner/repo@v4` in it
  // is a hole in the freeze: the tag can move to different code while the digest
  // stays identical, and the night would run a harness nobody can name. Pinning
  // by SHA is what makes the digest cover what actually ran. (Also the #528
  // pin sweep for this file, folded into S1's single pre-window touch.)
  it('every action in the frozen workflow is pinned by 40-hex SHA with an auditable tag comment', () => {
    const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(5);
    for (const [, ref, trailing] of uses) {
      expect(ref, `unpinned action: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      expect(trailing, `pin without a version comment: ${ref}`).toMatch(/#\s*v?\d+\.\d+\.\d+/);
    }
  });

  it('the run ledger carries the fingerprint, so a mismatch is visible per night', () => {
    const ledger = workflow.slice(workflow.indexOf('shard-ledger:'));
    expect(ledger).toContain('windowFingerprint');
  });

  // #1294 round 5 — the fingerprint script now imports `typescript` to parse
  // JS (a REAL parser, not a hand tokenizer). `typescript` is a root
  // devDependency, installed by the workspace `bun install`, so that install
  // step must run BEFORE the fingerprint step or the import fails closed
  // with Node's own module-not-found error — a real but unfriendly failure
  // this test exists to make unnecessary by verifying the step ORDER, not
  // just that an install step exists somewhere in the file. This is a
  // regression guard: a future reorder (e.g. moving the fingerprint step
  // earlier to shave a few seconds) would silently reintroduce the failure.
  it('"Install knext deps" (the bun install that provides typescript) runs BEFORE the fingerprint step', () => {
    const installIdx = workflow.indexOf('name: Install knext deps');
    const fingerprintIdx = workflow.indexOf('name: Fingerprint the frozen compat-window set');
    expect(installIdx, 'Install knext deps step not found').toBeGreaterThan(-1);
    expect(fingerprintIdx, 'Fingerprint step not found').toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(fingerprintIdx);
  });

  // #1316 — the test above only ever read `test-e2e-deploy.yml` (via the
  // module-level `WORKFLOW` constant), so `compat-vinext.yml` — the OTHER
  // real `workflowFile` in `CREDENTIAL_CELLS` (#1294's per-cell workflow
  // entry) — was completely unguarded: a reorder there that put the
  // fingerprint step before the install step would break the bun-vinext
  // lane's nightly run and nothing in this suite would notice. SCANNED, not
  // hand-listed: this reads the actual `workflowFile` values off
  // `CREDENTIAL_CELLS` (deduped, `null` entries dropped — a cell with no
  // workflow wired yet, e.g. node-vinext, has nothing to check), so a NEW
  // lane wired to a NEW workflow file is covered automatically, the same
  // "scan, don't enumerate" discipline `compat-window-fingerprint.mjs`
  // itself uses for the frozen set.
  it('every wired lane workflow in CREDENTIAL_CELLS runs "Install knext deps" BEFORE its fingerprint step', () => {
    // CREDENTIAL_CELLS is inferred from literal values in a plain .mjs
    // module, so `workflowFile` narrows to a LITERAL union (e.g.
    // `"test-e2e-deploy.yml" | "compat-vinext.yml" | null`), not `string |
    // null` — a `(f): f is string =>` predicate widens past that literal
    // union and TS correctly rejects it as unsound. `NonNullable<...>` keeps
    // the predicate's output type assignable to the real element type.
    const rawWorkflowFiles = CREDENTIAL_CELLS.map((c) => c.workflowFile);
    const workflowFiles = [
      ...new Set(
        rawWorkflowFiles.filter(
          (f): f is NonNullable<(typeof rawWorkflowFiles)[number]> => f !== null,
        ),
      ),
    ];
    expect(workflowFiles.length).toBeGreaterThan(1);
    for (const file of workflowFiles) {
      const path = resolve(REPO_ROOT, '.github/workflows', file);
      const contents = readFileSync(path, 'utf8');
      const installIdx = contents.indexOf('name: Install knext deps');
      const fingerprintIdx = contents.indexOf('name: Fingerprint the frozen compat-window set');
      expect(installIdx, `${file}: "Install knext deps" step not found`).toBeGreaterThan(-1);
      expect(fingerprintIdx, `${file}: fingerprint step not found`).toBeGreaterThan(-1);
      expect(
        installIdx,
        `${file}: "Install knext deps" (idx ${installIdx}) must run BEFORE the fingerprint step (idx ${fingerprintIdx})`,
      ).toBeLessThan(fingerprintIdx);
    }
  });
});

/**
 * #1294 — PER-CELL WORKFLOW ENTRY.
 *
 * Before this, the `harness` workflow-file entry was hardcoded to
 * `.github/workflows/test-e2e-deploy.yml` for every lane. The vinext cells
 * actually run from `.github/workflows/compat-vinext.yml`, so an edit there
 * NEVER moved the vinext cells' fingerprint — a changed harness could carry a
 * 14-night window, which violates ADR-0056 D3.
 */
describe('compat-window fingerprint — each cell hashes the workflow that actually executes it (#1294)', () => {
  const VINEXT_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/compat-vinext.yml');

  function fingerprintLane(
    repoRoot: string,
    tarballsDir: string,
    lane: string,
  ): { fingerprint: string; components: Record<string, string>; files: { path: string }[] } {
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--repo-root',
        repoRoot,
        '--tarballs-dir',
        tarballsDir,
        '--lane',
        lane,
        '--json',
        '--files',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(out);
  }

  /** A fixture carrying BOTH real-world workflow files, so a lane's harness set is attributable. */
  function makeMultiWorkflowFixture(): { repoRoot: string; tarballsDir: string } {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, '.github/workflows/compat-vinext.yml'),
      'name: Compat suite — vinext single-executable axis\n',
    );
    writeFileSync(
      join(repoRoot, 'scripts/e2e-deploy-vinext.sh'),
      '#!/usr/bin/env bash\necho vinext-deploy\n',
    );
    chmodSync(join(repoRoot, 'scripts/e2e-deploy-vinext.sh'), 0o755);
    return { repoRoot, tarballsDir };
  }

  it('names the real repo files: node/bun cells hash test-e2e-deploy.yml, the vinext cells hash compat-vinext.yml', () => {
    for (const lane of ['node', 'bun']) {
      const tarballsDir = tempDir('knext-fp-cellreal-');
      packFixtureTarball(tarballsDir, 'core', '0.3.0');
      const result = fingerprintLane(REPO_ROOT, tarballsDir, lane);
      const workflows = result.files.filter((f) => f.path.startsWith('.github/workflows/'));
      expect(workflows.map((f) => f.path)).toEqual(['.github/workflows/test-e2e-deploy.yml']);
    }
    for (const lane of ['bun-vinext']) {
      const tarballsDir = tempDir('knext-fp-cellreal-');
      packFixtureTarball(tarballsDir, 'core', '0.3.0');
      const result = fingerprintLane(REPO_ROOT, tarballsDir, lane);
      const workflows = result.files.filter((f) => f.path.startsWith('.github/workflows/'));
      expect(workflows.map((f) => f.path)).toEqual(['.github/workflows/compat-vinext.yml']);
    }
  });

  it('an unknown lane is a hard error, never a silent fallback to some workflow', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    expect(() => fingerprintLane(repoRoot, tarballsDir, 'not-a-real-lane')).toThrow();
  });

  it('a lane with no workflow wired yet (node-vinext) is a hard error, not a guess', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    expect(() => fingerprintLane(repoRoot, tarballsDir, 'node-vinext')).toThrow();
  });

  it('#1245: the webpack lanes resolve to the shared test-e2e-deploy.yml, same harness bytes as their turbopack sibling', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const node = fingerprintLane(repoRoot, tarballsDir, 'node');
    expect(fingerprintLane(repoRoot, tarballsDir, 'node-webpack').components.harness).toEqual(
      node.components.harness,
    );
    expect(fingerprintLane(repoRoot, tarballsDir, 'bun-webpack').components.harness).toEqual(
      node.components.harness,
    );
  });

  // THE mutation named in the exit criteria: editing `compat-vinext.yml` moves
  // the vinext cells' fingerprint and NOT the turbopack (node/bun) cells', and
  // vice versa for `test-e2e-deploy.yml`.
  it('editing compat-vinext.yml moves the vinext-lane fingerprint and NOT the turbopack lanes', () => {
    const { repoRoot, tarballsDir } = makeMultiWorkflowFixture();
    const before = {
      node: fingerprintLane(repoRoot, tarballsDir, 'node').fingerprint,
      bun: fingerprintLane(repoRoot, tarballsDir, 'bun').fingerprint,
      vinext: fingerprintLane(repoRoot, tarballsDir, 'bun-vinext').fingerprint,
    };

    writeFileSync(
      join(repoRoot, '.github/workflows/compat-vinext.yml'),
      'name: Compat suite — vinext single-executable axis\n# edited\n',
    );

    const after = {
      node: fingerprintLane(repoRoot, tarballsDir, 'node').fingerprint,
      bun: fingerprintLane(repoRoot, tarballsDir, 'bun').fingerprint,
      vinext: fingerprintLane(repoRoot, tarballsDir, 'bun-vinext').fingerprint,
    };

    expect(after.vinext).not.toBe(before.vinext);
    expect(after.node).toBe(before.node);
    expect(after.bun).toBe(before.bun);
  });

  it('and vice versa: editing test-e2e-deploy.yml moves the turbopack lanes and NOT the vinext lane', () => {
    const { repoRoot, tarballsDir } = makeMultiWorkflowFixture();
    const before = {
      node: fingerprintLane(repoRoot, tarballsDir, 'node').fingerprint,
      bun: fingerprintLane(repoRoot, tarballsDir, 'bun').fingerprint,
      vinext: fingerprintLane(repoRoot, tarballsDir, 'bun-vinext').fingerprint,
    };

    writeFileSync(
      join(repoRoot, '.github/workflows/test-e2e-deploy.yml'),
      'name: Compat suite\n# edited\n',
    );

    const after = {
      node: fingerprintLane(repoRoot, tarballsDir, 'node').fingerprint,
      bun: fingerprintLane(repoRoot, tarballsDir, 'bun').fingerprint,
      vinext: fingerprintLane(repoRoot, tarballsDir, 'bun-vinext').fingerprint,
    };

    expect(after.node).not.toBe(before.node);
    expect(after.bun).not.toBe(before.bun);
    expect(after.vinext).toBe(before.vinext);
  });

  it('sanity: the two real workflow files in this checkout are not byte-identical', () => {
    // If they ever became identical, the test above would pass for the wrong
    // reason — pin this so that regression is visible here first.
    expect(readFileSync(WORKFLOW, 'utf8')).not.toBe(readFileSync(VINEXT_WORKFLOW, 'utf8'));
  });
});

/**
 * #1294 round 2 — a lifecycle script's LOCAL dependency closure (imports,
 * requires, dynamic import()s, and shell `source`/`.`) is part of the frozen
 * harness set, followed TRANSITIVELY and regardless of filename convention.
 *
 * Round 1 fixed this for shell (`scripts/e2e-deploy.sh` sources
 * `scripts/lib/e2e-state-snapshot.sh`) with a directory-pattern root scoped to
 * `e2e-*`-prefixed files. That pattern went blind the moment a REAL sourced
 * file broke the naming convention: `scripts/e2e-preflight.mjs` imports
 * `./lib/knext-closure.mjs` and `./lib/workspace-protocol.mjs`, neither
 * `e2e-`-prefixed, so the pattern-based root never saw them — the same gap
 * class, one level less naming-dependent. The closure fixes the CLASS: it
 * reaches every file an entry script actually imports or sources, however
 * it is named.
 */
describe('compat-window fingerprint — the entry scripts’ import/source closure is part of the frozen harness (#1294 round 2, #1280)', () => {
  it('a newly-SOURCED scripts/lib/*.sh file moves the digest with no script edit to the entry point itself', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/helper.sh'), '#!/usr/bin/env bash\necho v1\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-deploy.sh'),
      '#!/usr/bin/env bash\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n. "${SCRIPT_DIR}/lib/helper.sh"\necho deploy\n',
    );
    const before = fingerprint(repoRoot, tarballsDir);
    writeFileSync(join(repoRoot, 'scripts/lib/helper.sh'), '#!/usr/bin/env bash\necho v2\n');
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // Attributable: the closure adds exactly the one sourced file, no matter
    // that its name carries no `e2e-` prefix.
    expect(after.counts.harness).toBe(before.counts.harness);
  });

  it('a newly-IMPORTED scripts/lib/*.mjs file (no e2e- prefix) moves the digest — the exact #1294 round-2 gap', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/knext-closure.mjs'), 'export const x = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "import { x } from './lib/knext-closure.mjs';\nexport const y = x;\n",
    );
    const before = fingerprint(repoRoot, tarballsDir);
    writeFileSync(join(repoRoot, 'scripts/lib/knext-closure.mjs'), 'export const x = 2;\n');
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.counts.harness).toBe(before.counts.harness);
  });

  it('a scripts/lib/ file that NOTHING references is not swept in (the closure follows references, not a directory pattern)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/unreferenced.sh'), '#!/usr/bin/env bash\n');
    const before = fingerprint(repoRoot, tarballsDir);
    writeFileSync(
      join(repoRoot, 'scripts/lib/unreferenced.sh'),
      '#!/usr/bin/env bash\necho changed\n',
    );
    const after = fingerprint(repoRoot, tarballsDir);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('a fixture with no scripts/lib/ at all still fingerprints (no entry references it)', () => {
    // Every OTHER makeFixture()-based test in this file relies on this: none of
    // them create scripts/lib/, and none of them may start failing because of
    // an unrelated closure that has nothing to do with what they test.
    const { repoRoot, tarballsDir } = makeFixture();
    expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
  });

  it('a REFERENCED-but-missing file is a hard error, never a silently shrunk closure', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "import { x } from './lib/does-not-exist.mjs';\nexport const y = x;\n",
    );
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow();
  });

  // #1294 round 3 (jev 0.90) — a regex over RAW source cannot tell a comment
  // or an unrelated string from genuine import syntax. Either makes the WHOLE
  // fingerprint hard-error on a file that imports nothing missing at all,
  // which would break the entire nightly window on one spurious failure.
  it('a COMMENT mentioning an import-like path to a nonexistent file neither errors nor adds a dependency', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "// see: import x from './nonexistent-thing'\n/* also require('./nonexistent-thing-2') */\nexport const y = 1;\n",
    );
    const before = fingerprint(repoRoot, tarballsDir);
    expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
    // The comment text moves the DIGESTED file's own bytes (it's still part of
    // e2e-summary.mjs, which is frozen), but harness COUNT must not grow — no
    // phantom dependency was added.
    expect(fingerprint(repoRoot, tarballsDir).counts.harness).toBe(before.counts.harness);
  });

  it('a STRING LITERAL whose body looks like import syntax neither errors nor adds a dependency', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      'const msg = "from \'./nonexistent-thing\'";\nconst msg2 = "require(\'./nonexistent-thing-2\')";\nexport const y = msg + msg2;\n',
    );
    const before = fingerprint(repoRoot, tarballsDir);
    expect(before.counts.harness).toBeGreaterThan(0);
  });

  it('a GENUINE import right after a decoy comment is still caught (comment-stripping does not eat real syntax)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.mjs'), 'export const real = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "// import x from './nonexistent-thing'\nimport { real } from './lib/real.mjs';\nexport const y = real;\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.mjs');
  });

  // #1294 round 4 (jev 0.69, the hand-tokenizer's ORIGINAL regex-literal
  // hole) — a regex containing a quote character (`/'/`, or `/[\"']/g`) got
  // its quote misread as a fresh STRING START by round 4's hand-rolled
  // regex-tracking. Found on the real repo:
  // `scripts/e2e-preflight.mjs`'s own
  // `/EUNSUPPORTEDPROTOCOL|…"workspace:/.test(out)` regex, whose embedded `"`
  // was misread as a string start that then consumed 1500+ real characters
  // hunting for a closing quote. Round 5 replaced the hand tokenizer
  // entirely with `ts.createSourceFile` — a REAL parser handles a regex
  // literal's contents correctly by construction, so these fixtures are now
  // regression tests for the OLD bug class rather than exercises of hand-
  // rolled regex-tracking logic that no longer exists.
  it('a regex literal containing a quote character does not corrupt scanning, and a genuine import right after it is still caught', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.mjs'), 'export const real = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "const stripQuote = /'/;\nconst charClass = /[\\\"']/g;\nimport { real } from './lib/real.mjs';\nexport const y = real + String(stripQuote) + String(charClass);\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.mjs');
  });

  it('a REGEX after `=` (operand position) containing a quote is scanned correctly — the exact e2e-preflight.mjs shape', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.mjs'), 'export const real = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      'const hint = /EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:/.test(out)\n' +
        "  ? ' — the tarball smells like a workspace: dep'\n" +
        "  : '';\n" +
        "import { real } from './lib/real.mjs';\n" +
        'export const y = real + hint;\n',
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.mjs');
  });

  it('a DIVISION (not a regex) after an identifier is NOT misread as a regex start', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.mjs'), 'export const real = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "const half = total / 2;\nimport { real } from './lib/real.mjs';\nexport const y = real + half;\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.mjs');
  });

  // #1294 round 5 (jev 0.90, THE main finding) — `isRegexPosition` (the hand
  // tokenizer's regex/division heuristic) treated JS KEYWORDS the same as
  // identifiers/operands, so `return /'/.test(s)` misread the regex's `'` as
  // a STRING START exactly like the round-4 bug it was supposed to fix — a
  // `require()` right after it silently vanished, `directLocalDeps`
  // returning `[]` with NO error at all. A real parser has no such
  // ambiguity: `return` is a `ReturnStatement`, `/'/`  is unambiguously a
  // `RegularExpressionLiteral` regardless of what token precedes it.
  it('a regex after a KEYWORD (e.g. `return`) is not misread as a string, and the following require() is still caught', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "function checkIt(s) {\n  return /'/.test(s);\n}\nconst { real } = require('./lib/real.cjs');\nexport const y = real + checkIt('x');\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.cjs');
  });

  // #1294 round 5 (jev 0.90) — a NESTED template literal
  // (`` `${a ? `'` : ""}` ``) was never modelled by the hand tokenizer at
  // all: its inner backtick either terminated the outer template early or
  // confused the quote-tracking state, either way risking the SAME
  // silently-dropped-dependency failure for whatever followed. A real
  // parser treats the whole thing as one `TemplateExpression` node whose
  // substitution is itself a `ConditionalExpression` containing two nested
  // template literals — nesting depth is not special-cased, it falls out of
  // the grammar.
  it('a NESTED template literal does not corrupt scanning, and a following import() is still caught', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.mjs'), 'export const real = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      'const nested = `${true ? `\'` : ""}`;\n' +
        "export async function load() {\n  const { real } = await import('./lib/real.mjs');\n  return real + nested;\n}\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.mjs');
  });

  // #1294 round 5 — a require()/import() whose specifier is NOT a string
  // literal (a computed path) might be relative, and there is no static way
  // to know. Silently finding zero specs there — which `ts.isStringLiteralLike`
  // naturally would, by construction, if this weren't checked explicitly —
  // would reopen the "silently unfrozen dependency" failure mode one layer
  // up. This is a HARD ERROR, never a guess.
  it('require()/import() with a NON-LITERAL specifier is a hard error, not a silent skip', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "const dynamicPath = './lib/real.cjs';\nconst { real } = require(dynamicPath);\nexport const y = real;\n",
    );
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(/NON-LITERAL specifier/);
  });

  // The residual half of the above: `require.resolve(x)` is a RESOLVE call,
  // never a module load that adds a dependency to this closure, so a
  // non-literal argument to IT must NOT trip the fail-closed check —
  // `scripts/e2e-preflight.mjs`'s real `require.resolve(ADAPTER_SUBPATH)`
  // depends on this being true.
  it('require.resolve(x) with a non-literal argument does NOT trip the fail-closed check (it is not a module load)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "const SUBPATH = '@getknext/core/adapter';\nconst adapterPath = require.resolve(SUBPATH);\nconst { real } = require('./lib/real.cjs');\nexport const y = real + adapterPath;\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/real.cjs');
  });

  // #1316 — `createRequire`, an aliased `require`, and `module.require` were
  // all invisible to jsLocalImportSpecifiers: none of them is literally the
  // identifier `require` called directly, so a relative path reached through
  // any of them returned [] SILENTLY — the exact "silently unfrozen
  // dependency" failure mode #1294 round 5 closed for non-literal specifiers,
  // just reopened one idiom over.
  describe('aliased require / createRequire / module.require fail closed (#1316)', () => {
    it('a plain require() alias with a literal relative specifier is recognised and resolved (same base as require())', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const r = require;\nconst { real } = r('./lib/real.cjs');\nexport const y = real;\n",
      );
      const result = execFileSync(
        process.execPath,
        [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
      const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
      expect(harness).toContain('scripts/lib/real.cjs');
    });

    // An UNTRACKED alias — one this scanner's collect pass never bound to
    // `require`/`createRequire` — must still fail closed. `passthrough`
    // returns its argument unchanged at runtime, but that is not something a
    // static AST walk can know; treating it as safe would be exactly the
    // silent-omission failure mode this whole mechanism exists to close.
    it('an UNTRACKED require reference (e.g. passed through a function) is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "function passthrough(fn) { return fn; }\nconst r = passthrough(require);\nconst { real } = r('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `require` in a form this scanner does not track/,
      );
    });

    it('module.require(...) with a literal relative specifier is recognised and resolved (same base as require())', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const { real } = module.require('./lib/real.cjs');\nexport const y = real;\n",
      );
      const result = execFileSync(
        process.execPath,
        [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
      const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
      expect(harness).toContain('scripts/lib/real.cjs');
    });

    it('a createRequire()-derived function called with a relative-looking literal is a hard error (wrong resolution base)', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst { real } = req('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /createRequire\(\)-derived function with the relative-looking specifier/,
      );
    });

    it('createRequire() invoked inline (not bound to a tracked local) is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst { real } = createRequire(import.meta.url)('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /calls createRequire\(\).*without binding it to a tracked local/,
      );
    });

    it('a createRequire()-derived function used ONLY for .resolve() on a bare specifier does NOT trip fail-closed (the real scripts\\/e2e-preflight.mjs shape)', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst SUBPATH = '@getknext/core/adapter';\nconst adapterPath = req.resolve(SUBPATH);\nexport const y = adapterPath;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
    });

    it('a createRequire()-derived function called with a BARE (non-relative) specifier does NOT trip fail-closed', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst pkg = req('@getknext/core/adapter');\nexport const y = pkg;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
    });

    it('createRequire referenced but not called (e.g. passed around) is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nfunction wrap(fn) { return fn; }\nconst req = wrap(createRequire);\nexport const y = req;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `createRequire` in a form this scanner does not track/,
      );
    });

    it('a plain require() alias reaching a NON-relative (bare) specifier does NOT trip fail-closed', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const r = require;\nconst pkg = r('node:path');\nexport const y = pkg;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
    });

    // The real corpus case (scripts/e2e-preflight.mjs): `const require =
    // createRequire(...)` SHADOWS the global `require` name with a
    // createRequire-derived function. This must not itself be a hard error —
    // only a later CALL through it (already covered above) is.
    it('`const require = createRequire(...)` (shadowing the global name) is not itself a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst adapterPath = require.resolve('@getknext/core/adapter');\nexport const y = adapterPath;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).not.toThrow();
    });

    it('module.require(...) with a NON-literal specifier is a hard error, matching bare require()', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const dynamicPath = './lib/real.cjs';\nconst { real } = module.require(dynamicPath);\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(/NON-LITERAL specifier/);
    });

    // #1388 review round — four shapes that still returned [] silently.
    it('an ALIASED createRequire import (`import { createRequire as cr }`) reaching a relative path is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire as cr } from 'node:module';\nconst req = cr(import.meta.url);\nconst { real } = req('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /createRequire\(\)-derived function with the relative-looking specifier/,
      );
    });

    it('a TWO-LEVEL plain alias (`const a = require; const b = a;`) resolves the relative path it reaches — tracked, not dropped', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const a = require;\nconst b = a;\nconst { real } = b('./lib/real.cjs');\nexport const y = real;\n",
      );
      const result = execFileSync(
        process.execPath,
        [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
      const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
      // A two-hop plain alias still resolves relative to the FILE's OWN
      // directory (same base as bare `require()`) — no ambiguity, so it is
      // TRACKED, not a hard error, and the real dependency lands in the
      // harness rather than silently vanishing.
      expect(harness).toContain('scripts/lib/real.cjs');
    });

    // A single top-to-bottom AST walk happens to resolve a two-hop chain
    // DECLARED IN DEPENDENCY ORDER on its own (by the time `const b = a` is
    // visited, `a` was already added while visiting `const a = require`
    // earlier in the same walk) — so that shape alone does not prove the
    // FIXPOINT loop is load-bearing. A chain three hops deep, declared in
    // REVERSE dependency order, does: a single pass can only add `a` (the
    // one whose RHS is already tracked); `b`'s RHS (`a`) and `c`'s RHS (`b`)
    // are not yet tracked when the walk reaches them, so only a SECOND and
    // THIRD pass (the `while (grew)` loop) tracks `b` then `c`.
    it('a THREE-level alias chain declared in REVERSE order is still tracked (the fixpoint, not a single pass)', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts/lib/real.cjs'), 'module.exports = { real: 1 };\n');
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const c = b;\nconst b = a;\nconst a = require;\nconst { real } = c('./lib/real.cjs');\nexport const y = real;\n",
      );
      const result = execFileSync(
        process.execPath,
        [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
      const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
      expect(harness).toContain('scripts/lib/real.cjs');
    });

    it('a TWO-LEVEL alias where the second hop escapes tracking (`const a = require; const b = wrap(a);`) is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "function wrap(fn) { return fn; }\nconst a = require;\nconst b = wrap(a);\nconst { real } = b('./lib/real.cjs');\nexport const y = real;\n",
      );
      // `a` is passed to a function call, not aliased by a plain
      // `const X = <tracked-name>` reference — the fixpoint pass correctly
      // does NOT track `b`, so referencing `a` this way must itself fail
      // closed (an untracked way to get at a tracked name).
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `a` in a form this scanner does not track/,
      );
    });

    it('a two-level createRequire alias chain (`const a = cr; const b = a(u); b(x)`) with a relative-looking literal is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "import { createRequire } from 'node:module';\nconst a = createRequire;\nconst req = a(import.meta.url);\nconst { real } = req('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /createRequire\(\)-derived function with the relative-looking specifier/,
      );
    });

    it('require.call(null, "./x") — a property access other than .resolve/.cache — is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const { real } = require.call(null, './lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `require` in a form this scanner does not track/,
      );
    });

    it('an aliased require.call (`req.call(null, "./x")`) is a hard error', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const req = require;\nconst { real } = req.call(null, './lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `req` in a form this scanner does not track/,
      );
    });

    it('require.apply(null, ["./x"]) is a hard error too (not just .call)', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const { real } = require.apply(null, ['./lib/real.cjs']);\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /references `require` in a form this scanner does not track/,
      );
    });

    it('import.meta.require("./x") (Bun-specific) is UNCONDITIONALLY a hard error, even with a bare specifier', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const { real } = import.meta.require('node:path');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /import\.meta\.require\(\), a Bun-specific form/,
      );
    });

    it('import.meta.require("./x") with a relative-looking literal is also a hard error (same unconditional rule)', () => {
      const { repoRoot, tarballsDir } = makeFixture();
      writeFileSync(
        join(repoRoot, 'scripts/e2e-summary.mjs'),
        "const { real } = import.meta.require('./lib/real.cjs');\nexport const y = real;\n",
      );
      expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(
        /import\.meta\.require\(\), a Bun-specific form/,
      );
    });
  });

  // Fail CLOSED: a file that does not PARSE at all (an unterminated regex or
  // string literal, among other syntax errors) is a hard error — refusing
  // to scan a recovered-but-possibly-wrong best-effort AST — rather than a
  // silent guess. `ts.createSourceFile` is deliberately ERROR-TOLERANT (it
  // powers editor tooling, which must produce SOME AST for a file mid-edit),
  // so this checks `ts.transpileModule`'s syntax diagnostics FIRST and
  // throws before ever walking the recovered tree.
  it('an unterminated regex-looking construct is a hard error (the file does not parse)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      "const bad = /unterminated\nimport { x } from './does-not-matter.mjs';\n",
    );
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(/does not parse as JavaScript/);
  });

  it('an unterminated string literal is a hard error (the file does not parse)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    writeFileSync(
      join(repoRoot, 'scripts/e2e-summary.mjs'),
      'const bad = "unterminated\nexport const y = 1;\n',
    );
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow(/does not parse as JavaScript/);
  });

  it('names BOTH scripts/lib/e2e-state-snapshot.sh (sourced) and scripts/lib/knext-closure.mjs (imported, no e2e- prefix) in the real repo harness (node lane)', () => {
    const tarballsDir = tempDir('knext-fp-lib-real-');
    packFixtureTarball(tarballsDir, 'core', '0.3.0');
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', REPO_ROOT, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/e2e-state-snapshot.sh');
    expect(harness).toContain('scripts/lib/knext-closure.mjs');
    expect(harness).toContain('scripts/lib/workspace-protocol.mjs');
  });
});

/**
 * #1294 round 3 — the DECLARED `extraFiles` (files a lane EXECUTES via
 * subprocess or READS directly, not `import`ed/`source`d) must actually land
 * in the frozen harness. `scripts/compat-credential-ref.mjs` and
 * `.github/compat-credential-ref.json` run/are-read only on the node/bun
 * (turbopack) lanes' credential-ref job; `scripts/compat-run-ledger.mjs` runs
 * on every lane that has a workflow wired at all.
 */
describe('compat-window fingerprint — declared credential-run extraFiles land in the harness (#1294 round 3)', () => {
  function harnessFor(lane: string): string[] {
    const tarballsDir = tempDir('knext-fp-extra-');
    packFixtureTarball(tarballsDir, 'core', '0.3.0');
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--repo-root',
        REPO_ROOT,
        '--tarballs-dir',
        tarballsDir,
        '--lane',
        lane,
        '--json',
        '--files',
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { files: { component: string; path: string }[] };
    return parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
  }

  it('node lane: compat-credential-ref.mjs, the RC pin JSON, and compat-run-ledger.mjs are all in the harness', () => {
    const harness = harnessFor('node');
    expect(harness).toContain('scripts/compat-credential-ref.mjs');
    expect(harness).toContain('scripts/compat-run-ledger.mjs');
    expect(harness).toContain('.github/compat-credential-ref.json');
    // … and NOT here: the vinext quarantine ledger (#1321) must never move
    // the node lanes' fingerprints (it would reset their 14-night windows).
    expect(harness).not.toContain('scripts/compat-vinext-ledger.mjs');
    expect(harness).not.toContain('test/compat-vinext-ledger.json');
  });

  it('bun lane: same declared extras as node (both run the credential-ref job)', () => {
    const harness = harnessFor('bun');
    expect(harness).toContain('scripts/compat-credential-ref.mjs');
    expect(harness).toContain('.github/compat-credential-ref.json');
  });

  it('bun-vinext lane: compat-run-ledger.mjs is frozen, and so is compat-credential-ref.mjs — TRANSITIVELY, via run-ledger.mjs importing it (#1294 round 4), even though this lane never runs the credential-ref RESOLUTION step directly', () => {
    const harness = harnessFor('bun-vinext');
    expect(harness).toContain('scripts/compat-run-ledger.mjs');
    // Round 4: compat-run-ledger.mjs imports `./compat-credential-ref.mjs`
    // (for COMPAT_MODES / isRcRef), so it is a REAL dependency of a file
    // this lane genuinely runs — freezing it is correct, not accidental
    // over-inclusion. bun-vinext still does NOT declare it directly in
    // CREDENTIAL_CELLS.extraFiles (it never runs the resolve step), which is
    // what the RC pin JSON assertion below distinguishes.
    expect(harness).toContain('scripts/compat-credential-ref.mjs');
    // The RC pin JSON is read only by the resolve step this lane never runs,
    // and nothing imports a JSON file, so it stays correctly absent.
    expect(harness).not.toContain('.github/compat-credential-ref.json');
    // #1321: the quarantine ledger reclassifies THIS cell's results, so the
    // script and the ledger it reads are frozen here …
    expect(harness).toContain('scripts/compat-vinext-ledger.mjs');
    expect(harness).toContain('test/compat-vinext-ledger.json');
  });

  it('editing compat-credential-ref.mjs moves the node-lane fingerprint (it is genuinely frozen, not just listed)', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    writeFileSync(join(repoRoot, 'scripts/compat-credential-ref.mjs'), 'export const noop = 2;\n');
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  it('a lane whose declared extraFiles entry is missing from disk is a hard error', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    rmSync(join(repoRoot, 'scripts/compat-credential-ref.mjs'));
    expect(() => fingerprint(repoRoot, tarballsDir)).toThrow();
  });

  // #1294 round 4 (jev 0.75, the main finding): a declared extra's OWN
  // imports were never followed — `compat-run-ledger.mjs` imports
  // `./compat-credential-ref.mjs`, and that import was invisible to the
  // digest on a lane that declares run-ledger.mjs but not credential-ref.mjs
  // directly (bun-vinext). Extras now feed into the SAME closure walk as
  // every other entry point, so this is fixed for every lane, not just the
  // one example that surfaced it.
  it('an extraFiles entry that itself IMPORTS another file freezes that file too', () => {
    const { repoRoot, tarballsDir } = makeFixture();
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/lib/extra-dep.mjs'), 'export const v = 1;\n');
    writeFileSync(
      join(repoRoot, 'scripts/compat-run-ledger.mjs'),
      "import { v } from './lib/extra-dep.mjs';\nexport const noop = v;\n",
    );
    const result = execFileSync(
      process.execPath,
      [SCRIPT, '--repo-root', repoRoot, '--tarballs-dir', tarballsDir, '--json', '--files'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/lib/extra-dep.mjs');

    // And it is GENUINELY frozen, not just present: editing the transitive
    // dependency moves the digest.
    const before = fingerprint(repoRoot, tarballsDir).fingerprint;
    writeFileSync(join(repoRoot, 'scripts/lib/extra-dep.mjs'), 'export const v = 2;\n');
    expect(fingerprint(repoRoot, tarballsDir).fingerprint).not.toBe(before);
  });

  it('names the real scripts/compat-credential-ref.mjs in the bun-vinext harness — the exact round-4 gap, on the real repo', () => {
    const tarballsDir = tempDir('knext-fp-extra-transitive-');
    packFixtureTarball(tarballsDir, 'core', '0.3.0');
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--repo-root',
        REPO_ROOT,
        '--tarballs-dir',
        tarballsDir,
        '--lane',
        'bun-vinext',
        '--json',
        '--files',
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { files: { component: string; path: string }[] };
    const harness = parsed.files.filter((f) => f.component === 'harness').map((f) => f.path);
    expect(harness).toContain('scripts/compat-credential-ref.mjs');
  });
});

/**
 * #1294 round 2 — SCANNING TEST, INDEPENDENTLY REIMPLEMENTED: every file a
 * top-level `scripts/e2e-*` entry script reaches via shell `source`/`. ` OR a
 * JS `import`/`require`/`import()`, TRANSITIVELY, must be present in the
 * frozen harness set. Deliberately does NOT call into
 * `directLocalDeps`/`closureFrom` from `compat-window-fingerprint.mjs` — a
 * scan that shares its own implementation with the thing it is checking would
 * go green the same way the thing it checks is wrong. It reads the REAL
 * `scripts/e2e-*` sources with its own parser and cross-checks the reachable
 * set against what `computeFingerprint` actually swept in, for BOTH lane
 * families (node/bun → test-e2e-deploy.yml, bun-vinext → compat-vinext.yml —
 * the entry-point set itself does not vary by lane, only the workflow entry
 * does). A referenced file the closure misses — a shell `source`, OR a `.mjs`
 * `import` with no `e2e-` prefix, at any depth — goes RED here.
 */
describe('compat-window fingerprint — scanning: every file an e2e-* entry script reaches (source OR import) is in the harness', () => {
  /** Direct local (`./…`) dependencies of one file — shell `source`/`.` and JS import/require/import(). */
  function directDeps(absPath: string): string[] {
    const src = readFileSync(absPath, 'utf8');
    const dir = dirname(absPath);
    const specs = new Set<string>();
    if (/\.(mjs|cjs|js)$/.test(absPath)) {
      for (const re of [
        /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g,
        /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
        /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
        /^\s*import\s+['"](\.\.?\/[^'"]+)['"]/gm,
      ]) {
        for (const m of src.matchAll(re)) specs.add(m[1]);
      }
    } else {
      for (const re of [
        /^\s*\.\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
        /^\s*source\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
      ]) {
        for (const m of src.matchAll(re)) specs.add(`./${m[1]}`);
      }
    }
    const resolved: string[] = [];
    for (const spec of specs) {
      const base = resolve(dir, spec);
      const candidates = /\.[a-z]+$/.test(spec)
        ? [base]
        : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`];
      const hit = candidates.find((c) => existsSync(c));
      if (hit) resolved.push(hit);
    }
    return resolved;
  }

  /** Full transitive closure, repo-relative paths, of the given entry files. */
  function closure(entryAbsPaths: string[]): string[] {
    const seen = new Set(entryAbsPaths);
    const queue = [...entryAbsPaths];
    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: queue.length checked above
      const current = queue.shift()!;
      for (const dep of directDeps(current)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    return [...seen].map((abs) => relative(REPO_ROOT, abs)).sort();
  }

  const ENTRY_SCRIPTS = readdirSync(resolve(REPO_ROOT, 'scripts')).filter((f) =>
    /^e2e-[^/]*\.(sh|mjs|cjs|js)$/.test(f),
  );

  it('the real scripts/e2e-* entry set is non-empty and reaches at least one file outside itself, so this scan is not vacuous', () => {
    expect(ENTRY_SCRIPTS.length).toBeGreaterThan(0);
    const reached = closure(ENTRY_SCRIPTS.map((f) => resolve(REPO_ROOT, 'scripts', f)));
    expect(reached.length).toBeGreaterThan(ENTRY_SCRIPTS.length);
  });

  it('the reachable closure includes a SOURCED shell helper AND an IMPORTED .mjs helper with no e2e- prefix', () => {
    const reached = closure(ENTRY_SCRIPTS.map((f) => resolve(REPO_ROOT, 'scripts', f)));
    expect(reached).toContain('scripts/lib/e2e-state-snapshot.sh');
    expect(reached).toContain('scripts/lib/knext-closure.mjs');
  });

  for (const [lane, workflowFile] of [
    ['node', 'test-e2e-deploy.yml'],
    ['bun', 'test-e2e-deploy.yml'],
    ['bun-vinext', 'compat-vinext.yml'],
  ] as const) {
    it(`lane "${lane}" (${workflowFile}): every file reachable from the entry scripts is in the frozen harness`, () => {
      const reached = closure(ENTRY_SCRIPTS.map((f) => resolve(REPO_ROOT, 'scripts', f)));

      const tarballsDir = tempDir('knext-fp-scan-');
      packFixtureTarball(tarballsDir, 'core', '0.3.0');
      const out = execFileSync(
        process.execPath,
        [
          SCRIPT,
          '--repo-root',
          REPO_ROOT,
          '--tarballs-dir',
          tarballsDir,
          '--lane',
          lane,
          '--json',
          '--files',
        ],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(out) as { files: { component: string; path: string }[] };
      const harness = new Set(
        parsed.files.filter((f) => f.component === 'harness').map((f) => f.path),
      );

      for (const path of reached) {
        expect(
          harness.has(path),
          `reachable from an e2e-* entry script, missing from lane "${lane}"'s harness: ${path}`,
        ).toBe(true);
      }
    });
  }
});
