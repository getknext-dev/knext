import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  FORBIDDEN_PR_GRANTS,
  findPrReachableWriteGrants,
  grantsOf,
  ifExcludesPullRequests,
  isPullRequestReachable,
} from '../scripts/lib/workflow-token-scope.mjs';

/**
 * GUARD: no job a pull request (or the merge queue) can run holds a
 * registry-write, OIDC or attestation credential.
 *
 * `supply-chain.yml` and `operator-supply-chain.yml` used to grant
 * `packages: write` and `id-token: write` at JOB level on the one job that
 * also runs on `pull_request`. Only individual steps checked whether to
 * publish, so on a same-repo PR every step in that job ran with a GHCR-write
 * token and the OIDC token-request credential in reach: the third-party
 * sbom/trivy/upload actions, and any local composite action a PR edits.
 *
 * The invariant: a job reachable from `pull_request`, `pull_request_target`,
 * `merge_group` (or a reusable workflow, which a PR workflow may call) never
 * holds `packages: write`, `id-token: write`, `attestations: write` or
 * `write-all`. Reachability is decided from the job's own `if:`, conservatively:
 * a job is excluded only when its condition provably cannot be true on those
 * events. Anything the small expression model does not understand counts as
 * reachable, so an unparseable condition fails the test instead of passing it.
 *
 * The publish halves of the two supply-chain workflows are pinned separately
 * below, so "move the write permission to a job that is also push-only" cannot
 * be satisfied by deleting the publish job.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

type Doc = {
  on?: unknown;
  permissions?: unknown;
  jobs: Record<string, Record<string, unknown>>;
};

function readWorkflow(file: string): Doc {
  const doc = parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Doc | null;
  if (!doc || typeof doc !== 'object' || !doc.jobs) throw new Error(`${file}: not a workflow`);
  return doc;
}

describe('analyzer: ifExcludesPullRequests', () => {
  const excludes = [
    "github.event_name == 'push'",
    `\${{ github.event_name == 'push' }}`,
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    "github.event_name == 'push' && needs.build.outputs.ok == 'true'",
    "needs.build.outputs.ok == 'true' && github.event_name == 'push'",
    "github.ref == 'refs/heads/main'",
    "needs.x.result == 'success' && (github.event_name == 'push' || github.event_name == 'schedule')",
    "always() && github.event_name == 'schedule'",
  ];
  const reaches = [
    undefined,
    '',
    'always()',
    "needs.build.outputs.ok == 'true'",
    // The OR lets a pull request through on the right-hand side.
    "github.event_name == 'push' || needs.build.outputs.ok == 'true'",
    "github.event_name != 'pull_request'", // admits merge_group
    "github.event_name == 'pull_request'",
    "github.event_name == 'merge_group'",
    "!(github.event_name == 'push')",
    "contains(github.ref, 'main')",
    "startsWith(github.ref, 'refs/heads/')", // the merge queue ref starts with it
    "github.event_name == 'push' || github.event_name == 'pull_request'",
  ];
  for (const expr of excludes) {
    it(`excludes PR events: ${JSON.stringify(expr)}`, () => {
      expect(ifExcludesPullRequests(expr)).toBe(true);
    });
  }
  for (const expr of reaches) {
    it(`stays PR-reachable: ${JSON.stringify(expr)}`, () => {
      expect(ifExcludesPullRequests(expr)).toBe(false);
    });
  }
});

describe('analyzer: grantsOf', () => {
  it('reads a map, a write-all string and an absent block', () => {
    expect(grantsOf({ contents: 'read', packages: 'write', 'id-token': 'write' })).toEqual([
      'packages: write',
      'id-token: write',
    ]);
    expect(grantsOf('write-all')).toEqual(['write-all']);
    expect(grantsOf(undefined)).toEqual([]);
    expect(grantsOf({ contents: 'read' })).toEqual([]);
    expect(grantsOf({ attestations: 'write' })).toEqual(['attestations: write']);
    // `contents: write` is not on the forbidden list, `packages: read` is not a write.
    expect(grantsOf({ contents: 'write', packages: 'read' })).toEqual([]);
  });
  it('lists the forbidden grants once, in one place', () => {
    expect([...FORBIDDEN_PR_GRANTS].sort()).toEqual(['attestations', 'id-token', 'packages']);
  });
});

describe('analyzer: findPrReachableWriteGrants', () => {
  const wf = (over: Record<string, unknown>) => ({
    on: { pull_request: null, push: { branches: ['main'] } },
    jobs: {},
    ...over,
  });
  it('flags a job-level grant on a PR-reachable job', () => {
    const doc = wf({
      jobs: { build: { permissions: { packages: 'write' }, steps: [] } },
    });
    expect(findPrReachableWriteGrants(doc as never)).toEqual([
      { job: 'build', grants: ['packages: write'] },
    ]);
  });
  it('flags a workflow-level grant inherited by a PR-reachable job', () => {
    const doc = wf({ permissions: { 'id-token': 'write' }, jobs: { a: { steps: [] } } });
    expect(findPrReachableWriteGrants(doc as never)).toEqual([
      { job: 'a', grants: ['id-token: write'] },
    ]);
  });
  it('lets a job-level block narrow a wide workflow-level one', () => {
    const doc = wf({
      permissions: 'write-all',
      jobs: { a: { permissions: { contents: 'read' }, steps: [] } },
    });
    expect(findPrReachableWriteGrants(doc as never)).toEqual([]);
  });
  it('does not flag a push-only publish job', () => {
    const doc = wf({
      jobs: {
        publish: {
          if: "github.event_name == 'push'",
          permissions: { packages: 'write', 'id-token': 'write' },
          steps: [],
        },
      },
    });
    expect(findPrReachableWriteGrants(doc as never)).toEqual([]);
  });
  it('flags write-all', () => {
    const doc = wf({ jobs: { a: { permissions: 'write-all', steps: [] } } });
    expect(findPrReachableWriteGrants(doc as never)).toEqual([{ job: 'a', grants: ['write-all'] }]);
  });
  it('ignores a workflow no PR event can start', () => {
    const doc = {
      on: { schedule: [{ cron: '1 2 * * *' }], workflow_dispatch: {} },
      jobs: { a: { permissions: { 'id-token': 'write' }, steps: [] } },
    };
    expect(isPullRequestReachable(doc as never)).toBe(false);
    expect(findPrReachableWriteGrants(doc as never)).toEqual([]);
  });
  it('treats a reusable workflow as reachable (a PR workflow may call it)', () => {
    const doc = {
      on: { workflow_call: null },
      jobs: { a: { permissions: { 'id-token': 'write' }, steps: [] } },
    };
    expect(isPullRequestReachable(doc as never)).toBe(true);
    expect(findPrReachableWriteGrants(doc as never)).toHaveLength(1);
  });
  it('accepts every trigger spelling: string, list, map', () => {
    expect(isPullRequestReachable({ on: 'pull_request', jobs: {} } as never)).toBe(true);
    expect(isPullRequestReachable({ on: ['push', 'merge_group'], jobs: {} } as never)).toBe(true);
    expect(isPullRequestReachable({ on: { push: {} }, jobs: {} } as never)).toBe(false);
  });
  it('fails closed on a workflow with no on: block', () => {
    expect(() => isPullRequestReachable({ jobs: {} } as never)).toThrow();
  });
});

describe('every workflow in the repo', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
  it('discovers the workflows (a scan of nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('supply-chain.yml');
    expect(files).toContain('operator-supply-chain.yml');
  });
  it('holds no write/OIDC grant on a job a pull request or the merge queue can run', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of findPrReachableWriteGrants(readWorkflow(file) as never)) {
        offenders.push(`${file} :: ${hit.job} :: ${hit.grants.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The split itself. A read-only job builds and scans on every event; a separate
 * push-only job holds the write permissions and publishes the scanned bytes.
 */
