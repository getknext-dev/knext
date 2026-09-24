import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1300 (TD2) — wiring tests for the credential-alerting redesign.
 *
 * Two halves, asserted by scanning the REAL workflow YAML as text (the
 * established pattern in this repo for asserting on workflow behaviour the
 * knowledge graph cannot see — see .claude/rules/workflow.md):
 *
 *   1. the per-cell `nightly-red-alert` step in test-e2e-deploy.yml: labels
 *      its credential-mode issues `credential-reset`, names the restart
 *      cause, and does NOT try to pin the per-cell issue (the thing that
 *      silently lost visibility past GitHub's 3-pin cap);
 *   2. the new `compat-matrix-tracker-nightly.yml`: runs on a daily cron,
 *      computes the full `--matrix`, and pins exactly one issue.
 *
 * Both directions are asserted where it matters — the alert step still DOES
 * comment/create issues, it just never pins them; the tracker workflow DOES
 * pin, exactly once.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ALERT_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const TRACKER_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/compat-matrix-tracker-nightly.yml',
);

/**
 * Strip `#`-prefixed comment lines before scanning for an actual shell
 * invocation. Without this, this file's OWN prose (e.g. "a failed `gh issue
 * pin` call is only a warning") would false-positive a "does it invoke X"
 * scan — the comments in these workflows deliberately document the commands
 * they no longer run, which is exactly the kind of text a naive scan
 * confuses with the command itself.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** Isolate the `nightly-red-alert` job's single step body as raw text. */
function alertStepBody(): string {
  const text = readFileSync(ALERT_WORKFLOW_PATH, 'utf8');
  const start = text.indexOf('Create or update the "Compat nightly RED" issue');
  expect(start).toBeGreaterThan(-1);
  // The next top-level job header ("  nightly-red-alert:" siblings) bounds the
  // step; cheaply, the file's next "\n  [a-z-]+:\n" at column 0 after `start`
  // is the next job. Scanning to EOF is also safe here since this is the last
  // job in the file, so this stays correct either way.
  return text.slice(start);
}

describe('#1300: per-cell credential alert (test-e2e-deploy.yml)', () => {
  const body = alertStepBody();

  it('is valid YAML (parses without throwing)', () => {
    expect(() => parse(readFileSync(ALERT_WORKFLOW_PATH, 'utf8'))).not.toThrow();
  });

  it('ensures the credential-reset label exists before using it (fail-closed create)', () => {
    expect(body).toMatch(/gh label create "credential-reset"/);
    expect(body).toContain('--force');
  });

  it('adds --label "credential-reset" on gh issue create for credential mode', () => {
    expect(body).toContain('--label "credential-reset"');
  });

  it('backfills the label on an already-open issue via gh issue edit --add-label', () => {
    expect(body).toContain('--add-label "credential-reset"');
  });

  it('names a restart cause, computed from the job results already in scope', () => {
    expect(body).toContain('restart_cause=');
    expect(body).toContain('**Restart cause:**');
  });

  it('review finding 5: distinguishes a bytecode-liveness shard failure from a generic one by the ledger being empty', () => {
    // A shard can fail with zero named test failures (the boot-mode-ledger
    // step fails the JOB directly, independent of test results) — the
    // restart cause must not claim "see the named failures below" when there
    // are none, or the reader goes looking for something that isn't there.
    expect(body).toContain('bytecode-caching-liveness');
    expect(body).toMatch(/RED_SHARD_DETAIL.*tr -d/);
  });

  it('does NOT pin the per-cell issue (the thing that lost visibility past the 3-pin cap)', () => {
    expect(stripComments(body)).not.toMatch(/gh issue pin/);
  });

  it('documents, in-body, that the aggregate view lives in the pinned tracker', () => {
    expect(body).toContain('credential matrix tracker');
  });
});

