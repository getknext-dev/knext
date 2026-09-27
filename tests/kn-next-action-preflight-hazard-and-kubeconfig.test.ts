import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  LEAK_SENTINEL_PREFIX,
  MALFORMED_TOKEN_KUBECONFIGS,
} from '../packages/kn-next/src/__tests__/helpers/malformed-kubeconfigs';

/**
 * The two refusals #1533 adds to the kn-next action, tested separately from
 * `kn-next-action-preflight.test.ts` (which owns the #874/#1493/#1500
 * rules-review behaviour):
 *
 *   1. (#1495) the hazardous-permission SelfSubjectAccessReview spot-check in
 *      `preflight.mjs`, against a fake kubectl that answers like a
 *      webhook-authorized cluster (OKE/GKE IAM): the rules review comes back
 *      `incomplete` and EMPTY, and access reviews answer per GRANTS. The probe
 *      set is the REAL one — `hazardProbes()` from `credential-scope.ts` —
 *      so these tests exercise what ships, not a stand-in list.
 *   2. (ADR-0061) the cloud-credential kubeconfig refusal in
 *      `kubeconfig-check.mjs`, with the REAL classifier — a separate action
 *      step that `skip-credential-preflight` cannot reach (proved by running
 *      the action's own step scripts with the skip input on).
 *
 * The scripts run under `process.execPath` (bun in this suite), which loads
 * the TypeScript sources directly — no built dist needed.
 */

// Each preflight run submits ~40 access reviews, one fake-kubectl process
// each; under a loaded runner (or the mutation prover) that exceeds bun's
// 5 s default. Measured: 1 of 3 back-to-back runs timed out at 5 s.
setDefaultTimeout(30_000);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ACTION_DIR = join(REPO_ROOT, 'packages/kn-next-action');
const PREFLIGHT = join(ACTION_DIR, 'preflight.mjs');
const KUBECONFIG_CHECK = join(ACTION_DIR, 'kubeconfig-check.mjs');
const CORE_SRC = join(REPO_ROOT, 'packages/kn-next/src/cli/ci');
const CLOUD_CREDENTIAL_REFUSAL =
  'This kubeconfig needs cloud-account credentials on the runner. Use the knext-deployer ServiceAccount token.';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An app dir whose `@getknext/core` re-exports the REAL classifiers from
 * source. The rules classifier is deliberately inert (always ok) — the rules
 * half is `kn-next-action-preflight.test.ts`'s — but `hazardProbes` and
 * `classifyKubeconfigSafety` are the shipped ones.
 */
function appWithRealCore(opts: { withHazardProbes?: boolean } = {}): string {
  const app = tempDir('knext-preflight-hz-app-');
  writeFileSync(join(app, 'package.json'), '{"name":"app","private":true}\n');
  const core = join(app, 'node_modules/@getknext/core');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    JSON.stringify({
      name: '@getknext/core',
      type: 'module',
      exports: {
        './internal/credential-scope': './scope.js',
        './internal/kubeconfig-safety': './kubeconfig-safety.js',
      },
    }),
  );
  writeFileSync(
    join(core, 'scope.js'),
    [
      'export function classifyCredentialScope() { return { ok: true, findings: [], remedy: "apply the published Role" }; }',
      opts.withHazardProbes === false
        ? ''
        : `export { hazardProbes } from ${JSON.stringify(join(CORE_SRC, 'credential-scope.ts'))};`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(core, 'kubeconfig-safety.js'),
    `export { classifyKubeconfigSafety } from ${JSON.stringify(join(CORE_SRC, 'kubeconfig-safety.ts'))};\n`,
  );
  return app;
}

/**
 * A fake kubectl for a webhook-authorized cluster. Rules review: `incomplete`,
 * EMPTY resourceRules. Access review: allowed iff a GRANTS entry
 * `group|resource[/sub]|verb|ns` matches (any field `*`; ns `*` = every
 * namespace AND cluster-wide; a concrete ns matches only a review naming it).
 * SSAR_MODE simulates a review that does not complete.
 */
const FAKE_KUBECTL_JS = `
import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(0, 'utf8'));
const mode = process.env.SSAR_MODE || 'normal';
if (body.kind === 'SelfSubjectRulesReview') {
  process.stdout.write(JSON.stringify({ status: { incomplete: true,
    evaluationError: 'webhook authorizer does not support user rule resolution', resourceRules: [] } }));
  process.exit(0);
}
if (mode === 'error') { process.stderr.write('Error from server (InternalError)\\n'); process.exit(1); }
if (mode === 'nostatus') { process.stdout.write('{}'); process.exit(0); }
if (mode === 'allowed_string') { process.stdout.write(JSON.stringify({ status: { allowed: 'true' } })); process.exit(0); }
if (mode === 'evalerr') { process.stdout.write(JSON.stringify({ status: { allowed: false, evaluationError: 'webhook timeout' } })); process.exit(0); }
if (mode === 'nonjson') { process.stdout.write('<html>502 bad gateway</html>'); process.exit(0); }
const a = body.spec.resourceAttributes;
const res = a.subresource ? a.resource + '/' + a.subresource : a.resource;
const m = (g, v) => g === '*' || g === v;
const allowed = (process.env.GRANTS || '').split(',').filter(Boolean).some((s) => {
  const [g, r, v, ns] = s.split('|');
  return m(g, a.group) && m(r, res) && m(v, a.verb) && (ns === '*' || (a.namespace !== undefined && a.namespace === ns));
});
process.stdout.write(JSON.stringify({ status: { allowed } }));
`;

