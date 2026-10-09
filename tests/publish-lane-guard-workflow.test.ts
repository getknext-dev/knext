import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { resolveLane } from '../scripts/publish-lane-guard.mjs';
import { jobs, WORKFLOW_DIR, workflowDoc } from './helpers/release-workflow';

/**
 * WORKFLOW GUARD for the publish-lane guard (#2035, v2 task R0).
 *
 * `scripts/publish-lane-guard.mjs` decides two things — is this ref a publish
 * lane, and does the version changesets would publish carry that lane's major
 * — and `tests/publish-lane-guard.test.ts` proves the decisions. None of that
 * matters unless `release.yml` actually runs both checks, on the real ref,
 * BEFORE any job that can touch the npm token, and cannot route around them.
 *
 * SCANNED, NOT ENUMERATED. Which jobs hold the credential is derived from the
 * parsed workflow (every job whose comment-free body carries `NODE_AUTH_TOKEN`,
 * `secrets.NPM_TOKEN`, or an `npm-publish*` environment), across EVERY workflow
 * file, so a second credentialed job added next month is covered without
 * anyone remembering to list it here.
 *
 * Mutation-proved by `scripts/mutation-prove-publish-lane-guard.mjs`.
 */

const GUARD_JOB = 'publish-lane-guard';
const GUARD_SCRIPT = 'scripts/publish-lane-guard.mjs';

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function needsOf(job: Job | undefined): string[] {
  const need = job?.needs;
  if (typeof need === 'string') return [need];
  if (Array.isArray(need)) return need.map(String);
  return [];
}

function transitiveNeeds(all: Record<string, Job>, jobId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...needsOf(all[jobId])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...needsOf(all[next]));
  }
  return seen;
}

function environmentName(job: Job): string {
  const env = job.environment;
  if (typeof env === 'string') return env;
  if (env && typeof env === 'object' && 'name' in env) return String(env.name);
  return '';
}

/** Every string key/value in the parsed job: unescaped and comment-free. */
function stringValues(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringValues(v, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      stringValues(v, out);
    }
  }
  return out;
}

/**
 * An `environment:` whose name is an expression (`${{ ... }}`), as a string or as
 * `{ name: ${{ ... }} }`, can resolve to `npm-publish*` at run time, so it is
 * treated as credential-bearing: it must name the guard in `needs` or be refused.
 */
function hasExpressionEnvironment(job: Job): boolean {
  return environmentName(job).includes('${{');
}

/** Comment-free: a comment saying "NO NODE_AUTH_TOKEN" cannot trip it. */
function holdsPublishCredential(job: Job): boolean {
  const text = stringValues(job).join('\n');
  return (
    text.includes('NODE_AUTH_TOKEN') ||
    // dot AND bracket access, either quote style; GitHub contexts are case-insensitive
    /secrets\s*\.\s*NPM_TOKEN/i.test(text) ||
    /secrets\s*\[\s*['"]NPM_TOKEN['"]\s*\]/i.test(text) ||
    /^npm-publish/.test(environmentName(job)) ||
    hasExpressionEnvironment(job)
  );
}

function allWorkflows(): Array<{ file: string; jobs: Record<string, Job> }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const doc = parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Record<
        string,
        unknown
      >;
      return { file, jobs: (doc?.jobs ?? {}) as Record<string, Job> };
    });
}

function guardSteps(): Step[] {
  const steps = jobs()[GUARD_JOB]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

function stepIndex(predicate: (step: Step) => boolean): number {
  return guardSteps().findIndex(predicate);
}

const runOf = (step: Step) => (typeof step.run === 'string' ? step.run : '');
const invokesGuard = (mode: 'ref' | 'major') => (step: Step) =>
  new RegExp(`node ${GUARD_SCRIPT.replace(/[./]/g, '\\$&')} ${mode}\\b`).test(runOf(step));

/**
 * Job-level status functions that let a job start after a `needs` FAILED.
 * Only the implicit/explicit `success()` keeps a failed guard fatal downstream.
 */
const BYPASSES_FAILED_NEEDS = /\b(always|failure|cancelled)\s*\(\s*\)/;

describe('release.yml: the guard is the root every job hangs from', () => {
  it('declares the guard job', () => {
    expect(Object.keys(jobs())).toContain(GUARD_JOB);
  });

  it('the guard job needs nothing, holds no credential and declares no environment', () => {
    const guard = jobs()[GUARD_JOB] ?? {};
    expect(needsOf(guard)).toEqual([]);
    expect('environment' in guard).toBe(false);
    expect(holdsPublishCredential(guard)).toBe(false);
    expect(guard['continue-on-error'] ?? false).toBe(false);
  });

  it('EVERY other job transitively needs the guard, so a refused ref runs nothing', () => {
    const all = jobs();
    const others = Object.keys(all).filter((id) => id !== GUARD_JOB);
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) {
      expect(
        transitiveNeeds(all, id).has(GUARD_JOB),
        `job \`${id}\` does not hang from the guard`,
      ).toBe(true);
    }
  });
});

