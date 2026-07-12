import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The GHP rename script exposes pure, staging-based helpers so the rewrite logic
// is unit-testable without touching the real working tree or publishing anything.
import { rewriteManifest, rewriteScopeString, stageForGhp } from '../scripts/rename-for-ghp.mjs';

/**
 * Contract test for scripts/rename-for-ghp.mjs (interim GitHub Packages channel).
 *
 * GitHub Packages requires the scope to match the owning org, so the three
 * publishable packages (@knext/lib, @knext/db, @knext/core) must be republished
 * as @getknext-dev/{lib,db,core}. `publishConfig` cannot override the name, and
 * both @knext/lib and @knext/db are EXTERNALIZED in core's tsup build (db's tsc
 * build likewise preserves its @knext/lib imports) — so the compiled dists
 * hardcode `@knext/lib/...` + `@knext/db/...` specifiers that MUST be rewritten
 * too, or the published @getknext-dev/core would try to resolve the unpublished
 * @knext/lib + @knext/db at runtime (`kn-next db migrate` dynamically imports
 * `@knext/db/migrate`).
 *
 * Every assertion below maps to a deliverable acceptance criterion:
 *  - names rewritten to @getknext-dev
 *  - inter-package dep keys (@knext/lib, @knext/db) rewritten in dependents
 *  - dist import strings rewritten (lib AND db specifiers)
 *  - publishConfig.provenance stripped (+ GHP registry set)
 *  - the ORIGINAL fixture tree is left untouched (staging copy only)
 *  - loud non-zero failure PER MISSING SPECIFIER: for every @knext/* dependency
 *    a staged package declares, its dist must contain ≥1 occurrence of that
 *    exact specifier to rewrite — "lib rewritten but db chunk gone" fails too
 *  - loud failure when a staged package depends on an @knext/* package that is
 *    NOT itself in the publish set (closure check — an unpublished dep would
 *    ship an uninstallable manifest)
 *  - staging/publish order is lib → db → core
 */

let fixtureRoot: string;
let stagingRoot: string;

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

// Build a synthetic monorepo slice: packages/lib + packages/db + packages/kn-next,
// each with a package.json, a dist/ tree containing @knext/ import strings, a
// LICENSE + README.
function buildFixture(
  root: string,
  opts: {
    coreDistHasLibImports: boolean;
    coreDistHasDbImports: boolean;
    dbDistHasLibImports?: boolean;
    coreExtraDep?: Record<string, string>;
  },
) {
  const libDir = join(root, 'packages', 'lib');
  const dbDir = join(root, 'packages', 'db');
  const coreDir = join(root, 'packages', 'kn-next');
  mkdirSync(join(libDir, 'dist'), { recursive: true });
  mkdirSync(join(dbDir, 'dist'), { recursive: true });
  mkdirSync(join(coreDir, 'dist', 'adapters'), { recursive: true });
  mkdirSync(join(coreDir, 'dist', 'cli'), { recursive: true });

  writeJson(join(libDir, 'package.json'), {
    name: '@knext/lib',
    version: '0.1.0',
    main: 'dist/index.js',
    publishConfig: { access: 'public', provenance: true },
    dependencies: { pino: '^10.0.0' },
  });
  writeFileSync(join(libDir, 'dist', 'index.js'), 'export const lib = true;\n');
  writeFileSync(join(libDir, 'LICENSE'), 'Apache-2.0\n');
  writeFileSync(join(libDir, 'README.md'), '# @knext/lib\n');

  writeJson(join(dbDir, 'package.json'), {
    name: '@knext/db',
    version: '0.1.0',
    main: 'dist/index.js',
    publishConfig: { access: 'public', provenance: true },
    dependencies: { '@knext/lib': 'workspace:^', pg: '^8.16.3' },
  });
  writeFileSync(
    join(dbDir, 'dist', 'index.js'),
    (opts.dbDistHasLibImports ?? true)
      ? `import { getDbPool } from "@knext/lib/clients";\nexport { getDbPool };\n`
      : `export const db = true;\n`,
  );
  writeFileSync(
    join(dbDir, 'dist', 'migrate.js'),
    'export const runMigrations = async () => ({ applied: 0 });\n',
  );
  writeFileSync(join(dbDir, 'LICENSE'), 'Apache-2.0\n');
  writeFileSync(join(dbDir, 'README.md'), '# @knext/db\n');

  writeJson(join(coreDir, 'package.json'), {
    name: '@knext/core',
    version: '0.1.0',
    main: 'dist/config.js',
    publishConfig: { access: 'public', provenance: true },
    dependencies: {
      '@knext/db': 'workspace:^',
      '@knext/lib': 'workspace:^',
      ioredis: '^5.0.0',
      ...(opts.coreExtraDep ?? {}),
    },
    peerDependencies: { next: '>=16.0.0' },
  });
  writeFileSync(
    join(coreDir, 'dist', 'adapters', 'node-server.js'),
    opts.coreDistHasLibImports
      ? `import { clients } from "@knext/lib/clients";\nexport { clients };\n`
      : `export const core = true;\n`,
  );
  writeFileSync(
    join(coreDir, 'dist', 'adapters', 'node-server.d.ts'),
    opts.coreDistHasLibImports
      ? `export * from "@knext/lib/clients";\n`
      : `export declare const core: boolean;\n`,
  );
  writeFileSync(
    join(coreDir, 'dist', 'cli', 'db-migrate.js'),
    opts.coreDistHasDbImports
      ? `const run = async () => (await import("@knext/db/migrate")).runMigrations({});\nexport { run };\n`
      : `export const run = async () => {};\n`,
  );
  writeFileSync(join(coreDir, 'LICENSE'), 'Apache-2.0\n');
  writeFileSync(join(coreDir, 'README.md'), '# @knext/core\n');
}

