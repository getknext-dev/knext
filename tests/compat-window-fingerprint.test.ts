import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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
  execFileSync('tar', [
    'czf',
    join(destDir, `getknext-${name}-${version}.tgz`),
    '-C',
    stage,
    'package',
  ]);
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
  });
});

describe('compat-window fingerprint — wired into the scheduled run', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('the workflow computes the fingerprint from the SAME packed tarballs the shards use', () => {
    expect(workflow).toContain('scripts/compat-window-fingerprint.mjs');
    const step = workflow.slice(workflow.indexOf('scripts/compat-window-fingerprint.mjs'));
    expect(step).toContain('knext-tarballs');
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
});
