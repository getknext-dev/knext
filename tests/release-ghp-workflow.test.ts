import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for .github/workflows/release-ghp.yml — the interim GitHub
 * Packages release channel (@getknext-dev/*).
 *
 * The invariants these lock in (see docs/RELEASING.md):
 *   - MANUAL only (workflow_dispatch); never publishes on push.
 *   - Scoped to the canonical repo (never forks).
 *   - `packages: write` but NO `id-token` — the GHP path publishes WITHOUT
 *     provenance (provenance needs npmjs/OIDC).
 *   - Builds + publishes lib BEFORE db BEFORE core (core depends on both;
 *     db depends on lib) — #255/#256 added @knext/db to the publish set.
 *   - Runs the rename script so publishes carry the @getknext-dev scope.
 *   - Does NOT touch the clean npmjs release.yml.
 *
 * Like the other workflow guard tests, this scans the YAML as text so it adds
 * no runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/release-ghp.yml');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('.github/workflows/release-ghp.yml', () => {
  it('is manual-only (workflow_dispatch) and never triggers on push', () => {
    const text = workflowText();
    expect(text).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    // No push trigger — the npmjs release.yml owns the on-push path.
    const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nconcurrency:'));
    expect(onBlock).not.toMatch(/^\s*push:/m);
  });

  it('is guarded to the canonical repo', () => {
    expect(workflowText()).toContain("github.repository == 'getknext-dev/knext'");
  });

  it('grants packages:write but NOT id-token (no provenance on GHP)', () => {
    const text = workflowText();
    expect(text).toMatch(/permissions:/);
    expect(text).toMatch(/packages:\s*write/);
    expect(text).toContain('contents: read');
    expect(text).not.toMatch(/id-token:\s*write/);
  });

  it('builds lib and db before core', () => {
    const text = workflowText();
    expect(text).toContain(
      'pnpm --filter @knext/lib build && pnpm --filter @knext/db build && pnpm --filter @knext/core build',
    );
  });

  it('runs the rename-for-ghp staging script before publishing', () => {
    const text = workflowText();
    const renameIdx = text.indexOf('scripts/rename-for-ghp.mjs');
    const publishIdx = text.indexOf('npm publish');
    expect(renameIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(renameIdx);
  });

  it('publishes lib, then db, then core staging dirs (dependency order)', () => {
    // #255/#256: @knext/core depends on @knext/db (which depends on @knext/lib)
    // — publishing without db shipped an uninstallable @getknext-dev/core.
    const text = workflowText();
    const libIdx = text.indexOf('.ghp-staging/lib');
    const dbIdx = text.indexOf('.ghp-staging/db');
    const coreIdx = text.indexOf('.ghp-staging/core');
    expect(libIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(libIdx);
    expect(coreIdx).toBeGreaterThan(dbIdx);
  });

  it('publishes to the GitHub Packages registry with GITHUB_TOKEN auth', () => {
    const text = workflowText();
    expect(text).toContain('npm.pkg.github.com');
    // Auth wired via the built-in GITHUB_TOKEN (avoid the literal ${{ }} to keep
    // biome's noTemplateCurlyInString quiet — assert the two halves instead).
    expect(text).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  });

  it('fails clearly on an already-published version (idempotent-friendly)', () => {
    const text = workflowText();
    expect(text).toMatch(/EPUBLISHCONFLICT|409|already published|already exists/i);
    expect(text).toMatch(/bump versions via changesets/i);
  });
});

/**
 * GUARD TESTS for the P3a consumer-side install-smoke job — the missing
 * registry-channel consumer proof (a v2 incident follow-up). This job installs
 * the JUST-PUBLISHED @getknext-dev/* packages FROM npm.pkg.github.com (not from a
 * source tarball) and asserts the CLI bin runs + every public app-import resolves.
 *
 * The invariants locked here (plan-v3 P3a binding conditions):
 *   - It is a SEPARATE job that runs AFTER publish (`needs: publish-ghp`).
 *   - Its job-scoped permissions are READ-ONLY: {contents: read, packages: read}
 *     — never `packages: write`, never `id-token`.
 *   - It uses only the built-in GITHUB_TOKEN (no other secrets.*).
 *   - It scopes @getknext-dev to npm.pkg.github.com and asserts that pre-install.
 *   - The consumer smoke script asserts every resolved @getknext-dev/* tarball
 *     URL is on pkg.github.com (dependency-confusion / endpoint-assert discipline).
 */
describe('.github/workflows/release-ghp.yml — P3a consumer install-smoke job', () => {
  /** The block of YAML text for the smoke job (from its `smoke-ghp:` key to EOF). */
  function smokeJobBlock(): string {
    const text = workflowText();
    const idx = text.indexOf('\n  smoke-ghp:');
    expect(idx).toBeGreaterThan(-1);
    return text.slice(idx);
  }

  it('defines a consumer-side smoke job that runs AFTER publish', () => {
    const text = workflowText();
    expect(text).toMatch(/^ {2}smoke-ghp:/m);
    // Runs after the publish job — the registry channel must exist first.
    expect(smokeJobBlock()).toMatch(/needs:\s*\[?\s*publish-ghp\s*\]?/);
  });

  it('grants the smoke job READ-ONLY permissions (packages: read, never write)', () => {
    const block = smokeJobBlock();
    // Job-scoped permissions block, read-only both axes.
    expect(block).toMatch(/permissions:/);
    expect(block).toMatch(/contents:\s*read/);
    expect(block).toMatch(/packages:\s*read/);
    // Never write, never id-token — a consumer NEVER publishes.
    expect(block).not.toMatch(/packages:\s*write/);
    expect(block).not.toMatch(/id-token:/);
    expect(block).not.toMatch(/contents:\s*write/);
  });

  it('is guarded to the canonical repo (never forks)', () => {
    expect(smokeJobBlock()).toContain("github.repository == 'getknext-dev/knext'");
  });

  it('uses ONLY the built-in GITHUB_TOKEN (no other secrets)', () => {
    const block = smokeJobBlock();
    // The only secret referenced anywhere in the smoke job is GITHUB_TOKEN.
    const secretRefs = block.match(/secrets\.[A-Z_]+/g) ?? [];
    for (const ref of secretRefs) {
      expect(ref).toBe('secrets.GITHUB_TOKEN');
    }
    // And it IS wired (so the consumer can read repo-linked packages).
    expect(block).toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it('scopes @getknext-dev to npm.pkg.github.com and runs the consumer smoke script', () => {
    const block = smokeJobBlock();
    expect(block).toContain('@getknext-dev:registry=https://npm.pkg.github.com');
    expect(block).toContain('scripts/ghp-install-smoke.mjs');
  });
});

/**
 * GUARD TESTS for scripts/ghp-install-smoke.mjs — the consumer smoke script the
 * P3a job runs. These lock the SECURITY-CRITICAL assertions statically (the job
 * itself only runs on release-ghp dispatch, so the contract test is the standing
 * proof that the dependency-confusion guards are present and un-weakened).
 */
describe('scripts/ghp-install-smoke.mjs — registry-channel consumer proof', () => {
  function scriptText(): string {
    return readFileSync(resolve(REPO_ROOT, 'scripts/ghp-install-smoke.mjs'), 'utf8');
  }

  it('installs from the GitHub Packages registry, not a source tarball', () => {
    const text = scriptText();
    expect(text).toContain('npm.pkg.github.com');
    expect(text).toContain('@getknext-dev/core');
    // It writes an .npmrc scoping @getknext-dev + wiring the auth token.
    expect(text).toContain('@getknext-dev:registry=https://npm.pkg.github.com');
    expect(text).toContain('//npm.pkg.github.com/:_authToken=');
  });

  it('asserts the scope registry resolves to pkg.github.com BEFORE installing', () => {
    const text = scriptText();
    // `npm config get @getknext-dev:registry` (or equivalent) must be checked pre-install.
    expect(text).toMatch(/@getknext-dev:registry/);
    expect(text).toMatch(/npm.*config.*get|getConfiguredRegistry|assertScopeRegistry/i);
  });

  it('asserts every resolved @getknext-dev tarball URL is on pkg.github.com (endpoint-assert)', () => {
    const text = scriptText();
    // The dependency-confusion guard: audit the resolved tarball origins.
    expect(text).toMatch(/resolved/i);
    expect(text).toMatch(/pkg\.github\.com/);
    expect(text).toMatch(/@getknext-dev/);
  });

  it('runs the clean consumer dir OUTSIDE the repo workspace', () => {
    const text = scriptText();
    expect(text).toMatch(/mkdtemp/);
    // Fail-closed if the work dir ends up inside the repo.
    expect(text).toMatch(/startsWith\(repoRoot\)|inside the repo/);
  });

  it('proves the CLI bin runs and app-import subpaths resolve to real JS', () => {
    const text = scriptText();
    expect(text).toMatch(/--help/);
    // Mirrors install-smoke.mjs: resolved subpaths must not be raw .ts.
    expect(text).toMatch(/\.ts/);
    expect(text).toContain('@getknext-dev/db');
  });
});
