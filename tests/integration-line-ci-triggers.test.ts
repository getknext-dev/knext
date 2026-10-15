import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';

/**
 * GUARD: every long-lived release line gets post-merge CI and enforce-grade
 * Trivy scans (#2249, agent half).
 *
 * Before this guard, `ci.yml` and `supply-chain.yml` ran `push` only on
 * `main`. A push to `integration/v2` ran neither, so the combined tree after a
 * merge or forward-merge was never tested on its own: only each PR's merge ref
 * was. And the Trivy steps were `continue-on-error: ${{ github.ref !=
 * 'refs/heads/main' }}`, so a HIGH/CRITICAL finding in a v2-only base image
 * stayed report-only until v2 reached `main`.
 *
 * The invariant, in two halves, checked for every release line:
 *
 *   1. TRIGGER. `on.push.branches` in both workflows matches the line, with
 *      no `branches-ignore` that excludes it and no `paths`/`paths-ignore`
 *      that could skip the run.
 *   2. ENFORCE. Every ref-gated Trivy step in both workflows ENFORCES on the
 *      line's push ref and stays report-only on PR and merge-queue refs. The
 *      expression is evaluated, not string-matched. Anything outside the small
 *      grammar the evaluator understands fails the test.
 *
 * The lines are DERIVED, not listed here. They are `PUBLISH_LANES` in
 * `scripts/publish-lane-guard.mjs` (the lanes that publish to npm), plus one
 * synthetic next line, `integration/v3`. The synthetic line pins the glob
 * choice: a filter that lists today's lines by name goes red on it, because
 * the next integration line must get CI without anyone editing a workflow.
 *
 * Fail-closed: a YAML parse error, a missing `on:` block, or an unknown glob
 * or expression syntax throws. None of them can pass by being skipped.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = ['ci.yml', 'supply-chain.yml'] as const;

/** The next integration line. It must be covered before it exists. */
const NEXT_LINE_REF = 'refs/heads/integration/v3';

/** Refs that must stay report-only, so a base-image CVE cannot block a PR. */
const REPORT_ONLY_REFS = [
  'refs/pull/2249/merge',
  'refs/heads/gh-readonly-queue/main/pr-2249-0123456789abcdef0123456789abcdef01234567',
  'refs/heads/gh-readonly-queue/integration/v2/pr-2249-0123456789abcdef0123456789abcdef01234567',
] as const;

function releaseLineRefs(): string[] {
  const lanes = [...PUBLISH_LANES.keys()].map(String);
  if (lanes.length === 0) throw new Error('PUBLISH_LANES is empty: nothing to check');
  for (const ref of lanes) {
    if (!ref.startsWith('refs/heads/')) throw new Error(`lane is not a branch ref: ${ref}`);
  }
  return [...lanes, NEXT_LINE_REF];
}

type Workflow = { on: Record<string, unknown>; jobs: Record<string, unknown> };

function readWorkflow(file: string): Workflow {
  const path = resolve(REPO_ROOT, '.github/workflows', file);
  // `parse` throws on a syntax error; that is the fail-closed path.
  const doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new Error(`${file}: not a YAML mapping`);
  // YAML 1.1 can read the plain key `on` as boolean `true`. Accept both.
  const on = doc.on ?? doc.true;
  if (!on || typeof on !== 'object') throw new Error(`${file}: no \`on:\` block`);
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object') throw new Error(`${file}: no \`jobs:\` block`);
  return { on: on as Record<string, unknown>, jobs: jobs as Record<string, unknown> };
}

/**
 * GitHub branch-filter glob to a RegExp. Models `**` (anything, including `/`),
 * `*` (anything except `/`) and `?` (one non-`/` char). Throws on syntax it
 * does not model (`!` negation, `[]` classes, `+`) rather than guess.
 */
function globToRegExp(pattern: string): RegExp {
  if (/[![\]+]/.test(pattern)) {
    throw new Error(`unmodelled branch-filter syntax in ${JSON.stringify(pattern)}`);
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.^$|(){}\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function asPatterns(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** Why `branch` would NOT start a push run of this workflow, or null if it would. */
function pushGap(on: Record<string, unknown>, branch: string): string | null {
  if (!('push' in on)) return 'no `push` trigger';
  const push = on.push;
  if (push === null) return null; // bare `push:` runs on every branch
  if (typeof push !== 'object') throw new Error(`unexpected \`push\` value: ${String(push)}`);
  const cfg = push as Record<string, unknown>;
  for (const key of ['paths', 'paths-ignore']) {
    if (key in cfg) return `push carries \`${key}\`, which can skip the run`;
  }
  if (asPatterns(cfg['branches-ignore']).some((p) => globToRegExp(p).test(branch))) {
    return 'push `branches-ignore` excludes it';
  }
  if (!('branches' in cfg)) return null;
  const branches = asPatterns(cfg.branches);
  if (!branches.some((p) => globToRegExp(p).test(branch))) {
    return `push \`branches\` ${JSON.stringify(branches)} does not match it`;
  }
  return null;
}

/**
 * Evaluates a `continue-on-error` value for `ref`. Returns true when the step
 * is report-only. Understands a literal boolean, or an expression that is an
 * `&&` of `github.ref != '<lit>'` and `!startsWith(github.ref, '<lit>')`
 * terms. Anything else throws.
 */
function continuesOnError(value: unknown, ref: string): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  if (typeof value !== 'string') throw new Error(`unexpected continue-on-error: ${String(value)}`);
  const m = value.trim().match(/^\$\{\{([\s\S]*)\}\}$/);
  if (!m) throw new Error(`unmodelled continue-on-error: ${value}`);
  return m[1].split('&&').every((raw) => {
    const term = raw.trim();
    const ne = term.match(/^github\.ref\s*!=\s*'([^']*)'$/);
    if (ne) return ref !== ne[1];
    const notPrefix = term.match(/^!\s*startsWith\(\s*github\.ref\s*,\s*'([^']*)'\s*\)$/);
    if (notPrefix) return !ref.startsWith(notPrefix[1]);
    throw new Error(`unmodelled continue-on-error term \`${term}\` in: ${value}`);
  });
}

type RefGatedStep = { where: string; value: string };

/** Every Trivy step whose `continue-on-error` depends on `github.ref`. */
function refGatedTrivySteps(file: string, wf: Workflow): RefGatedStep[] {
  const found: RefGatedStep[] = [];
  for (const [jobId, job] of Object.entries(wf.jobs)) {
    const steps = (job as { steps?: unknown })?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps as Record<string, unknown>[]) {
      if (!String(step?.uses ?? '').startsWith('aquasecurity/trivy-action@')) continue;
      const value = step['continue-on-error'];
      if (typeof value === 'string' && /github\.ref\b/.test(value)) {
        found.push({ where: `${file} job \`${jobId}\` step \`${String(step.name)}\``, value });
      }
    }
  }
  return found;
}

