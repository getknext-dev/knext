import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
      (s) => s.name === 'Compute the workflow files this diff actually changed',
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
      (s) => s.name === 'Compute the workflow files this diff actually changed',
    );
    expect(diffStep?.env?.BASE_SHA).toBeTruthy();
    expect(diffStep?.env?.HEAD_SHA).toBeTruthy();
    expect(String(diffStep!.run)).not.toMatch(/\$\{\{\s*github\./);
  });
});
