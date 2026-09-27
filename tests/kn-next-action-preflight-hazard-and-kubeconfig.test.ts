import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Two refusals #1533 adds to `packages/kn-next-action/preflight.mjs`, tested
 * separately from `kn-next-action-preflight.test.ts` (which owns the
 * pre-existing #874/#1493/#1500 behaviour) to keep blast radius disjoint:
 *
 *   1. (#1495 fix) the fail-OPEN replacement — a `SelfSubjectRulesReview`
 *      that reports `incomplete: true` with EMPTY `resourceRules` (the exact
 *      shape a webhook-authorized cluster returns) used to pass the rules
 *      classifier trivially, because `classifyCredentialScope([])` finds
 *      nothing to complain about. The `SelfSubjectAccessReview`
 *      hazard-check spot-check must now catch an over-broad credential in
 *      EXACTLY that scenario, and must also refuse if the spot-check itself
 *      cannot run.
 *   2. (ADR-0061) an exec-plugin / auth-provider kubeconfig is refused with
 *      the exact #1533 sentence, BEFORE any kubectl call — proved by never
 *      installing a `kubectl` on PATH at all for that case.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = join(REPO_ROOT, 'packages/kn-next-action/preflight.mjs');
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

/** An app dir with stub `credential-scope` + `kubeconfig-safety` modules. */
function appWithStubCore(): string {
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
  // Passes every rule set — this describe block is about the ACCESS review,
  // not the rules classifier, so the rules half is deliberately inert.
  writeFileSync(
    join(core, 'scope.js'),
    'export function classifyCredentialScope() { return { ok: true, findings: [], remedy: "apply the published Role" }; }\n',
  );
  // A minimal STAND-IN classifier — no `yaml` dependency in the fake app's
  // node_modules, so it matches structurally on the two keys via a cheap
  // per-line scan rather than a full YAML parse. `ci-kubeconfig-safety.test.ts`
  // (packages/kn-next) exercises the REAL, published classifier; this file
  // is only proving the WIRING (preflight.mjs calls it, refuses before any
  // kubectl call, prints the exact sentence).
  writeFileSync(
    join(core, 'kubeconfig-safety.js'),
    [
      `const REFUSAL = ${JSON.stringify(CLOUD_CREDENTIAL_REFUSAL)};`,
      'export function classifyKubeconfigSafety(text) {',
      '  if (/^\\s*exec:/m.test(text) || /^\\s*auth-provider:/m.test(text)) {',
      '    return { ok: false, reason: REFUSAL };',
      '  }',
      '  return { ok: true };',
      '}',
      '',
    ].join('\n'),
  );
  return app;
}

/**
 * kubectl stub: `SelfSubjectRulesReview` always answers `incomplete: true`
 * with EMPTY resourceRules (the exact #1495 webhook-authorizer shape).
 * `SelfSubjectAccessReview` calls are routed by `accessReviewAllowed`.
 */
function stubKubectlForHazardTest(opts: { accessReviewAllowed: boolean | 'unreachable' }): string {
  const dir = tempDir('knext-preflight-hz-bin-');
  const bin = join(dir, 'kubectl');
  const INCOMPLETE_REVIEW = JSON.stringify({
    status: {
      resourceRules: [],
      incomplete: true,
      evaluationError: 'webhook authorizer does not support user rule resolution',
    },
  });
  const accessResponse =
    opts.accessReviewAllowed === 'unreachable'
      ? 'echo "error: could not reach apiserver" >&2\n    exit 1'
      : `echo '{"status":{"allowed":${opts.accessReviewAllowed === true}}}'\n    exit 0`;
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'body="$(cat)"',
      'case "$body" in',
      '  *SelfSubjectAccessReview*)',
      `    ${accessResponse}`,
      '    ;;',
      '  *SelfSubjectRulesReview*)',
      `    echo '${INCOMPLETE_REVIEW}'`,
      '    exit 0',
      '    ;;',
      'esac',
      'echo "kubectl-stub: unrecognized invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return dir;
}

function runPreflight(cwd: string, kubectlDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [PREFLIGHT, '--namespace', 'ns'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${kubectlDir}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
}

describe('#1495 fix — hazardous-permission SelfSubjectAccessReview spot-check', () => {
  it('an incomplete rules review with EMPTY resourceRules (the old fail-open shape) still PASSES when every hazard check is denied', () => {
    const app = appWithStubCore();
    const kubectlDir = stubKubectlForHazardTest({ accessReviewAllowed: false });
    const r = runPreflight(app, kubectlDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('correctly scoped');
    expect(r.stderr).toContain('::warning::');
    expect(r.stderr).toContain('incomplete');
  });

  it('the SAME incomplete/empty rules review is now REFUSED when a hazard check reports allowed:true — the exact #1495 fail-open scenario, fixed', () => {
    const app = appWithStubCore();
    const kubectlDir = stubKubectlForHazardTest({ accessReviewAllowed: true });
    const r = runPreflight(app, kubectlDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'This kubeconfig can do things far outside what knext needs. Refusing to use it.',
    );
  });

  it('refuses, fail-CLOSED, when the hazard spot-check itself cannot run', () => {
    const app = appWithStubCore();
    const kubectlDir = stubKubectlForHazardTest({ accessReviewAllowed: 'unreachable' });
    const r = runPreflight(app, kubectlDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'Could not run the hazardous-permission spot-check (SelfSubjectAccessReview)',
    );
  });
});

describe('ADR-0061/#1533 — exec-plugin/auth-provider kubeconfig refused BEFORE any cluster call', () => {
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

  it('refuses with the EXACT sentence and NEVER invokes kubectl at all', () => {
    const app = appWithStubCore();
    const kubeconfigDir = tempDir('knext-preflight-kubeconfig-');
    const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
    writeFileSync(kubeconfigPath, EXEC_KUBECONFIG);

    // No kubectl anywhere on PATH: if the code reached a kubectl call it
    // would fail with "command not found" (or a shell error), not this
    // refusal — so a passing assertion on the refusal text also proves
    // kubectl was never invoked. `process.execPath` (an ABSOLUTE path) is
    // used to launch the script itself so an EMPTY child PATH cannot also
    // prevent the interpreter from being found.
    const r = spawnSync(process.execPath, [PREFLIGHT, '--namespace', 'ns'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, PATH: '', KUBECONFIG: kubeconfigPath },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(CLOUD_CREDENTIAL_REFUSAL);
  });

  it('a plain bearer-token kubeconfig proceeds past this check to the cluster calls', () => {
    const app = appWithStubCore();
    const kubeconfigDir = tempDir('knext-preflight-kubeconfig-ok-');
    const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
    writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);
    const kubectlDir = stubKubectlForHazardTest({ accessReviewAllowed: false });

    const r = runPreflight(app, kubectlDir, { KUBECONFIG: kubeconfigPath });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('correctly scoped');
  });

  it('is a no-op when KUBECONFIG is not set at all (existing callers unaffected)', () => {
    const app = appWithStubCore();
    const kubectlDir = stubKubectlForHazardTest({ accessReviewAllowed: false });
    const r = runPreflight(app, kubectlDir);
    expect(r.status).toBe(0);
  });
});