describe('every release line gets post-merge CI and enforce-grade Trivy (#2249)', () => {
  const lines = releaseLineRefs();

  it('derives the release lines from PUBLISH_LANES (not vacuous)', () => {
    expect(lines).toContain('refs/heads/main');
    expect(lines).toContain('refs/heads/integration/v2');
    expect(lines).toContain(NEXT_LINE_REF);
  });

  for (const file of WORKFLOWS) {
    it(`${file} runs on push to every release line`, () => {
      const { on } = readWorkflow(file);
      const gaps = lines
        .map((ref) => {
          const gap = pushGap(on, ref.slice('refs/heads/'.length));
          return gap ? `${ref}: ${gap}` : null;
        })
        .filter((g): g is string => g !== null);
      expect(
        gaps,
        `${file} must run on push to every release line, or the combined tree after a merge is never tested`,
      ).toEqual([]);
    });

    it(`${file}'s ref-gated Trivy steps enforce on every release line and report on PR/queue refs`, () => {
      const wf = readWorkflow(file);
      const steps = refGatedTrivySteps(file, wf);
      expect(
        steps.length,
        `${file}: no ref-gated Trivy step found (scan is vacuous)`,
      ).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const { where, value } of steps) {
        for (const ref of lines) {
          if (continuesOnError(value, ref)) problems.push(`${where} is report-only on ${ref}`);
        }
        for (const ref of REPORT_ONLY_REFS) {
          if (!continuesOnError(value, ref)) problems.push(`${where} enforces on ${ref}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

/** Wraps `body` in GitHub's expression delimiters. */
function ghExpr(body: string): string {
  return `\${{ ${body} }}`;
}

describe('the guard helpers fail closed and see red', () => {
  it('globToRegExp: `**` crosses `/`, `*` does not, negation throws', () => {
    expect(globToRegExp('integration/**').test('integration/v2')).toBe(true);
    expect(globToRegExp('integration/**').test('integration/a/b')).toBe(true);
    expect(globToRegExp('*').test('integration/v2')).toBe(false);
    expect(globToRegExp('main').test('main')).toBe(true);
    expect(globToRegExp('integration/v1.3').test('integration/v1x3')).toBe(false);
    expect(() => globToRegExp('!integration/v2')).toThrow(/unmodelled/);
  });

  it('pushGap: a main-only filter misses an integration line', () => {
    expect(pushGap({ push: { branches: ['main'] } }, 'integration/v2')).toMatch(/does not match/);
    expect(pushGap({ pull_request: null }, 'main')).toMatch(/no `push` trigger/);
    expect(pushGap({ push: { branches: ['**'], paths: ['src/**'] } }, 'main')).toMatch(/paths/);
    expect(
      pushGap(
        { push: { branches: ['**'], 'branches-ignore': ['integration/**'] } },
        'integration/v2',
      ),
    ).toMatch(/branches-ignore/);
    expect(pushGap({ push: { branches: ['main', 'integration/**'] } }, 'integration/v3')).toBe(
      null,
    );
  });

  it('continuesOnError: the main-only gate is report-only on integration refs; unknown terms throw', () => {
    const mainOnly = ghExpr("github.ref != 'refs/heads/main'");
    expect(continuesOnError(mainOnly, 'refs/heads/integration/v2')).toBe(true);
    expect(continuesOnError(mainOnly, 'refs/heads/main')).toBe(false);
    const widened = ghExpr(
      "github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/integration/')",
    );
    expect(continuesOnError(widened, 'refs/heads/integration/v2')).toBe(false);
    expect(continuesOnError(widened, 'refs/pull/1/merge')).toBe(true);
    expect(() => continuesOnError(ghExpr("github.ref == 'refs/heads/main' || true"), 'x')).toThrow(
      /unmodelled/,
    );
    expect(() => continuesOnError('github.ref != main', 'x')).toThrow(/unmodelled/);
  });
});
