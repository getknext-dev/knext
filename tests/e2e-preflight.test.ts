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

/**
 * A minimal @knext/db fixture with the `./migrate` subpath (the exact module
 * `kn-next db migrate` dynamically imports); dep spec injectable.
 */
function packFixtureDb(dest: string, libSpec = '^0.1.0'): void {
  packFixture(
    dest,
    {
      name: '@knext/db',
      version: '0.1.0',
      exports: { '.': './index.js', './migrate': './migrate.js' },
      dependencies: { '@knext/lib': libSpec },
    },
    {
      'index.js': 'module.exports = { db: true };\n',
      'migrate.js': 'module.exports = { runMigrations: async () => ({ applied: 0 }) };\n',
    },
  );
}

/** A minimal @knext/core fixture with an `./adapter` export; dep specs injectable. */
function packFixtureCore(dest: string, libSpec: string, dbSpec = '^0.1.0'): void {
  packFixture(
    dest,
    {
      name: '@knext/core',
      version: '0.1.0',
      exports: { '.': './index.js', './adapter': './adapter.js' },
      dependencies: { '@knext/lib': libSpec, '@knext/db': dbSpec },
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

describe('scripts/e2e-preflight.mjs — fail-fast adapter-tarball gate (#147 fix round 1, #255/#256 db)', () => {
  it('PASSES for an installable lib+db+core tarball trio (real npm install + adapter resolve + db/migrate probe)', () => {
    const dir = tempDir('knext-tarballs-good-');
    packFixtureLib(dir);
    packFixtureDb(dir);
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight should pass, output:\n${out}`).toBe(0);
    expect(out).toMatch(/@knext\/core\/adapter/);
    // The db probe must exercise the EXACT dynamic import `kn-next db migrate`
    // performs (db-migrate.ts: `await import("@knext/db/migrate")`).
    expect(out).toMatch(/@knext\/db\/migrate/);
  }, 180_000);

  it('FAILS with ::error:: when the core tarball still ships a raw workspace:^ dep (the 472-failure bug)', () => {
    const dir = tempDir('knext-tarballs-workspace-');
    packFixtureLib(dir);
    packFixtureDb(dir);
    packFixtureCore(dir, 'workspace:^');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight must fail, output:\n${out}`).toBe(1);
    expect(out).toMatch(/::error::/);
    // The failure must NAME the cause so the next triage is instant.
    expect(out).toMatch(/workspace:/);
  }, 180_000);

  it('FAILS with ::error:: when the db tarball ships a raw workspace: dep (manifest inspection covers ALL THREE)', () => {
    const dir = tempDir('knext-tarballs-db-workspace-');
    packFixtureLib(dir);
    packFixtureDb(dir, 'workspace:^');
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight must fail, output:\n${out}`).toBe(1);
    expect(out).toMatch(/::error::/);
    expect(out).toMatch(/workspace:/);
  }, 180_000);

  it('FAILS fast with ::error:: when a tarball is missing entirely', () => {
    const dir = tempDir('knext-tarballs-missing-');
    packFixtureLib(dir); // lib only — no db or core tarball
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).toBe(1);
    expect(out).toMatch(/::error::/);
  }, 180_000);

  it('FAILS fast with the cause NAMED when only the db tarball is missing (the #255/#256 incident shape)', () => {
    // Runs 29182334221/29184529993: lib+core packed, @knext/db not — every
    // downstream npm install 404'd on the unpublished `@knext/db@^0.1.0`.
    // The gate must catch the missing tarball BEFORE any npm install runs.
    const dir = tempDir('knext-tarballs-no-db-');
    packFixtureLib(dir);
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight must fail, output:\n${out}`).toBe(1);
    expect(out).toMatch(/::error::/);
    expect(out).toMatch(/knext-db/);
  }, 180_000);

  it('leaves no tarball behind unvetted: the good-trio run actually installed into a scratch dir (adapter resolves to real JS)', () => {
    const dir = tempDir('knext-tarballs-good2-');
    packFixtureLib(dir);
    packFixtureDb(dir);
    packFixtureCore(dir, '^0.1.0');
    const r = runPreflight(dir);
    expect(r.status).toBe(0);
    // The gate reports the resolved adapter path; it must be a .js file, not .ts.
    expect(`${r.stdout}`).toMatch(/adapter\.js/);
    // And the tarballs dir itself is untouched (still exactly the three fixtures).
    expect(readdirSync(dir).filter((f) => f.endsWith('.tgz')).length).toBe(3);
  }, 180_000);
});

describe('scripts/lib/knext-closure.mjs — dependency-graph-derived tarball set + local-origin guard (#255/#256)', () => {
  // WHY not a hardcoded 3-list: pnpm pack rewrites `workspace:^` → `^x.y.z`, so a
  // FOURTH @knext/* workspace dep added later never trips the workspace-spec
  // check — and since the @knext scope is not ours on npmjs yet (#53), a squatted
  // package could satisfy the install SILENTLY (dependency confusion). The
  // required tarball set is derived from @knext/core's @knext/* dependency
  // closure, and every installed @knext/* package must have resolved from a
  // LOCAL tarball, never the registry.
  it('tarballPrefix maps @knext/* names to pnpm pack tarball prefixes', async () => {
    const { tarballPrefix } = await import('../scripts/lib/knext-closure.mjs');
    expect(tarballPrefix('@knext/db')).toBe('knext-db');
    expect(tarballPrefix('@knext/core')).toBe('knext-core');
  });

  it('knextDepsOf collects @knext/* keys across dependency fields', async () => {
    const { knextDepsOf } = await import('../scripts/lib/knext-closure.mjs');
    expect(
      knextDepsOf({
        dependencies: { '@knext/db': '^0.1.0', '@knext/lib': '^0.1.0', ioredis: '^5' },
        optionalDependencies: { '@knext/opt': '^1.0.0' },
        peerDependencies: { next: '>=16', '@knext/peer': '^2.0.0' },
        devDependencies: { '@knext/devonly': '^1.0.0' }, // dev deps do NOT install
      }).sort(),
    ).toEqual(['@knext/db', '@knext/lib', '@knext/opt', '@knext/peer']);
  });

  it('assertLocalKnextResolutions accepts only local (file:/absent-registry) @knext resolutions', async () => {
    const { assertLocalKnextResolutions } = await import('../scripts/lib/knext-closure.mjs');
    const ok = assertLocalKnextResolutions(
      {
        packages: {
          '': {},
          'node_modules/@knext/lib': { version: '0.1.0', resolved: 'file:../knext-lib-0.1.0.tgz' },
          'node_modules/@knext/db': { version: '0.1.0', resolved: 'file:../knext-db-0.1.0.tgz' },
          'node_modules/ioredis': { version: '5.9.2', resolved: 'https://registry.npmjs.org/x' },
        },
      },
      new Set(['@knext/lib', '@knext/db', '@knext/core']),
    );
    expect(ok.problems).toEqual([]);
  });

  it('assertLocalKnextResolutions REJECTS a registry-resolved @knext package (dependency confusion)', async () => {
    const { assertLocalKnextResolutions } = await import('../scripts/lib/knext-closure.mjs');
    const bad = assertLocalKnextResolutions(
      {
        packages: {
          'node_modules/@knext/db': {
            version: '0.1.0',
            resolved: 'https://registry.npmjs.org/@knext/db/-/db-0.1.0.tgz',
          },
        },
      },
      new Set(['@knext/db']),
    );
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.problems.join('\n')).toMatch(/@knext\/db/);
    expect(bad.problems.join('\n')).toMatch(/registry/i);
  });

  it('assertLocalKnextResolutions ignores non-@knext packages NESTED under an @knext package', async () => {
    // Regression: `node_modules/@knext/lib/node_modules/pino` is pino (registry
    // -resolved, fine), not an @knext package — naive path matching flagged it.
    const { assertLocalKnextResolutions } = await import('../scripts/lib/knext-closure.mjs');
    const ok = assertLocalKnextResolutions(
      {
        packages: {
          'node_modules/@knext/lib': { version: '0.1.0', resolved: 'file:../knext-lib-0.1.0.tgz' },
          'node_modules/@knext/lib/node_modules/pino': {
            version: '10.3.1',
            resolved: 'https://registry.npmjs.org/pino/-/pino-10.3.1.tgz',
          },
          'node_modules/@knext/lib/node_modules/@knext/db': {
            version: '0.1.0',
            resolved: 'file:../knext-db-0.1.0.tgz',
          },
        },
      },
      new Set(['@knext/lib', '@knext/db']),
    );
    expect(ok.problems).toEqual([]);
  });

  it('assertLocalKnextResolutions REJECTS an @knext package outside the derived closure', async () => {
    const { assertLocalKnextResolutions } = await import('../scripts/lib/knext-closure.mjs');
    const bad = assertLocalKnextResolutions(
      {
        packages: {
          'node_modules/@knext/unexpected': {
            version: '9.9.9',
            resolved: 'file:../whatever.tgz',
          },
        },
      },
      new Set(['@knext/lib']),
    );
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.problems.join('\n')).toMatch(/@knext\/unexpected/);
  });
});

describe('scripts/e2e-preflight.mjs — dependency-graph-derived set (behavioral, #255/#256)', () => {
  it('FAILS naming the missing tarball when core declares an @knext/* dep with NO local tarball (future 4th dep)', () => {
    const dir = tempDir('knext-tarballs-extra-dep-');
    packFixtureLib(dir);
    packFixtureDb(dir);
    // core additionally depends on @knext/extra — no local tarball exists.
    packFixture(
      dir,
      {
        name: '@knext/core',
        version: '0.1.0',
        exports: { '.': './index.js', './adapter': './adapter.js' },
        dependencies: { '@knext/lib': '^0.1.0', '@knext/db': '^0.1.0', '@knext/extra': '^0.1.0' },
      },
      {
        'index.js': 'module.exports = {};\n',
        'adapter.js': "module.exports = { name: 'knext-fixture-adapter' };\n",
      },
    );
    const r = runPreflight(dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `preflight must fail, output:\n${out}`).toBe(1);
    expect(out).toMatch(/::error::/);
    expect(out).toMatch(/knext-extra|@knext\/extra/);
  }, 180_000);
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
