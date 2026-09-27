import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Guards `.github/workflows/docs-deploy-oke.yml` — the docs site's deploy to
 * OKE THROUGH the platform (#1481). The workflow holds a cluster credential
 * and a registry push token, so what it may do with them is asserted here
 * rather than trusted to review:
 *
 *  1. ADR-0001: nothing in it writes the cluster except `kn-next deploy`
 *     (inside the action). No `kubectl apply/create/patch/...` anywhere, and
 *     no Knative object kind in any inline manifest.
 *  2. Credentials exist ONLY in the main-branch deploy job, and that job reads
 *     them through the `docs-oke` environment (main-only branch policy).
 *     Every other job references no secret at all.
 *  3. Pull requests get a dry run, credential-free.
 *  4. Every third-party action is pinned by a 40-hex SHA with a version
 *     comment — this job has a live push token and kubeconfig in scope.
 *
 * SCANNED, not enumerated: every job, every step, every `uses:` line and every
 * `${{ secrets.* }}` occurrence is found by walking the file, so a new step or
 * job is covered the day it lands.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = '.github/workflows/docs-deploy-oke.yml';
const DEPLOY_ENVIRONMENT = 'docs-oke';

type Step = Record<string, unknown>;
interface Job {
  if?: string;
  environment?: string | { name?: string };
  permissions?: Record<string, string> | string;
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

const raw = (): string => readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), 'utf8');
const load = (text: string = raw()): Workflow => parse(text) as Workflow;

/** Everything a job carries that could run or leak: its YAML, re-serialised per key. */
function jobText(job: Job): string {
  return JSON.stringify(job);
}

function envName(job: Job): string | undefined {
  return typeof job.environment === 'string' ? job.environment : job.environment?.name;
}

/** Every `run:` script in the workflow, joined. */
function runScripts(wf: Workflow): string {
  return Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => String(step.run ?? ''))
    .join('\n');
}

/** `kubectl <verb>` that WRITES the cluster. Reads (get, auth can-i, version) stay allowed. */
const KUBECTL_WRITE =
  /\bkubectl\b[^\n|;&]*\s(apply|create|replace|patch|edit|delete|scale|annotate|label|set|rollout|expose|run)\b/;
/** A raw Knative (or other workload) object declared inline. */
const RAW_OBJECT_KIND =
  /^\s*kind:\s*(Service|Route|Configuration|Revision|DomainMapping|Deployment)\s*$/m;

function clusterWrites(wf: Workflow): string[] {
  const hits: string[] = [];
  for (const line of runScripts(wf).split('\n')) {
    if (KUBECTL_WRITE.test(line)) hits.push(line.trim());
  }
  if (RAW_OBJECT_KIND.test(runScripts(wf))) hits.push('inline Knative/workload manifest');
  return hits;
}

