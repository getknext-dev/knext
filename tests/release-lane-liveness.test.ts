import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  jobConcurrency,
  jobJson,
  jobNeeds,
  jobs,
  workflowDoc,
  workflowText,
} from './helpers/release-workflow';

/**
 * GUARD TESTS for the RELEASE LANE COMPLETING AT ALL.
 *
 * ## The failure this exists to prevent, measured
 *
 * `release.yml` used to be one credentialed job that both opened the "Version
 * Packages" PR and published, and it declared `environment: npm-publish`. That
 * environment carries a `required_reviewers` rule (measured 2026-08-25 via
 * `gh api repos/getknext-dev/knext/environments`: `AhmedElBanna80`, no wait
 * timer). So EVERY push to `main` requested a human approval — including the
 * pushes whose only job was to open a Version PR, which publishes nothing and is
 * entirely reversible.
 *
 * Run **30207128316** (created 2026-07-26T14:56:15Z) is the one that was never
 * clicked. Its `audit` job succeeded; its `release` job has sat in `waiting`
 * ever since, holding the workflow-level concurrency group
 * `release-refs/heads/main`. With `cancel-in-progress: false`, every later push
 * queued behind it as `pending` — and GitHub keeps at most ONE pending run per
 * group, so each new push cancelled the previous one.
 *
 * MEASURED, not reasoned about: of the last 100 `release.yml` runs, **99 are
 * `cancelled` and 1 is `pending`; zero succeeded**. Sampled cancelled runs
 * (32778745189, 32775932033, 32638786251, 32488765483) all report
 * `jobs.total_count == 0` — they were killed in the queue, having never started
 * a step. And each cancelled run's `updated_at` equals the NEXT run's
 * `created_at` to the second (e.g. 32778745189 updated 21:26:49, 32779529246
 * created 21:26:48). That timestamp pairing is the cancellation, and it is why
 * no "Version Packages" PR opened after #523 and `kn-next` stayed a 404 on npm
 * for a month.
 *
 * ## The two halves, and why BOTH are asserted
 *
 *   1. **Nothing that can park on a human approval may hold a group that the
 *      version lane needs.** So: no workflow-level `concurrency`, and the
 *      version and publish jobs live in DIFFERENT job-level groups.
 *   2. **The publish job must be able to decide it has nothing to do WITHOUT
 *      STARTING.** GitHub evaluates a job's `if:` before its `environment:`, so
 *      a skipped job never requests an approval and therefore never parks. A
 *      publish job that started on every push and exited early in a step would
 *      re-create the exact trap this file is named for.
 *
 * Half 1 alone leaves a publish job requesting an approval on every docs commit,
 * each un-clicked request parking a run in its own group. Half 2 alone leaves a
 * single workflow-level group that any parked run still starves. Neither is
 * sufficient; this file asserts both.
 *
 * Mutation-proved by `scripts/mutation-prove-release-lane.mjs`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const VERSION_JOB = 'version-pr';
const PREFLIGHT_JOB = 'publish-preflight';
const PUBLISH_JOB = 'release';

/** `cancel-in-progress` is "on" in every form except a literal `false`/absent. */
function cancels(value: ReturnType<typeof jobConcurrency>): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return false;
  return 'cancel-in-progress' in value && value['cancel-in-progress'] !== false;
}

function groupOf(jobId: string): string {
  const value = jobConcurrency(jobId);
  if (value === undefined) return '';
  return typeof value === 'string' ? value : String(value.group ?? '');
}

