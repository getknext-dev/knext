import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

/**
 * #1156 — the standalone-on-bun SIGTERM drain e2e has NO skip path; this asserts
 * it has somewhere to run, and that the somewhere actually reaches it.
 *
 * `packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts` fails
 * (never skips) when docker or bun is missing — the right shape for a drain
 * gate. But its `.docker-e2e.test.ts` suffix excludes it from the fast
 * `Lint & Test` lane (scripts/bun-test.mjs / vitest.config.ts both drop that
 * pattern unless the file is named explicitly), so the ONLY thing that runs it
 * is the `standalone-drain-bun-image` job. Delete that job and the suite goes
 * unreachable: nothing turns red, and the R3 shim / supervisor drain it protects
 * could regress with the same silence #1156 was filed against.
 *
 * These assertions guard the WIRING. The CONTENT half reads the job as text (the
 * SHA-pinned `uses:`, the exact e2e path it runs); the "is this job actually
 * blocking?" half is PARSED via tests/helpers/blocking-gate.ts (a text `if:`
 * anchor misses quoted-key and skippable-`needs:` disarms — #661).
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'standalone-drain-bun-image:';
const E2E_PATH = 'packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts';

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

describe('standalone-on-bun drain gate is wired into CI (#1156)', () => {
  it('runs the container e2e by its explicit path, not the fast suite', () => {
    const block = jobBlock();
    // Scope to the actual `run:` commands, not the whole block — the job's
    // leading comment also names E2E_PATH in prose (#1188), so asserting over
    // the whole block stays green even if a `run:` line is renamed away from
    // the real path while the comment still mentions it.
    const runCommands = [...block.matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(
      runCommands,
      'the job never invokes the standalone-drain docker e2e by its explicit path, so it is unreachable',
    ).toContain(E2E_PATH);
  });

  it('runs the runner that can collect a bun:test file (not vitest)', () => {
    const block = jobBlock();
    expect(block, 'the job never invokes scripts/bun-test.mjs').toMatch(/bun-test\.mjs/);
    // Scope the not-vitest check to the actual `run:` commands — the prose above
    // legitimately names `vitest.config.ts` as the file that excludes the suite.
    const runCommands = [...block.matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(runCommands, 'the e2e imports bun:test — a `run:` must not invoke vitest').not.toMatch(
      /vitest/,
    );
  });

  it('installs bun, which the image build + operator command need', () => {
    expect(jobBlock(), 'the job never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('builds @getknext/core, whose dist the image COPYs as the supervisor', () => {
    expect(jobBlock(), 'the job never builds @getknext/core').toMatch(
      /bun run --filter @getknext\/core build/,
    );
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    // No `needs:` — the job stands alone, so its closure is just itself.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      'standalone-drain-bun-image',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});

// #1226 — the Pages Router + custom-cacheHandler identity e2e for the compiled
// executable rides in the same job (it needs the same docker + bun) and has
// the same no-skip contract, so it needs the same wiring guard.
const PAGES_E2E_PATH = 'packages/kn-next/src/__tests__/standalone-pages.docker-e2e.test.ts';

describe('the compiled-exec Pages Router / cacheHandler identity e2e is wired into CI (#1226)', () => {
  it('a `run:` in the job invokes it by its explicit path, as a blocking step', () => {
    const runCommands = [...jobBlock().matchAll(/run:\s*([^\n]*)/g)].map((m) => m[1]).join('\n');
    expect(runCommands, 'the job never runs the standalone-pages docker e2e').toContain(
      PAGES_E2E_PATH,
    );
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'standalone-drain-bun-image',
      gateCommand: new RegExp(PAGES_E2E_PATH.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    });
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the e2e').toBe(1);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the file exists, is a container e2e, and imports bun:test', () => {
    const full = resolve(REPO_ROOT, PAGES_E2E_PATH);
    expect(existsSync(full), `${PAGES_E2E_PATH} does not exist`).toBe(true);
    expect(PAGES_E2E_PATH).toMatch(/\.docker-e2e\.test\.ts$/);
    expect(readFileSync(full, 'utf8'), 'the e2e must import bun:test').toMatch(
      /from ['"]bun:test['"]/,
    );
  });
});

describe('the CI path actually reaches the suite (both halves)', () => {
  it('the file the job names exists and is a container e2e', () => {
    const full = resolve(REPO_ROOT, E2E_PATH);
    expect(existsSync(full), `${E2E_PATH} does not exist`).toBe(true);
    expect(
      E2E_PATH,
      'the e2e must carry the `.docker-e2e.test.ts` suffix the fast lane excludes',
    ).toMatch(/\.docker-e2e\.test\.ts$/);
    // It must import bun:test (the runner the job uses), not vitest.
    const text = readFileSync(full, 'utf8');
    expect(text, 'the e2e must import bun:test').toMatch(/from ['"]bun:test['"]/);
  });
});
