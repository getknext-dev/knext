import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * #448 — the SIGTERM hardcap e2e has a hard-fail guard; this asserts it has
 * somewhere to fire.
 *
 * The e2e itself throws when `KNEXT_REQUIRE_BUN=1` and `bun` is absent, which is
 * the right shape. But it also carries `describe.skipIf(!bunAvailable)`, so in
 * any environment WITHOUT that env var it silently skips. Before the
 * `bun-exec-hardcap` job existed, no workflow ran `examples/bun-exec`'s tests at
 * all — so the guard was correct and completely inert, which is #408 item 2
 * verbatim ("the flag exists, CI never sets it") in a different subsystem.
 *
 * These assertions therefore guard the WIRING, not the behaviour: the job must
 * exist, must actually run the example's suite, and must set the env var that
 * converts a missing `bun` from a skip into a failure. Deleting the env var is a
 * one-character edit that disarms the gate without reddening anything else —
 * this test is what makes that edit visible.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { steps?: Step[] };

function ciJobs(): Record<string, Job> {
  const parsed = parse(readFileSync(CI_YML, 'utf8')) as { jobs?: Record<string, Job> };
  const jobs = parsed.jobs;
  // Non-vacuity: if the parse silently produced nothing, every assertion below
  // would pass by absence rather than by agreement.
  expect(jobs, 'ci.yml parsed to no jobs at all').toBeTruthy();
  expect(Object.keys(jobs as Record<string, Job>).length).toBeGreaterThan(5);
  return jobs as Record<string, Job>;
}

describe('bun-exec hardcap gate is wired into CI (#448)', () => {
  it('has a job that runs the example suite', () => {
    const job = ciJobs()['bun-exec-hardcap'];
    expect(job, 'no bun-exec-hardcap job in ci.yml').toBeTruthy();

    const runs = (job.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(runs, 'the job never runs the example test suite').toMatch(/bun run test|vitest/);
  });

  it('sets KNEXT_REQUIRE_BUN=1 on the step that runs the suite', () => {
    const job = ciJobs()['bun-exec-hardcap'];
    const testStep = (job.steps ?? []).find((s) => /bun run test|vitest/.test(s.run ?? ''));
    expect(testStep, 'no step runs the suite').toBeTruthy();

    // The whole point. Without this, a runner without `bun` skips the hardcap
    // suite and the job goes green having asserted nothing.
    expect(
      testStep?.env?.KNEXT_REQUIRE_BUN,
      'the suite runs WITHOUT KNEXT_REQUIRE_BUN=1 — a missing bun would skip, not fail',
    ).toBe('1');
  });

  it('installs bun, since the guard turns a missing bun into a hard failure', () => {
    const job = ciJobs()['bun-exec-hardcap'];
    const uses = (job.steps ?? []).map((s) => s.uses ?? '').join('\n');
    expect(uses, 'the job never installs bun, so KNEXT_REQUIRE_BUN=1 would always throw').toMatch(
      /oven-sh\/setup-bun@[0-9a-f]{40}/,
    );
  });

  it('does not disarm itself with continue-on-error', () => {
    const raw = readFileSync(CI_YML, 'utf8');
    const start = raw.indexOf('bun-exec-hardcap:');
    expect(start).toBeGreaterThan(-1);
    // Bound the slice to this job: the next top-level job key, or EOF.
    const rest = raw.slice(start + 1);
    const nextJob = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const body = nextJob === -1 ? rest : rest.slice(0, nextJob);
    expect(body, 'the hardcap job is continue-on-error, so it cannot fail the workflow').not.toMatch(
      /continue-on-error:\s*true/,
    );
  });
});