const SPLITS = [
  {
    file: 'supply-chain.yml',
    build: 'image-supply-chain',
    publish: 'image-publish',
    layout: 'image-oci',
    // What, besides leaving PR events out, the publish job's own if: must demand.
    gate: /github\.ref\s*==\s*'refs\/heads\/main'/,
  },
  {
    file: 'operator-supply-chain.yml',
    build: 'operator-image-supply-chain',
    publish: 'operator-image-publish',
    layout: 'operator-oci',
    gate: /needs\.operator-image-supply-chain\.outputs\.ready\s*==\s*'true'/,
  },
] as const;

function stepText(step: Record<string, unknown>): string {
  return [step.name, step.uses, step.run, JSON.stringify(step.with ?? {})]
    .filter((v) => typeof v === 'string')
    .join('\n');
}
function stepsOf(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return (job.steps as Array<Record<string, unknown>>) ?? [];
}
function jobText(job: Record<string, unknown>): string {
  return stepsOf(job).map(stepText).join('\n====\n');
}

for (const split of SPLITS) {
  describe(`${split.file}: build/scan is read-only, publish is push-only`, () => {
    const doc = readWorkflow(split.file);
    const build = doc.jobs[split.build];
    const publish = doc.jobs[split.publish];

    it('has both halves', () => {
      expect(build, `job ${split.build}`).toBeDefined();
      expect(publish, `job ${split.publish}`).toBeDefined();
    });

    it('the build/scan job holds contents: read and nothing else', () => {
      expect(build.permissions).toEqual({ contents: 'read' });
    });

    it('the build/scan job runs no publish, login or signing step', () => {
      const text = jobText(build);
      expect(text).not.toMatch(/crane\s+push/);
      expect(text).not.toMatch(/cosign\s+(sign|attest)/);
      expect(text).not.toMatch(/docker\/login-action/);
      expect(text).not.toMatch(/softprops\/action-gh-release/);
    });

    it('the publish job holds the write permissions', () => {
      const perms = publish.permissions as Record<string, string>;
      expect(perms.packages).toBe('write');
      expect(perms['id-token']).toBe('write');
    });

    it('the publish job is excluded from PR and merge-queue events by its own if:', () => {
      expect(ifExcludesPullRequests(publish.if as string)).toBe(true);
    });

    it('the publish job also demands its publish gate in the same if:', () => {
      expect(String(publish.if)).toMatch(split.gate);
    });

    it('the publish job needs the build/scan job, so a failed scan publishes nothing', () => {
      const needs = ([] as string[]).concat((publish.needs as string | string[]) ?? []);
      expect(needs).toContain(split.build);
    });

    it('the publish job runs the push and the signature', () => {
      const text = jobText(publish);
      expect(text).toMatch(/crane\s+push/);
      expect(text).toMatch(/cosign\s+sign/);
    });

    it('the publish job consumes the SCANNED layout and checks its digest first', () => {
      const steps = stepsOf(publish);
      const dl = steps.findIndex((s) =>
        String(s.uses ?? '').startsWith('actions/download-artifact@'),
      );
      const verify = steps.findIndex(
        (s) =>
          /sha256sum/.test(String(s.run ?? '')) &&
          new RegExp(split.layout).test(String(s.run ?? '')),
      );
      const push = steps.findIndex((s) => /crane\s+push/.test(String(s.run ?? '')));
      expect(dl, 'download-artifact step').toBeGreaterThanOrEqual(0);
      expect(verify, 'a sha256sum check of the downloaded layout').toBeGreaterThan(dl);
      expect(push, 'crane push').toBeGreaterThan(verify);
    });

    it('the build/scan job hands the layout and its digest to the publish job', () => {
      const text = jobText(build);
      expect(text).toMatch(/actions\/upload-artifact@/);
      expect(JSON.stringify(build.outputs ?? {})).toMatch(/sha256/i);
    });

    it('no job outside the publish job holds a write grant', () => {
      for (const [id, job] of Object.entries(doc.jobs)) {
        if (id === split.publish) continue;
        expect(grantsOf(job.permissions ?? doc.permissions), `job ${id}`).toEqual([]);
      }
    });
  });
}