/** Jobs that reference ANY secret, anywhere in their definition. */
function jobsReferencingSecrets(wf: Workflow): string[] {
  return Object.entries(wf.jobs)
    .filter(([, job]) => /\$\{\{\s*secrets\./.test(jobText(job)))
    .map(([id]) => id);
}

const isMainOnly = (job: Job): boolean =>
  /github\.ref\s*==\s*'refs\/heads\/main'/.test(job.if ?? '') &&
  /github\.event_name\s*!=\s*'pull_request'/.test(job.if ?? '');

const isPullRequestOnly = (job: Job): boolean =>
  /github\.event_name\s*==\s*'pull_request'/.test(job.if ?? '');

/** Permissions must be exactly `contents: read` — no write scope anywhere. */
const readOnly = (p: Workflow['permissions']): boolean =>
  typeof p === 'object' && p !== null && Object.keys(p).length === 1 && p.contents === 'read';

const USES = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s*#\s*(.*))?$/;

function unpinnedUses(text: string): string[] {
  const off: string[] = [];
  for (const line of text.split('\n')) {
    const m = USES.exec(line);
    if (!m) continue;
    const [, ref, comment] = m;
    if (ref === undefined || ref.startsWith('./')) continue; // the in-tree action
    const [, sha] = ref.split('@');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !/^v\d+\.\d+\.\d+/.test(comment?.trim() ?? '')) {
      off.push(line.trim());
    }
  }
  return off;
}

describe('docs-deploy-oke.yml — the cluster is written only through the NextApp (ADR-0001)', () => {
  it('scans a non-empty workflow (the guards below are not vacuous)', () => {
    const wf = load();
    expect(Object.keys(wf.jobs).length).toBeGreaterThanOrEqual(2);
    expect(runScripts(wf)).toContain('kubectl');
  });

  it('runs no kubectl write and declares no raw Knative object', () => {
    expect(clusterWrites(load())).toEqual([]);
  });

  it('deploys through the knext action, from the tree, without the asset upload', () => {
    const steps = Object.values(load().jobs).flatMap((j) => j.steps ?? []);
    const action = steps.filter((s) => String(s.uses ?? '') === './packages/kn-next-action');
    expect(action).toHaveLength(1);
    const withBlock = action[0]?.with as Record<string, unknown>;
    expect(String(withBlock['skip-upload'])).toBe('true');
    expect(String(withBlock.namespace)).toBe('knext-docs');
    expect(String(withBlock['dry-run'] ?? 'false')).toBe('false');
  });

  it('REDS on a kubectl apply of a Service (mutation)', () => {
    const wf = load(`${raw()}
  rogue:
    runs-on: ubuntu-latest
    steps:
      - run: kubectl -n knext-docs apply -f apps/docs/deploy/oke/docs-ksvc.yaml
`);
    expect(clusterWrites(wf)).toHaveLength(1);
  });
});

describe('docs-deploy-oke.yml — credentials only in the main-branch deploy job', () => {
  it('exactly one job references secrets, and it is main-only in the docs-oke environment', () => {
    const wf = load();
    const withSecrets = jobsReferencingSecrets(wf);
    expect(withSecrets).toHaveLength(1);
    const job = wf.jobs[withSecrets[0] as string] as Job;
    expect(isMainOnly(job), `job ${withSecrets[0]} must be gated to push/dispatch on main`).toBe(
      true,
    );
    expect(envName(job)).toBe(DEPLOY_ENVIRONMENT);
  });

  it('the kubeconfig secret is read in that job only', () => {
    const wf = load();
    const holders = Object.entries(wf.jobs)
      .filter(([, job]) => jobText(job).includes('secrets.KNEXT_DOCS_KUBECONFIG_B64'))
      .map(([id]) => id);
    expect(holders).toEqual(jobsReferencingSecrets(wf));
  });

  it('never triggers on pull_request_target (which would hand a fork secrets)', () => {
    expect(Object.keys(load().on ?? {})).not.toContain('pull_request_target');
  });

  it('holds no write scope at workflow or job level', () => {
    const wf = load();
    expect(readOnly(wf.permissions)).toBe(true);
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(readOnly(job.permissions), `job ${id}`).toBe(true);
    }
  });

  it('REDS when a pull-request job references a secret (mutation)', () => {
    const wf = load(
      raw().replace(
        '      - name: Dry run — print the NextApp, apply nothing\n',
        '      - name: leak\n        run: echo "${{ secrets.OCIR_TOKEN }}"\n      - name: Dry run — print the NextApp, apply nothing\n',
      ),
    );
    expect(jobsReferencingSecrets(wf)).toHaveLength(2);
  });
});