const PACKAGES = [
  { name: '@knext/lib', dir: 'packages/lib' },
  { name: '@knext/db', dir: 'packages/db' },
  { name: '@knext/core', dir: 'packages/kn-next' },
];

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'ghp-fixture-'));
  stagingRoot = mkdtempSync(join(tmpdir(), 'ghp-staging-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(stagingRoot, { recursive: true, force: true });
});

describe('rewriteScopeString()', () => {
  it('rewrites every @knext/ occurrence to @getknext-dev/', () => {
    const { content, count } = rewriteScopeString(
      `import a from "@knext/lib/clients";\nimport b from "@knext/db/migrate";\n`,
    );
    expect(content).toBe(
      `import a from "@getknext-dev/lib/clients";\nimport b from "@getknext-dev/db/migrate";\n`,
    );
    expect(count).toBe(2);
  });

  it('is a no-op (count 0) when there is nothing to rewrite', () => {
    const { content, count } = rewriteScopeString('export const x = 1;\n');
    expect(content).toBe('export const x = 1;\n');
    expect(count).toBe(0);
  });
});

describe('rewriteManifest()', () => {
  it('rewrites name, dep keys, resolves workspace:, and strips provenance while setting GHP registry', () => {
    const out = rewriteManifest(
      {
        name: '@knext/core',
        dependencies: {
          '@knext/db': 'workspace:^',
          '@knext/lib': 'workspace:^',
          ioredis: '^5.0.0',
        },
        publishConfig: { access: 'public', provenance: true },
      },
      { '@knext/lib': '0.2.0', '@knext/db': '0.3.0' },
    );
    expect(out.name).toBe('@getknext-dev/core');
    // workspace:^ resolved against the provided version map.
    expect(out.dependencies['@getknext-dev/lib']).toBe('^0.2.0');
    expect(out.dependencies['@getknext-dev/db']).toBe('^0.3.0');
    expect(out.dependencies['@knext/lib']).toBeUndefined();
    expect(out.dependencies['@knext/db']).toBeUndefined();
    expect(out.dependencies.ioredis).toBe('^5.0.0');
    expect(out.publishConfig.provenance).toBeUndefined();
    expect(out.publishConfig.registry).toBe('https://npm.pkg.github.com');
    expect(out.publishConfig.access).toBe('public');
  });
});

