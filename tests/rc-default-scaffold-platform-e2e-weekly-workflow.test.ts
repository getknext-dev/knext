import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the G1 weekly default-scaffold platform e2e (#1732).
 *
 * This lane is the first real-cluster lane to deploy the ACTUAL v1.0 default
 * cell (turbopack build x bun compiled single-executable runtime) rather
 * than apps/file-manager (a `build: 'vinext'` app). Each test below pins one
 * contract the lane must hold, read from the PARSED workflow — never a text
 * substring check, so a semantically-equivalent rewrite cannot silently drop
 * the property under test.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF_PATH = resolve(ROOT, '.github/workflows/rc-default-scaffold-platform-e2e-weekly.yml');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  [k: string]: unknown;
};
type Job = {
  steps?: Step[];
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  [k: string]: unknown;
};

const text = readFileSync(WF_PATH, 'utf8');
const wf = parse(text) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const resolveJob = wf.jobs['resolve-git-ref'];
const mainJob = wf.jobs['rc-scaffold-platform-e2e'];
const evidenceJob = wf.jobs['record-evidence'];

function allSteps(): Step[] {
  return Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
}

function stepByName(name: string): Step | undefined {
  return allSteps().find((s) => s.name === name);
}

describe('rc-default-scaffold-platform-e2e-weekly — triggers, scheduling, required-ness', () => {
  it('triggers ONLY on schedule + workflow_dispatch — never a PR/push/merge_group gate', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('is weekly (exactly one schedule entry)', () => {
    const schedule = wf.on['schedule'] as { cron: string }[];
    expect(schedule).toHaveLength(1);
    // day-of-week is a single literal 0-6, not "*" (daily) — M H * * D.
    const parts = schedule[0].cron.trim().split(/\s+/);
    expect(parts).toHaveLength(5);
    expect(parts[2]).toBe('*');
    expect(parts[3]).toBe('*');
    expect(parts[4]).not.toBe('*');
  });

  it('is off every credential slot (22:17/23:47/01:17/03:17/04:47/05:47 UTC) and its ~1h runtime window', () => {
    const schedule = wf.on['schedule'] as { cron: string }[];
    const [minuteStr, hourStr] = schedule[0].cron.trim().split(/\s+/);
    const minute = Number(minuteStr);
    const hour = Number(hourStr);
    const fired = hour * 60 + minute;
    const credentialSlots = ['22:17', '23:47', '01:17', '03:17', '04:47', '05:47'].map((hm) => {
      const [h, m] = hm.split(':').map(Number);
      return h * 60 + m;
    });
    for (const slot of credentialSlots) {
      // 1h grace window either side of the slot start.
      const diff = Math.min(
        Math.abs(fired - slot),
        1440 - Math.abs(fired - slot), // wrap across midnight
      );
      expect(diff).toBeGreaterThanOrEqual(60);
    }
  });

  it('accepts a git-ref dispatch input defaulting to rcTag from .github/compat-credential-ref.json', () => {
    const dispatch = wf.on['workflow_dispatch'] as { inputs?: Record<string, unknown> };
    expect(dispatch?.inputs).toHaveProperty('git-ref');
    expect(text).toMatch(/\.github\/compat-credential-ref\.json/);
    expect(text).toMatch(/rcTag/);
  });

  it('never interpolates `${{ inputs.* }}` directly into any run: script', () => {
    for (const job of Object.values(wf.jobs)) {
      for (const s of job.steps ?? []) {
        expect(s.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
      }
    }
  });

  it('is not added to any merge_group/required-checks surface (no such trigger exists here)', () => {
    expect(wf.on).not.toHaveProperty('pull_request');
    expect(wf.on).not.toHaveProperty('push');
    expect(wf.on).not.toHaveProperty('merge_group');
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — scaffolds from npm @rc, not repo source', () => {
  it('scaffolds with npx @getknext/core@rc create — never a repo-source CLI invocation for the scaffold', () => {
    const step = stepByName('Scaffold a brand-new app with the published @rc CLI (no repo source)');
    expect(step).toBeDefined();
    expect(String(step?.run)).toMatch(/npx --yes @getknext\/core@rc create\b/);
    expect(String(step?.run)).not.toMatch(/dist\/cli\/kn-next\.js/);
    expect(String(step?.run)).not.toMatch(/packages\/kn-next\/src/);
  });

  it("npm installs the scaffolded app so the deploy step resolves @rc from the app's own node_modules", () => {
    const step = stepByName('npm install the scaffolded app (resolves @getknext/core@rc for real)');
    expect(step).toBeDefined();
    expect(String(step?.run)).toMatch(/npm install\b/);
    expect(String(step?.run)).toMatch(/node_modules\/@getknext\/core/);
  });

  it('deploys via the locally-resolved published bin (npx knext), not a bundled repo dist path', () => {
    const step = stepByName(
      'kn-next deploy (published CLI, default target, against the kind cluster)',
    );
    expect(step).toBeDefined();
    expect(String(step?.run)).toMatch(/npx knext deploy\b/);
    expect(String(step?.run)).not.toMatch(/dist\/cli\/kn-next\.js/);
  });

  it('never passes --builder to create, nor build/runtime in the generated config — the DEFAULT target', () => {
    const scaffoldStep = stepByName(
      'Scaffold a brand-new app with the published @rc CLI (no repo source)',
    );
    expect(String(scaffoldStep?.run)).not.toMatch(/--builder/);
    const configStep = stepByName(
      'Write the kind-cluster knext.config.ts (default build/runtime, explicit cache/storage)',
    );
    expect(configStep).toBeDefined();
    const configRun = String(configStep?.run);
    expect(configRun).not.toMatch(/\bbuild:\s*["']/);
    expect(configRun).not.toMatch(/\bruntime:\s*["']/);
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — operator built from the resolved rc ref', () => {
  it('resolves the git ref to a peeled commit before the main job depends on it', () => {
    expect(resolveJob.outputs).toMatchObject({
      'git-ref': '${{ steps.resolve.outputs.git-ref }}',
      'git-sha': '${{ steps.resolve.outputs.git-sha }}',
    });
    expect(mainJob.needs).toBe('resolve-git-ref');
  });

  it('checks out the resolved SHA before building the operator image', () => {
    const checkout = mainJob.steps?.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ needs.resolve-git-ref.outputs.git-sha }}');
  });

  it('captures the operator digest from the registry push, cross-checked against the deployed pod imageID', () => {
    const step = mainJob.steps?.find((s) => s.id === 'build-operator');
    expect(step).toBeDefined();
    const run = String(step?.run);
    expect(run).toMatch(/docker-push/);
    expect(run).toMatch(/PUSH_DIGEST/);
    expect(run).toMatch(/containerStatuses/);
    expect(run).toMatch(/operator-image-digest=\$PUSH_DIGEST/);
  });

  it('exposes the digest as a job output the evidence job consumes directly (never re-derives)', () => {
    expect(mainJob.outputs).toMatchObject({
      'operator-image-digest': '${{ steps.build-operator.outputs.operator-image-digest }}',
    });
    const evidenceStep = evidenceJob.steps?.find((s) => s.name === 'Record rc evidence');
    expect(evidenceStep?.env?.OPERATOR_DIGEST).toBe(
      '${{ needs.rc-scaffold-platform-e2e.outputs.operator-image-digest }}',
    );
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — the four assertions are present', () => {
  const assertionsScript = readFileSync(
    resolve(ROOT, 'scripts/rc-scaffold-platform-e2e.mjs'),
    'utf8',
  );

  it('runs the assertion script from the main job', () => {
    const step = mainJob.steps?.find((s) =>
      String(s.run ?? '').includes('rc-scaffold-platform-e2e.mjs'),
    );
    expect(step).toBeDefined();
  });

  it('asserts scale-to-zero then wake', () => {
    expect(assertionsScript).toMatch(/Scale-to-zero/);
    expect(assertionsScript).toMatch(/Wake from zero/);
  });

  it('asserts Redis-backed ISR changes only after an authenticated invalidation', () => {
    expect(assertionsScript).toMatch(/ISR served from Redis/);
    expect(assertionsScript).toMatch(/isr-smoke/);
  });

  it('re-reads the ISR value AFTER the wake and requires the cached value (Redis, not pod memory)', () => {
    const wake = assertionsScript.indexOf("'Wake from zero");
    const survive = assertionsScript.indexOf("'ISR entry survives scale-to-zero");
    expect(wake).toBeGreaterThan(-1);
    expect(survive).toBeGreaterThan(wake);
    expect(assertionsScript).toMatch(/isrAfterInvalidate = after;/);
    expect(assertionsScript).toMatch(/v !== isrAfterInvalidate/);
  });

  it('asserts invalidation rejects without a token and with a wrong token, and succeeds with the right one', () => {
    expect(assertionsScript).toMatch(/noAuth\.status !== 401/);
    expect(assertionsScript).toMatch(/wrongAuth\.status !== 401/);
    expect(assertionsScript).toMatch(/rightAuth\.status !== 200/);
    expect(assertionsScript).toMatch(/\/api\/cache\/invalidate/);
  });

  it('asserts static-asset upload to object storage (MinIO)', () => {
    expect(assertionsScript).toMatch(/Object storage/);
    expect(assertionsScript).toMatch(/_next\/static\//);
  });

  it('fails closed: every required env var is checked via requireEnv, never silently defaulted', () => {
    expect(assertionsScript).toMatch(/function requireEnv/);
    expect(assertionsScript).toMatch(/requireEnv\('RC_E2E_BASE_URL'\)/);
    expect(assertionsScript).toMatch(/requireEnv\('CACHE_INVALIDATE_TOKEN'\)/);
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — MinIO reachability (#1732 run 36808875670 fix)', () => {
  const reach = stepByName('Reach the cluster (kourier-internal + MinIO port-forwards)');
  const bucket = stepByName('Create the MinIO bucket for static assets (anonymous-read)');
  const reachRun = String(reach?.run);
  const bucketRun = String(bucket?.run);

  it('port-forwards MinIO on the same port the bucket step talks to (127.0.0.1:9000)', () => {
    expect(reachRun).toMatch(/port-forward svc\/minio 9000:9000/);
    expect(bucketRun).toMatch(/--endpoint-url http:\/\/127\.0\.0\.1:9000\b/);
  });

  it('verifies MinIO end-to-end through the forward (HTTP health check), not just a bare TCP connect', () => {
    // A bare `exec 3<>/dev/tcp/.../9000` connect-test passed in the failing run
    // (36808875670) while the SPDY tunnel was not yet proxying traffic, so
    // `aws s3 mb` immediately after it hit "Could not connect to the endpoint
    // URL". The fix must verify MinIO's own readiness endpoint THROUGH the
    // port-forward, which only returns 2xx once the tunnel is actually live.
    expect(reachRun).toMatch(/curl\s+-fsS[^\n]*http:\/\/127\.0\.0\.1:9000\/minio\/health\/ready/);
  });

  it('the MinIO readiness wait is bounded and fails loudly on timeout (no silent pass-through)', () => {
    const minioSection = reachRun.slice(reachRun.indexOf('/minio/health/ready'));
    expect(reachRun).toMatch(/for _ in \$\(seq 1 \d+\); do[\s\S]*minio\/health\/ready/);
    expect(minioSection).toMatch(/::error::.*MinIO/);
    expect(minioSection).toMatch(/exit 1/);
  });

  it('still fails loudly if the kourier-internal forward never comes up (not silently skipped)', () => {
    expect(reachRun).toMatch(/::error::.*kourier-internal.*never came up/);
    const kourierSection = reachRun.slice(0, reachRun.indexOf('/minio/health/ready'));
    expect(kourierSection).toMatch(/exit 1/);
  });

  it('never falls back to continue-on-error or `|| true` around the readiness checks', () => {
    expect(reachRun).not.toMatch(/continue-on-error/);
    expect(reachRun).not.toMatch(/\|\|\s*true/);
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — evidence recording', () => {
  it('records the git ref, the peeled commit, the operator digest and the run id', () => {
    const step = evidenceJob.steps?.find((s) => s.name === 'Record rc evidence');
    expect(step?.env).toMatchObject({
      GIT_REF: '${{ needs.resolve-git-ref.outputs.git-ref }}',
      GIT_SHA: '${{ needs.resolve-git-ref.outputs.git-sha }}',
      RUN_ID: '${{ github.run_id }}',
    });
    const run = String(step?.run);
    expect(run).toMatch(/peeled_commit/);
    expect(run).toMatch(/operator_image_digest/);
    expect(run).toMatch(/run_id/);
  });

  it('uploads the evidence as an artifact', () => {
    const upload = evidenceJob.steps?.find((s) => (s.uses ?? '').includes('upload-artifact'));
    expect(upload).toBeDefined();
    expect(upload?.with).toMatchObject({ name: 'rc-scaffold-e2e-evidence' });
  });

  it('fails closed: no continue-on-error anywhere in this file', () => {
    expect(text).not.toMatch(/continue-on-error/);
  });
});

describe('rc-default-scaffold-platform-e2e-weekly — action pins', () => {
  it('every `uses:` third-party action is pinned to a full 40-hex SHA with a version comment', () => {
    const usesLines = text
      .split('\n')
      .filter((l) => /^\s*-?\s*uses:\s*\S+@/.test(l) && !l.includes('./.github/workflows'));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/@[0-9a-f]{40}\s*#\s*v[\w.]+/);
    }
  });
});
