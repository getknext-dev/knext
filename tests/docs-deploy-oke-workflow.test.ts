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
