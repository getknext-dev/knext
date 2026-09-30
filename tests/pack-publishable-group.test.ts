import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalPublishableGroup,
  npmPackOne,
  packPublishableGroup,
  readPackManifest,
  sha256File,
  tarballDriftProblems,
} from '../scripts/lib/pack-publishable-group.mjs';

/**
 * #1614/#1616 — the shared packer. `rewriteWorkspaceRanges` is deliberately
 * NOT exercised here: it shells to the real `scripts/rewrite-workspace-ranges.mjs`,
 * which resolves its OWN repo root from the script's file location regardless
 * of the `cwd` passed to it (by design — every real call site here runs it
 * against the checkout it lives in, never a synthetic fixture), so invoking
 * it in a test would mutate this repo's actual `package.json` files on disk.
 * `rewrite-workspace-ranges.mjs` already carries its own unit tests for the
 * pure rewrite logic; every test below packs with `{ rewrite: false }` to
 * isolate the packing behaviour from that side effect.
 */

function mkFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

/** A minimal, real, packable npm package directory — no workspace: deps. */
function writeFixturePackage(
  dir: string,
  name: string,
  version: string,
  extraFiles: Record<string, string> = {},
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, files: ['index.js', ...Object.keys(extraFiles)] }, null, 2),
  );
  writeFileSync(join(dir, 'index.js'), `module.exports = ${JSON.stringify(name)};\n`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, rel), content);
  }
}

