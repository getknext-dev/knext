import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The GitHub Action's credential preflight (`packages/kn-next-action/preflight.mjs`)
 * loads its classifier from `@getknext/core`. It used to `import()` that bare
 * specifier from its OWN file — the action's checkout, which has no
 * node_modules — so the preflight could never load the classifier and failed
 * for every consumer (found dogfooding the docs deploy, #1481). It must resolve
 * from the step's working directory: the app, where `@getknext/core` is
 * installed.
 *
 * Runs the real script against a stub `@getknext/core` in a temp app dir and a
 * fake `kubectl` on PATH, so it needs neither a cluster nor a built dist.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = join(REPO_ROOT, 'packages/kn-next-action/preflight.mjs');
const ACTION = join(REPO_ROOT, 'packages/kn-next-action/action.yml');

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
 * #1883: make a freshly written fake `kubectl` shim EXECUTABLE-BY-CONSTRUCTION
 * before any child can resolve it. `writeFileSync` + `chmodSync` alone leaves a
 * window in which `execve` of the just-written script can fail (`ETXTBSY` while
 * a write fd is still open anywhere in a fork-happy process, or a not-yet-visible
 * mode). preflight.mjs maps ANY exec failure of `kubectl` to the generic
 * "Could not determine what this credential can do" refusal with none of the
 * shim's stderr — exactly the flake's symptom. So: chmod, fsync+close through an
 * explicit fd, then PROBE-exec the shim, retrying only the transient exec errors,
 * so the real run below can never be the first exec of a half-ready file.
 */
function sealShim(bin: string): void {
  chmodSync(bin, 0o755);
  const fd = openSync(bin, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = spawnSync(bin, ['--knext-shim-probe'], { input: '', timeout: 10_000 });
    const code = (probe.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === undefined) return;
    if (code !== 'ETXTBSY' && code !== 'EACCES' && code !== 'ENOENT') {
      throw new Error(`shim ${bin} is not executable: ${code}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`shim ${bin} never became executable (ETXTBSY/EACCES/ENOENT for 2s)`);
}

/**
 * `#1533`/`#1495`: preflight.mjs now also issues `SelfSubjectAccessReview`
 * calls (one per hazard check) at a DIFFERENT raw path, distinguished by
 * BODY content rather than argv — so this stub reads stdin once, routes an
 * access-review request to a fixed "nothing hazardous is allowed" answer
 * (the correctly-scoped-credential scenario every test in THIS describe
 * block represents), and falls through to the original rules-review
 * handling for everything else.
 */
function fakeKubectlDir(): string {
  const dir = tempDir('knext-preflight-bin-');
  const bin = join(dir, 'kubectl');
  // Must answer the form the fix actually invokes (`create --raw <path> -f -`),
  // not the pre-#1500 `create -o json -f -` shape.
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'body="$(cat)"',
      'case "$body" in',
      '  *SelfSubjectAccessReview*)',
      '    echo \'{"status":{"allowed":false}}\'',
      '    exit 0',
      '    ;;',
      'esac',
      'if [ "$1" = "create" ] && [ "$2" = "--raw" ]; then',
      '  echo \'{"status":{"resourceRules":[]}}\'',
      '  exit 0',
      'fi',
      'echo "kubectl-stub: unrecognized invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  sealShim(bin);
  return dir;
}

// Minimal stand-in for the derived probe set (ci-hazard-probes.test.ts owns the real
// one): ONE probe, so the access-review wiring still runs in every test here.
const HAZARD_PROBES_STUB =
  'export function hazardProbes() { return [{ group: "*", resource: "*", verb: "*", label: "wildcard on everything" }]; }\n';

/**
 * An app dir whose node_modules carries stub classifiers that always pass —
 * both `credential-scope` (#874) and `kubeconfig-safety` (#1533), so a test
 * that DOES set KUBECONFIG (none in this describe block do) would not hit
 * "could not load" instead of the behaviour under test.
 */
function appWithStubCore(): string {
  const app = tempDir('knext-preflight-app-');
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
    'export function classifyCredentialScope() { return { ok: true, findings: [], remedy: "" }; }\n' +
      HAZARD_PROBES_STUB,
  );
  writeFileSync(
    join(core, 'kubeconfig-safety.js'),
    'export function classifyKubeconfigSafety() { return { ok: true }; }\n',
  );
  return app;
}

// #1499: no timeout previously — under resource-starved CI concurrency an
// unbounded spawnSync can only ever fail fast or hang the whole job forever;
// this makes "hang" impossible and turns it into a loud, attributable
// failure instead (never observed to hang here, but a bound costs nothing).
const PREFLIGHT_TIMEOUT_MS = 60_000;

function runPreflight(cwd: string) {
  return spawnSync('node', [PREFLIGHT, '--namespace', 'ns'], {
    cwd,
    encoding: 'utf8',
    timeout: PREFLIGHT_TIMEOUT_MS,
    env: { ...process.env, PATH: `${fakeKubectlDir()}:${process.env.PATH ?? ''}` },
  });
}

/**
 * #1499: every assertion on a `runPreflight`/`run` result below prints the
 * child's own stdout/stderr/status/signal on failure — the CI flake this
 * closes (run 36302339979, job 108572201855: `r.stdout` was `""`, and
 * `r.stderr` did NOT contain the classifier-load message, meaning the
 * process failed EARLIER, at the `SelfSubjectRulesReview` kubectl-exec step
 * — but the assertion alone gave no way to tell that from anywhere else the
 * process could have failed) reproduces under NO local stress this fix
 * could apply (single-file 15x concurrent, fd-limited (`ulimit -n 256`)
 * 30-way full-suite runs, 4 plain full-suite runs — all green; see the PR
 * description for the full account) — the isolation this file already had
 * (a fresh `mkdtempSync` per call, for both the app dir and the PATH-
 * prefixed kubectl stub dir, never reused or shared across calls) was
 * already correct. Diagnosability is the fix a failure that cannot be
 * reproduced on demand actually needs: the next occurrence prints exactly
 * what the child process said, rather than a bare "" a human has to
 * re-derive a hypothesis for from scratch.
 */
function describeResult(r: {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}) {
  return `status=${r.status} signal=${r.signal}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
}

describe('kn-next-action preflight resolves @getknext/core from the app', () => {
  it('loads the classifier installed in the working directory', () => {
    const r = runPreflight(appWithStubCore());
    expect(r.stderr, describeResult(r)).not.toContain('Could not load the credential classifier');
    expect(r.stdout, describeResult(r)).toContain('correctly scoped');
    expect(r.status, describeResult(r)).toBe(0);
  });

  it('fails CLOSED, naming the fix, when the app has no @getknext/core', () => {
    const r = runPreflight(tempDir('knext-preflight-empty-'));
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr, describeResult(r)).toContain('Could not load the credential classifier');
    expect(r.stderr, describeResult(r)).toContain('working-directory');
  });

  it('the action runs the preflight step in the app directory', () => {
    const action = parse(readFileSync(ACTION, 'utf8')) as {
      runs: { steps: { name?: string; 'working-directory'?: string }[] };
    };
    const step = action.runs.steps.find((s) => s.name === 'Credential preflight');
    expect(step?.['working-directory']).toBe('${{ inputs.working-directory }}');
  });
  // The credentialed docs deploy uses this in-tree action, so the preflight's
  // off-switch is the one input that can silently disable the ADR-0049 check.
  describe('the preflight cannot be disabled by default or by a second exit', () => {
    type Step = {
      name?: string;
      run?: string;
      env?: Record<string, string>;
      'continue-on-error'?: unknown;
    };
    const loadAction = () =>
      parse(readFileSync(ACTION, 'utf8')) as {
        inputs: Record<string, { default?: string }>;
        runs: { steps: Step[] };
      };

    // Located by what the step DOES (it runs preflight.mjs), not its display name,
    // so renaming the step cannot un-guard it.
    const preflightStep = () => {
      const steps = loadAction().runs.steps.filter((s) => (s.run ?? '').includes('preflight.mjs'));
      expect(steps).toHaveLength(1);
      return steps[0] as Step;
    };

    it('skip-credential-preflight defaults to exactly the string "false"', () => {
      expect(loadAction().inputs['skip-credential-preflight']?.default).toBe('false');
    });

    it('the skip branch is the ONLY exit 0, gated on the input being literally "true"', () => {
      const step = preflightStep();
      expect(step?.env?.KNEXT_SKIP_PREFLIGHT).toBe('${{ inputs.skip-credential-preflight }}');
      const run = step?.run ?? '';
      const exits = run.match(/\bexit\b/g) ?? [];
      expect(exits).toHaveLength(1);
      expect(run).toMatch(
        /if \[ "\$KNEXT_SKIP_PREFLIGHT" = "true" \]; then\n[^\n]*\n\s*exit 0\n\s*fi\n/,
      );
      // the classifier's exit code must reach the step: nothing may swallow it.
      const node = run.split('\n').find((l) => l.includes('preflight.mjs')) ?? '';
      expect(node).not.toMatch(/\|\||;\s*true|\bexit 0\b/);
      expect(run).not.toMatch(/\breturn\b|set \+e/);
    });

    it('the preflight step has no continue-on-error in any form (a rejection must fail the job)', () => {
      expect(preflightStep()['continue-on-error']).toBeUndefined();
    });
  });
});

/**
 * #1493 — the first real docs deploy through the platform (run 36300738817,
 * job 108567783572) failed CLOSED on every runner:
 *
 *   underlying error: Command failed: kubectl auth can-i --list -n knext-docs -o json
 *   error: unknown shorthand flag: 'o' in -o
 *
 * `-o`/`--output` has never been a flag `kubectl auth can-i` accepts, on ANY
 * kubectl release — verified locally (client v1.33.3) and live against the
 * real OKE cluster. The fix landed as `kubectl create -o json -f -`.
 *
 * #1500 — the SECOND real docs deploy (run 36303738838) then failed with a
 * different error, because the scoped `knext-deployer` ServiceAccount is not
 * the admin credential #1493 was verified with:
 *
 *   error validating "STDIN": error validating data: failed to check CRD:
 *   failed to list CRDs: customresourcedefinitions.apiextensions.k8s.io is
 *   forbidden: User "system:serviceaccount:knext-docs:knext-deployer" cannot
 *   list resource "customresourcedefinitions" in API group
 *   "apiextensions.k8s.io" at the cluster scope
 *
 * `kubectl create` (without `--raw`) does client-side schema validation
 * before submitting, and that validation itself lists CRDs — a permission
 * the scoped SA was never granted, by design. The fix submits the review as
 * a raw POST instead — `kubectl create --raw <path> -f -` — which talks to
 * the apiserver directly with no client-side validation at all. Verified
 * live against OKE with the actual `knext-deployer` ServiceAccount token
 * (scoped: passes) and with the cluster-admin context (broad: still
 * refused, on the wildcard grant, not on a permissions error from the
 * review itself).
 */
describe('#1500 — SelfSubjectRulesReview via `kubectl create --raw <path> -f -`, not client-side-validated `create -o json -f -`', () => {
  const RAW_PATH = '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews';

  /**
   * The file this stub writes into `dir` carries the SelfSubjectRulesReview
   * body the preflight piped on stdin to `kubectl create` — so a test can
   * assert what was actually submitted, not just what the stub echoed back.
   */
  function capturedReviewPath(dir: string): string {
    return join(dir, 'create-input.json');
  }

  /**
   * A stub that answers the way a REAL cluster's kubectl does for a SCOPED
   * credential: `create --raw <path> -f -` succeeds (no client-side
   * validation to trip over), but the pre-#1500 `create -o json -f -` form
   * reproduces the exact CRD-list-forbidden error from the live incident —
   * so any regression back to that form is caught by this stub returning a
   * refusal, not by a separate assertion.
   */
  function stubKubectl(opts: {
    rawExit?: number;
    rawStdout?: string;
    rawStderr?: string;
    /** Simulate a kubectl release that doesn't understand `--raw` at all. */
    rawFlagUnknown?: boolean;
    /** What the FALLBACK form (`create -o json --validate=false -f -`) returns, when reached. */
    fallbackStdout?: string;
    fallbackExit?: number;
    /**
     * #1533/#1495: every `SelfSubjectAccessReview` hazard-check call is
     * routed by BODY content (it shares the rules review's argv shapes) to
     * this fixed answer — `false` (the default) represents a correctly
     * scoped credential, matching what every test in THIS describe block
     * that expects PASS already assumes. `true` simulates a credential that
     * CAN do at least one hazardous thing. `"unreachable"` simulates the
     * review itself failing to run.
     */
    accessReviewAllowed?: boolean | 'unreachable';
  }): string {
    const dir = tempDir('knext-preflight-1500-bin-');
    const bin = join(dir, 'kubectl');
    const captureFile = capturedReviewPath(dir);
    const rawExit = opts.rawExit ?? 0;
    const fallbackExit = opts.fallbackExit ?? 0;
    const accessReviewAllowed = opts.accessReviewAllowed ?? false;
    const esc = (s: string) => s.replace(/'/g, `'\\''`);
    const script = [
      '#!/bin/sh',
      // Read stdin ONCE, up front — several distinct request KINDS share the
      // same argv shapes (SelfSubjectRulesReview vs SelfSubjectAccessReview,
      // #1533/#1495), so this stub tells them apart by body content rather
      // than by argv. Every branch below that used to `cat` stdin itself now
      // reads `$body` instead.
      'body="$(cat)"',
      '# The OLD, client-side-validated form — reproduces the real #1500 runner',
      '# failure verbatim. Any mutation that reverts to this shape, or drops',
      "# '--raw' so the argv no longer matches the raw form below, lands HERE.",
      `if [ "$1" = "create" ] && [ "$2" = "-o" ] && [ "$3" = "json" ] && [ "$4" = "-f" ] && [ "$5" = "-" ] && [ "$#" -eq 5 ]; then`,
      '  echo "error validating \\"STDIN\\": error validating data: failed to check CRD: failed to list CRDs: customresourcedefinitions.apiextensions.k8s.io is forbidden: User \\"system:serviceaccount:knext-docs:knext-deployer\\" cannot list resource \\"customresourcedefinitions\\" in API group \\"apiextensions.k8s.io\\" at the cluster scope" >&2',
      '  exit 1',
      'fi',
      // #1495/#1533 hazard checks — routed by content, before the
      // rules-review-only handling below, so a hazard-check call never falls
      // through to "unrecognized invocation" and never touches captureFile
      // (which stays exclusively the rules-review body, as every existing
      // assertion here expects).
      'case "$body" in',
      '  *SelfSubjectAccessReview*)',
      accessReviewAllowed === 'unreachable'
        ? ['    echo "error: could not reach apiserver for access review" >&2', '    exit 1'].join(
            '\n',
          )
        : `    echo '{"status":{"allowed":${accessReviewAllowed === true}}}'\n    exit 0`,
      '    ;;',
      'esac',
      opts.rawFlagUnknown
        ? [
            `if [ "$1" = "create" ] && [ "$2" = "--raw" ]; then`,
            '  echo "error: unknown flag: --raw" >&2',
            '  exit 1',
            'fi',
          ].join('\n')
        : [
            `# the raw form the fix invokes — enforce the exact flags so a mutation`,
            `# that drops '--raw', reorders args, or points at the wrong path fails`,
            `# HERE, not on a live cluster.`,
            `if [ "$1" = "create" ] && [ "$2" = "--raw" ] && [ "$3" = "${RAW_PATH}" ] && [ "$4" = "-f" ] && [ "$5" = "-" ] && [ "$#" -eq 5 ]; then`,
            `  printf '%s' "$body" > '${captureFile}'`,
            opts.rawStderr ? `  echo '${esc(opts.rawStderr)}' >&2` : '  :',
            opts.rawStdout ? `  echo '${esc(opts.rawStdout)}'` : '  :',
            `  exit ${rawExit}`,
            'fi',
          ].join('\n'),
      '# the explicit-fallback form, reached only when --raw itself is unknown',
      `if [ "$1" = "create" ] && [ "$2" = "-o" ] && [ "$3" = "json" ] && [ "$4" = "--validate=false" ] && [ "$5" = "-f" ] && [ "$6" = "-" ] && [ "$#" -eq 6 ]; then`,
      `  printf '%s' "$body" > '${captureFile}'`,
      opts.fallbackStdout ? `  echo '${esc(opts.fallbackStdout)}'` : '  :',
      `  exit ${fallbackExit}`,
      'fi',
      'echo "kubectl-stub: unrecognized invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n');
    writeFileSync(bin, script);
    sealShim(bin);
    return dir;
  }

  /** An app dir whose stub classifier refuses any rule set carrying a wildcard grant. */
  function appWithWildcardAwareCore(): string {
    const app = tempDir('knext-preflight-1500-app-');
    writeFileSync(join(app, 'package.json'), '{"name":"app","private":true}\n');
    const core = join(app, 'node_modules/@getknext/core');
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      JSON.stringify({
        name: '@getknext/core',
        type: 'module',
        exports: { './internal/credential-scope': './scope.js' },
      }),
    );
    writeFileSync(
      join(core, 'scope.js'),
      [
        'export function classifyCredentialScope(rules) {',
        '  const flat = JSON.stringify(rules);',
        '  if (flat.includes(\'"*"\')) {',
        '    return { ok: false, findings: ["wildcard grant — cluster-admin-shaped"], remedy: "apply the published Role instead" };',
        '  }',
        '  return { ok: true, findings: [], remedy: "" };',
        '}',
        '',
      ].join('\n') + HAZARD_PROBES_STUB,
    );
    return app;
  }

  function run(cwd: string, kubectlDir: string) {
    return spawnSync('node', [PREFLIGHT, '--namespace', 'knext-docs'], {
      cwd,
      encoding: 'utf8',
      timeout: PREFLIGHT_TIMEOUT_MS,
      env: { ...process.env, PATH: `${kubectlDir}:${process.env.PATH ?? ''}` },
    });
  }

  const SCOPED_REVIEW = JSON.stringify({
    status: {
      resourceRules: [
        {
          apiGroups: ['apps.kn-next.dev'],
          resources: ['nextapps'],
          verbs: ['get', 'list', 'create', 'patch', 'update'],
        },
      ],
    },
  });
  const WILDCARD_REVIEW = JSON.stringify({
    status: { resourceRules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
  });

  it('(a) kubectl answers `create --raw <path> -f -` with scoped rules → PASSES, and the old form is not what was called', () => {
    const r = run(appWithWildcardAwareCore(), stubKubectl({ rawStdout: SCOPED_REVIEW }));
    expect(r.stderr).not.toContain('Could not determine what this credential can do');
    expect(r.stdout).toContain('correctly scoped');
    expect(r.status, describeResult(r)).toBe(0);
  });

  it('the SelfSubjectRulesReview it submits is scoped to the --namespace argument, not hardcoded', () => {
    // `run()` always passes `--namespace knext-docs` — this asserts the review the stub
    // actually received carries THAT namespace, not a literal like "default". Without
    // this, hardcoding `spec: { namespace: 'default' }` in preflight.mjs stays green:
    // every other test here happens to pass with the wrong namespace evaluated.
    const kubectlDir = stubKubectl({ rawStdout: SCOPED_REVIEW });
    const r = run(appWithWildcardAwareCore(), kubectlDir);
    expect(r.status, describeResult(r)).toBe(0);
    const captured = JSON.parse(readFileSync(capturedReviewPath(kubectlDir), 'utf8'));
    expect(captured).toEqual({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectRulesReview',
      spec: { namespace: 'knext-docs' },
    });
  });

  it('(b) the review reports a wildcard rule → REFUSED, the same refusal message as before', () => {
    const r = run(appWithWildcardAwareCore(), stubKubectl({ rawStdout: WILDCARD_REVIEW }));
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr).toContain('This kubeconfig grants more than knext needs. Refusing to use it.');
    expect(r.stderr).toContain('wildcard grant');
  });

  it('(c) `kubectl create --raw` itself fails → refused, fail CLOSED (never a silent pass)', () => {
    const r = run(
      appWithWildcardAwareCore(),
      stubKubectl({
        rawExit: 1,
        rawStderr: 'error: the server could not find the requested resource',
      }),
    );
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
    expect(r.stderr).toContain('the server could not find the requested resource');
  });

  it('(d) kubectl has NEITHER working form (no `--raw`, no fallback) → refused, message names the cause', () => {
    const dir = tempDir('knext-preflight-1500-bin-d-');
    const bin = join(dir, 'kubectl');
    const marker = join(dir, 'shim-ran');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'cat >/dev/null', // drain stdin: never exit before the caller's write lands
        // only the real call counts, not sealShim's probe invocation
        `[ "$1" = "create" ] && echo ran >> '${marker}'`,
        'if [ "$1" = "create" ] && [ "$2" = "--raw" ]; then',
        '  echo "error: unknown flag: --raw" >&2',
        '  exit 1',
        'fi',
        'echo "error: unknown command \\"create\\" for \\"kubectl\\"" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
    sealShim(bin);
    const r = run(appWithWildcardAwareCore(), dir);
    // The shim must have actually been exec'd — otherwise the generic refusal below
    // is the real code path running WITHOUT the shim (the #1883 flake), not a pass.
    // Diagnose a recurrence: if the shim never ran, say so WITH the run's output
    // instead of a bare ENOENT from reading the marker.
    expect(existsSync(marker), `shim never ran — ${describeResult(r)}`).toBe(true);
    expect(readFileSync(marker, 'utf8'), describeResult(r)).toContain('ran');
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
    expect(r.stderr).toContain('unknown command');
  });

  it('a review with no `.status` at all is refused, never silently treated as zero rules', () => {
    // Guards the fail-closed shape itself: a classifier fed `[]` reports
    // ok:true (nothing to complain about), so defaulting a missing `status` to
    // an empty rule set would turn "the cluster didn't answer" into a PASS.
    const r = run(appWithWildcardAwareCore(), stubKubectl({ rawStdout: '{}' }));
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
  });

  it('never depends on the client-side-validated `create -o json -f -` form succeeding (regression guard for #1500)', () => {
    // If preflight.mjs regresses to submitting the old form, THIS stub reproduces the
    // literal CRD-list-forbidden error from the live incident — the same string a mutation
    // test would need to see fail. So a revert is caught by this test going red, not by a
    // bespoke assertion elsewhere.
    const kubectlDir = stubKubectl({ rawStdout: SCOPED_REVIEW });
    const r = run(appWithWildcardAwareCore(), kubectlDir);
    expect(r.status, describeResult(r)).toBe(0);
    expect(r.stderr).not.toContain('customresourcedefinitions.apiextensions.k8s.io is forbidden');
  });

  it('the OLD `create -o json -f -` form, if invoked, reproduces the exact #1500 CRD-forbidden error', () => {
    // Documents what the stub's old-form branch actually returns, independent of whether
    // preflight.mjs calls it — pins the fixture itself against silent drift.
    const kubectlDir = stubKubectl({ rawStdout: SCOPED_REVIEW });
    const bin = join(kubectlDir, 'kubectl');
    const direct = spawnSync(bin, ['create', '-o', 'json', '-f', '-'], {
      input: '{}',
      encoding: 'utf8',
    });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('customresourcedefinitions.apiextensions.k8s.io is forbidden');
  });

  it('falls back, loudly, to `create -o json --validate=false -f -` only when `--raw` is unrecognized', () => {
    const kubectlDir = stubKubectl({ rawFlagUnknown: true, fallbackStdout: SCOPED_REVIEW });
    const r = run(appWithWildcardAwareCore(), kubectlDir);
    expect(r.status, describeResult(r)).toBe(0);
    expect(r.stdout).toContain('correctly scoped');
    expect(r.stderr).toContain('::warning::');
    expect(r.stderr).toContain('does not recognize');
    const captured = JSON.parse(readFileSync(capturedReviewPath(kubectlDir), 'utf8'));
    expect(captured).toEqual({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectRulesReview',
      spec: { namespace: 'knext-docs' },
    });
  });

  it('does NOT fall back when `--raw` fails for a real (non-flag) reason — no silent retry into a different request', () => {
    const r = run(
      appWithWildcardAwareCore(),
      stubKubectl({ rawExit: 1, rawStderr: 'Error from server (Forbidden): ...' }),
    );
    expect(r.status, describeResult(r)).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
    expect(r.stderr).not.toContain('does not recognize');
  });

  it('never depends on `kubectl auth can-i` succeeding at all (regression guard for the original #1493 bug)', () => {
    const dir = tempDir('knext-preflight-1493-bin-e-');
    const bin = join(dir, 'kubectl');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "create" ] && [ "$2" = "--raw" ]; then',
        '  body="$(cat)"',
        // An access review needs a real verdict — the rules-review body is
        // not one, and since round 2 of #1557 a reply without a boolean
        // `allowed` is refused rather than read as "not allowed".
        '  case "$body" in *SelfSubjectAccessReview*) echo \'{"status":{"allowed":false}}\'; exit 0;; esac',
        `  echo '${SCOPED_REVIEW}'`,
        '  exit 0',
        'fi',
        'echo "unexpected invocation: $*" >&2',
        'exit 7',
        '',
      ].join('\n'),
    );
    sealShim(bin);
    const r = run(appWithWildcardAwareCore(), dir);
    expect(r.status, describeResult(r)).toBe(0);
  });

  it('warns but does not fail closed when the review reports status.incomplete, quoting evaluationError', () => {
    // The real shape on a webhook-authorized cluster (OKE/GKE IAM): the review answers,
    // but incompletely, and resourceRules comes back empty. Failing closed on `incomplete`
    // alone would refuse every credential on such a cluster, including a correctly-scoped
    // one — so this must still pass, and must say why in a warning, not silently.
    const INCOMPLETE_REVIEW = JSON.stringify({
      status: {
        resourceRules: [],
        incomplete: true,
        evaluationError: 'webhook authorizer does not support user rule resolution',
      },
    });
    const r = run(appWithWildcardAwareCore(), stubKubectl({ rawStdout: INCOMPLETE_REVIEW }));
    expect(r.status, describeResult(r)).toBe(0);
    expect(r.stdout).toContain('correctly scoped');
    expect(r.stderr).toContain('::warning::');
    expect(r.stderr).toContain('incomplete');
    expect(r.stderr).toContain('webhook authorizer does not support user rule resolution');
  });
});
