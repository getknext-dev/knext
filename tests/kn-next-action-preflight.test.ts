import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fakeKubectlDir(): string {
  const dir = tempDir('knext-preflight-bin-');
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, '#!/bin/sh\necho \'{"status":{"resourceRules":[]}}\'\n');
  chmodSync(bin, 0o755);
  return dir;
}

/** An app dir whose node_modules carries a stub classifier that always passes. */
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
      exports: { './internal/credential-scope': './scope.js' },
    }),
  );
  writeFileSync(
    join(core, 'scope.js'),
    'export function classifyCredentialScope() { return { ok: true, findings: [], remedy: "" }; }\n',
  );
  return app;
}

function runPreflight(cwd: string) {
  return spawnSync('node', [PREFLIGHT, '--namespace', 'ns'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeKubectlDir()}:${process.env.PATH ?? ''}` },
  });
}

describe('kn-next-action preflight resolves @getknext/core from the app', () => {
  it('loads the classifier installed in the working directory', () => {
    const r = runPreflight(appWithStubCore());
    expect(r.stderr).not.toContain('Could not load the credential classifier');
    expect(r.stdout).toContain('correctly scoped');
    expect(r.status).toBe(0);
  });

  it('fails CLOSED, naming the fix, when the app has no @getknext/core', () => {
    const r = runPreflight(tempDir('knext-preflight-empty-'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not load the credential classifier');
    expect(r.stderr).toContain('working-directory');
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
 * real OKE cluster (`kubectl --context knext-oke-sa auth can-i --list -n
 * default -o json` reproduces the identical error), and the runner's own
 * kubectl (ubuntu-latest/24.04 image 20260920.314.1 ships kubectl 1.37.0) has
 * the same `--help` output with no `-o`. So this was never a version-skew
 * bug; it could not have worked anywhere. The fix stops depending on that
 * subcommand's output format at all: it submits the `SelfSubjectRulesReview`
 * directly via `kubectl create -o json -f -`, a form `create` has supported
 * `-o json` on since the flag has existed — verified against the same live
 * cluster (`echo '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectRulesReview","spec":{"namespace":"default"}}' | kubectl --context knext-oke-sa create -o json -f -`
 * returns a populated `.status.resourceRules`).
 */
describe('#1493 — SelfSubjectRulesReview via `kubectl create -o json -f -`, not `auth can-i --list -o json`', () => {
  /**
   * A stub that answers the way a REAL cluster's kubectl does: it rejects `-o`
   * on `auth can-i` (reproducing the exact runner failure) but answers the
   * `create -o json -f -` form the fix actually uses. `createExit`/`createStdout`/
   * `createStderr` let each case control what that second form returns.
   */
  function stubKubectl(opts: {
    createExit?: number;
    createStdout?: string;
    createStderr?: string;
  }): string {
    const dir = tempDir('knext-preflight-1493-bin-');
    const bin = join(dir, 'kubectl');
    const createExit = opts.createExit ?? 0;
    const esc = (s: string) => s.replace(/'/g, `'\\''`);
    const script = [
      '#!/bin/sh',
      '# reproduces the real #1493 runner failure for the OLD command shape',
      'if [ "$1" = "auth" ] && [ "$2" = "can-i" ]; then',
      '  echo "error: unknown shorthand flag: \'o\' in -o" >&2',
      '  echo "See \'kubectl auth can-i --help\' for usage." >&2',
      '  exit 1',
      'fi',
      '# the form the fix actually invokes',
      'if [ "$1" = "create" ]; then',
      '  cat >/dev/null', // drain the SelfSubjectRulesReview piped on stdin
      opts.createStderr ? `  echo '${esc(opts.createStderr)}' >&2` : '  :',
      opts.createStdout ? `  echo '${esc(opts.createStdout)}'` : '  :',
      `  exit ${createExit}`,
      'fi',
      'echo "kubectl-stub: unrecognized invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n');
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    return dir;
  }

  /** An app dir whose stub classifier refuses any rule set carrying a wildcard grant. */
  function appWithWildcardAwareCore(): string {
    const app = tempDir('knext-preflight-1493-app-');
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
      ].join('\n'),
    );
    return app;
  }

  function run(cwd: string, kubectlDir: string) {
    return spawnSync('node', [PREFLIGHT, '--namespace', 'knext-docs'], {
      cwd,
      encoding: 'utf8',
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

  it('(a) kubectl rejects `-o` for `auth can-i` but answers `create -o json -f -` with scoped rules → PASSES', () => {
    const r = run(appWithWildcardAwareCore(), stubKubectl({ createStdout: SCOPED_REVIEW }));
    expect(r.stderr).not.toContain('Could not determine what this credential can do');
    expect(r.stdout).toContain('correctly scoped');
    expect(r.status).toBe(0);
  });

  it('(b) the review reports a wildcard rule → REFUSED, the same refusal message as before', () => {
    const r = run(appWithWildcardAwareCore(), stubKubectl({ createStdout: WILDCARD_REVIEW }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('This kubeconfig grants more than knext needs. Refusing to use it.');
    expect(r.stderr).toContain('wildcard grant');
  });

  it('(c) `kubectl create` itself fails → refused, fail CLOSED (never a silent pass)', () => {
    const r = run(
      appWithWildcardAwareCore(),
      stubKubectl({
        createExit: 1,
        createStderr: 'error: the server could not find the requested resource',
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
    expect(r.stderr).toContain('the server could not find the requested resource');
  });

  it('(d) kubectl has NEITHER working form (no `auth can-i -o`, no `create -o json -f -`) → refused, message names the cause', () => {
    const dir = tempDir('knext-preflight-1493-bin-d-');
    const bin = join(dir, 'kubectl');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "auth" ] && [ "$2" = "can-i" ]; then',
        '  echo "error: unknown shorthand flag: \'o\' in -o" >&2',
        '  exit 1',
        'fi',
        'echo "error: unknown command \\"create\\" for \\"kubectl\\"" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    const r = run(appWithWildcardAwareCore(), dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
    expect(r.stderr).toContain('unknown command');
  });

  it('a review with no `.status` at all is refused, never silently treated as zero rules', () => {
    // Guards the fail-closed shape itself: a classifier fed `[]` reports
    // ok:true (nothing to complain about), so defaulting a missing `status` to
    // an empty rule set would turn "the cluster didn't answer" into a PASS.
    const r = run(appWithWildcardAwareCore(), stubKubectl({ createStdout: '{}' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not determine what this credential can do');
  });

  it('never depends on `kubectl auth can-i` succeeding at all (regression guard for the actual #1493 bug)', () => {
    const dir = tempDir('knext-preflight-1493-bin-e-');
    const bin = join(dir, 'kubectl');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "create" ]; then',
        '  cat >/dev/null',
        `  echo '${SCOPED_REVIEW}'`,
        '  exit 0',
        'fi',
        'echo "unexpected invocation: $*" >&2',
        'exit 7',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    const r = run(appWithWildcardAwareCore(), dir);
    expect(r.status).toBe(0);
  });
});