describe('release.yml: no parked job can starve the version lane', () => {
  it('has NO workflow-level concurrency group', () => {
    // The precise mechanism of the month-long outage. A workflow-level group is
    // held by the whole RUN, including a run parked in `waiting` on an
    // environment approval, and every later run then queues as `pending` behind
    // it — where GitHub keeps only one and cancels the rest.
    const doc = workflowDoc();
    expect(
      'concurrency' in doc,
      'release.yml has a workflow-level `concurrency:` again. A run parked on the npm-publish approval will hold it and cancel every subsequent run in the queue — this is exactly how runs 32488765483..32778745189 died with zero jobs each. Put the group on the JOB instead.',
    ).toBe(false);
  });

  it('gives the version job and the publish job DIFFERENT concurrency groups', () => {
    const versionGroup = groupOf(VERSION_JOB);
    const publishGroup = groupOf(PUBLISH_JOB);
    expect(versionGroup, `\`${VERSION_JOB}\` has no concurrency group`).not.toBe('');
    expect(publishGroup, `\`${PUBLISH_JOB}\` has no concurrency group`).not.toBe('');
    expect(
      versionGroup,
      'the version and publish jobs share a concurrency group — a publish waiting on the required reviewer would queue the version lane behind it, which is the whole bug',
    ).not.toBe(publishGroup);
  });

  it('scopes both job groups to the ref, so one branch cannot queue another', () => {
    for (const jobId of [VERSION_JOB, PUBLISH_JOB]) {
      expect(groupOf(jobId), `\`${jobId}\`s concurrency group is not ref-scoped`).toMatch(
        /\$\{\{\s*github\.ref\s*\}\}/,
      );
    }
  });

  it('neither group cancels in progress', () => {
    // The other half of the trade. `tests/ci-concurrency-group.test.ts` asserts
    // this across every publishing workflow; it is repeated here because THIS
    // file is the one a future author edits when reasoning about the groups, and
    // "make it cancel" is the obvious wrong fix for a queue.
    for (const jobId of [VERSION_JOB, PUBLISH_JOB]) {
      expect(
        cancels(jobConcurrency(jobId)),
        `\`${jobId}\` cancels in progress — a half-finished changeset publish is worse than a queue`,
      ).toBe(false);
    }
  });
});

describe('release.yml: the version lane runs unapproved and cannot publish', () => {
  it('the version job declares no environment', () => {
    expect(
      'environment' in (jobs()[VERSION_JOB] ?? {}),
      `\`${VERSION_JOB}\` declares an environment. Opening a Version PR is reversible and must never wait on a human click — that wait is what starved the lane.`,
    ).toBe(false);
  });

  it('the version job holds no npm credential, in any form', () => {
    // The PARSED job, so the comment that says "NO NODE_AUTH_TOKEN" cannot
    // satisfy — or trip — this check. See jobJson's note.
    const json = jobJson(VERSION_JOB);
    expect(json, `\`${VERSION_JOB}\` job not found`).not.toBe('');
    // Both the env var and the secret reference: a future edit could introduce
    // either name, and only one of them is the one this repo currently writes.
    expect(
      json.includes('NODE_AUTH_TOKEN'),
      `\`${VERSION_JOB}\` now receives NODE_AUTH_TOKEN. It runs WITHOUT the environment approval, so a publish credential there defeats the gate entirely.`,
    ).toBe(false);
    expect(
      json.includes('secrets.NPM_TOKEN'),
      `\`${VERSION_JOB}\` now references secrets.NPM_TOKEN. It runs WITHOUT the environment approval.`,
    ).toBe(false);
  });

  it('the version job passes no publish-script, so it cannot publish even with a token', () => {
    const json = jobJson(VERSION_JOB);
    expect(
      json.includes('publish-script'),
      `\`${VERSION_JOB}\` passes a publish-script. Defence in depth: even if a credential leaked into this job, the action must have no publish command to run.`,
    ).toBe(false);
    // The positive half — it must still actually run the version path, or the
    // assertion above is satisfied by an empty job.
    expect(
      json.includes('"version-script":"pnpm run changeset:version"'),
      `\`${VERSION_JOB}\` no longer runs the changeset version script — this guard would be about nothing`,
    ).toBe(true);
  });

  it('the version job is still ordered after the supply-chain audit', () => {
    expect(jobNeeds(VERSION_JOB)).toContain('audit');
  });
});

