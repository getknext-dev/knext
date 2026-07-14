import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for the npm/JS supply-chain gate (v4-P3).
 *
 * Container images are Trivy-gated before push (tests/supply-chain-workflow.test.ts,
 * tests/operator-supply-chain-workflow.test.ts). The npm TARBALLS that the release
 * workflows publish (`@knext/{core,lib,db}` on npmjs; `@getknext-dev/{core,lib,db}`
 * on GitHub Packages) had NO equivalent gate — closing that real gap in
 * .claude/rules/security.md ("SBOM per image, scan every image, fail on
 * HIGH/CRITICAL"), extended here to the published JS dependency closure.
 *
 * The invariant these lock in:
 *   - Both release workflows run an audit + JS-SBOM job over the PRODUCTION
 *     (`--omit=dev`) dependency closure of the PUBLISHED packages.
 *   - That job FAILS on HIGH/CRITICAL (`--audit-level=high`, mirror the Trivy
 *     HIGH/CRITICAL rule).
 *   - It is ORDERED BEFORE publish: the publish job `needs:` it, so a failed
 *     audit blocks the publish (never advisory/after).
 *   - Any accepted advisory lives in a dated + justified allowlist (mirrors the
 *     Trivy triage discipline) so the gate can't be silently neutered.
 *
 * Like the sibling workflow guards, this scans the YAML + script as text so the
 * test adds no runtime YAML dependency. CI-safe path resolution:
 * dirname(fileURLToPath(import.meta.url)) + resolve (never new URL(relative)).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RELEASE_PATH = resolve(REPO_ROOT, '.github/workflows/release.yml');
const RELEASE_GHP_PATH = resolve(REPO_ROOT, '.github/workflows/release-ghp.yml');
const AUDIT_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/audit-published.mjs');
const ALLOWLIST_PATH = resolve(REPO_ROOT, 'security/npm-audit-allowlist.json');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Return the YAML text of the named top-level job (from `  <job>:` at 2-space
 * indent to the next 2-space job key or EOF).
 */
function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z0-9_-]+:\n/i);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

/** Value of a job's `needs:` (array or scalar) as a flat string list. */
function jobNeeds(text: string, job: string): string[] {
  const block = jobBlock(text, job);
  const m = block.match(/^\s*needs:\s*(.+)$/m);
  if (!m) return [];
  return m[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The audit job must invoke the shared audit script (single source of truth for
// scope + audit-level) so both channels gate identically.
const AUDIT_SCRIPT_RE = /scripts\/audit-published\.mjs/;

describe('npm supply-chain gate: release.yml (npmjs canonical)', () => {
  const text = read(RELEASE_PATH);

  it('defines a dedicated audit/SBOM job that runs the shared audit script', () => {
    expect(text).toMatch(/^ {2}audit:/m);
    const audit = jobBlock(text, 'audit');
    expect(audit).not.toBe('');
    expect(AUDIT_SCRIPT_RE.test(audit), 'the audit job must run scripts/audit-published.mjs').toBe(
      true,
    );
  });

  it('the audit job uploads a JS SBOM artifact', () => {
    const audit = jobBlock(text, 'audit');
    expect(/uses:\s*actions\/upload-artifact/.test(audit), 'must upload the SBOM artifact').toBe(
      true,
    );
    expect(/sbom/i.test(audit), 'the uploaded artifact must be the SBOM').toBe(true);
  });

  it('the publish job is ordered AFTER the audit job (needs: audit)', () => {
    // release.yml's publish job is `release`.
    expect(jobNeeds(text, 'release')).toContain('audit');
  });
});

describe('npm supply-chain gate: release-ghp.yml (GitHub Packages interim)', () => {
  const text = read(RELEASE_GHP_PATH);

  it('defines a dedicated audit/SBOM job that runs the shared audit script', () => {
    expect(text).toMatch(/^ {2}audit:/m);
    const audit = jobBlock(text, 'audit');
    expect(audit).not.toBe('');
    expect(AUDIT_SCRIPT_RE.test(audit), 'the audit job must run scripts/audit-published.mjs').toBe(
      true,
    );
  });

  it('the audit job uploads a JS SBOM artifact', () => {
    const audit = jobBlock(text, 'audit');
    expect(/uses:\s*actions\/upload-artifact/.test(audit), 'must upload the SBOM artifact').toBe(
      true,
    );
    expect(/sbom/i.test(audit), 'the uploaded artifact must be the SBOM').toBe(true);
  });

  it('the publish job is ordered AFTER the audit job (needs: audit)', () => {
    // release-ghp.yml's publish job is `publish-ghp`.
    expect(jobNeeds(text, 'publish-ghp')).toContain('audit');
  });

  it('is guarded to the canonical repo on the audit job (never forks)', () => {
    const audit = jobBlock(text, 'audit');
    expect(audit).toContain("github.repository == 'getknext-dev/knext'");
  });
});

describe('scripts/audit-published.mjs — the shared audit contract', () => {
  const text = read(AUDIT_SCRIPT_PATH);

  it('audits the PRODUCTION closure only (--omit=dev), not root devDeps', () => {
    // False-confidence guard: dev/build tooling (drizzle-kit, esbuild, vitest,
    // biome, tsx) must NOT be in scope — only what actually ships.
    expect(text).toContain('--omit=dev');
  });

  it('fails on HIGH/CRITICAL (--audit-level=high, mirror the Trivy rule)', () => {
    expect(text).toContain('--audit-level=high');
  });

  it('scopes the audit to the PUBLISHED package set {core, lib, db}', () => {
    // The published set (ADR-0020) — NOT @knext/ui (private, changeset-ignored).
    expect(text).toContain('@knext/core');
    expect(text).toContain('@knext/lib');
    expect(text).toContain('@knext/db');
    expect(text).not.toContain('@knext/ui');
  });

  it('generates a JS SBOM (CycloneDX) per published package', () => {
    expect(text).toMatch(/cyclonedx/i);
  });

  it('consumes the dated+justified allowlist so accepted advisories are auditable', () => {
    expect(text).toContain('npm-audit-allowlist.json');
  });

  it('resolves paths CI-safely (fileURLToPath, not new URL(relative))', () => {
    expect(text).toContain('fileURLToPath');
    expect(text).not.toMatch(/new URL\(\s*['"]\.\.?\//);
  });
});

describe('security/npm-audit-allowlist.json — dated + justified triage', () => {
  it('exists and is valid JSON with a documented shape', () => {
    const parsed = JSON.parse(read(ALLOWLIST_PATH)) as {
      allow?: Array<{ id?: string; justification?: string; added?: string; expires?: string }>;
    };
    expect(Array.isArray(parsed.allow), 'allowlist must have an `allow` array').toBe(true);
    // Every entry must be DATED + JUSTIFIED (mirror the Trivy triage pattern) —
    // an undated/unjustified suppression is exactly the silent-neuter this guards.
    for (const entry of parsed.allow ?? []) {
      expect(typeof entry.id, 'each allow entry needs an advisory id').toBe('string');
      expect(
        typeof entry.justification === 'string' && entry.justification.length > 0,
        `advisory ${entry.id} must carry a justification`,
      ).toBe(true);
      expect(
        typeof entry.added === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.added),
        `advisory ${entry.id} must carry an ISO added date`,
      ).toBe(true);
    }
  });
});