describe('every credentialed job, in EVERY workflow, needs the guard DIRECTLY', () => {
  const credentialed = allWorkflows().flatMap(({ file, jobs: fileJobs }) =>
    Object.entries(fileJobs)
      .filter(([, job]) => holdsPublishCredential(job))
      .map(([id, job]) => ({ file, id, job, fileJobs })),
  );

  it('non-vacuity: at least one job holds the npm publish credential', () => {
    expect(credentialed.length).toBeGreaterThan(0);
  });

  it.each(
    credentialed.map((c) => [`${c.file}#${c.id}`, c] as const),
  )('%s names the guard in its own needs', (_label, c) => {
    // Directly, not only transitively: deleting an intermediate job must not
    // silently drop the guard from the credentialed job's ancestry.
    expect(needsOf(c.job)).toContain(GUARD_JOB);
    expect(Object.keys(c.fileJobs)).toContain(GUARD_JOB);
  });

  it.each(
    credentialed.map((c) => [`${c.file}#${c.id}`, c] as const),
  )('%s cannot start after a FAILED guard (no always()/failure()/cancelled() in its job if:)', (_label, c) => {
    const condition = typeof c.job.if === 'string' ? c.job.if : '';
    expect(condition, `job-level if: ${condition}`).not.toMatch(BYPASSES_FAILED_NEEDS);
  });
});

describe('the guard job runs BOTH checks on the real ref, unskippably', () => {
  it('runs the ref check on `${{ github.ref }}` — the full ref, never ref_name or an input', () => {
    const i = stepIndex(invokesGuard('ref'));
    expect(i, 'no step runs the ref check').toBeGreaterThanOrEqual(0);
    const step = guardSteps()[i] as Step;
    expect(runOf(step)).toContain('--ref "$PUBLISH_REF"');
    expect((step.env as Record<string, unknown> | undefined)?.PUBLISH_REF).toBe(
      '${{ github.ref }}',
    );
  });

  it('runs the ref check BEFORE installing anything (the cheapest refusal comes first)', () => {
    const ref = stepIndex(invokesGuard('ref'));
    const install = stepIndex((s) => /\bbun install\b/.test(runOf(s)));
    expect(ref).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(ref).toBeLessThan(install);
  });

  it('computes the bump, then runs the major check on the SAME ref after it', () => {
    const bump = stepIndex((s) => /changeset:version|changeset version/.test(runOf(s)));
    const major = stepIndex(invokesGuard('major'));
    expect(bump, 'no step computes the version changesets would publish').toBeGreaterThanOrEqual(0);
    expect(major, 'no step runs the major check').toBeGreaterThanOrEqual(0);
    expect(major).toBeGreaterThan(bump);
    const step = guardSteps()[major] as Step;
    expect(runOf(step)).toContain('--ref "$PUBLISH_REF"');
    expect((step.env as Record<string, unknown> | undefined)?.PUBLISH_REF).toBe(
      '${{ github.ref }}',
    );
  });

  it('no guard step can be skipped or softened (no step-level if:, no continue-on-error)', () => {
    const steps = guardSteps();
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const label = String(step.name ?? step.uses ?? runOf(step));
      expect('if' in step, `guard step "${label}" carries an if:`).toBe(false);
      expect(step['continue-on-error'] ?? false, `guard step "${label}" continue-on-error`).toBe(
        false,
      );
    }
  });
});

describe('the allowlist lives in ONE place, and the triggers stay inside it', () => {
  it('release.yml (comment-free) carries no lane literal of its own', () => {
    // R4 edits the map in scripts/publish-lane-guard.mjs. A second copy here
    // would let the two drift — the edit lands in one and not the other.
    const json = JSON.stringify(workflowDoc());
    for (const literal of ['refs/heads/', 'integration/v', 'release/1.x', 'release/v']) {
      expect(json, `release.yml mentions ${literal} outside a comment`).not.toContain(literal);
    }
  });

  it('every push-trigger branch is itself an allowlisted lane', () => {
    const on = (workflowDoc().on ?? workflowDoc().true) as Record<string, unknown>;
    const push = (on?.push ?? {}) as { branches?: unknown };
    const branches = Array.isArray(push.branches) ? push.branches.map(String) : [];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(resolveLane(`refs/heads/${branch}`).ok, `push trigger ${branch}`).toBe(true);
    }
  });
});
