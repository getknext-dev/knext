import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parseArgs, resolveGroup } from '../scripts/pack-release-tarballs.mjs';

/**
 * #1614/#1616 — the `pack` job's CLI. Only the pure argument/manifest helpers
 * are unit-tested here; `main()`'s real pack (via `packPublishableGroup`) is
 * exercised end-to-end by `tests/pack-publishable-group.test.ts` and by the
 * live `release.yml` `pack` job itself.
 */

describe('parseArgs', () => {
  it('requires --dest', () => {
    expect(() => parseArgs([])).toThrow(/--dest/);
  });

  it('accepts --dest alone (canonical group)', () => {
    expect(parseArgs(['--dest', '/tmp/x'])).toEqual({ dest: '/tmp/x', dirs: null, manifest: null });
  });

  it('accepts --dest, --dirs and --manifest together', () => {
    expect(
      parseArgs([
        '--dest',
        '/tmp/x',
        '--dirs',
        'packages/lib,packages/db',
        '--manifest',
        '/tmp/m.json',
      ]),
    ).toEqual({ dest: '/tmp/x', dirs: 'packages/lib,packages/db', manifest: '/tmp/m.json' });
  });

  it('rejects an unrecognized argument', () => {
    expect(() => parseArgs(['--dest', '/tmp/x', '--bogus'])).toThrow(/unrecognized argument/);
  });
});

describe('resolveGroup', () => {
  it('resolves the canonical 4-member group when --dirs is omitted', () => {
    const repoRoot = join(import.meta.dir, '..');
    const group = resolveGroup(null, repoRoot);
    expect(group.map((p) => p.name)).toEqual([
      '@getknext/lib',
      '@getknext/db',
      '@getknext/core',
      'kn-next',
    ]);
  });

  it('resolves a --dirs subset by reading each package.json name from disk', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'prt-resolve-root-'));
    mkdirSync(join(repoRoot, 'packages', 'a'), { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'b'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'fixture-a', version: '1.0.0' }),
    );
    writeFileSync(
      join(repoRoot, 'packages', 'b', 'package.json'),
      JSON.stringify({ name: 'fixture-b', version: '1.0.0' }),
    );
    const group = resolveGroup('packages/a,packages/b', repoRoot);
    expect(group).toEqual([
      { name: 'fixture-a', dir: join(repoRoot, 'packages', 'a') },
      { name: 'fixture-b', dir: join(repoRoot, 'packages', 'b') },
    ]);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('FAILS CLOSED when a --dirs entry package.json has no "name"', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'prt-resolve-noname-'));
    mkdirSync(join(repoRoot, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'packages', 'a', 'package.json'),
      JSON.stringify({ version: '1.0.0' }),
    );
    expect(() => resolveGroup('packages/a', repoRoot)).toThrow(/no "name"/);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe('buildManifest', () => {
  it('records name/tarball/sha256 per packed member and a resolvable git sha', () => {
    const repoRoot = join(import.meta.dir, '..'); // a real git repo
    const packed = [
      { name: 'fixture-a', dir: '/x/a', tarball: '/dest/fixture-a-1.0.0.tgz', sha256: 'aaa' },
      { name: 'fixture-b', dir: '/x/b', tarball: '/dest/fixture-b-1.0.0.tgz', sha256: 'bbb' },
    ];
    const manifest = buildManifest(packed, repoRoot);
    expect(manifest.packages).toEqual([
      { name: 'fixture-a', tarball: 'fixture-a-1.0.0.tgz', sha256: 'aaa' },
      { name: 'fixture-b', tarball: 'fixture-b-1.0.0.tgz', sha256: 'bbb' },
    ]);
    expect(manifest.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(manifest.packedAt).toString()).not.toBe('Invalid Date');
  });

  it('degrades gitSha to "unknown" rather than throwing outside a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'prt-nongit-'));
    const manifest = buildManifest([], nonRepo);
    expect(manifest.gitSha).toBe('unknown');
    rmSync(nonRepo, { recursive: true, force: true });
  });
});
