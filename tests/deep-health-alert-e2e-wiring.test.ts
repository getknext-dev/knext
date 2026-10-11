import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The deep-health alert kind e2e is only worth having if it cannot quietly stop
 * proving the claim. This pins the properties that make it a PROOF rather than a
 * green job:
 *
 *   - it applies the SHIPPED PodMonitor and PrometheusRule by path, never a copy
 *     and never an edited one — a fixture-tuned copy could stay green while the
 *     shipped manifest was unusable;
 *   - its Prometheus selects everything (empty selectors), so nothing about the
 *     fixture is what makes the shipped manifests get picked up;
 *   - it asserts the alert reaches `firing` — not "exists", not "pending";
 *   - the release bundle it installs is checksum-pinned (no placeholder left);
 *   - the CI job runs on PRs that touch the pieces it exercises.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SCRIPT = read('scripts/deep-health-alert-e2e.sh');
const ASSERT = read('scripts/deep-health-alert-e2e/assert-alert.mjs');
const PROMETHEUS = read('scripts/deep-health-alert-e2e/prometheus.yaml');
const FIXTURE_APP = read('scripts/deep-health-alert-e2e/fixture-app.yaml');
const WORKFLOW_SRC = read('.github/workflows/deep-health-alert-kind-e2e.yml');
const WORKFLOW = parse(WORKFLOW_SRC) as {
  on: { pull_request: { paths: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, { steps: Array<{ run?: string; uses?: string }> }>;
};

describe('deep-health alert e2e: applies the shipped manifests, unmodified', () => {
  it('applies the shipped PodMonitor and PrometheusRule by repo path', () => {
    expect(SCRIPT).toMatch(
      /apply -f "\$\{ROOT\}\/packages\/kn-next-operator\/config\/prometheus\/app-podmonitor\.yaml"/,
    );
    expect(SCRIPT).toMatch(
      /apply -f "\$\{ROOT\}\/packages\/kn-next-operator\/config\/observability\/prometheusrule\.yaml"/,
    );
  });

  it('does not rewrite the shipped manifests on the way in', () => {
    for (const verb of ['sed ', 'yq ', 'envsubst', 'kustomize', 'patch ']) {
      expect(
        SCRIPT,
        `the script uses "${verb.trim()}" and could be editing the shipped manifests`,
      ).not.toContain(verb);
    }
  });

  it('runs a Prometheus that selects every PodMonitor and rule (empty selectors)', () => {
    for (const sel of [
      'podMonitorSelector',
      'podMonitorNamespaceSelector',
      'ruleSelector',
      'ruleNamespaceSelector',
    ]) {
      expect(PROMETHEUS).toMatch(new RegExp(`${sel}: \\{\\}`));
    }
  });

  it('labels the fixture the way the operator labels app pods, and declares the scraped port', () => {
    expect(FIXTURE_APP).toContain('generated-by: kn-next-operator');
    expect(FIXTURE_APP).toMatch(/containerPort: 9464/);
  });
});

describe('deep-health alert e2e: asserts the alert FIRES', () => {
  it('waits for state === "firing" on KnextDeepHealthDown', () => {
    expect(ASSERT).toMatch(/KnextDeepHealthDown/);
    expect(ASSERT).toMatch(/state === 'firing'/);
  });

  it('exits non-zero on a timeout rather than skipping', () => {
    expect(ASSERT).toMatch(/process\.exit\(1\)/);
    expect(ASSERT).not.toMatch(/skip/i);
  });

  it('asserts the allowlist: nothing but the one family reaches the scraped port', () => {
    expect(ASSERT).toMatch(/knext_\(http\|coldstart\|db_wake\)_/);
  });
});

describe('deep-health alert e2e: supply chain and CI wiring', () => {
  it('pins the prometheus-operator bundle by checksum, with no placeholder left', () => {
    const m = SCRIPT.match(/PROMETHEUS_OPERATOR_SHA256="([^"]*)"/);
    expect(m, 'PROMETHEUS_OPERATOR_SHA256 is missing').not.toBeNull();
    expect(m?.[1]).toMatch(/^[0-9a-f]{64}$/);
    // the checksum must be verified BEFORE anything is applied
    const verify = SCRIPT.indexOf('sha256sum -c');
    const apply = SCRIPT.indexOf('apply --server-side -f "${OUT}"');
    expect(verify).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(verify);
  });

  it('the fixture pins its image by digest', () => {
    expect(FIXTURE_APP).toMatch(/image: oven\/bun:[\w.-]+@sha256:[0-9a-f]{64}/);
  });

  it('the workflow runs the script, on PRs that touch what it exercises', () => {
    const steps = Object.values(WORKFLOW.jobs).flatMap((j) => j.steps);
    expect(steps.some((s) => s.run?.includes('scripts/deep-health-alert-e2e.sh'))).toBe(true);
    const paths = WORKFLOW.on.pull_request.paths;
    for (const needle of [
      'packages/kn-next-operator/config/observability/**',
      'packages/kn-next-operator/config/prometheus/**',
      'packages/kn-next/templates/app/runtime-contract.mjs.hbs',
      'packages/lib/src/health/**',
    ]) {
      expect(paths, `the lane would not run when ${needle} changes`).toContain(needle);
    }
    expect(WORKFLOW.on.workflow_dispatch).toBeDefined();
  });

  it('does not tolerate its own failure', () => {
    expect(WORKFLOW_SRC).not.toMatch(/continue-on-error:\s*true/);
    // the failure-only diagnostics step is allowed `|| true`; the proof step is not
    const proof = WORKFLOW_SRC.split('Dump Prometheus')[0] ?? '';
    expect(proof).not.toContain('|| true');
  });
});
