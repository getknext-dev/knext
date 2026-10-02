/**
 * The stability-tiers page states which features are Stable, Beta, or
 * Experimental at v1.0. The Experimental list is the one most likely to rot:
 * a surface gets marked `@experimental` in code (or removed from that
 * carve-out) without the docs page following. These assertions pin the
 * docs page's Experimental list to the SAME source of truth the code-level
 * `experimental-surfaces.test.ts` guard uses — `INTERNAL_ONLY_VERBS` for the
 * directly-runnable CLI entries, and the `selfContained` `@experimental`
 * JSDoc marker — plus `vinext`, which the code does not carve out yet (that
 * lands separately) so it is listed here explicitly rather than derived.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_ONLY_VERBS } from '../../packages/kn-next/src/cli/help';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDocsDir = resolve(__dirname, '.');
const repoRoot = resolve(appDocsDir, '../..');

function read(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

const DOCS_DIR = resolve(appDocsDir, 'content/docs');
const PAGE = resolve(DOCS_DIR, 'stability.mdx');
const page = readFileSync(PAGE, 'utf8');

describe('docs — stability tiers page', () => {
  it('is listed in the sidebar navigation', () => {
    const meta = JSON.parse(readFileSync(resolve(DOCS_DIR, 'meta.json'), 'utf8')) as {
      pages: string[];
    };
    expect(meta.pages).toContain('stability');
  });

  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('names the three tiers, in plain language', () => {
    expect(page).toMatch(/^##\s+Stable\s*$/m);
    expect(page).toMatch(/^##\s+Beta\s*$/m);
    expect(page).toMatch(/^##\s+Experimental\s*$/m);
  });

  it('names every code-level experimental surface, sourced from the same guard code uses', () => {
    // Same list experimental-surfaces.test.ts pins: INTERNAL_ONLY_VERBS
    // (preview/loadtest) + selfContained. `vinext` the BUILD TARGET moved to
    // Beta on 2026-10-02 (founder decision, both runtimes) — it is no longer
    // asserted here. `selfContained` stays Experimental and is still
    // asserted as a literal (its own `@experimental` JSDoc marker is checked
    // below).
    const experimentalSection = page.slice(page.search(/^##\s+Experimental/m));
    for (const verb of INTERNAL_ONLY_VERBS) {
      expect(experimentalSection).toContain(verb);
    }
    expect(experimentalSection).toContain('selfContained');
  });

  it('lists the vinext build target under Beta, on both runtimes, not under Experimental', () => {
    const betaSection = page.slice(page.search(/^##\s+Beta/m), page.search(/^##\s+Experimental/m));
    const experimentalSection = page.slice(page.search(/^##\s+Experimental/m));
    expect(betaSection).toContain('vinext');
    expect(betaSection.toLowerCase()).toContain('bun');
    expect(betaSection.toLowerCase()).toContain('node');
    expect(experimentalSection).not.toContain('vinext');
  });

  it('selfContained is still @experimental in config.ts (page would go stale otherwise)', () => {
    const configSrc = read('packages/kn-next/src/config.ts');
    const match = configSrc.match(/\/\*\*([\s\S]*?)\*\/\s*selfContained\?:\s*boolean;/);
    expect(match, 'selfContained?: boolean must be preceded by a doc comment').not.toBeNull();
    expect((match?.[1] ?? '').includes('@experimental')).toBe(true);
  });

  it('vinext is not yet DEFAULT_BUILDER_ID (guards the day the code marker lands)', () => {
    // If vinext ever becomes the default builder again, this whole page's
    // framing (vinext = experimental, turbopack = default/stable) is wrong
    // and must be revisited, not silently left stale.
    const artifactContract = read('packages/kn-next/src/adapters/artifact-contract.ts');
    const match = artifactContract.match(/export const DEFAULT_BUILDER_ID = "([^"]+)";/);
    expect(match, 'DEFAULT_BUILDER_ID must be findable in artifact-contract.ts').not.toBeNull();
    expect(match?.[1]).not.toBe('vinext');
  });

  it('states the Stable tier includes the four credentialed cells', () => {
    const stableSection = page.slice(page.search(/^##\s+Stable/m), page.search(/^##\s+Beta/m));
    expect(stableSection).toMatch(/Turbopack/);
    expect(stableSection).toMatch(/Webpack/);
  });

  // No scheduled, red-on-fail, real-cluster check exists yet for ISR/Redis
  // caching or object storage on the default build target — so, by this
  // page's own Stable definition ("only when a scheduled, red-on-fail check
  // covers it"), they cannot be listed as Stable. Pin them to Beta here; move
  // this list to Stable only once that check exists AND the page's own text
  // says so. Do not let a docs edit quietly re-promote these without a real
  // check landing first.
  const PENDING_REAL_CLUSTER_CHECK = ['ISR/Redis caching', 'gcs', 's3', 'minio'] as const;

  it('keeps ISR/Redis caching and object storage in Beta until a scheduled real-cluster check exists', () => {
    const stableSection = page.slice(page.search(/^##\s+Stable/m), page.search(/^##\s+Beta/m));
    const betaSection = page.slice(page.search(/^##\s+Beta/m), page.search(/^##\s+Experimental/m));
    for (const item of PENDING_REAL_CLUSTER_CHECK) {
      expect(stableSection, `"${item}" must not be listed as Stable yet`).not.toContain(item);
      expect(betaSection, `"${item}" must be listed under Beta`).toContain(item);
    }
  });

  it('states the promotion rule for the Beta caching/storage entries, without internal references', () => {
    const betaSection = page.slice(page.search(/^##\s+Beta/m), page.search(/^##\s+Experimental/m));
    expect(betaSection).toMatch(/move to Stable once/i);
    expect(betaSection).toMatch(/scheduled/i);
    expect(betaSection).toMatch(/real cluster/i);
  });

  it('states NetworkPolicy enforcement depends on the cluster CNI', () => {
    expect(page).toMatch(/CNI|network plugin/i);
    expect(page.toLowerCase()).toContain('flannel');
  });

  it('is linked from the versioning page', () => {
    const versioningPage = readFileSync(resolve(DOCS_DIR, 'versioning.mdx'), 'utf8');
    expect(versioningPage).toContain('/docs/stability');
  });

  it('contains no ADR references or issue/PR numbers (content-hygiene rules apply here too)', () => {
    expect(page).not.toMatch(/\bADR-?\s?\d/i);
    expect(page).not.toMatch(/(?:\bPR |\bissue |\(|\s)#\d+\b/i);
  });
});

describe('docs — support-matrix reflects the real default build/runtime', () => {
  const supportMatrix = readFileSync(resolve(DOCS_DIR, 'support-matrix.mdx'), 'utf8');
  const artifactContract = read('packages/kn-next/src/adapters/artifact-contract.ts');

  it('does not claim vinext is the default build target', () => {
    expect(supportMatrix).not.toMatch(/default \(vinext\)/i);
    expect(supportMatrix).not.toMatch(/vinext is the default/i);
  });

  it('the runtime default the page cites matches DEFAULT_RUNTIME_ID in source', () => {
    const match = artifactContract.match(/export const DEFAULT_RUNTIME_ID: RuntimeId = "([^"]+)";/);
    expect(match, 'DEFAULT_RUNTIME_ID must be findable in artifact-contract.ts').not.toBeNull();
    const defaultRuntime = match?.[1] ?? '';
    expect(defaultRuntime).toBe('bun');
    expect(supportMatrix).toContain('default `bun` runtime');
  });
});

describe('docs — release notes do not call the credentialed default experimental', () => {
  const rc2 = read('docs/release/v1.0.0-rc.2.md');

  it('never says "compiled single-executable Bun build target is experimental" without naming vinext', () => {
    // The old, wrong phrasing named no build/target, which read as calling
    // the default, credentialed bun-runtime cell experimental. Guard the
    // exact regression: this phrase must not appear un-disambiguated.
    expect(rc2).not.toMatch(/\bThe compiled single-executable Bun build target is experimental\b/);
  });

  it('names vinext, not the default Bun runtime cell, as the experimental single-executable target', () => {
    expect(rc2).toMatch(/vinext.{0,80}experimental/is);
    expect(rc2).toMatch(/not experimental/i);
  });
});
