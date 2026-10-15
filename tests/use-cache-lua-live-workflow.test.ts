import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { auditBlockingGate } from './helpers/blocking-gate.js';

/**
 * GUARD TESTS for the lanes that run the `'use cache'` tag replay's Lua
 * (`REPLAY_STAMPS_SCRIPT`) on a REAL Redis.
 *
 * The live suite skips without `KNEXT_REDIS_LIVE_URL`, so on its own it is only
 * as strong as the workflow that sets that variable. These tests hold that
 * workflow in place:
 *
 * 1. `ci.yml`'s `use-cache-lua-live-redis` job is a BLOCKING PR gate (parsed,
 *    not text-matched) that runs the live suite with the variable set inline to
 *    a loopback URL of a digest-pinned, health-checked Redis service, and never
 *    sets `REDIS_URL`.
 * 2. The nightly mutation-prover lane gives the replay prover the same Redis,
 *    because that prover's Lua rows are graded by the live suite and refuse to
 *    run without it.
 * 3. The suite reads the same variable name the workflows set.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const NIGHTLY_YML = resolve(REPO_ROOT, '.github/workflows/mutation-prover-nightly.yml');
const LIVE_SPEC = 'packages/kn-next/src/__tests__/use-cache-replay-script-live-redis.test.ts';
// The per-app key-prefix collapse spec: two app processes on one Redis, graded
// on the fake RESP server always and on this job's real Redis when the variable
// is set. Without this job it never meets a real SCAN/DEL.
const PREFIX_SPEC = 'packages/kn-next/src/__tests__/redis-prefix-collapse-isolation.test.ts';
const PROVER = 'scripts/mutation-prove-2331-use-cache-tag-replay.mjs';
const JOB_ID = 'use-cache-lua-live-redis';
const ENV_VAR = 'KNEXT_REDIS_LIVE_URL';
const LOOPBACK_URL = /^redis:\/\/(127\.0\.0\.1|localhost):\d+\/?$/;

type Obj = Record<string, unknown>;

function jobsOf(path: string): Record<string, Obj> {
  const doc = parse(readFileSync(path, 'utf8')) as { jobs?: Record<string, Obj> };
  expect(doc?.jobs, `${path} parsed to no jobs`).toBeDefined();
  return doc.jobs as Record<string, Obj>;
}

function redisService(job: Obj, where: string): Obj {
  const services = job.services as Record<string, Obj> | undefined;
  expect(services?.redis, `${where} must run a redis service container`).toBeDefined();
  return (services as Record<string, Obj>).redis as Obj;
}

function expectPinnedHealthyRedis(service: Obj, where: string) {
  expect(String(service.image), `${where}: redis image must be digest-pinned`).toMatch(
    /^mirror\.gcr\.io\/library\/redis:[\w.-]+@sha256:[0-9a-f]{64}$/,
  );
  expect(String(service.options), `${where}: redis must be health-gated`).toMatch(
    /--health-cmd[^\n]*redis-cli ping/,
  );
  expect(String(service.options)).toMatch(/--health-retries/);
  expect(service.ports, `${where}: redis must be reachable on loopback`).toContain('6379:6379');
}

/** The env a step runs with: the job's, overlaid by the step's own. */
function stepEnv(job: Obj, step: Obj): Obj {
  return { ...((job.env as Obj) ?? {}), ...((step.env as Obj) ?? {}) };
}

function stepsRunning(job: Obj, pattern: RegExp): Obj[] {
  const steps = (job.steps as Obj[] | undefined) ?? [];
  return steps.filter((s) => typeof s.run === 'string' && pattern.test(s.run as string));
}