describe('release.yml: the publish job decides BEFORE it starts', () => {
  it('the publish decision is an output of an earlier, ungated job', () => {
    const preflight = jobs()[PREFLIGHT_JOB];
    expect(preflight, `\`${PREFLIGHT_JOB}\` job is missing`).toBeDefined();
    expect(
      'environment' in (preflight ?? {}),
      `\`${PREFLIGHT_JOB}\` declares an environment — then it too would park, and the decision would never reach the publish job`,
    ).toBe(false);
    const outputs = (preflight?.outputs ?? {}) as Record<string, unknown>;
    expect(
      Object.keys(outputs),
      `\`${PREFLIGHT_JOB}\` must expose the decision as a job output; a job-level \`if:\` can read nothing else`,
    ).toContain('should_publish');
    expect(
      jobJson(PREFLIGHT_JOB).includes('node scripts/publish-preflight.mjs'),
      `\`${PREFLIGHT_JOB}\` must run scripts/publish-preflight.mjs`,
    ).toBe(true);
  });

  it('the publish job is gated on BOTH halves of "there is something to publish"', () => {
    const condition = String(jobs()[PUBLISH_JOB]?.if ?? '').replace(/\s+/g, ' ');
    expect(condition, `\`${PUBLISH_JOB}\` has no \`if:\` at all`).not.toBe('');
    // Half one: a run that just opened a Version PR has nothing on main to ship.
    expect(
      condition,
      `\`${PUBLISH_JOB}\` does not check has_changesets — it would request a publish approval on the very push that opened the Version PR`,
    ).toContain("needs.version-pr.outputs.has_changesets == 'false'");
    // Half two: no pending changesets is NOT the same as something to publish —
    // a routine docs commit satisfies it, and without this half every such
    // commit would park a run on the approval and re-create the outage.
    expect(
      condition,
      `\`${PUBLISH_JOB}\` does not check should_publish — every ordinary commit to main would request a publish approval`,
    ).toContain("needs.publish-preflight.outputs.should_publish == 'true'");
  });

  it('the publish job still carries the environment gate and the audit ordering', () => {
    // The gate is the POINT of the split, not an obstacle to it: publishing to a
    // public registry is irreversible and stays behind a human click.
    expect(jobs()[PUBLISH_JOB]?.environment).toBe('npm-publish');
    expect(jobNeeds(PUBLISH_JOB)).toContain('audit');
    expect(jobNeeds(PUBLISH_JOB)).toContain(PREFLIGHT_JOB);
  });

  it('the publish job verifies the token is ACCEPTED, not merely present', () => {
    // The claim `docs/release/public-release-readiness.md` used to make — "the
    // token is set" — is a claim about presence. A token can be present and
    // expired; this one was set 2026-07-25.
    expect(
      jobJson(PUBLISH_JOB).includes('npm whoami'),
      `\`${PUBLISH_JOB}\` no longer probes the token with \`npm whoami\` — presence is not validity`,
    ).toBe(true);
  });
});

describe('scripts/publish-preflight.mjs decides on exit codes, never output', () => {
  // Its BEHAVIOUR — including the fail-closed reachability probe — is covered
  // behaviourally in `tests/publish-preflight.test.ts`. What can only be checked
  // as source is the discipline this repo has been burned by: npm's stderr
  // wording has changed between majors, and a message match rots silently.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/publish-preflight.mjs'), 'utf8');

  it('branches on the spawn status', () => {
    expect(source).toContain('run.status === 0');
  });

  it('parses no npm stdout', () => {
    expect(
      /stdout\s*\)?\s*\.\s*(includes|match|indexOf|test)/.test(source),
      'the preflight is parsing npm stdout — branch on the exit code instead',
    ).toBe(false);
  });
});

describe('non-vacuity: the guards read the real file', () => {
  it('release.yml parses and contains the three lane jobs', () => {
    // Every assertion above is keyed on a job id. A rename would make most of
    // them pass vacuously against `undefined`, so the ids are asserted once,
    // here, where the failure names the cause.
    const ids = Object.keys(jobs());
    expect(ids).toEqual(expect.arrayContaining(['audit', VERSION_JOB, PREFLIGHT_JOB, PUBLISH_JOB]));
    expect(workflowText()).toMatch(/^name: Release$/m);
  });

  it('the workflow header records WHY the lane is split', () => {
    // A future tidy-up that re-merges the jobs will read this file's header
    // first. If the explanation is gone, the merge looks like a simplification.
    const header = workflowText().split('\nname:')[0] ?? '';
    expect(header).toMatch(/30207128316/);
    expect(header).toMatch(/concurrency/i);
  });
});