describe('docs-deploy-oke.yml — pull requests get a credential-free dry run', () => {
  it('has a pull_request trigger and a pull-request-only job that dry-runs', () => {
    const wf = load();
    expect(Object.keys(wf.on ?? {})).toContain('pull_request');
    const prJobs = Object.entries(wf.jobs).filter(([, job]) => isPullRequestOnly(job));
    expect(prJobs).toHaveLength(1);
    const [, job] = prJobs[0] as [string, Job];
    const scripts = (job.steps ?? []).map((s) => String(s.run ?? '')).join('\n');
    expect(scripts).toMatch(/kn-next\.js deploy[\s\\]+--dry-run/);
    expect(jobText(job)).not.toMatch(/\$\{\{\s*secrets\./);
    expect(envName(job)).toBeUndefined();
  });
});

describe('docs-deploy-oke.yml — every third-party action is SHA-pinned', () => {
  it('pins every uses: by 40-hex SHA with a # vX.Y.Z comment', () => {
    expect(unpinnedUses(raw())).toEqual([]);
  });

  it('REDS on a floating tag (mutation)', () => {
    expect(unpinnedUses('      - uses: docker/login-action@v4')).toHaveLength(1);
    expect(
      unpinnedUses('      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f'),
    ).toHaveLength(1);
  });
});

const ACTION_PATH = 'packages/kn-next-action/action.yml';
const actionRaw = (): string => readFileSync(resolve(REPO_ROOT, ACTION_PATH), 'utf8');

const allSteps = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
const stepByName = (wf: Workflow, re: RegExp): Step | undefined =>
  allSteps(wf).find((s) => re.test(String(s.name ?? '')));

/** A `skip-credential-preflight` value that is anything but an explicit false. */
function preflightDisabled(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split('\n')) {
    const m = /skip-credential-preflight['"]?\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = (m[1] ?? '')
      .replace(/#.*$/, '')
      .replace(/['"\s]/g, '')
      .toLowerCase();
    if (v !== 'false') hits.push(line.trim());
  }
  return hits;
}

describe('docs-deploy-oke.yml — the credential preflight cannot be switched off', () => {
  it('no step that receives the kubeconfig sets skip-credential-preflight to anything truthy', () => {
    const wf = load();
    const holders = allSteps(wf).filter((s) =>
      JSON.stringify(s.with ?? {}).includes('KNEXT_DOCS_KUBECONFIG_B64'),
    );
    expect(holders.length).toBeGreaterThanOrEqual(1);
    for (const step of holders) {
      const w = (step.with ?? {}) as Record<string, unknown>;
      const v = w['skip-credential-preflight'];
      expect(v === undefined || String(v).toLowerCase() === 'false').toBe(true);
    }
  });

  it('the workflow file as text never sets skip-credential-preflight but to false', () => {
    expect(preflightDisabled(raw())).toEqual([]);
  });

  it('doctor is off, as the header comment says (namespace-scoped credential)', () => {
    const step = stepByName(load(), /Deploy through the platform/);
    const w = (step?.with ?? {}) as Record<string, unknown>;
    expect(String(w.doctor)).toBe('false');
  });

  it('REDS when the preflight is disabled (mutation)', () => {
    expect(preflightDisabled("          skip-credential-preflight: 'true'")).toHaveLength(1);
    expect(preflightDisabled('          skip-credential-preflight: true')).toHaveLength(1);
    expect(preflightDisabled("          skip-credential-preflight: 'false'")).toEqual([]);
  });
});

describe('docs-deploy-oke.yml — the deploy is verified, not assumed', () => {
  const waitScript = (): string => String(stepByName(load(), /Wait for the operator/)?.run ?? '');

  it('compares the deployed spec.image to THIS commit and exits non-zero on mismatch', () => {
    const s = waitScript();
    expect(s).toContain('{.spec.image}');
    expect(s).toMatch(/case "\$image" in \*":\$\{SHA\}@sha256:"\*\) ;; \*\)/);
    expect(s).toMatch(/is not this commit"; exit 1/);
  });

  it('polls for Ready at the CURRENT generation and fails the step if it never is', () => {
    const s = waitScript();
    expect(s).toMatch(/for _ in \$\(seq 1 \d+\); do/);
    expect(s).toContain('{.metadata.generation}');
    expect(s).toMatch(/if \[ "\$ready" = "True\/\$gen" \]; then break; fi/);
    expect(s).toMatch(/\[ "\$ready" = "True\/\$gen" \] \|\| \{[^\n]*exit 1/);
    expect(s).toContain('sleep');
  });

  it('smoke-tests the origin through the Kourier LB with a Host header, and can fail', () => {
    const step = stepByName(load(), /Smoke-test the origin/);
    expect(step, 'origin smoke step').toBeDefined();
    expect(step?.['continue-on-error']).toBeUndefined();
    const s = String(step?.run ?? '');
    expect(s).toMatch(/-H "Host: \$\{HOST\}"/);
    expect(s).toContain('http://${LB}${path}');
    expect(s).toMatch(/for path in \/api\/health \/ \/docs; do/);
    expect(s).toMatch(/\[ "\$code" = 200 \] \|\| \{[^\n]*exit 1/);
    const env = (step?.env ?? {}) as Record<string, string>;
    expect(env.LB).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(env.HOST).toBe('knext.dev');
  });

  it('continue-on-error appears on exactly one step: the advisory public-host check', () => {
    const soft = allSteps(load()).filter((s) => s['continue-on-error'] !== undefined);
    expect(soft).toHaveLength(1);
    expect(String(soft[0]?.name)).toMatch(/Public host check \(advisory/);
    expect(soft[0]?.['continue-on-error']).toBe(true);
  });
});

describe('docs-deploy-oke.yml — the kubeconfig does not outlive the job', () => {
  it('an always() step removes $RUNNER_TEMP/kubeconfig, after the deploy step', () => {
    const steps = load().jobs.deploy?.steps ?? [];
    const idx = steps.findIndex((s) => /Remove the kubeconfig/.test(String(s.name ?? '')));
    const deployIdx = steps.findIndex((s) => s.uses === './packages/kn-next-action');
    expect(idx).toBeGreaterThan(deployIdx);
    expect(steps[idx]?.if).toBe('always()');
    expect(String(steps[idx]?.run)).toMatch(/rm -f "\$RUNNER_TEMP\/kubeconfig"/);
  });

  it('the action writes it under RUNNER_TEMP with umask 077, never into the workspace', () => {
    const a = actionRaw();
    const write = a.indexOf('base64 -d >');
    expect(write).toBeGreaterThan(-1);
    const umask = a.lastIndexOf('umask 077', write);
    expect(umask, 'umask 077 must precede the kubeconfig write').toBeGreaterThan(-1);
    expect(write - umask).toBeLessThan(200);
    expect(a.slice(write, write + 120)).toContain('"$RUNNER_TEMP/kubeconfig"');
    expect(a).toContain('KUBECONFIG=$RUNNER_TEMP/kubeconfig');
    expect(a).not.toMatch(/GITHUB_WORKSPACE\/kubeconfig|\.\/kubeconfig|>\s*kubeconfig/);
  });
});

describe('docs-deploy-oke.yml — the closure audit gates the push', () => {
  it('both jobs run the closure audit; in deploy it precedes the registry login and the deploy', () => {
    const wf = load();
    for (const [id, job] of Object.entries(wf.jobs)) {
      const steps = job.steps ?? [];
      const audit = steps.findIndex((s) =>
        /precompile-closure-audit\.mjs --app apps\/docs/.test(String(s.run ?? '')),
      );
      expect(audit, `job ${id} must run the closure audit`).toBeGreaterThan(-1);
      expect(steps[audit]?.['continue-on-error']).toBeUndefined();
      if (id !== 'deploy') continue;
      const login = steps.findIndex((s) => /docker\/login-action/.test(String(s.uses ?? '')));
      const deploy = steps.findIndex((s) => s.uses === './packages/kn-next-action');
      expect(audit).toBeLessThan(login);
      expect(audit).toBeLessThan(deploy);
    }
  });
});

/**
 * #1502 — the third real docs deploy (run 36306107152, job 108582984798) got
 * past the credential preflight and the OCIR login, then died in the
 * action's Deploy sub-step: `npx --yes @getknext/core deploy …` exited 127
 * with `sh: 1: knext: not found`.
 *
 * Reproduced locally from `apps/docs` after a real `bun install` + build:
 * unversioned `npx @getknext/core`, run inside a workspace member that
 * depends on it via `workspace:*`, resolves the LOCAL tree rather than
 * fetching the published package — but `packages/kn-next/package.json` now
 * declares two bins (`knext`, the new canonical name, and `kn-next`, kept as
 * a deprecated alias — see `deprecated-alias-invocation.test.ts`), and `bun
 * install` only creates a `node_modules/.bin` entry for a bin whose target
 * file exists AT INSTALL TIME. The workflow's "Install the workspace" step
 * runs before the CLI is built, so neither bin gets linked, and npx's local
 * resolution falls through to a bare, unlinked `knext` — exactly the
 * `sh: knext: command not found` this reproduces. The fix does not depend on
 * guessing that mechanism correctly in perpetuity: it stops going through
 * npx's bin resolution for this dogfooded workflow at all.
 */
describe("docs-deploy-oke.yml — the deploy step dogfoods THIS commit's built CLI, not npx (#1502)", () => {
  /** The knext-action step's `cli` input must be `node <path ending in packages/kn-next/dist/cli/kn-next.js>`. */
  function deployCliIsTreeBuild(wf: Workflow): boolean {
    const step = allSteps(wf).find((s) => s.uses === './packages/kn-next-action');
    const cli = String((step?.with as Record<string, unknown> | undefined)?.cli ?? '');
    return /^node\s+\$\{\{\s*github\.workspace\s*\}\}\/packages\/kn-next\/dist\/cli\/kn-next\.js$/.test(
      cli,
    );
  }

  it("the cli input points node at the tree's built kn-next.js, not npx", () => {
    expect(deployCliIsTreeBuild(load())).toBe(true);
    const step = allSteps(load()).find((s) => s.uses === './packages/kn-next-action');
    const cli = String((step?.with as Record<string, unknown>).cli ?? '');
    expect(cli).not.toMatch(/npx/);
  });

  it('REDS when the cli input is dropped from the deploy step (mutation)', () => {
    const mutated = raw().replace(
      /\n\s*cli: node \$\{\{ github\.workspace \}\}\/packages\/kn-next\/dist\/cli\/kn-next\.js\n/,
      '\n',
    );
    expect(mutated).not.toEqual(raw());
    expect(deployCliIsTreeBuild(load(mutated))).toBe(false);
  });

  it('REDS when the cli input is pointed back at npx (mutation)', () => {
    const mutated = raw().replace(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      'cli: node ${{ github.workspace }}/packages/kn-next/dist/cli/kn-next.js',
      'cli: npx --yes @getknext/core',
    );
    expect(mutated).not.toEqual(raw());
    expect(deployCliIsTreeBuild(load(mutated))).toBe(false);
  });

  it('the deploy job builds @getknext/lib, @getknext/db and @getknext/core before the action step', () => {
    const steps = load().jobs.deploy?.steps ?? [];
    const buildIdx = steps.findIndex((s) =>
      /Build the libraries and the CLI/.test(String(s.name ?? '')),
    );
    const deployIdx = steps.findIndex((s) => s.uses === './packages/kn-next-action');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(deployIdx);
    const run = String(steps[buildIdx]?.run ?? '');
    for (const pkg of ['@getknext/lib', '@getknext/db', '@getknext/core']) {
      expect(run).toContain(pkg);
    }
  });
});

describe('packages/kn-next-action — the cli input actually drives the Deploy step (#1502)', () => {
  const deployRun = (text: string = actionRaw()): string => {
    const a = parse(text) as { runs: { steps: { name?: string; run?: string }[] } };
    return String(a.runs.steps.find((s) => s.name === 'Deploy')?.run ?? '');
  };

  it('the cli input defaults to npx, for a consumer who never sets it', () => {
    const a = parse(actionRaw()) as { inputs: Record<string, { default?: string }> };
    expect(a.inputs.cli?.default).toBe('npx --yes @getknext/core');
  });

  it('the Deploy step invokes the resolved cli array, not a hardcoded npx call', () => {
    const run = deployRun();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax, not a JS template placeholder
    expect(run).toContain('"${CLI[@]}" doctor');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax, not a JS template placeholder
    expect(run).toContain('"${CLI[@]}" deploy');
    expect(run).not.toMatch(/npx --yes @getknext\/core (doctor|deploy)/);
  });

  it('splits the cli input into argv words via `read`, never `eval`', () => {
    const run = deployRun();
    expect(run).toMatch(/read -r -a CLI <<< "\$KNEXT_CLI"/);
    expect(run).not.toMatch(/\beval\b/);
  });

  it('fails loudly, before doing anything, if the resolved executable is not on PATH', () => {
    const run = deployRun();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax being searched for, not a JS template placeholder
    const checkIdx = run.indexOf('command -v "${CLI[0]}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax being searched for, not a JS template placeholder
    const doctorIdx = run.indexOf('"${CLI[@]}" doctor');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(doctorIdx);
    expect(run).toMatch(/::error::the 'cli' input's executable[^\n]*not found on PATH/);
  });

  it('REDS when the executable check is removed (mutation)', () => {
    const mutated = actionRaw().replace(
      /\s*# A wrong 'cli' input[\s\S]*?not found on PATH\. cli=\\"\$KNEXT_CLI\\""\n\s*exit 1\n\s*fi\n/,
      '\n',
    );
    expect(mutated).not.toEqual(actionRaw());
    expect(deployRun(mutated)).not.toMatch(/command -v "\$\{CLI\[0\]\}"/);
  });

  it('REDS when the action ignores cli and hardcodes npx again (mutation)', () => {
    const mutated = actionRaw()
      .replace(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax, not a JS template placeholder
        '"${CLI[@]}" doctor --namespace "$KNEXT_NAMESPACE"',
        'npx --yes @getknext/core doctor --namespace "$KNEXT_NAMESPACE"',
      )
      .replace(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax, not a JS template placeholder
        '"${CLI[@]}" deploy "${DEPLOY_ARGS[@]}"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array syntax, not a JS template placeholder
        'npx --yes @getknext/core deploy "${DEPLOY_ARGS[@]}"',
      );
    expect(mutated).not.toEqual(actionRaw());
    expect(deployRun(mutated)).toMatch(/npx --yes @getknext\/core (doctor|deploy)/);
  });
});
