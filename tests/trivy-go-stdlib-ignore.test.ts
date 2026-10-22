/**
 * A dated Trivy ignore for the Go stdlib advisory fixed in go1.26.10, held back
 * by the 3-day release-age rule. It must expire on its own, carry a statement,
 * be wired into exactly the Trivy steps that scan an image built from the Go
 * toolchain, and never into a scan of anything else (an ignore on a JS image
 * scan would hide a real finding there).
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const IGNORE = 'security/trivy-go-stdlib.trivyignore.yaml';
const LATEST_EXPIRY = '2026-10-26';

const ignore = parse(readFileSync(resolve(REPO_ROOT, IGNORE), 'utf8')) as {
  vulnerabilities: { id: string; statement?: string; expired_at?: string | Date }[];
};

// The ONLY Trivy steps that scan an image built from the Go toolchain.
const GO_IMAGE_STEPS = new Set([
  'go-template.yml::Trivy scan — FAIL on HIGH/CRITICAL',
  'operator-supply-chain.yml::Trivy scan — FAIL on HIGH/CRITICAL',
]);

type Step = { name?: string; uses?: string; with?: Record<string, unknown> };
const wfDir = resolve(REPO_ROOT, '.github/workflows');
const trivySteps: { key: string; file: string; step: Step }[] = [];
for (const file of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  const wf = parse(readFileSync(resolve(wfDir, file), 'utf8')) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('aquasecurity/trivy-action@')) {
        trivySteps.push({ key: `${file}::${step.name}`, file, step });
      }
    }
  }
}
const wired = (s: Step) => String(s.with?.trivyignores ?? '').includes(IGNORE);

describe('security/trivy-go-stdlib.trivyignore.yaml', () => {
  it('has the one advisory entry', () => {
    expect(ignore.vulnerabilities.map((v) => v.id)).toEqual(['CVE-2026-111943']);
  });

  it('every entry expires by 2026-10-26 at the latest and carries a statement', () => {
    for (const v of ignore.vulnerabilities) {
      const raw = v.expired_at instanceof Date ? v.expired_at.toISOString() : String(v.expired_at);
      expect(raw, `${v.id} expired_at`).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(raw.slice(0, 10) <= LATEST_EXPIRY, `${v.id} expires ${raw}`).toBe(true);
      expect(v.statement ?? '', `${v.id} statement`).toMatch(/go1\.26\.10/);
      expect(v.statement ?? '', `${v.id} statement`).toContain('#2567');
    }
  });
});

describe('where the ignore is wired', () => {
  it('finds the Go-image Trivy steps (the scan is not vacuous)', () => {
    const keys = trivySteps.map((t) => t.key);
    for (const k of GO_IMAGE_STEPS) expect(keys, k).toContain(k);
  });

  it('is wired into exactly the Go-image steps', () => {
    const wiredKeys = trivySteps.filter((t) => wired(t.step)).map((t) => t.key);
    expect(wiredKeys.sort()).toEqual([...GO_IMAGE_STEPS].sort());
  });

  it('is never wired into any other Trivy scan', () => {
    for (const t of trivySteps) {
      if (GO_IMAGE_STEPS.has(t.key)) continue;
      expect(JSON.stringify(t.step.with ?? {}), t.key).not.toContain('trivy-go-stdlib');
    }
  });
});
