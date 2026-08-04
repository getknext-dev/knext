import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * exist, must actually run the example's suite, must install bun, and must set
 * the env var that converts a missing `bun` from a skip into a failure. Deleting
 * that env var is a one-line edit that disarms the gate without reddening
 * anything else — this test is what makes that edit visible.
 *
 * Read as TEXT rather than parsed: the root package has no direct `yaml`
 * dependency, and `tests/compat-suite-workflow.test.ts` establishes the same
 * convention for the same reason ("stays trivially portable across CI runners").
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'bun-exec-hardcap:';

/** The `bun-exec-hardcap` job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');

  // Non-vacuity: if the file were unreadable or the workflow restructured, every
  // assertion below would pass by absence rather than by agreement.
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('bun-exec hardcap gate is wired into CI (#448)', () => {
  it('runs the example suite', () => {
    expect(jobBlock(), 'the job never runs the example test suite').toMatch(/bun run test|vitest/);
  });

  it('sets KNEXT_REQUIRE_BUN=1, so a missing bun FAILS instead of skipping', () => {
    // The whole point. Without it, a runner without `bun` skips the hardcap
    // suite and the job goes green having asserted nothing.
    expect(
      jobBlock(),
      'the suite runs WITHOUT KNEXT_REQUIRE_BUN=1 — a missing bun would skip, not fail',
    ).toMatch(/KNEXT_REQUIRE_BUN:\s*['"]?1['"]?/);
  });

  it('installs bun, since the guard turns a missing bun into a hard failure', () => {
    expect(
      jobBlock(),
      'the job never installs bun, so KNEXT_REQUIRE_BUN=1 would always throw',
    ).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('does not disarm itself with continue-on-error', () => {
    expect(
      jobBlock(),
      'the hardcap job is continue-on-error, so it cannot fail the workflow',
    ).not.toMatch(/continue-on-error:\s*true/);
  });
});
