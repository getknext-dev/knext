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
  if?: string;
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

/** Index of the first step matching a predicate, or -1. */
function stepIndex(jobId: string, pred: (s: Step) => boolean): number {
  return stepsOf(jobId).findIndex(pred);
}

const isBumpStep = (s: Step): boolean =>
  typeof s.run === 'string' && s.run.includes('changeset:version');
const isPrStep = (s: Step): boolean =>
  typeof s.uses === 'string' && s.uses.includes('changesets/action');

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

describe('release.yml version-pr: the fail-closed bump runs BEFORE the PR-open (F2)', () => {
  it('orders the version-bump step before the changesets/action step', () => {
    // Mutation-proved defect: move the bump AFTER the action and this whole PR
    // is decoration — the action consumes the changesets first, so the
    // standalone `changeset version` in the "fail-closed" step then runs with
    // NONE left, exits 0 vacuously, and validates nothing. Order is the
    // invariant, so assert it, not just presence.
    const bumpIdx = stepIndex(VERSION_JOB, isBumpStep);
    const prIdx = stepIndex(VERSION_JOB, isPrStep);
    expect(bumpIdx, `\`${VERSION_JOB}\` has no version-bump step`).toBeGreaterThanOrEqual(0);
    expect(prIdx, `\`${VERSION_JOB}\` has no changesets/action step`).toBeGreaterThanOrEqual(0);
    expect(
      bumpIdx < prIdx,
      `the fail-closed version-bump step must come BEFORE the changesets/action step. If it runs after, the action consumes the changesets first and the standalone \`changeset version\` validates nothing (exits 0 with no changesets), making "fail-closed bump" decoration.`,
    ).toBe(true);
  });
});

describe('release.yml version-pr: a swallowed PUSH failure stays red (gate)', () => {
  it('has a FAIL-CLOSED step that asserts the version branch was pushed', () => {
    // `continue-on-error` on the PR-open step swallows the branch push too (the
    // action pushes changeset-release/main with GITHUB_TOKEN BEFORE opening the
    // PR). A real push failure must NOT be tolerated as "the org limitation".
    const gate = stepsOf(VERSION_JOB).find(
      (s) =>
        typeof s.run === 'string' &&
        s.run.includes('git ls-remote') &&
        s.run.includes('changeset-release/main'),
    );
    expect(
      gate,
      `\`${VERSION_JOB}\` has no push-integrity gate. The best-effort PR step swallows the branch push failure too; add a step that runs \`git ls-remote --exit-code origin refs/heads/changeset-release/main\` and FAILS when the branch is absent.`,
    ).toBeDefined();
    const g = gate as Step;
    // It must be able to red the job.
    expect(
      isBestEffort(g),
      'the push-integrity gate is continue-on-error — then a swallowed push failure would be swallowed a second time and never red the lane',
    ).toBe(false);
    expect(
      typeof g.run === 'string' && /exit\s+1/.test(g.run),
      'the push-integrity gate never exits non-zero on a missing branch — it cannot red the lane',
    ).toBe(true);
    // It must only run when the best-effort step actually failed (something was
    // swallowed) — otherwise it either never runs or runs when there is no
    // branch to expect.
    expect(
      String(g.if ?? ''),
      "the push-integrity gate must be gated on the PR-open step's failure (`steps.changesets.outcome == 'failure'`), so it runs exactly when a push OR a PR-open was swallowed",
    ).toContain("steps.changesets.outcome == 'failure'");
  });
});

describe('release.yml version-pr: the honesty warning never asserts an unverified cause (F1)', () => {
  it('gates the "open by hand / not a release defect" claim on bump-success AND PR failure', () => {
    // The bug this prevents: an `else` that fires on `outcome != 'success'`
    // ALSO fires on `skipped` (bump failed → job red), printing "the version
    // bump PASSED … not a release defect" on a RED job — the exact inversion
    // this PR exists to stop. The claim may appear ONLY when the bump actually
    // succeeded.
    const nudge = stepsOf(VERSION_JOB).find(
      (s) =>
        typeof s.run === 'string' &&
        s.run.includes('not a release defect') &&
        /by hand/i.test(s.run),
    );
    expect(
      nudge,
      `\`${VERSION_JOB}\` has no "open by hand" nudge step to check — the F1 guard would be vacuous`,
    ).toBeDefined();
    const cond = String((nudge as Step).if ?? '').replace(/\s+/g, ' ');
    expect(
      cond,
      `the "not a release defect" nudge is not gated on the bump having SUCCEEDED. Without \`steps.bump.outcome == 'success'\` it can fire on a skipped/failed bump and claim the bump passed on a red job.`,
    ).toContain("steps.bump.outcome == 'success'");
    // And it must be tied to the PR-open failure, not fired unconditionally.
    expect(cond, 'the nudge must only fire when the PR-open actually failed').toContain(
      "steps.changesets.outcome == 'failure'",
    );
    // The nudge must NOT be able to red or mask — it is annotation only.
    expect(
      /\bexit\s+1\b/.test(String((nudge as Step).run ?? '')),
      'the nudge step exits 1 — annotation must not red the job; the push-integrity gate is what reds a real failure',
    ).toBe(false);
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