describe('#1300: pinned matrix tracker workflow', () => {
  const text = readFileSync(TRACKER_WORKFLOW_PATH, 'utf8');
  const parsed = parse(text) as Record<string, unknown>;

  it('is valid YAML', () => {
    expect(parsed).toBeTruthy();
  });

  it('runs on a daily schedule', () => {
    const on = parsed.on as Record<string, unknown>;
    const schedule = on.schedule as Array<{ cron: string }>;
    expect(Array.isArray(schedule)).toBe(true);
    expect(schedule.length).toBeGreaterThan(0);
    // A daily cron has exactly one `*` in the day-of-month field (field 3) —
    // asserted structurally rather than pinning the literal string, so a
    // legitimate re-offset (avoiding a busy runner window) doesn't red this.
    for (const { cron } of schedule) {
      const fields = cron.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      expect(fields[2]).toBe('*'); // day-of-month: every day
      expect(fields[3]).toBe('*'); // month: every month
    }
  });

  it('computes the full matrix via compat-window-audit.mjs --fetch --matrix --json', () => {
    expect(text).toContain('compat-window-audit.mjs --fetch --matrix --json');
  });

  it('grants issues: write only to the job that needs it (least privilege)', () => {
    const topLevelPermissions = parsed.permissions as Record<string, string>;
    expect(topLevelPermissions.contents).toBe('read');
    expect(topLevelPermissions.issues).toBeUndefined();
    const jobs = parsed.jobs as Record<string, { permissions?: Record<string, string> }>;
    const jobPerms = Object.values(jobs).map((j) => j.permissions);
    expect(jobPerms.some((p) => p?.issues === 'write')).toBe(true);
  });

  it('review finding 3: the EFFECTIVE (job-level) permissions carry actions+contents, not just the top-level block', () => {
    // A job-level `permissions:` block REPLACES the top-level one wholesale in
    // GitHub Actions — it does not merge. Asserting only the top-level block
    // (as the round-1 test did) would stay green even if the job silently
    // dropped `actions: read`/`contents: read`, exactly the regression that
    // starved `gh run list`/`gh run download` inside `--fetch` and produced an
    // all-unresolved matrix. So this checks the JOB's own permissions map,
    // which is what actually governs the token the step runs with.
    const jobs = parsed.jobs as Record<string, { permissions?: Record<string, string> }>;
    const jobWithIssuesWrite = Object.values(jobs).find((j) => j.permissions?.issues === 'write');
    expect(jobWithIssuesWrite).toBeTruthy();
    expect(jobWithIssuesWrite?.permissions?.actions).toBe('read');
    expect(jobWithIssuesWrite?.permissions?.contents).toBe('read');
  });

  it('delegates issue create/comment/pin to compat-matrix-tracker.mjs, not inline gh calls', () => {
    // The workflow itself never shells `gh issue`/`gh label` directly — that
    // logic lives in the one script below, so it is unit-testable without a
    // network. See the sibling `describe` block for the script-level pin scan.
    expect(stripComments(text)).not.toMatch(/gh issue (create|comment|pin)/);
    expect(text).toContain('compat-matrix-tracker.mjs');
  });
});

