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
 * GitHub Packages requires the scope to match the owning org, so the two
 * publishable packages (@knext/lib, @knext/core) must be republished as
 * @getknext-dev/lib + @getknext-dev/core. `publishConfig` cannot override the
 * name, and @knext/lib is EXTERNALIZED in core's tsup build — so the compiled
 * dist hardcodes `@knext/lib/...` imports that MUST be rewritten too, or the
 * published @getknext-dev/core would try to resolve an unpublished @knext/lib.
 *
 * Every assertion below maps to a deliverable acceptance criterion:
 *  - names rewritten to @getknext-dev
 *  - inter-package dep key @knext/lib rewritten in core.dependencies
 *  - dist import strings rewritten
 *  - publishConfig.provenance stripped (+ GHP registry set)
 *  - the ORIGINAL fixture tree is left untouched (staging copy only)
 *  - loud non-zero failure when core has zero dist occurrences to rewrite
 */

let fixtureRoot: string;
let stagingRoot: string;

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

// Build a synthetic monorepo slice: packages/lib + packages/kn-next, each with a
// package.json, a dist/ tree containing @knext/ import strings, a LICENSE + README.
function buildFixture(root: string, opts: { coreDistHasImports: boolean }) {
  const libDir = join(root, 'packages', 'lib');
  const coreDir = join(root, 'packages', 'kn-next');
  mkdirSync(join(libDir, 'dist'), { recursive: true });
  mkdirSync(join(coreDir, 'dist', 'adapters'), { recursive: true });

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

  writeJson(join(coreDir, 'package.json'), {
    name: '@knext/core',
    version: '0.1.0',
    main: 'dist/config.js',
    publishConfig: { access: 'public', provenance: true },
    dependencies: { '@knext/lib': 'workspace:^', ioredis: '^5.0.0' },
    peerDependencies: { next: '>=16.0.0' },
  });
  const coreImport = opts.coreDistHasImports
    ? `import { clients } from "@knext/lib/clients";\nexport { clients };\n`
    : `export const core = true;\n`;
  writeFileSync(join(coreDir, 'dist', 'adapters', 'node-server.js'), coreImport);
  writeFileSync(
    join(coreDir, 'dist', 'adapters', 'node-server.d.ts'),
    opts.coreDistHasImports
      ? `export * from "@knext/lib/clients";\n`
      : `export declare const core: boolean;\n`,
  );
  writeFileSync(join(coreDir, 'LICENSE'), 'Apache-2.0\n');
  writeFileSync(join(coreDir, 'README.md'), '# @knext/core\n');
}

const PACKAGES = [
  { name: '@knext/lib', dir: 'packages/lib', requireDistRewrites: false },
  { name: '@knext/core', dir: 'packages/kn-next', requireDistRewrites: true },
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
      `import a from "@knext/lib/clients";\nimport b from "@knext/lib";\n`,
    );
    expect(content).toBe(
      `import a from "@getknext-dev/lib/clients";\nimport b from "@getknext-dev/lib";\n`,
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
        dependencies: { '@knext/lib': 'workspace:^', ioredis: '^5.0.0' },
        publishConfig: { access: 'public', provenance: true },
      },
      { '@knext/lib': '0.2.0' },
    );
    expect(out.name).toBe('@getknext-dev/core');
    // workspace:^ resolved against the provided version map.
    expect(out.dependencies['@getknext-dev/lib']).toBe('^0.2.0');
    expect(out.dependencies['@knext/lib']).toBeUndefined();
    expect(out.dependencies.ioredis).toBe('^5.0.0');
    expect(out.publishConfig.provenance).toBeUndefined();
    expect(out.publishConfig.registry).toBe('https://npm.pkg.github.com');
    expect(out.publishConfig.access).toBe('public');
  });
});

describe('stageForGhp()', () => {
  it('stages renamed packages without mutating the original tree', () => {
    buildFixture(fixtureRoot, { coreDistHasImports: true });
    const report = stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES });

    // --- staged manifests renamed ---
    const libPkg = JSON.parse(
      readFileSync(join(report.staged['@knext/lib'].stagingDir, 'package.json'), 'utf8'),
    );
    const corePkg = JSON.parse(
      readFileSync(join(report.staged['@knext/core'].stagingDir, 'package.json'), 'utf8'),
    );
    expect(libPkg.name).toBe('@getknext-dev/lib');
    expect(corePkg.name).toBe('@getknext-dev/core');

    // --- inter-package dep key rewritten AND workspace: resolved to a concrete
    // range (npm publish from staging cannot rewrite `workspace:^` itself). Lib
    // fixture version is 0.1.0 → ^0.1.0. ---
    expect(corePkg.dependencies['@getknext-dev/lib']).toBe('^0.1.0');
    expect(corePkg.dependencies['@knext/lib']).toBeUndefined();

    // --- provenance stripped + registry set on both ---
    expect(libPkg.publishConfig.provenance).toBeUndefined();
    expect(corePkg.publishConfig.provenance).toBeUndefined();
    expect(corePkg.publishConfig.registry).toBe('https://npm.pkg.github.com');

    // --- dist import strings rewritten in staging ---
    const stagedJs = readFileSync(
      join(report.staged['@knext/core'].stagingDir, 'dist', 'adapters', 'node-server.js'),
      'utf8',
    );
    const stagedDts = readFileSync(
      join(report.staged['@knext/core'].stagingDir, 'dist', 'adapters', 'node-server.d.ts'),
      'utf8',
    );
    expect(stagedJs).toContain('@getknext-dev/lib/clients');
    expect(stagedJs).not.toContain('@knext/lib');
    expect(stagedDts).toContain('@getknext-dev/lib/clients');
    expect(report.staged['@knext/core'].distOccurrences).toBeGreaterThan(0);

    // --- ORIGINAL tree untouched ---
    const origCore = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages', 'kn-next', 'package.json'), 'utf8'),
    );
    expect(origCore.name).toBe('@knext/core');
    expect(origCore.dependencies['@knext/lib']).toBe('workspace:^');
    const origJs = readFileSync(
      join(fixtureRoot, 'packages', 'kn-next', 'dist', 'adapters', 'node-server.js'),
      'utf8',
    );
    expect(origJs).toContain('@knext/lib/clients');
  });

  it('copies LICENSE and README into staging', () => {
    buildFixture(fixtureRoot, { coreDistHasImports: true });
    const report = stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES });
    expect(existsSync(join(report.staged['@knext/core'].stagingDir, 'LICENSE'))).toBe(true);
    expect(existsSync(join(report.staged['@knext/core'].stagingDir, 'README.md'))).toBe(true);
  });

  it('FAILS LOUDLY when core has zero dist occurrences to rewrite', () => {
    buildFixture(fixtureRoot, { coreDistHasImports: false });
    expect(() => stageForGhp({ rootDir: fixtureRoot, stagingRoot, packages: PACKAGES })).toThrow(
      /zero .*@knext\/.*occurrences|externaliz/i,
    );
  });
});
