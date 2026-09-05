import { describe, expect, it } from 'bun:test';
import { jobs } from './helpers/release-workflow';

/**
 * GUARD TESTS for S4-B: the Version-PR job's outcome must be HONEST.
 *
 * ## The failure this exists to fix, measured
 *
 * `release.yml`'s `version-pr` job fails on EVERY push to `main` at the
 * "Create or update the Version Packages PR" step. Confirmed on run
 * 33977112622 (2026-09-05): the step first runs `bun run changeset:version`
 * ("All files have been updated") and then dies with
 *
 *   HttpError: GitHub Actions is not permitted to create or approve pull
 *   requests. - https://docs.github.com/rest/pulls/pulls#create-a-pull-request
 *
 * That is a STANDING ORG LIMITATION, not a lane bug: the getknext-dev org/repo
 * toggle "Allow GitHub Actions to create and approve pull requests" is OFF (a
 * human-only setting), so the Version PR has always been hand-made. But a
 * permanently-red lane trains the main CI rollup to noise — which is precisely
 * how a live HIGH CVE hid for a whole sprint (sprint-3 architect close).
 *
 * ## The two halves, and why BOTH are asserted
 *
 *   1. **Opening the PR is BEST-EFFORT.** The `changesets/action` step that
 *      attempts the PR carries `continue-on-error: true`, scoped to that step
 *      only, so the org limitation does not fail the job.
 *   2. **The version bump MUST still fail loudly.** A real release defect — a
 *      malformed changeset, a broken bump — has to turn this job RED. So the
 *      bump runs in its OWN fail-closed step (no continue-on-error), separate
 *      from the best-effort PR-open.
 *
 * Half 1 alone (continue-on-error on the whole job, or with no fail-closed
 * bump) blanket-greens a genuine bump failure. Half 2 alone leaves the lane
 * permanently red. Neither is sufficient; this file asserts both.
 *
 * And the PUBLISH job stays fully fail-closed — this change touches only the
 * un-credentialed version lane's PR-open error handling.
 */

const VERSION_JOB = 'version-pr';
const PUBLISH_JOB = 'release';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: unknown;
}

function stepsOf(jobId: string): Step[] {
  const steps = jobs()[jobId]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

/** `continue-on-error` is "on" in any form except a literal `false`/absent. */
function isBestEffort(step: Step): boolean {
  const value = step['continue-on-error'];
  if (value === undefined || value === null) return false;
  return value !== false;
}

describe('release.yml version-pr: opening the PR is best-effort', () => {
  it('the changesets/action step that opens the PR carries continue-on-error', () => {
    const steps = stepsOf(VERSION_JOB);
    expect(steps.length, `\`${VERSION_JOB}\` has no steps`).toBeGreaterThan(0);
    const prStep = steps.find(
      (s) => typeof s.uses === 'string' && s.uses.includes('changesets/action'),
    );
    expect(prStep, `\`${VERSION_JOB}\` no longer runs changesets/action`).toBeDefined();
    expect(
      isBestEffort(prStep as Step),
      `the changesets/action PR-open step in \`${VERSION_JOB}\` is not best-effort. The org toggle "Allow GitHub Actions to create and approve pull requests" is OFF for getknext-dev, so this step ALWAYS ends in "GitHub Actions is not permitted to create or approve pull requests" AFTER the bump has succeeded. Without continue-on-error scoped to this step, that environment limitation paints the main CI rollup permanently red.`,
    ).toBe(true);
  });

  it('does NOT blanket-green the whole version-pr job', () => {
    // continue-on-error at JOB level would swallow a broken bump, a failed
    // install, everything. It must live on the PR-open STEP only.
    expect(
      isBestEffort(jobs()[VERSION_JOB] as unknown as Step),
      `\`${VERSION_JOB}\` has a job-level continue-on-error — that blanket-greens a real release defect (broken bump, failed install). Scope it to the PR-open step.`,
    ).toBe(false);
  });
});

describe('release.yml version-pr: the version bump still fails loudly', () => {
  it('runs the version bump in its own fail-closed step', () => {
    // The "must pass" half. A step that runs `changeset:version` (the actual
    // bump the action runs) and is NOT continue-on-error, so a malformed
    // changeset or a broken bump turns the job RED even though the PR-open
    // beside it is best-effort.
    const bumpSteps = stepsOf(VERSION_JOB).filter(
      (s) => typeof s.run === 'string' && s.run.includes('changeset:version'),
    );
    expect(
      bumpSteps.length,
      `\`${VERSION_JOB}\` has no fail-closed \`run:\` step that executes the version bump. Splitting the bump out of the best-effort changesets/action step is the whole point: a real bump failure must stay red.`,
    ).toBeGreaterThan(0);
    for (const step of bumpSteps) {
      expect(
        isBestEffort(step),
        `the version-bump step "${step.name ?? step.id ?? '(unnamed)'}" is continue-on-error — a broken bump would then be swallowed. The bump must be fail-closed; only the PR-open is best-effort.`,
      ).toBe(false);
    }
  });
});

describe('release.yml: the publish job stays fully fail-closed', () => {
  it('no step in the publish job is best-effort, and the job is not either', () => {
    expect(
      isBestEffort(jobs()[PUBLISH_JOB] as unknown as Step),
      `\`${PUBLISH_JOB}\` (the credentialed publish job) is now continue-on-error — a publish/build/token failure would be swallowed. This change touches ONLY the version lane's PR-open.`,
    ).toBe(false);
    for (const step of stepsOf(PUBLISH_JOB)) {
      expect(
        isBestEffort(step),
        `the publish step "${step.name ?? step.id ?? '(unnamed)'}" is continue-on-error — the publish path must fail closed on any real defect (build break, rejected token, publish error).`,
      ).toBe(false);
    }
  });
});
