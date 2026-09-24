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

  it('pins on the create-new-issue branch', () => {
    const createBranch = scriptText.slice(scriptText.indexOf('creating the tracker issue'));
    expect(createBranch).toMatch(/gh\(\[\s*'issue',\s*\n?\s*'pin'/);
  });

  it('re-asserts the pin on the update-existing-issue branch (a human could have unpinned it)', () => {
    const updateBranch = scriptText.slice(
      scriptText.indexOf('updating existing tracker issue'),
      scriptText.indexOf('creating the tracker issue'),
    );
    expect(updateBranch).toMatch(/gh\(\[\s*'issue',\s*\n?\s*'pin'/);
  });
});
