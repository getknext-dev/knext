import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #1722 — the `js-closure-fs-trivy` job in `supply-chain.yml`.
 *
 * `built-image-trivy` scans the shipped images' runtime OS layer ONLY (see
 * its own header) — it cannot see the production `node_modules`/runtime JS
 * the DEFAULT `standalone-bun` target actually ships (Next's traced
 * `.next/standalone/node_modules` + `@getknext/core`'s supervisor deps).
 * This job closes that for one reference app, REPORT-ONLY: it builds the
 * real `standalone-bun` image locally (no push) and Trivy-scans its `/app`
 * directory in filesystem/rootfs mode.
 *
 * Report-only in THIS PR (deliberately): an enforcing scan against the
 * existing, untriaged JS closure would red every PR on day one — the job
 * must carry an UNCONDITIONAL `continue-on-error: true` (not ref-gated like
 * `built-image-trivy`'s own enforce-on-main gate), and must still publish
 * its findings (artifact + job summary) even when the scan reds.
 */

const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/supply-chain.yml');

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/** Slice out the `js-closure-fs-trivy` job body (up to the next top-level job or EOF). */
function jsClosureJob(workflow: string): string {
  const start = workflow.indexOf('js-closure-fs-trivy:');
  expect(start, 'the js-closure-fs-trivy job must exist in supply-chain.yml').toBeGreaterThan(-1);
  const rest = workflow.slice(start + 'js-closure-fs-trivy:'.length);
  const next = rest.search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 'js-closure-fs-trivy:'.length + next);
}

describe('#1722 — js-closure-fs-trivy job (report-only JS closure scan for the default target)', () => {
  it('exists as a top-level job in supply-chain.yml', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('js-closure-fs-trivy:');
  });

  it('builds the standalone-bun target locally (no push) and runs kn-next build (default builder)', () => {
    const job = jsClosureJob(readWorkflow());
    expect(job).toContain('kn-next.js" build');
    expect(job).toContain('--target standalone-bun');
    expect(job).toContain('--load');
    expect(job).not.toMatch(/docker buildx build[^\n]*--push/);
  });

  it('runs Trivy in filesystem/rootfs mode over the extracted /app directory', () => {
    const job = jsClosureJob(readWorkflow());
    expect(job).toContain('scan-type: fs');
    expect(job).toMatch(/scan-ref:\s*\$\{\{\s*runner\.temp\s*\}\}\/extracted-app/);
    expect(job).toContain('docker cp');
  });

  it('is UNCONDITIONALLY report-only (continue-on-error: true, not ref-gated)', () => {
    const job = jsClosureJob(readWorkflow());
    // Must carry a bare `continue-on-error: true` on the Trivy step, never the
    // built-image-trivy job's ref-gated `${{ github.ref != 'refs/heads/main' }}`
    // form — this PR does not flip it to enforce-on-main.
    expect(job).toMatch(/continue-on-error:\s*true\b/);
    expect(job).not.toMatch(/continue-on-error:\s*\$\{\{\s*github\.ref/);
  });

  it('uploads the scan report as a workflow artifact, unconditionally (always())', () => {
    const job = jsClosureJob(readWorkflow());
    expect(job).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(job).toContain('js-closure-trivy-report-');
    // The upload step must run even when the scan step failed.
    const uploadIdx = job.indexOf('Upload the JS closure Trivy report');
    expect(uploadIdx).toBeGreaterThan(-1);
    const uploadBlock = job.slice(job.lastIndexOf('- name:', uploadIdx));
    expect(uploadBlock.slice(0, 200)).toContain('if: always()');
  });

  it('summarises findings into the job summary', () => {
    const job = jsClosureJob(readWorkflow());
    expect(job).toContain('summarize-trivy-fs-report.mjs');
    expect(job).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('#1722 — summarize-trivy-fs-report.mjs', () => {
  const scriptPath = join(REPO_ROOT, 'scripts/summarize-trivy-fs-report.mjs');

  it('exists', () => {
    expect(() => readFileSync(scriptPath, 'utf8')).not.toThrow();
  });

  it('never throws on a missing report path (the `always()` summary step must not itself fail the job)', () => {
    const result = Bun.spawnSync(['node', scriptPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('No report to summarise');
  });

  it('never throws on a malformed report file', () => {
    const tmp = join(REPO_ROOT, '.tmp-trivy-report-malformed.json');
    Bun.write(tmp, 'not json');
    try {
      const result = Bun.spawnSync(['node', scriptPath, tmp]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('No report to summarise');
    } finally {
      require('node:fs').rmSync(tmp, { force: true });
    }
  });

  it('counts HIGH/CRITICAL findings and surfaces the top affected packages', () => {
    const tmp = join(REPO_ROOT, '.tmp-trivy-report-sample.json');
    const sample = {
      Results: [
        {
          Vulnerabilities: [
            { Severity: 'CRITICAL', PkgName: 'lodash' },
            { Severity: 'HIGH', PkgName: 'lodash' },
            { Severity: 'HIGH', PkgName: 'minimist' },
            { Severity: 'LOW', PkgName: 'ignored-pkg' },
          ],
        },
      ],
    };
    Bun.write(tmp, JSON.stringify(sample));
    try {
      const result = Bun.spawnSync(['node', scriptPath, tmp]);
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain('**3**');
      expect(out).toContain('1 CRITICAL, 2 HIGH');
      expect(out).toContain('lodash');
      expect(out).toContain('minimist');
      expect(out).not.toContain('ignored-pkg');
    } finally {
      require('node:fs').rmSync(tmp, { force: true });
    }
  });
});

describe('#1722 — the #1525 fixture-comment correction', () => {
  it('Dockerfile.standalone-bun.trivyscan no longer cites #1525 as covering the same node_modules gap', () => {
    const text = readFileSync(
      join(REPO_ROOT, 'packages/kn-next/Dockerfile.standalone-bun.trivyscan'),
      'utf8',
    );
    // Must still mention #1525 (to explain why it is a DIFFERENT gap), but
    // must no longer say the stage's node_modules gap "IS" #1525's gap.
    expect(text).toContain('#1525');
    expect(text).not.toMatch(/same acknowledged gap #1525 tracks/);
    expect(text).toContain('#1722');
  });
});
