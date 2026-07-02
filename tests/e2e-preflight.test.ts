import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Behavioral tests for scripts/e2e-preflight.mjs — the fail-fast gate #147 A3-3
 * fix round 1 adds after the tarball-packaging bug (triage run 28558576615)
 * burned a full 16-shard compat run: the packed @knext/core tarball shipped a
 * raw `workspace:^` dep, EVERY fixture `npm install` failed with
 * EUNSUPPORTEDPROTOCOL, and 472/473 failures were that ONE bug. The gate that
 * SHOULD have existed: right after packing, npm-install both tarballs into a
 * scratch dir (real dependency resolution) and resolve the adapter subpath —
 * `::error::` + exit 1 on any failure.
 *
 * These tests exercise the REAL gate against real `npm pack`ed fixture tarballs
 * (tiny local packages — no registry access needed): a good pair PASSES, a
 * workspace:^-poisoned core FAILS with the cause named, and a missing tarball
 * FAILS fast. Also unit-tests the shared pure helper the gate + install-smoke
 * use to name workspace:-protocol leaks directly from a manifest.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = resolve(REPO_ROOT, 'scripts/e2e-preflight.mjs');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Build + `npm pack` a tiny fixture package; returns nothing (tarball lands in dest). */
function packFixture(
  dest: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const src = tempDir('knext-preflight-fixture-');
  writeFileSync(join(src, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(src, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('npm', ['pack', '--silent', '--pack-destination', dest], {
    cwd: src,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A minimal @knext/lib fixture tarball (real npm package, no deps). */
function packFixtureLib(dest: string): void {
  packFixture(
    dest,
    { name: '@knext/lib', version: '0.1.0', main: 'index.js' },
    { 'index.js': 'module.exports = { lib: true };\n' },
  );
}

/** A minimal @knext/core fixture with an `./adapter` export; dep spec injectable. */
function packFixtureCore(dest: string, libSpec: string): void {
  packFixture(
    dest,
    {
      name: '@knext/core',
      version: '0.1.0',
      exports: { '.': './index.js', './adapter': './adapter.js' },
      dependencies: { '@knext/lib': libSpec },
    },
    {
      'index.js': 'module.exports = {};\n',
      'adapter.js': "module.exports = { name: 'knext-fixture-adapter' };\n",
    },
  );
}

function runPreflight(tarballsDir: string) {
  return spawnSync('node', [PREFLIGHT, '--tarballs-dir', tarballsDir], {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('scripts/e2e-preflight.mjs — fail-fast adapter-tarball gate (#147 fix round 1)', () => {
  it('PASSES for an installable lib+core tarball pair (real npm install + adapter resolve)', () => {
    const dir = tempDir('knext-tarballs-good-');
    packFixtureLib(dir);
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight should pass, output:\n${out}`).toBe(0);
    expect(out).toMatch(/@knext\/core\/adapter/);
  });

  it('FAILS with ::error:: when the core tarball still ships a raw workspace:^ dep (the 472-failure bug)', () => {
    const dir = tempDir('knext-tarballs-workspace-');
    packFixtureLib(dir);
    packFixtureCore(dir, 'workspace:^');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight must fail, output:\n${out}`).toBe(1);
    expect(out).toMatch(/::error::/);
    // The failure must NAME the cause so the next triage is instant.
    expect(out).toMatch(/workspace:/);
  });

  it('FAILS fast with ::error:: when a tarball is missing entirely', () => {
    const dir = tempDir('knext-tarballs-missing-');
    packFixtureLib(dir); // lib only — no core tarball
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).toBe(1);
    expect(out).toMatch(/::error::/);
    expect(out).toMatch(/knext-core/);
  });

  it('leaves no tarball behind unvetted: the good-pair run actually installed into a scratch dir (adapter resolves to real JS)', () => {
    const dir = tempDir('knext-tarballs-good2-');
    packFixtureLib(dir);
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    expect(r.status).toBe(0);
    // The gate reports the resolved adapter path; it must be a .js file, not .ts.
    expect(`${r.stdout}`).toMatch(/adapter\.js/);
    // And the tarballs dir itself is untouched (still exactly the two fixtures).
    expect(readdirSync(dir).filter((f) => f.endsWith('.tgz')).length).toBe(2);
  });
});

describe('scripts/lib/workspace-protocol.mjs — pure manifest guard (#147 fix round 1)', () => {
  it('names every workspace:-protocol dependency across all dependency fields', async () => {
    const { findWorkspaceProtocolDeps } = await import('../scripts/lib/workspace-protocol.mjs');
    const hits = findWorkspaceProtocolDeps({
      name: '@knext/core',
      dependencies: { '@knext/lib': 'workspace:^', ioredis: '^5.9.2' },
      devDependencies: { '@knext/tools': 'workspace:*' },
      optionalDependencies: { '@knext/opt': 'workspace:~' },
      peerDependencies: { next: '>=16' },
    });
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'dependencies', name: '@knext/lib', spec: 'workspace:^' }),
        expect.objectContaining({ field: 'devDependencies', name: '@knext/tools' }),
        expect.objectContaining({ field: 'optionalDependencies', name: '@knext/opt' }),
      ]),
    );
    expect(hits).toHaveLength(3);
  });

  it('returns an empty list for a clean (publishable) manifest', async () => {
    const { findWorkspaceProtocolDeps } = await import('../scripts/lib/workspace-protocol.mjs');
    expect(
      findWorkspaceProtocolDeps({
        name: '@knext/core',
        dependencies: { '@knext/lib': '^0.1.0' },
      }),
    ).toEqual([]);
  });
});
