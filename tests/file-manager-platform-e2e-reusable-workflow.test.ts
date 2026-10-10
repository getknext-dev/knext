import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { unsafeAppliesInWorkflow } from '../scripts/lib/apply-safety-scan.mjs';

/**
 * WIRING GUARD for the shared file-manager platform e2e implementation
 * (#1282, #1305, #1563 round 2). This is the reusable `workflow_call`
 * workflow that both the nightly (file-manager-platform-e2e-nightly.yml) and
 * the at-tag caller (file-manager-platform-e2e-at-tag.yml) invoke — the
 * step-level assertions that used to live against the nightly file directly
 * (before the two callers were de-duplicated into one implementation) now
 * live here, against the shared file both callers actually run. Each was
 * mutation-proved (delete the behaviour it protects; it goes red).
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e.yml');
const DATA_PLANE = resolve(ROOT, 'apps/file-manager/platform-e2e/data-plane.yaml');
const PROFILE = resolve(ROOT, 'apps/file-manager/platform-e2e/knext.config.e2e.ts');
const REAL_CONFIG = resolve(ROOT, 'apps/file-manager/knext.config.ts');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  [k: string]: unknown;
};
type Job = { steps: Step[]; needs?: string[]; if?: string; [k: string]: unknown };
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as {
  on: { workflow_call?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> } };
  jobs: Record<string, Job>;
};
const check = wf.jobs['platform-e2e'];

describe('file-manager platform e2e (reusable) - wiring', () => {
  it('triggers on workflow_call ONLY - it is never run directly', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
  });

  it("accepts a `ref` input (empty default = the caller's own commit) and a `cluster-name` input", () => {
    const inputs = wf.on.workflow_call?.inputs as
      | Record<string, { type?: string; default?: string }>
      | undefined;
    expect(inputs).toBeDefined();
    expect(inputs?.ref?.type).toBe('string');
    expect(inputs?.ref?.default).toBe('');
    expect(inputs?.['cluster-name']?.type).toBe('string');
  });

  it('exposes the operator image digest as a workflow_call output, wired to the build-operator step', () => {
    const outputs = wf.on.workflow_call?.outputs as Record<string, { value?: string }> | undefined;
    expect(outputs?.['operator-image-digest']?.value).toBe(
      '${{ jobs.platform-e2e.outputs.operator-image-digest }}',
    );
    expect(check.outputs).toMatchObject({
      'operator-image-digest': '${{ steps.build-operator.outputs.operator-image-digest }}',
    });
  });

  it('the check job is fail-closed: no continue-on-error anywhere, no `if:` on the suite step', () => {
    expect(text).not.toMatch(/continue-on-error/);
    const suite = check.steps.find((s) => (s.run ?? '').includes('platform-e2e.mjs'));
    expect(suite).toBeDefined();
    expect(suite?.if).toBeUndefined();
  });

  it('runs the deploy through the product CLI, and no hand-written Knative apply', () => {
    const deploy = check.steps.find((s) => (s.run ?? '').includes('kn-next.js deploy'));
    expect(deploy).toBeDefined();
    for (const s of check.steps) {
      expect(s.run ?? '').not.toMatch(/kind:\s*Service\b|serving\.knative\.dev\/v1/);
    }
  });

  it('runs the harness self-test BEFORE the cluster suite', () => {
    const idx = (needle: string) => check.steps.findIndex((s) => (s.run ?? '').includes(needle));
    const selftest = idx('platform-e2e.selftest.mjs');
    expect(selftest).toBeGreaterThanOrEqual(0);
    expect(selftest).toBeLessThan(idx('scripts/platform-e2e.mjs'));
  });

  it('states a budget: a timeout, and a documented expectation', () => {
    expect(typeof (check as unknown as { 'timeout-minutes': number })['timeout-minutes']).toBe(
      'number',
    );
    expect(text).toMatch(/BUDGET:/);
  });

  it('every third-party action is pinned by 40-hex SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(3);
    for (const [, ref, rest] of uses) {
      // #2106: the repo's own first-party mirror composite is the one local action.
      if (ref === './.github/actions/docker-hub-mirror') continue;
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d/);
    }
  });

  it('every container image (workflow + data plane) is digest-pinned', () => {
    const images = [
      ...text.matchAll(/(?:image:\s*|docker run [^\n]*\\\n\s*|CURL_IMAGE:\s*)(\S+:\S+)/g),
      ...readFileSync(DATA_PLANE, 'utf8').matchAll(/image:\s*(\S+)/g),
    ].map((m) => m[1]);
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const img of images) expect(img).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(text).toMatch(/registry:2\.8\.3@sha256:[0-9a-f]{64}/);
  });

  it('every cluster manifest is sha256-verified before it is applied', () => {
    // The fetch + checksum + digest-pin now lives in the shared kind-manifest
    // scripts (#1289); this workflow must delegate to them rather than
    // download release assets inline…
    expect(text).toContain('scripts/kind-manifests/apply-cert-manager.sh');
    expect(text).toContain('scripts/kind-manifests/apply-knative-kourier.sh');
    expect(text).not.toMatch(/releases\/download\//);
    // …and the fail-closed apply-safety scanner (the same one
    // kind-manifest-checksum-pin.test.ts runs over the whole tree) must find
    // nothing unverified in any of its jobs.
    expect(unsafeAppliesInWorkflow(wf)).toEqual([]);
  });

  it('secrets are created per run from random values and masked, never committed', () => {
    const setup = check.steps.find((s) => (s.run ?? '').includes('create secret'));
    expect(setup?.run).toContain('openssl rand');
    expect(setup?.run).toContain('::add-mask::');
  });

  it('never interpolates `${{ inputs.* }}` directly into a `run:` script - always via env:', () => {
    for (const s of check.steps) {
      expect(s.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it('the `ref` input is consumed via env: in the ref-resolution step, and the resolved ref feeds checkout', () => {
    const resolveStep = check.steps.find(
      (s) => s.name === "Resolve checkout ref (input or this run's own commit)",
    );
    expect(resolveStep?.env?.REF_INPUT).toBe('${{ inputs.ref }}');
    expect(resolveStep?.run).toContain('REF_INPUT');
    const checkoutStep = check.steps.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkoutStep?.with).toMatchObject({ ref: '${{ steps.resolve-ref.outputs.ref }}' });
  });
});

describe('file-manager platform e2e (reusable) - operator image digest is the DEPLOYED image', () => {
  const buildOperator = check.steps.find((s) => s.id === 'build-operator');

  it('the build-operator step exists and builds via the Makefile', () => {
    expect(buildOperator).toBeDefined();
    expect(buildOperator?.run).toContain('make docker-build');
  });

  it('pushes the image to a registry BEFORE reading its digest - never `docker inspect` on an unpushed local build', () => {
    const run = String(buildOperator?.run);
    const pushIdx = run.indexOf('make docker-push');
    const inspectIdx = run.indexOf('docker inspect');
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(inspectIdx).toBeGreaterThan(pushIdx);
  });

  it('fails closed (no silent empty digest) if the push digest cannot be captured', () => {
    const run = String(buildOperator?.run);
    const afterInspect = run.slice(run.indexOf('docker inspect'));
    expect(afterInspect).toMatch(/if \[ -z "\$PUSH_DIGEST" \][\s\S]*?exit 1/);
  });

  it('deploys BEFORE reading the pod imageID (rollout must complete first)', () => {
    const run = String(buildOperator?.run);
    const deployIdx = run.indexOf('make deploy');
    const rolloutIdx = run.indexOf('kubectl rollout status');
    const podImageIdx = run.indexOf('POD_IMAGE_ID=');
    expect(deployIdx).toBeGreaterThanOrEqual(0);
    expect(rolloutIdx).toBeGreaterThan(deployIdx);
    expect(podImageIdx).toBeGreaterThan(rolloutIdx);
  });

  it("reads the digest from the DEPLOYED pod's own imageID (containerStatuses), not just the push", () => {
    const run = String(buildOperator?.run);
    expect(run).toMatch(/status\.containerStatuses\[\?\(@\.name=="manager"\)\]\.imageID/);
    expect(run).toMatch(/control-plane=controller-manager/);
    expect(run).toContain('-n kn-next-operator-system');
  });

  it('cross-checks the pod imageID against the push digest and fails closed on a mismatch', () => {
    const run = String(buildOperator?.run);
    expect(run).toMatch(/case "\$POD_IMAGE_ID" in/);
    expect(run).toMatch(/\*"\$PUSH_DIGEST"\*\)/);
    // The mismatch (default) arm must error and exit non-zero.
    const caseBlock = run.slice(run.indexOf('case "$POD_IMAGE_ID" in'), run.indexOf('esac') + 4);
    expect(caseBlock).toMatch(/::error::[\s\S]*exit 1/);
  });

  it('the job output is the push-captured (and cross-checked) digest, never a hardcoded/empty value', () => {
    const run = String(buildOperator?.run);
    expect(run).toMatch(/echo "operator-image-digest=\$PUSH_DIGEST" >> "\$GITHUB_OUTPUT"/);
  });
});

describe('platform e2e runner - no unbounded child process', () => {
  const runner = readFileSync(resolve(ROOT, 'apps/file-manager/scripts/platform-e2e.mjs'), 'utf8');
  it('every execFileSync call carries a timeout', () => {
    const calls = [...runner.matchAll(/execFileSync\(/g)].length;
    const bounded = [...runner.matchAll(/\btimeout:\s*\w+/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(bounded).toBeGreaterThanOrEqual(calls);
  });
  it('the rollout deploy spawn is killed on a deadline', () => {
    expect(runner).toMatch(/spawn\([\s\S]*?setTimeout\([\s\S]*?kill\('SIGKILL'\)/);
  });
});

describe('platform e2e config profile', () => {
  const norm = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const keys = (src: string) =>
    [...norm(src).matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();

  it('differs from the real config only in storage/registry/cache/database', () => {
    const real = keys(readFileSync(REAL_CONFIG, 'utf8'));
    const prof = keys(readFileSync(PROFILE, 'utf8'));
    const allowed = new Set(['storage', 'registry', 'cache', 'database']);
    const onlyReal = real.filter((k) => !prof.includes(k));
    const onlyProf = prof.filter((k) => !real.includes(k));
    for (const k of [...onlyReal, ...onlyProf]) expect(allowed.has(k)).toBe(true);
    expect(onlyReal).toContain('storage');
  });

  it('non-differing keys are byte-identical', () => {
    const block = (src: string, key: string) =>
      new RegExp(`^ {2}${key}:[\\s\\S]*?(?=^ {2}[a-zA-Z]+:|^\\};?$)`, 'm')
        .exec(norm(src))?.[0]
        .replace(/\s+/g, ' ')
        .trim();
    const real = readFileSync(REAL_CONFIG, 'utf8');
    const prof = readFileSync(PROFILE, 'utf8');
    for (const k of ['name', 'infrastructure', 'scaling', 'observability', 'secrets']) {
      expect(block(prof, k)).toBeDefined();
      expect(block(prof, k)).toBe(block(real, k));
    }
  });
});

describe('platform e2e harness self-test', () => {
  it('passes: every check is green when healthy and red on each defect', () => {
    const r = spawnSync('node', ['apps/file-manager/scripts/platform-e2e.selftest.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.stdout + r.stderr).toContain('goes red on each defect');
    expect(r.status).toBe(0);
  });
});