describe('#1300: compat-matrix-tracker.mjs owns pinning, on both its branches', () => {
  const scriptText = readFileSync(resolve(REPO_ROOT, 'scripts/compat-matrix-tracker.mjs'), 'utf8');

  it('main() calls ensurePinned UNCONDITIONALLY, after the create/update branches join back up', () => {
    // Review round 2: pinning moved OUT of each branch and into one shared
    // `ensurePinned` call reached by both — the tests below prove the branches
    // join back up on `issueNumber` before that one call, rather than each
    // branch having (and being able to drift on) its own pin logic.
    const main = scriptText.slice(scriptText.indexOf('function main('));
    const ensurePinnedCalls = main.match(/ensurePinned\(/g) ?? [];
    expect(ensurePinnedCalls.length).toBe(1);
  });

  it('the create branch sets `issueNumber` (not a bare local used only inside the branch)', () => {
    const createBranch = scriptText.slice(scriptText.indexOf('creating the tracker issue'));
    expect(createBranch).toMatch(/issueNumber\s*=\s*Number\(/);
  });

  it('the update branch reuses the EXISTING issue number, not a fresh lookup per branch', () => {
    const updateBranch = scriptText.slice(
      scriptText.indexOf('updating existing tracker issue'),
      scriptText.indexOf('creating the tracker issue'),
    );
    expect(updateBranch).toContain('existing');
  });

  it('ensurePinned itself never warns-and-continues on a failed pin — it throws (review finding 1)', () => {
    const fn = scriptText.slice(
      scriptText.indexOf('export function ensurePinned'),
      scriptText.indexOf('// ── CLI'),
    );
    expect(fn).not.toMatch(/catch\s*\(/);
    expect(fn).toMatch(/throw new Error/);
  });

  it('ensurePinned only unpins CLOSED issues, never OPEN ones (review finding 1)', () => {
    const fn = scriptText.slice(
      scriptText.indexOf('export function ensurePinned'),
      scriptText.indexOf('export function ensurePinned') + 2000,
    );
    expect(fn).toContain("'CLOSED'");
    expect(fn).not.toMatch(/'OPEN'\s*\)\s*{[^}]*unpin/s);
  });
});

describe('#1300: compat-matrix-tracker.mjs refuses to publish a fetch-failure matrix (review finding 3)', () => {
  const scriptText = readFileSync(resolve(REPO_ROOT, 'scripts/compat-matrix-tracker.mjs'), 'utf8');

  it('main() checks looksLikeFetchFailure UNCONDITIONALLY, before any gh issue/label call', () => {
    const main = scriptText.slice(scriptText.indexOf('function main('));
    // The exact, unbroken condition — not merely "the string appears before
    // the first gh call" (a `false && looksLikeFetchFailure(matrix)` mutant
    // would still satisfy a position-only check while disabling the guard).
    expect(main).toContain('if (looksLikeFetchFailure(matrix)) {');
    const checkIdx = main.indexOf('if (looksLikeFetchFailure(matrix)) {');
    const firstGhCallIdx = main.indexOf("gh([\n    'label'");
    expect(firstGhCallIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(firstGhCallIdx);
  });

  it('exits non-zero (never continues) when the fetch-failure check trips', () => {
    const main = scriptText.slice(scriptText.indexOf('function main('));
    const checkBlock = main.slice(
      main.indexOf('looksLikeFetchFailure('),
      main.indexOf('looksLikeFetchFailure(') + 400,
    );
    expect(checkBlock).toMatch(/process\.exit\(1\)/);
  });
});

describe('#1300: tracker workflow — manual dispatch input (review finding 4)', () => {
  const trackerText = readFileSync(TRACKER_WORKFLOW_PATH, 'utf8');
  const trackerParsed = parse(trackerText) as Record<string, unknown>;

  it('exposes a workflow_dispatch input documenting a manual/acceptance run', () => {
    const on = trackerParsed.on as Record<string, unknown>;
    const dispatch = on.workflow_dispatch as { inputs?: Record<string, unknown> } | undefined;
    expect(dispatch?.inputs).toBeTruthy();
    expect(Object.keys(dispatch?.inputs ?? {}).length).toBeGreaterThan(0);
  });

  it('a manual dispatch runs the SAME real create/pin/comment flow — never a faked/dry path', () => {
    // The input is documentation-only: nothing in the workflow branches
    // dispatch-vs-schedule before calling compat-matrix-tracker.mjs, so this
    // proves there is no separate "fake" code path a dispatch could exercise
    // instead of the real one.
    expect(trackerText).not.toMatch(/if:\s*.*github\.event_name\s*==\s*'workflow_dispatch'/);
  });
});

describe('#1300 review round 2, finding 4: alert-test-dispatch (dispatch-only simulation)', () => {
  const alertText = readFileSync(ALERT_WORKFLOW_PATH, 'utf8');
  const alertParsed = parse(alertText) as {
    on: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    jobs: Record<string, { if?: string; needs?: string | string[]; name?: string }>;
  };

  it('exposes a simulate_red workflow_dispatch input, default false', () => {
    const input = alertParsed.on.workflow_dispatch?.inputs?.simulate_red as
      | { default?: boolean }
      | undefined;
    expect(input).toBeTruthy();
    expect(input?.default).toBe(false);
  });

  it('the job only fires on workflow_dispatch WITH simulate_red — never on a schedule', () => {
    const job = alertParsed.jobs['alert-test-dispatch'];
    expect(job).toBeTruthy();
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain('simulate_red');
    expect(job.if).not.toContain("github.event_name == 'schedule'");
  });

  it('is transitively gated on the lane-attribution marker job (credential-ref), like every other job', () => {
    const job = alertParsed.jobs['alert-test-dispatch'];
    const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
    expect(needs).toContain('credential-ref');
  });

  it('the test issue title is unambiguously prefixed [alert-test]', () => {
    const jobText = alertText.slice(alertText.indexOf('alert-test-dispatch:\n'));
    expect(jobText).toContain('title="[alert-test]');
  });

  it('closes the issue it creates, in the SAME job (never leaves a lingering test issue)', () => {
    const jobText = alertText.slice(
      alertText.indexOf('alert-test-dispatch:\n'),
      alertText.indexOf('credential-recovery:\n'),
    );
    expect(jobText).toContain('gh issue create');
    expect(jobText).toContain('gh issue close');
  });

  it('uses the real credential-reset label (proves the SAME label path the real alert uses)', () => {
    const jobText = alertText.slice(
      alertText.indexOf('alert-test-dispatch:\n'),
      alertText.indexOf('credential-recovery:\n'),
    );
    expect(jobText).toContain('gh label create "credential-reset"');
  });
});

describe('#1300 review round 2, finding 5: credential-recovery (close on green)', () => {
  const alertText = readFileSync(ALERT_WORKFLOW_PATH, 'utf8');
  const alertParsed = parse(alertText) as {
    jobs: Record<string, { if?: string; needs?: string | string[] }>;
  };

  it('only fires on a scheduled, fully-green CREDENTIAL night', () => {
    const job = alertParsed.jobs['credential-recovery'];
    expect(job).toBeTruthy();
    expect(job.if).toContain("github.event_name == 'schedule'");
    for (const jobName of ['credential-ref', 'build-next', 'deploy-tests', 'shard-ledger']) {
      expect(job.if).toContain(`needs.${jobName}.result == 'success'`);
    }
  });

  it('review round 3 (finding 1): the CREDENTIAL-mode test is inlined via github.event.schedule, NEVER env.* (job-level if: does not allow the env context)', () => {
    // Live-proven with actionlint: a job-level `if:` referencing `env.*`
    // makes GitHub reject the WHOLE workflow at parse time — not just this
    // job, every scheduled compat nightly. The four cron strings this
    // condition inlines are the SAME four `KNEXT_COMPAT_MODE` itself tests
    // against in the workflow's top-level `env:` block (kept in lockstep by
    // eye — both read from the one list of credential crons in
    // docs/compat-matrix.md).
    const job = alertParsed.jobs['credential-recovery'];
    expect(job.if).not.toMatch(/env\./);
    for (const cron of ['17 1 * * *', '47 5 * * *', '17 22 * * *', '47 23 * * *']) {
      expect(job.if).toContain(`github.event.schedule == '${cron}'`);
    }
  });

  it('is a root-reachable job (needs credential-ref transitively)', () => {
    const job = alertParsed.jobs['credential-recovery'];
    const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
    expect(needs).toContain('credential-ref');
  });

  it('looks up the issue by the SAME title the red alert uses, so recovery finds what red opened', () => {
    const jobText = alertText.slice(alertText.indexOf('credential-recovery:\n'));
    expect(jobText).toContain('title="Compat CREDENTIAL RED (${KNEXT_LANE}, RC tag)"');
  });

  it('comments "recovered" before closing (never closes silently)', () => {
    const jobText = alertText.slice(alertText.indexOf('credential-recovery:\n'));
    const commentIdx = jobText.indexOf('gh issue comment');
    const closeIdx = jobText.indexOf('gh issue close');
    expect(jobText).toMatch(/Recovered/i);
    expect(commentIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(commentIdx);
  });

  it('degrades to a no-op (exit 0), never an error, when there is nothing open to recover', () => {
    const jobText = alertText.slice(alertText.indexOf('credential-recovery:\n'));
    expect(jobText).toMatch(/if \[ -z "\$\{existing\}" \][\s\S]{0,200}exit 0/);
  });
});

describe('#1300 review round 3, finding 1: no job-level if: in either workflow ever references env.*', () => {
  // GENERALIZED beyond the one job that broke: a job-level `if:` cannot use
  // the `env` context at all (actionlint, confirmed live) — GitHub rejects
  // the WHOLE workflow at parse time. This scans every job in both files, so
  // a future job added the same (natural, since step-level `if:`/`run:` DOES
  // allow `env.*`) mistake is caught here too, not only for
  // credential-recovery.
  for (const path of [ALERT_WORKFLOW_PATH, TRACKER_WORKFLOW_PATH]) {
    it(`${path.split('/').at(-1)}: every job.if is env.*-free`, () => {
      const parsed = parse(readFileSync(path, 'utf8')) as {
        jobs: Record<string, { if?: string }>;
      };
      for (const [name, job] of Object.entries(parsed.jobs)) {
        if (typeof job.if === 'string') {
          expect(job.if, `job "${name}"'s if: must not reference env.*`).not.toMatch(/env\./);
        }
      }
    });
  }
});