function fakeKubectl(): string {
  const dir = tempDir('knext-preflight-hz-bin-');
  writeFileSync(join(dir, 'fake-kubectl.mjs'), FAKE_KUBECTL_JS);
  const bin = join(dir, 'kubectl');
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'fake-kubectl.mjs'))} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

const NS = 'demo';
/** Exactly the published Role, bound in `demo` — what `kn-next init-ci` sets up. */
const ROLE = ['get', 'list', 'create', 'patch', 'update']
  .map((v) => `apps.kn-next.dev|nextapps|${v}|${NS}`)
  .join(',');

function runPreflight(app: string, env: Record<string, string> = {}) {
  const env0: Record<string, string | undefined> = { ...process.env };
  delete env0.KUBECONFIG;
  return spawnSync(process.execPath, [PREFLIGHT, '--namespace', NS], {
    cwd: app,
    encoding: 'utf8',
    env: { ...env0, PATH: `${fakeKubectl()}:${process.env.PATH ?? ''}`, ...env },
  });
}

describe('#1495 — hazard spot-check on a webhook-authorized (OKE-style) cluster', () => {
  it('passes a credential granted exactly the published Role in its namespace', () => {
    const r = runPreflight(appWithRealCore(), { GRANTS: ROLE });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('correctly scoped');
    expect(r.stderr).toContain('incomplete');
  });

  const broader: Array<[string, string]> = [
    ['a Role verb granted in a FOREIGN namespace', 'apps.kn-next.dev|nextapps|patch|kube-system'],
    ['nextapps granted cluster-wide', 'apps.kn-next.dev|nextapps|create|*'],
    [
      'deletecollection on nextapps (outside the Role)',
      `apps.kn-next.dev|nextapps|deletecollection|${NS}`,
    ],
    ['create pods/exec', `|pods/exec|create|${NS}`],
    ['create serviceaccounts', `|serviceaccounts|create|${NS}`],
    ['patch deployments cluster-wide', 'apps|deployments|patch|*'],
    ['list secrets', `|secrets|list|${NS}`],
    ['watch secrets', `|secrets|watch|${NS}`],
    ['escalate clusterroles', 'rbac.authorization.k8s.io|clusterroles|escalate|*'],
    ['bind clusterroles', 'rbac.authorization.k8s.io|clusterroles|bind|*'],
    ['create rolebindings', `rbac.authorization.k8s.io|rolebindings|create|${NS}`],
    ['impersonate serviceaccounts', '|serviceaccounts|impersonate|*'],
    ['*/*/*', '*|*|*|*'],
  ];
  for (const [label, grant] of broader) {
    it(`refuses the Role plus ${label}`, () => {
      const r = runPreflight(appWithRealCore(), { GRANTS: `${ROLE},${grant}` });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('This kubeconfig can do things far outside what knext needs.');
    });
  }

  const noVerdict: Array<[string, string]> = [
    ['the review errors', 'error'],
    ['the reply has no status', 'nostatus'],
    ['allowed is the STRING "true"', 'allowed_string'],
    ['the reply carries an evaluationError', 'evalerr'],
    ['the reply is not JSON', 'nonjson'],
  ];
  for (const [label, mode] of noVerdict) {
    it(`refuses, fail-CLOSED, when ${label}`, () => {
      const r = runPreflight(appWithRealCore(), { GRANTS: ROLE, SSAR_MODE: mode });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'Could not run the hazardous-permission spot-check (SelfSubjectAccessReview)',
      );
    });
  }

  it('refuses when @getknext/core predates the derived probe set', () => {
    const r = runPreflight(appWithRealCore({ withHazardProbes: false }), { GRANTS: ROLE });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not provide the credential classifier and hazard probe set');
  });
});

const EXEC_KUBECONFIG = [
  'apiVersion: v1',
  'kind: Config',
  'users:',
  '  - name: admin',
  '    user:',
  '      exec:',
  '        command: aws',
  'contexts: []',
  '',
].join('\n');

const MERGE_KEY_KUBECONFIG = [
  'x: &a',
  '  exec: {command: aws, apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never}',
  'apiVersion: v1',
  'kind: Config',
  'users:',
  '- name: u',
  '  user:',
  '    <<: *a',
  '',
].join('\n');

const TOKEN_KUBECONFIG = [
  'apiVersion: v1',
  'kind: Config',
  'users:',
  '  - name: knext-deployer',
  '    user:',
  '      token: abc',
  'contexts: []',
  '',
].join('\n');

function writeKubeconfig(text: string): string {
  const path = join(tempDir('knext-kubeconfig-'), 'kubeconfig');
  writeFileSync(path, text);
  return path;
}

