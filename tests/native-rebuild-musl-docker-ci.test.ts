import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

/**
 * #1230 round 6 — the real-execution proof for scripts/e2e-native-rebuild-musl.sh
 * (sharp musl mapping, the ROOT-escape guard) needs a job somewhere; this
 * asserts it has one, and that the wiring actually reaches it.
 *
 * `tests/e2e-native-rebuild-musl.docker.test.ts` executes the real script
 * inside the pinned `oven/bun:1.4.0-alpine` image — a source-contract scan
 * (`tests/compat-bun-lane-compiled-exec.test.ts`) can only prove the anchor
 * strings exist, not that the behaviour they describe actually happens. It is
 * wired into the existing `sigterm-drain-shipped` job (already docker-capable
 * — every GitHub-hosted `ubuntu-latest` runner has a working docker daemon —
 * and already sets up Node + bun), deliberately NOT `standalone-drain-bun-image`
 * (other PRs were actively editing that job at the time). Delete the step and
 * the suite goes unreachable: nothing turns red, and the round-6 fixes it
 * protects could regress with the same silence `standalone-drain-image-ci.test.ts`
 * was filed against for a sibling gate.
 *
 * Same split as that sibling guard: WIRING here (this file), CONTENT in
 * `tests/compat-bun-lane-compiled-exec.test.ts` (the anchor strings) and in
 * `tests/e2e-native-rebuild-musl.docker.test.ts` itself (the real execution).
 * The "is this job actually blocking?" half is PARSED via
 * tests/helpers/blocking-gate.ts, not text-matched — a bare `if:` scan misses
 * quoted-key and skippable-`needs:` disarms (#661).
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'sigterm-drain-shipped:';
const DOCKER_TEST_PATH = 'tests/e2e-native-rebuild-musl.docker.test.ts';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the round-6 native-rebuild-musl docker suite is wired into CI (#1230)', () => {
  it('the sigterm-drain-shipped job runs the docker e2e by its explicit path, not the fast suite', () => {
    const block = jobBlock();
    const runCommands = [...block.matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never invokes the native-rebuild-musl docker e2e by its explicit path, so it is unreachable',
    ).toContain(DOCKER_TEST_PATH);
  });

  it('runs the runner that can collect a bun:test file (not vitest)', () => {
    const block = jobBlock();
    expect(block, 'the job never invokes scripts/bun-test.mjs for the docker e2e').toMatch(
      /bun-test\.mjs/,
    );
  });

  it('is NOT wired into standalone-drain-bun-image (other PRs were actively editing that job)', () => {
    const raw = readFileSync(CI_YML, 'utf8');
    const start = raw.indexOf('  standalone-drain-bun-image:');
    expect(start, 'standalone-drain-bun-image job not found').toBeGreaterThan(-1);
    const rest = raw.slice(start + '  standalone-drain-bun-image:'.length);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const otherBlock = next === -1 ? rest : rest.slice(0, next);
    expect(
      otherBlock.includes(DOCKER_TEST_PATH),
      'the docker e2e must not be duplicated into standalone-drain-bun-image',
    ).toBe(false);
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'sigterm-drain-shipped',
      gateCommand: new RegExp(DOCKER_TEST_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the docker e2e').toBe(1);
    // No `needs:` — sigterm-drain-shipped stands alone, so its closure is
    // just itself.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      'sigterm-drain-shipped',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

describe('the CI path actually reaches the suite (both halves)', () => {
  it('the file the job names exists and is a docker e2e (bun:test, no vitest exclusion needed)', () => {
    const full = resolve(REPO_ROOT, DOCKER_TEST_PATH);
    expect(existsSync(full), `${DOCKER_TEST_PATH} does not exist`).toBe(true);
    const text = readFileSync(full, 'utf8');
    expect(text, 'the e2e must import bun:test').toMatch(/from ['"]bun:test['"]/);
  });

  it("the suite's only skip is an environment-availability gate (docker daemon), never an artifact gate", () => {
    const full = resolve(REPO_ROOT, DOCKER_TEST_PATH);
    const text = readFileSync(full, 'utf8');
    expect(
      text,
      'the docker e2e must gate on dockerAvailable(), not silently skip on something else',
    ).toMatch(/describe\.skipIf\(!dockerAvailable\(\)\)/);
  });
});