describe(`ci.yml — ${JOB_ID} (the replay Lua on a real Redis)`, () => {
  it('is a blocking PR gate whose gate step runs the live suite', () => {
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: JOB_ID,
      gateCommand: /use-cache-replay-script-live-redis\.test\.ts/,
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'no step runs the live suite').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('runs the suite with --no-skip, so a skipped Lua case fails the job', () => {
    const job = jobsOf(CI_YML)[JOB_ID] as Obj;
    const [step] = stepsRunning(job, /use-cache-replay-script-live-redis\.test\.ts/);
    expect(step, 'no step runs the live suite').toBeDefined();
    expect(String((step as Obj).run)).toMatch(/scripts\/bun-test\.mjs\s+--no-skip\b/);
  });

  it('runs the key-prefix collapse spec in the same gate step, against the same Redis', () => {
    const job = jobsOf(CI_YML)[JOB_ID] as Obj;
    const [step] = stepsRunning(job, /use-cache-replay-script-live-redis\.test\.ts/);
    expect(step, 'no step runs the live suite').toBeDefined();
    const args = String((step as Obj).run).split(/\s+/);
    expect(args, `${PREFIX_SPEC} must run in the ${JOB_ID} gate step`).toContain(PREFIX_SPEC);
  });

  it('runs a digest-pinned, health-gated Redis service', () => {
    expectPinnedHealthyRedis(redisService(jobsOf(CI_YML)[JOB_ID] as Obj, JOB_ID), JOB_ID);
  });

  it(`runs the suite with ${ENV_VAR} set inline to the loopback service — no secret, no REDIS_URL`, () => {
    const job = jobsOf(CI_YML)[JOB_ID] as Obj;
    const [step] = stepsRunning(job, /use-cache-replay-script-live-redis\.test\.ts/);
    expect(step, 'no step runs the live suite').toBeDefined();
    const env = stepEnv(job, step as Obj);
    expect(String(env[ENV_VAR]), `${ENV_VAR} must be a loopback URL literal`).toMatch(LOOPBACK_URL);
    expect('REDIS_URL' in env, 'REDIS_URL would point every cache test at this Redis').toBe(false);
  });
});

describe('mutation-prover-nightly.yml — the replay prover can run its Lua rows', () => {
  it(`gives the prover lane a pinned Redis and ${ENV_VAR}`, () => {
    const job = jobsOf(NIGHTLY_YML)['run-mutation-provers'] as Obj;
    expect(job, 'the nightly lane job is gone').toBeDefined();
    expectPinnedHealthyRedis(redisService(job, 'run-mutation-provers'), 'run-mutation-provers');
    const [step] = stepsRunning(job, /run-mutation-provers\.mjs/);
    expect(step, 'no step runs the prover lane').toBeDefined();
    const env = stepEnv(job, step as Obj);
    expect(String(env[ENV_VAR]), `${ENV_VAR} must be a loopback URL literal`).toMatch(LOOPBACK_URL);
    expect('REDIS_URL' in env, 'REDIS_URL would point every prover spec at this Redis').toBe(false);
  });

  it('the prover grades its Lua rows on the live suite and refuses to run without Redis', () => {
    const src = readFileSync(resolve(REPO_ROOT, PROVER), 'utf8');
    expect(src).toContain(LIVE_SPEC);
    expect(src).toContain(ENV_VAR);
  });
});

describe('the key-prefix collapse spec', () => {
  // It SETS REDIS_URL itself (each "app" process points at the backend under
  // test), so the job's env must not, and it takes the real Redis only from
  // the job's variable, refusing a non-loopback host.
  it(`takes the real Redis from ${ENV_VAR} and refuses a non-loopback host`, () => {
    const src = readFileSync(resolve(REPO_ROOT, PREFIX_SPEC), 'utf8');
    expect(src).toContain(`process.env.${ENV_VAR}`);
    expect(src).toContain('must be a loopback Redis');
  });
});

describe('the live suite', () => {
  it(`reads ${ENV_VAR}, never REDIS_URL`, () => {
    const src = readFileSync(resolve(REPO_ROOT, LIVE_SPEC), 'utf8');
    expect(src).toContain(`process.env.${ENV_VAR}`);
    expect(src).not.toMatch(/process\.env\.REDIS_URL/);
    expect(src).toMatch(/describe\.skipIf\(!LIVE\)/);
  });
});
