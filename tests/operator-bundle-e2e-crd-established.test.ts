import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for issue #1532's literal exit criterion:
 *
 *   "kubectl apply -f <release url> on a clean kind cluster in Actions brings
 *    the operator Ready (a lane, red on fail)."
 *
 * The kind lane, the `kubectl apply --server-side -f` verb, and the operator
 * Deployment-Available assertion already existed before this change
 * (`.github/workflows/operator-bundle-e2e.yml` running
 * `packages/kn-next-operator/test/e2e/install_bundle_test.go`, issue #117).
 * What that spec did NOT assert is the other named half of the exit
 * criterion: that the bundle's `NextApp` CRD is actually **Established** —
 * it only ever applied a sample `NextApp` and inferred establishment from
 * that apply succeeding, which conflates "the API server accepted this one
 * object" with "the CRD registered a usable API". This test scans the e2e
 * source (this repo's established pattern — see
 * `tests/operator-supply-chain-workflow.test.ts` — for guarding workflow/e2e
 * shape without needing a live kind cluster in the unit-test lane) for an
 * EXPLICIT `status.conditions[?(@.type=='Established')]` check on the
 * `nextapps.apps.kn-next.dev` CRD, so a future edit that drops the assertion
 * (rather than merely the cluster it must run against) reds this offline
 * suite instead of silently passing.
 *
 * This is a text-shape guard, not a cluster run — the live proof is the kind
 * lane itself (`operator-bundle-e2e.yml`, Actions-only per this repo's rules).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const E2E_BUNDLE_TEST_PATH = resolve(
  REPO_ROOT,
  'packages/kn-next-operator/test/e2e/install_bundle_test.go',
);
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/operator-bundle-e2e.yml');

function e2eSource(): string {
  return readFileSync(E2E_BUNDLE_TEST_PATH, 'utf8');
}

describe('install_bundle_test.go asserts the NextApp CRD is Established', () => {
  it("checks status.conditions[?(@.type=='Established')] on the nextapps CRD", () => {
    const src = e2eSource();
    expect(src).toMatch(/get",\s*"crd",\s*"nextapps\.apps\.kn-next\.dev"/);
    expect(src).toContain("status.conditions[?(@.type=='Established')].status");
  });

  it('asserts the Established status is "True", not merely non-empty', () => {
    const src = e2eSource();
    // Find the Established jsonpath block and confirm the very next assertion
    // in that Eventually pins the value to "True" — a guard that only checked
    // "non-empty" would pass on Established=False just as readily.
    const idx = src.indexOf("status.conditions[?(@.type=='Established')].status");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 400);
    expect(window).toMatch(/To\(Equal\("True"\)/);
  });

  it('the Established check runs BEFORE the sample NextApp is applied', () => {
    // Ordering matters for what the assertion actually proves: checking
    // Established only makes sense before something that already assumes it
    // (a prior "the CR apply worked, so it must have been established" would
    // be circular). This anchors the check earlier in the file than the
    // sample-NextApp apply step.
    const src = e2eSource();
    const establishedIdx = src.indexOf("status.conditions[?(@.type=='Established')]");
    const sampleApplyIdx = src.indexOf('applying a DIGEST-PINNED sample NextApp');
    expect(establishedIdx).toBeGreaterThan(-1);
    expect(sampleApplyIdx).toBeGreaterThan(-1);
    expect(establishedIdx).toBeLessThan(sampleApplyIdx);
  });

  it('the spec still applies the bundle with `kubectl apply --server-side -f`', () => {
    // Regression guard for the OTHER named half of #1532's exit criterion —
    // already true before this change, pinned here so it cannot silently
    // regress alongside the new assertion this PR adds next to it.
    expect(e2eSource()).toMatch(/kubectl apply --server-side -f/);
  });
});

describe('operator-bundle-e2e.yml — the kind lane that proves the assertion above', () => {
  it('exists and runs the install-bundle e2e make target', () => {
    const wf = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(wf).toContain('make test-e2e-bundle');
  });

  it('creates a fresh (clean) kind cluster rather than reusing an ambient one', () => {
    const wf = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(wf).toMatch(/kind create cluster/);
  });
});
