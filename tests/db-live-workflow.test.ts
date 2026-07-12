import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TESTS for the `db-live-integration` CI job (plan P2).
 *
 * The `@knext/db` live-Postgres lane runs the integration suite against a
 * `postgres:16` service container. Two invariants are load-bearing:
 *
 * 1. **No real DSN can ever enter the lane.** The job's `DATABASE_URL` is a
 *    HARDCODED, inline, throwaway DSN pointing at the service container on
 *    loopback — it must reference NO `secrets.*`. Combined with the suite's
 *    own host guard (live-dsn-guard.ts), a production database can never
 *    receive test writes/drops from CI.
 * 2. **Readiness is gated on pg_isready-style health options** of the service
 *    container, so the suite never races a booting Postgres (the plan's
 *    container-readiness-flake risk).
 *
 * Like tests/supply-chain-workflow.test.ts, this scans the workflow YAML as
 * text so the test adds no runtime YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * Extract the `db-live-integration` job block: from its job key to the next
 * top-level job key (2-space indent) or EOF.
 */
function dbLiveJobBlock(): string {
  const text = workflowText();
  const start = text.search(/^ {2}db-live-integration:/m);
  expect(start, 'ci.yml must define a db-live-integration job').toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('ci.yml — db-live-integration job (live @knext/db lane)', () => {
  it('runs a postgres:16 service container', () => {
    const job = dbLiveJobBlock();
    expect(job).toMatch(/services:/);
    expect(job).toMatch(/image:\s*postgres:16/);
  });

  it('gates on pg_isready-style container health options', () => {
    const job = dbLiveJobBlock();
    expect(job).toMatch(/--health-cmd[^\n]*pg_isready/);
    expect(job).toMatch(/--health-retries/);
  });

  it('hardcodes an inline throwaway loopback DSN — DATABASE_URL comes from no secret', () => {
    const job = dbLiveJobBlock();
    const dsnLine = job.match(/DATABASE_URL:\s*(\S+)/);
    expect(dsnLine, 'job must set DATABASE_URL inline').not.toBeNull();
    const dsn = (dsnLine as RegExpMatchArray)[1].replace(/^['"]|['"]$/g, '');
    // Literal DSN, not an expression:
    expect(dsn).not.toContain('${{');
    // Loopback host only — the same allowlist the suite's host guard enforces.
    expect(dsn).toMatch(/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//);
  });

  it('references NO secrets.* expression anywhere in the job (throwaway credentials only)', () => {
    expect(dbLiveJobBlock()).not.toMatch(/\$\{\{[^}]*secrets\./);
  });

  it('enables the live gate (KNEXT_DB_LIVE=1) and runs the live suite', () => {
    const job = dbLiveJobBlock();
    expect(job).toMatch(/KNEXT_DB_LIVE:\s*['"]?1['"]?/);
    expect(job).toMatch(/live-postgres\.test\.ts/);
  });

  it('never sets the unsafe-host override in CI', () => {
    expect(dbLiveJobBlock()).not.toMatch(/KNEXT_DB_LIVE_UNSAFE_HOST/);
  });
});