describe('stageForGhp()', () => {
  it('stages all three renamed packages (lib → db → core) without mutating the original tree', () => {
    buildFixture(fixtureRoot, { coreDistHasLibImports: true, coreDistHasDbImports: true });
    const report = stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES });

    // --- publish order: lib before db before core ---
    expect(report.order).toEqual(['@knext/lib', '@knext/db', '@knext/core']);

    // --- staged manifests renamed ---
    const libPkg = JSON.parse(
      readFileSync(join(report.staged['@knext/lib'].stagingDir, 'package.json'), 'utf8'),
    );
    const dbPkg = JSON.parse(
      readFileSync(join(report.staged['@knext/db'].stagingDir, 'package.json'), 'utf8'),
    );
    const corePkg = JSON.parse(
      readFileSync(join(report.staged['@knext/core'].stagingDir, 'package.json'), 'utf8'),
    );
    expect(libPkg.name).toBe('@getknext-dev/lib');
    expect(dbPkg.name).toBe('@getknext-dev/db');
    expect(corePkg.name).toBe('@getknext-dev/core');

    // --- inter-package dep keys rewritten AND workspace: resolved to a concrete
    // range (npm publish from staging cannot rewrite `workspace:^` itself). All
    // fixture versions are 0.1.0 → ^0.1.0. ---
    expect(dbPkg.dependencies['@getknext-dev/lib']).toBe('^0.1.0');
    expect(dbPkg.dependencies['@knext/lib']).toBeUndefined();
    expect(corePkg.dependencies['@getknext-dev/lib']).toBe('^0.1.0');
    expect(corePkg.dependencies['@getknext-dev/db']).toBe('^0.1.0');
    expect(corePkg.dependencies['@knext/lib']).toBeUndefined();
    expect(corePkg.dependencies['@knext/db']).toBeUndefined();

    // --- provenance stripped + registry set on all three ---
    for (const pkg of [libPkg, dbPkg, corePkg]) {
      expect(pkg.publishConfig.provenance).toBeUndefined();
      expect(pkg.publishConfig.registry).toBe('https://npm.pkg.github.com');
    }

    // --- dist import strings rewritten in staging (lib AND db specifiers) ---
    const stagedJs = readFileSync(
      join(report.staged['@knext/core'].stagingDir, 'dist', 'adapters', 'node-server.js'),
      'utf8',
    );
    const stagedDbMigrateJs = readFileSync(
      join(report.staged['@knext/core'].stagingDir, 'dist', 'cli', 'db-migrate.js'),
      'utf8',
    );
    const stagedDbIndexJs = readFileSync(
      join(report.staged['@knext/db'].stagingDir, 'dist', 'index.js'),
      'utf8',
    );
    expect(stagedJs).toContain('@getknext-dev/lib/clients');
    expect(stagedJs).not.toContain('@knext/lib');
    expect(stagedDbMigrateJs).toContain('@getknext-dev/db/migrate');
    expect(stagedDbMigrateJs).not.toContain('@knext/db');
    expect(stagedDbIndexJs).toContain('@getknext-dev/lib/clients');
    expect(stagedDbIndexJs).not.toContain('@knext/lib');
    expect(report.staged['@knext/core'].distOccurrences).toBeGreaterThan(0);
    expect(report.staged['@knext/db'].distOccurrences).toBeGreaterThan(0);

    // --- ORIGINAL tree untouched ---
    const origCore = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages', 'kn-next', 'package.json'), 'utf8'),
    );
    expect(origCore.name).toBe('@knext/core');
    expect(origCore.dependencies['@knext/lib']).toBe('workspace:^');
    expect(origCore.dependencies['@knext/db']).toBe('workspace:^');
    const origJs = readFileSync(
      join(fixtureRoot, 'packages', 'kn-next', 'dist', 'adapters', 'node-server.js'),
      'utf8',
    );
    expect(origJs).toContain('@knext/lib/clients');
  });

  it('copies LICENSE and README into staging', () => {
    buildFixture(fixtureRoot, { coreDistHasLibImports: true, coreDistHasDbImports: true });
    const report = stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES });
    for (const name of ['@knext/lib', '@knext/db', '@knext/core'] as const) {
      expect(existsSync(join(report.staged[name].stagingDir, 'LICENSE'))).toBe(true);
      expect(existsSync(join(report.staged[name].stagingDir, 'README.md'))).toBe(true);
    }
  });

  it('FAILS LOUDLY when core has zero dist occurrences of @knext/lib to rewrite', () => {
    buildFixture(fixtureRoot, { coreDistHasLibImports: false, coreDistHasDbImports: true });
    expect(() => stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES })).toThrow(
      /@knext\/lib/,
    );
  });

  it('FAILS LOUDLY when core rewrote @knext/lib but has ZERO @knext/db occurrences (per-dependency drift check)', () => {
    // The aggregate count>0 guard would pass here (lib imports rewritten) while
    // silently shipping a dead `@knext/db/migrate` dynamic import — the exact
    // hole behind #255/#256. The guard must be per @knext/* dependency.
    buildFixture(fixtureRoot, { coreDistHasLibImports: true, coreDistHasDbImports: false });
    expect(() => stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES })).toThrow(
      /@knext\/db/,
    );
  });

  it('FAILS LOUDLY when db has zero dist occurrences of its @knext/lib dep to rewrite', () => {
    buildFixture(fixtureRoot, {
      coreDistHasLibImports: true,
      coreDistHasDbImports: true,
      dbDistHasLibImports: false,
    });
    expect(() => stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES })).toThrow(
      /@knext\/lib/,
    );
  });

  it('FAILS LOUDLY when a staged package depends on an @knext/* package OUTSIDE the publish set (closure check)', () => {
    // A plain-semver dep on an unpublished @knext/x would ship an uninstallable
    // manifest (resolveWorkspaceSpec only guards workspace: specs) — refuse it.
    buildFixture(fixtureRoot, {
      coreDistHasLibImports: true,
      coreDistHasDbImports: true,
      coreExtraDep: { '@knext/extra': '^1.0.0' },
    });
    expect(() => stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES })).toThrow(
      /@knext\/extra/,
    );
  });
});
