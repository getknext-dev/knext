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
 *   - Builds + publishes lib BEFORE core (core depends on lib).
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

  it('publishes lib staging dir before core staging dir', () => {
    const text = workflowText();
    const libIdx = text.indexOf('.ghp-staging/lib');
    const coreIdx = text.indexOf('.ghp-staging/core');
    expect(libIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeGreaterThan(libIdx);
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
