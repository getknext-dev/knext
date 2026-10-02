import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Domain-rename guard (#1832): knext's public site moved from `knext.dev` to
 * `knext-platform.dev` (2026-10-02 founder correction — `knext.dev` is now a
 * Cloudflare 403 page we do not own). This asserts the bare literal
 * `knext.dev` never reappears in the docs/CI/scripts areas owned by this PR.
 *
 * Scope is deliberately narrow to this PR's own files, not the whole repo:
 * `packages/*` and `apps/file-manager` carry the same literal and are fixed
 * in a separate PR (integration/v1.3) because published-package bytes freeze
 * differently there. Re-scan this guard's ROOTS list once that PR lands.
 *
 * ALLOWLIST (label markers): these are Kubernetes label/annotation KEYS
 * (API-group-style DNS prefixes), not web links — renaming the website
 * domain must not rename them, or it silently breaks the operator's
 * metrics-scrape / observability opt-in contract on live clusters. jev
 * confirmed this split (0.95 "yes, leave them unchanged") before this guard
 * was written.
 *   - knext.dev/metrics-scrape  (NetworkPolicy cross-namespace scrape label)
 *   - knext.dev/opt-in          (file-manager observability RBAC opt-in label)
 *   - knext.dev/purpose         (same RBAC manifest, label value annotation)
 *   - knext.dev/benchmark       (image-prewarm benchmark Job label)
 *   - apps.knext.dev/build-id   (CRD-adjacent label key, escaped-dot form)
 *
 * ALLOWLIST (OKE-cluster hostname, file-scoped): `#1824` review (jev 0.93
 * blocked, then 0.99 for this fix) found that this OKE cluster's
 * DomainMapping/ClusterDomainClaim objects were never migrated off
 * `knext.dev` — the live public docs site is `knext-platform.dev`, served by
 * Vercel, not by this cluster. Pointing `apps/docs/deploy/oke/domainmapping.yaml`
 * or the `docs-deploy-oke.yml` smoke/public-host checks at `knext-platform.dev`
 * while the cluster's own objects still claim `knext.dev` would make the next
 * push-to-main deploy 404 rather than migrate anything. These two files
 * intentionally keep the stale `knext.dev` literal — an internal Host header
 * and admin-applied IaC, not public links — until a follow-up migrates OKE's
 * DomainMapping to the real domain (tracked in a dedicated issue; both files
 * carry an inline comment pointing back here).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const ROOTS = [
  'apps/docs',
  'docs',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'benchmarks',
  'scripts',
  '.github/workflows/ci.yml',
  '.github/workflows/docs-deploy-oke.yml',
  'tests',
];

const ALLOWLISTED_LABEL_MARKERS = [
  'metrics-scrape',
  'knext.dev/opt-in',
  'knext.dev/purpose',
  'knext.dev/benchmark',
  'build-id',
];

/**
 * Files where the ENTIRE file is allowlisted for the OKE-cluster-hostname
 * reason above, rather than a line-level marker — the literal here is a bare
 * `knext.dev` with no distinguishing substring (a Host header value, a
 * ClusterDomainClaim/DomainMapping `metadata.name`), so a marker-based
 * allowlist would have to match everything in the file anyway.
 */
const ALLOWLISTED_OKE_HOSTNAME_FILES = [
  '.github/workflows/docs-deploy-oke.yml',
  'apps/docs/deploy/oke/domainmapping.yaml',
  'tests/docs-deploy-oke-workflow.test.ts',
];

// This guard file itself legitimately contains the literal `knext.dev` (in
// this comment block and the allowlist below) — exclude it from the scan.
const SELF = relative(
  REPO_ROOT,
  resolve(import.meta.dirname, 'knext-platform-dev-domain-guard.test.ts'),
);

function walk(path: string): string[] {
  const full = join(REPO_ROOT, path);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(full);
  } catch {
    return [];
  }
  if (st.isFile()) return [path];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(full)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    out.push(...walk(join(path, entry)));
  }
  return out;
}

function findings(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      if (file === SELF) continue;
      if (ALLOWLISTED_OKE_HOSTNAME_FILES.includes(file)) continue;
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf-8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('knext.dev')) return;
        if (ALLOWLISTED_LABEL_MARKERS.some((m) => line.includes(m))) return;
        out.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return out;
}

describe('domain-rename guard (knext.dev -> knext-platform.dev)', () => {
  it('scans a non-empty file set', () => {
    const count = ROOTS.flatMap((r) => walk(r)).length;
    expect(count).toBeGreaterThan(20);
  });

  it('never re-introduces the bare knext.dev literal outside the K8s-label allowlist', () => {
    expect(findings()).toEqual([]);
  });
});
