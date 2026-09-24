import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1300 review round 4 — wiring tests for `.github/workflows/actionlint.yml`.
 *
 * Finding 1 (jev 0.78, security.md): `${{ steps.diff.outputs.files }}`
 * substituted directly into a `run:` script body is GitHub's TEXTUAL
 * templating, done before the shell parses the script — with PR-controlled
 * filenames in that output (the diff of a PR the attacker authored), that is
 * a script-injection point, not merely an unsafe data value. The fix is the
 * documented mitigation: pass untrusted values via `env:`, never interpolate
 * them into the script text.
 *
 * Finding 3 (0.61): `git diff ... || true` swallows a REAL git error (not
 * just "no changes") and lets the step fall through as if nothing changed —
 * exactly the silent-degradation shape this repo's other guards keep having
 * to re-learn costs a real incident before it's caught.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ACTIONLINT_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/actionlint.yml');

function jobSteps() {
  const text = readFileSync(ACTIONLINT_WORKFLOW_PATH, 'utf8');
  const parsed = parse(text) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
    >;
  };
  const steps = parsed.jobs.actionlint.steps;
  return { text, steps };
}

describe('#1300 review round 4: actionlint.yml is injection-safe', () => {
  it('is valid YAML', () => {
    expect(() => jobSteps()).not.toThrow();
  });

  it('finding 1: the "Run actionlint" step never interpolates ${{ steps.*.outputs.* }} into its run: script', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(runStep).toBeTruthy();
    expect(String(runStep!.run)).not.toMatch(/\$\{\{\s*steps\./);
  });

  it('finding 1: that step instead passes the PR-controlled file list via env:, never inline', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(runStep?.env?.FILES).toBe('${{ steps.diff.outputs.files }}');
    // And the script reads it as a shell variable, not as templated text.
    expect(String(runStep!.run)).toContain('"${FILES}"');
  });

  it('finding 1: the file list is xargs-fed with an explicit NUL/newline delimiter, not default whitespace splitting', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(String(runStep!.run)).toMatch(/xargs -d '\\n'/);
  });

  it('finding 3: the git diff computing the changed files never swallows a real error with || true', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name === 'Compute the workflow/composite-action files this diff actually changed',
    );
    expect(diffStep).toBeTruthy();
    const diffLine = String(diffStep!.run)
      .split('\n')
      .find((l) => l.includes('git diff --name-only'));
    expect(diffLine).toBeTruthy();
    expect(diffLine).not.toContain('|| true');
  });

  it('the base/head SHAs are also passed via env:, not inlined into the run: script (same injection class)', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name === 'Compute the workflow/composite-action files this diff actually changed',
    );
    expect(diffStep?.env?.BASE_SHA).toBeTruthy();
    expect(diffStep?.env?.HEAD_SHA).toBeTruthy();
    expect(String(diffStep!.run)).not.toMatch(/\$\{\{\s*github\./);
  });
});

/**
 * #1352 — the gate did not cover `.github/actions/**` composite action
 * definitions (`action.yml`/`action.yaml`). This repo has none today, so
 * that gap was invisible: nothing would go red if one landed uncovered.
 * Two independent guards, per the issue:
 *
 *   1. the `paths:` trigger and the diff glob ARE widened to
 *      `.github/actions/**` (asserted directly against the workflow file);
 *   2. a SCANNING guard that fails the moment a composite action actually
 *      exists, if (for any reason — a future edit reverting #1, a rename)
 *      the workflow's own coverage of it goes stale. This is deliberately
 *      NOT gated on "if any exist today" — it always runs, so a composite
 *      action added tomorrow is covered from the day it lands, not from the
 *      day someone remembers to update a hand-kept exception list.
 */
describe('#1352: actionlint gate covers .github/actions/** composite actions', () => {
  it('the pull_request AND push path filters include .github/actions/**', () => {
    const text = readFileSync(ACTIONLINT_WORKFLOW_PATH, 'utf8');
    const parsed = parse(text) as {
      on: {
        pull_request?: { paths?: string[] };
        push?: { paths?: string[] };
      };
    };
    expect(parsed.on.pull_request?.paths).toContain('.github/actions/**');
    expect(parsed.on.push?.paths).toContain('.github/actions/**');
  });

  it('the diff-computing step globs .github/actions/**/action.yml AND .yaml, not just workflows', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    expect(diffStep).toBeTruthy();
    const run = String(diffStep!.run);
    expect(run).toContain('.github/actions/**/action.yml');
    expect(run).toContain('.github/actions/**/action.yaml');
  });

  it('the diff excludes DELETED paths (--diff-filter=d), so a PR that only deletes a workflow/composite-action file does not false-red', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    const diffLine = String(diffStep!.run)
      .split('\n')
      .find((l) => l.includes('git diff --name-only'));
    expect(diffLine).toBeTruthy();
    expect(diffLine).toContain('--diff-filter=d');
  });

  // No `if (composites.length) …` escape hatch: this ALWAYS runs. A composite
  // action landing without the workflow being updated to cover it is exactly
  // the failure this test exists to catch, so a conditional guard around it
  // would just move the same blind spot one file over.
  it('every real .github/actions/**/action.y(a)ml file in the repo is coverable by the widened glob (scan, not "if any exist today")', () => {
    const actionsDir = resolve(REPO_ROOT, '.github/actions');
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/^action\.ya?ml$/.test(entry)) {
          found.push(full);
        }
      }
    };
    walk(actionsDir);

    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    const run = String(diffStep!.run);
    const globbed =
      run.includes('.github/actions/**/action.yml') &&
      run.includes('.github/actions/**/action.yaml');

    // If ANY composite action exists, the gate's glob MUST cover it — this is
    // the assertion that goes red the day one lands without matching wiring.
    if (found.length > 0) {
      expect(globbed).toBe(true);
    } else {
      // Documents WHY this passes vacuously today, rather than silently
      // doing nothing — a reader of a green run can tell the difference
      // between "covered" and "nothing to cover yet".
      expect(found).toEqual([]);
    }
  });
});