/** Runs kubeconfig-check.mjs with NO kubectl reachable (PATH is empty). */
function runKubeconfigCheck(app: string, kubeconfig: string | undefined) {
  const env: Record<string, string | undefined> = { ...process.env, PATH: '' };
  if (kubeconfig === undefined) delete env.KUBECONFIG;
  else env.KUBECONFIG = kubeconfig;
  return spawnSync(process.execPath, [KUBECONFIG_CHECK], { cwd: app, encoding: 'utf8', env });
}

describe('ADR-0061/#1533 — kubeconfig-check.mjs, before any cluster call', () => {
  it('refuses an exec kubeconfig with the EXACT sentence, with no kubectl on PATH', () => {
    const r = runKubeconfigCheck(appWithRealCore(), writeKubeconfig(EXEC_KUBECONFIG));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`::error::${CLOUD_CREDENTIAL_REFUSAL}`);
  });

  it('refuses an exec block injected through a YAML merge key', () => {
    const r = runKubeconfigCheck(appWithRealCore(), writeKubeconfig(MERGE_KEY_KUBECONFIG));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(CLOUD_CREDENTIAL_REFUSAL);
  });

  it('passes a plain bearer-token kubeconfig', () => {
    const r = runKubeconfigCheck(appWithRealCore(), writeKubeconfig(TOKEN_KUBECONFIG));
    expect(r.status).toBe(0);
  });

  it('refuses, fail-CLOSED, when KUBECONFIG is not set at all', () => {
    const r = runKubeconfigCheck(appWithRealCore(), undefined);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('KUBECONFIG is unset');
  });

  for (const [name, text] of Object.entries(MALFORMED_TOKEN_KUBECONFIGS)) {
    it(`${name}: a malformed kubeconfig is refused and the ::error:: line carries no token bytes`, () => {
      const r = runKubeconfigCheck(appWithRealCore(), writeKubeconfig(text));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error::could not parse this file as a kubeconfig');
      expect(`${r.stdout}${r.stderr}`).not.toContain(LEAK_SENTINEL_PREFIX);
    });
  }
});

/**
 * The action's own step scripts, executed. `skip-credential-preflight: true`
 * must not let a cloud-credential kubeconfig through: the kubeconfig step has
 * no skip branch, so it refuses before the (skipped) preflight is reached.
 */
describe('action.yml — the kubeconfig check is not reachable by skip-credential-preflight', () => {
  type Step = {
    name?: string;
    if?: string;
    env?: Record<string, string>;
    run?: string;
    'continue-on-error'?: boolean;
  };
  const action = parse(readFileSync(join(ACTION_DIR, 'action.yml'), 'utf8')) as {
    runs: { steps: Step[] };
  };
  const steps = action.runs.steps;
  const kubeStep = steps.find((s) => s.name === 'Kubeconfig check');
  const preflightStep = steps.find((s) => s.name === 'Credential preflight');

  /** Execute one composite step's `run:` under bash, the way the runner would. */
  function runStep(step: Step | undefined, app: string, env: Record<string, string>) {
    // `node` -> this test's own runtime, so the re-exported TypeScript sources
    // load whatever node version the CI image carries.
    const script = String(step?.run ?? 'exit 99')
      .replaceAll('${{ github.action_path }}', ACTION_DIR)
      .replaceAll(/^(\s*)node /gm, `$1${JSON.stringify(process.execPath)} `);
    return spawnSync('bash', ['-c', script], {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        PATH: `${join(process.execPath, '..')}:${process.env.PATH ?? ''}`,
      },
    });
  }

  it('the kubeconfig step runs before the credential preflight, unconditionally', () => {
    expect(kubeStep).toBeDefined();
    expect(preflightStep).toBeDefined();
    expect(steps.indexOf(kubeStep as Step)).toBeLessThan(steps.indexOf(preflightStep as Step));
    expect(kubeStep?.if).toBeUndefined();
    expect(JSON.stringify(kubeStep)).not.toMatch(/skip/i);
    // N3 (review of #1557, round 2): `continue-on-error: true` is a SECOND
    // way to make this "non-skippable" step not actually block anything — it
    // logs the refusal and the job carries on to deploy anyway. No `if:` is
    // not the whole guarantee; this must hold too.
    expect(kubeStep?.['continue-on-error']).toBeUndefined();
  });

  it('with skip-credential-preflight on, an exec kubeconfig is STILL refused by the step scripts', () => {
    const app = appWithRealCore();
    const env = {
      KUBECONFIG: writeKubeconfig(EXEC_KUBECONFIG),
      KNEXT_SKIP_PREFLIGHT: 'true',
      KNEXT_NAMESPACE: NS,
    };
    // The preflight step alone, skipped, exits 0 — the hatch works as documented…
    expect(runStep(preflightStep, app, env).status).toBe(0);
    // …and the kubeconfig step, which the hatch does not reach, refuses.
    const r = runStep(kubeStep, app, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(CLOUD_CREDENTIAL_REFUSAL);
  });
});