describe('npmPackOne', () => {
  it('packs a real package with `npm pack` and returns the single produced tarball', () => {
    const pkgDir = mkFixtureDir('ppg-pkg-');
    const destDir = mkFixtureDir('ppg-dest-');
    writeFixturePackage(pkgDir, 'ppg-fixture-a', '1.0.0');

    const tgz = npmPackOne(pkgDir, destDir);

    expect(existsSync(tgz)).toBe(true);
    expect(tgz.endsWith('.tgz')).toBe(true);
    expect(readdirSync(destDir).filter((f) => f.endsWith('.tgz'))).toHaveLength(1);

    const out = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('package/index.js');
    expect(out.stdout).toContain('package/package.json');

    rmSync(pkgDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it('resolves a RELATIVE destDir against the caller, not the package dir (release.yml passes `--dest release-tarballs`)', () => {
    // npm resolves --pack-destination against ITS cwd (the package dir); a
    // relative destDir used to land in <pkgDir>/release-tarballs, which did
    // not exist, so the first real release run after the single-pack change
    // died with ENOENT and published nothing.
    // realpath: macOS tmpdir() is a symlink (/var → /private/var); the child's
    // process.cwd() reports the resolved path.
    const callerCwd = realpathSync(mkFixtureDir('ppg-caller-'));
    const pkgDir = mkFixtureDir('ppg-rel-pkg-');
    writeFixturePackage(pkgDir, 'ppg-fixture-rel', '1.0.0');
    const modUrl = new URL('../scripts/lib/pack-publishable-group.mjs', import.meta.url).href;
    const r = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(modUrl)}); console.log(m.npmPackOne(${JSON.stringify(pkgDir)}, 'rel-dest'));`,
      ],
      { cwd: callerCwd, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const tgz = r.stdout.trim().split('\n').at(-1) ?? '';
    expect(tgz.startsWith(join(callerCwd, 'rel-dest'))).toBe(true);
    expect(existsSync(tgz)).toBe(true);
    expect(existsSync(join(pkgDir, 'rel-dest'))).toBe(false);
  });

  it('never emits a duplicate tar entry for a multi-`bin`-key target (the bun-pm-pack #1562 bug)', () => {
    // The measured bug: bun pm pack adds a bin target once PER bin key without
    // de-duplicating, so a package whose two bin names point at the same file
    // (the real @getknext/core shape: `knext` + `kn-next` -> the same JS file)
    // gets that file packed twice. `npm pack` must emit it exactly once.
    const pkgDir = mkFixtureDir('ppg-pkg-bin-');
    const destDir = mkFixtureDir('ppg-dest-bin-');
    mkdirSync(join(pkgDir, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'cli', 'shared.js'), '#!/usr/bin/env node\n');
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: 'ppg-fixture-bin',
          version: '1.0.0',
          bin: { 'name-a': 'dist/cli/shared.js', 'name-b': 'dist/cli/shared.js' },
          files: ['dist'],
        },
        null,
        2,
      ),
    );

    const tgz = npmPackOne(pkgDir, destDir);
    const out = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const occurrences = out.stdout
      .split('\n')
      .filter((line) => line.trim() === 'package/dist/cli/shared.js');
    expect(occurrences).toHaveLength(1);

    rmSync(pkgDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it('FAILS CLOSED when packing the same unbumped package twice produces no NEW tarball', () => {
    const pkgDir = mkFixtureDir('ppg-pkg-repeat-');
    const destDir = mkFixtureDir('ppg-dest-repeat-');
    writeFixturePackage(pkgDir, 'ppg-fixture-repeat', '1.0.0');

    npmPackOne(pkgDir, destDir); // first pack succeeds and seeds destDir
    expect(() => npmPackOne(pkgDir, destDir)).toThrow(/produced 0 new tarball/);

    rmSync(pkgDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });
});

describe('sha256File', () => {
  it('is deterministic and content-sensitive', () => {
    const dir = mkFixtureDir('ppg-sha-');
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'same content');
    writeFileSync(b, 'same content');
    expect(sha256File(a)).toBe(sha256File(b));
    writeFileSync(b, 'different content');
    expect(sha256File(a)).not.toBe(sha256File(b));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('packPublishableGroup', () => {
  it('packs every member into destDir and returns name/dir/tarball/sha256 for each', () => {
    const destDir = mkFixtureDir('ppg-group-dest-');
    const dirA = mkFixtureDir('ppg-group-a-');
    const dirB = mkFixtureDir('ppg-group-b-');
    writeFixturePackage(dirA, 'ppg-group-fixture-a', '2.0.0');
    writeFixturePackage(dirB, 'ppg-group-fixture-b', '2.0.0');

    const packed = packPublishableGroup(
      [
        { name: 'ppg-group-fixture-a', dir: dirA },
        { name: 'ppg-group-fixture-b', dir: dirB },
      ],
      destDir,
      { rewrite: false },
    );

    expect(packed).toHaveLength(2);
    expect(packed.map((p) => p.name)).toEqual(['ppg-group-fixture-a', 'ppg-group-fixture-b']);
    for (const p of packed) {
      expect(existsSync(p.tarball)).toBe(true);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256File(p.tarball)).toBe(p.sha256);
    }
    expect(readdirSync(destDir).filter((f) => f.endsWith('.tgz'))).toHaveLength(2);

    rmSync(destDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

describe('canonicalPublishableGroup', () => {
  it('resolves the real 4-member @getknext/* fixed group from this repo, in build order', () => {
    const repoRoot = join(import.meta.dir, '..');
    const group = canonicalPublishableGroup(repoRoot);
    expect(group.map((p) => p.name)).toEqual([
      '@getknext/lib',
      '@getknext/db',
      '@getknext/core',
      'kn-next',
    ]);
    for (const p of group) expect(existsSync(p.dir)).toBe(true);
  });

  it('omits a member whose directory does not exist at the given repoRoot (e.g. an older ref)', () => {
    const fakeRoot = mkFixtureDir('ppg-canon-fake-root-');
    mkdirSync(join(fakeRoot, 'packages', 'lib'), { recursive: true });
    const group = canonicalPublishableGroup(fakeRoot);
    expect(group.map((p) => p.name)).toEqual(['@getknext/lib']);
    rmSync(fakeRoot, { recursive: true, force: true });
  });
});

describe('readPackManifest', () => {
  it('reads a well-formed manifest.json', () => {
    const dir = mkFixtureDir('ppg-manifest-');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ packedAt: '2026-09-29T00:00:00.000Z', gitSha: 'abc123', packages: [] }),
    );
    const manifest = readPackManifest(dir);
    expect(manifest.gitSha).toBe('abc123');
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAILS CLOSED when manifest.json is missing — never reads as "nothing to compare"', () => {
    const dir = mkFixtureDir('ppg-manifest-missing-');
    expect(() => readPackManifest(dir)).toThrow(/no manifest\.json found/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAILS CLOSED when manifest.json has no "packages" array', () => {
    const dir = mkFixtureDir('ppg-manifest-malformed-');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ gitSha: 'abc' }));
    expect(() => readPackManifest(dir)).toThrow(/no "packages" array/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tarballDriftProblems — the #1616 pre-publish drift check', () => {
  const manifest = {
    packages: [
      { name: '@getknext/lib', sha256: 'aaa' },
      { name: '@getknext/core', sha256: 'ccc' },
    ],
  };

  it('is clean when every fresh sha256 matches the pack-once manifest', () => {
    const fresh = new Map([
      ['@getknext/lib', 'aaa'],
      ['@getknext/core', 'ccc'],
    ]);
    expect(tarballDriftProblems(fresh, manifest)).toEqual([]);
  });

  it('flags a package whose fresh sha256 differs from the manifest (real drift)', () => {
    const fresh = new Map([
      ['@getknext/lib', 'aaa'],
      ['@getknext/core', 'DIFFERENT'],
    ]);
    const problems = tarballDriftProblems(fresh, manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@getknext/core');
    expect(problems[0]).toContain('DRIFT');
  });

  it('flags a package present fresh but absent from the manifest', () => {
    const fresh = new Map([
      ['@getknext/lib', 'aaa'],
      ['@getknext/core', 'ccc'],
      ['@getknext/db', 'ddd'],
    ]);
    const problems = tarballDriftProblems(fresh, manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@getknext/db');
    expect(problems[0]).toContain('not present in the pack-once manifest');
  });

  it('flags a package present in the manifest but missing from the fresh pack (partial re-pack)', () => {
    const fresh = new Map([['@getknext/lib', 'aaa']]);
    const problems = tarballDriftProblems(fresh, manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@getknext/core');
    expect(problems[0]).toContain('missing from the fresh pack');
  });
});
