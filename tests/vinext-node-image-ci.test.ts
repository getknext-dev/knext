import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

/**
 * #1260 — the vinext × node build-and-boot e2e has NO skip path; this asserts it
 * has somewhere to run, and that the somewhere actually reaches it.
 *
 * `packages/kn-next/src/__tests__/vinext-node-image.docker-e2e.test.ts` fails
 * (never skips) when docker, bun or a built @getknext/core is missing. Its
 * `.docker-e2e.test.ts` suffix excludes it from the fast `Lint & Test` lane, so
 * the ONLY thing that runs it is the `vinext-node-image` job. Delete that job
 * and the suite goes unreachable — and the one check that the node cell's V8
 * compile cache is baked AND accepted on boot (not merely present) would stop
 * running with nothing turning red.
 *
 * Same shape as tests/standalone-drain-image-ci.test.ts: the wiring is read as
 * text, the "is it blocking?" half is PARSED via tests/helpers/blocking-gate.ts.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_ID = 'vinext-node-image';
const JOB_KEY = `${JOB_ID}:`;
const E2E_PATH = 'packages/kn-next/src/__tests__/vinext-node-image.docker-e2e.test.ts';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`\n  ${JOB_KEY}\n`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length + 3);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Only the `run:` commands — prose in the job's comments must not satisfy a check. */
function runCommands(): string {
  return [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
}

describe('vinext × node image gate is wired into CI (#1260)', () => {
  it('runs the container e2e by its explicit path, not the fast suite', () => {
    expect(
      runCommands(),
      'the job never invokes the vinext-node docker e2e by its explicit path, so it is unreachable',
    ).toContain(E2E_PATH);
  });

  it('runs the runner that can collect a bun:test file (not vitest)', () => {
    expect(runCommands(), 'the job never invokes scripts/bun-test.mjs').toMatch(/bun-test\.mjs/);
    expect(runCommands(), 'the e2e imports bun:test — a `run:` must not invoke vitest').not.toMatch(
      /vitest/,
    );
  });

  it('installs bun, which the fixture install and build need', () => {
    expect(jobBlock(), 'the job never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('builds @getknext/core, whose dist the fixture links against', () => {
    expect(runCommands(), 'the job never builds @getknext/core').toMatch(
      /bun run --filter @getknext\/core build/,
    );
  });

  it('runs unconditionally on a PR and its failure fails the run', () => {
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: JOB_ID,
      gateCommand: new RegExp(E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    // ADR-0042 C6: a vinext image is built only after the pre-compile closure
    // gate. That gate cannot skip, so needing it does not make this skippable.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      JOB_ID,
      'vinext-precompile-closure',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

describe('the CI path actually reaches the suite (both halves)', () => {
  it('the file the job names exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, E2E_PATH);
    expect(existsSync(full), `${E2E_PATH} does not exist`).toBe(true);
    expect(E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

// #1273 — the vinext-node compile-cache bake's ONLY proof that the Dockerfile's
// ARG KNEXT_HEALTH_CHECK_PATH build-arg actually reaches the bake (rather than
// always falling back to /api/health) is this e2e: it rides in the same job
// (same docker + bun + @getknext/core setup) and has the same no-skip
// contract, so it needs the same wiring guard — mirrors the standalone-node
// #1264 follow-up wiring in tests/standalone-drain-image-ci.test.ts.
const CUSTOM_HEALTH_PATH_E2E_PATH =
  'packages/kn-next/src/__tests__/vinext-node-custom-health-path.docker-e2e.test.ts';

describe('the vinext-node custom-healthCheckPath bake e2e is wired into CI (#1273)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never runs the vinext-node-custom-health-path docker e2e',
    ).toContain(CUSTOM_HEALTH_PATH_E2E_PATH);
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: JOB_ID,
      gateCommand: new RegExp(CUSTOM_HEALTH_PATH_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, CUSTOM_HEALTH_PATH_E2E_PATH);
    expect(existsSync(full), `${CUSTOM_HEALTH_PATH_E2E_PATH} does not exist`).toBe(true);
    expect(CUSTOM_HEALTH_PATH_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});
