import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { cronsOverlap } from '../scripts/lib/cron-overlap.mjs';

/**
 * GUARD TESTS for #1733 (G2) — `standalone-deploy-kind-e2e.yml` only ran on
 * `pull_request`/`push` paths scoped to a handful of CLI/template files, so
 * a credential-window stretch that never touches any of them never runs it
 * at all. #1733 adds a weekly `schedule` AND a `webpack` leg next to the
 * existing `turbopack` leg (both are v1.0-default builders, ADR-0054), so
 * both run on a real kind cluster regardless of what else changes.
 *
 * Three things pinned, each with its own `it` so a failure names exactly
 * which property broke:
 *   1. the schedule trigger — exact cron, and that it does not collide (same
 *      UTC minute-of-day + day-of-week) with any credential slot or with the
 *      hour any other WEEKLY lane already uses;
 *   2. the matrix carries both `builder` values (`turbopack`, `webpack`)
 *      alongside both `runtime` values — this is what "both default
 *      builders run" cashes out to, mechanically;
 *   3. the health-check steps (`BUILD_ID`/CR `spec.buildId` assertion, the
 *      `/api/health` 200 assertion) are NOT gated behind a `matrix.builder`
 *      (or `matrix.runtime`) conditional — i.e. every matrix cell runs the
 *      SAME assertions, not a builder-scoped subset.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/standalone-deploy-kind-e2e.yml');

// The 6 credential slots this lane must stay off (test-e2e-deploy.yml),
// restated here rather than imported so this test pins the LITERAL crons a
// human reading the rule would check against, independent of that file's
// own schema reshaping.
const CREDENTIAL_CRONS = [
  '17 22 * * *',
  '47 23 * * *',
  '17 1 * * *',
  '17 3 * * *',
  '47 4 * * *',
  '47 5 * * *',
];

// Every OTHER workflow's weekly (day-of-week-scoped) cron in this repo, as of
// #1733 — used only to assert this lane's new cron does not land on the same
// UTC hour as any of them. If a future PR adds another weekly lane on this
// hour, THAT PR's own change should update this list (and will be caught by
// `tests/ci-capacity-budget.test.ts`'s repo-wide overlap scan regardless).
const OTHER_WEEKLY_CRONS = [
  '17 7 * * 0', // compat-vinext.yml
  '17 4 * * 1', // bun-base-build.yml
  '11 4 * * 1', // operator-upgrade-e2e.yml
  '7 6 * * 0', // mutation-prover-nightly.yml
  '37 4 * * 0', // file-manager-platform-e2e-nightly.yml
  '29 3 * * 0', // operator-e2e-nightly.yml
];

function readWorkflowDoc(): Record<string, unknown> {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Record<string, unknown>;
}

function scheduleCrons(doc: Record<string, unknown>): string[] {
  const on = doc.on as { schedule?: { cron?: unknown }[] } | undefined;
  const schedule = on?.schedule;
  if (!Array.isArray(schedule)) throw new Error('on.schedule is not an array');
  return schedule.map((entry, i) => {
    const cron = entry?.cron;
    if (typeof cron !== 'string') throw new Error(`on.schedule[${i}] has no string cron`);
    return cron;
  });
}

describe('standalone-deploy-kind-e2e.yml runs weekly off the credential slots (#1733)', () => {
  it('declares exactly one weekly schedule entry, pinned to Wed 10:23 UTC', () => {
    const crons = scheduleCrons(readWorkflowDoc());
    expect(crons).toEqual(['23 10 * * 3']);
  });

  it('does not overlap any credential-window slot (same UTC minute+hour+day-of-week)', () => {
    const [cron] = scheduleCrons(readWorkflowDoc());
    for (const slot of CREDENTIAL_CRONS) {
      expect(cronsOverlap(cron, slot), `${cron} must not overlap credential slot ${slot}`).toBe(
        false,
      );
    }
  });

  it('does not share its UTC hour with any other WEEKLY lane in this repo', () => {
    const [cron] = scheduleCrons(readWorkflowDoc());
    const [, hourRaw] = cron.trim().split(/\s+/);
    const hour = Number(hourRaw);
    for (const other of OTHER_WEEKLY_CRONS) {
      const [, otherHourRaw] = other.trim().split(/\s+/);
      expect(hour, `${cron} shares hour ${hour} with weekly lane cron ${other}`).not.toBe(
        Number(otherHourRaw),
      );
    }
  });

  it('still carries its path-filtered pull_request/push triggers and workflow_dispatch (schedule is additive)', () => {
    const on = readWorkflowDoc().on as Record<string, unknown>;
    expect(on.pull_request).toBeDefined();
    expect(on.push).toBeDefined();
    expect(on.workflow_dispatch).toBeDefined();
  });
});

describe('standalone-deploy-kind-e2e.yml matrix covers both default builders (#1733)', () => {
  function matrix(): { runtime?: string[]; builder?: string[] } {
    const doc = readWorkflowDoc();
    const jobs = doc.jobs as Record<
      string,
      { strategy?: { matrix?: { runtime?: string[]; builder?: string[] } } }
    >;
    const job = jobs['standalone-deploy-e2e'];
    if (!job?.strategy?.matrix) throw new Error('standalone-deploy-e2e job has no strategy.matrix');
    return job.strategy.matrix;
  }

  it('matrix.builder is exactly [turbopack, webpack]', () => {
    expect(matrix().builder).toEqual(['turbopack', 'webpack']);
  });

  it('matrix.runtime is still [bun, node] (unchanged by the builder leg)', () => {
    expect(matrix().runtime).toEqual(['bun', 'node']);
  });

  it('fail-fast stays false, so one builder/runtime cell failing does not cancel the others', () => {
    const doc = readWorkflowDoc();
    const jobs = doc.jobs as Record<string, { strategy?: { 'fail-fast'?: boolean } }>;
    expect(jobs['standalone-deploy-e2e'].strategy?.['fail-fast']).toBe(false);
  });
});

describe('standalone-deploy-kind-e2e.yml runs the SAME health checks on every builder leg (#1733)', () => {
  function steps(): { name?: string; if?: string }[] {
    const doc = readWorkflowDoc();
    const jobs = doc.jobs as Record<string, { steps?: { name?: string; if?: string }[] }>;
    const job = jobs['standalone-deploy-e2e'];
    if (!job?.steps) throw new Error('standalone-deploy-e2e job has no steps');
    return job.steps;
  }

  // The two assertions #1417's header calls out as the point of this lane:
  // the BUILD_ID/CR lock-step check, and the /api/health 200 check. Both
  // must exist, UNCONDITIONALLY (no `if` gating them on `matrix.builder` or
  // `matrix.runtime`) — i.e. every one of the 4 matrix cells runs them.
  const REQUIRED_UNCONDITIONAL_STEP_NAME_SUBSTRINGS = [
    'Assert the build id IS the deploy tag',
    '/api/health',
  ];

  it.each(
    REQUIRED_UNCONDITIONAL_STEP_NAME_SUBSTRINGS,
  )('step matching %s exists and has no builder/runtime "if" gate', (needle) => {
    const matches = steps().filter((s) => s.name?.includes(needle));
    expect(matches.length, `expected exactly one step named like "${needle}"`).toBe(1);
    const step = matches[0];
    if (step.if !== undefined) {
      expect(
        step.if,
        `step "${step.name}" must not be gated on matrix.builder/matrix.runtime`,
      ).not.toMatch(/matrix\.(builder|runtime)/);
    }
  });

  it('no step in the job conditions on matrix.builder at all (the health checks run on every leg)', () => {
    const gated = steps().filter((s) => s.if?.includes('matrix.builder'));
    expect(gated.map((s) => s.name)).toEqual([]);
  });
});
