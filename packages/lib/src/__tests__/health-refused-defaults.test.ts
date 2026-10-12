import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:net';

/**
 * A refused bring-your-own database reads `down` with DEFAULT settings.
 *
 * `health.test.ts` mocks the pool and rejects instantly, which is exactly why it
 * stayed green while the shipped behaviour was wrong: with no env set, the real
 * writer pool retries a failed connect for `DB_WAKE_RETRY_BUDGET_MS` (8 s) and the
 * deep check abandons the probe at `HEALTH_DEEP_TIMEOUT_MS` (8 s). The check lost
 * that race by a few milliseconds, kept its initial `waking`, and the
 * bring-your-own gate was never reached.
 *
 * So this file uses NEITHER a mock NOR a tuned knob: the real `getDbPool()` with
 * its real wake-retry layer, dialling a loopback port that really refuses, with
 * every timing variable unset. It runs once per driver the lib selects between
 * (`pg` on Node, `Bun.SQL` on Bun), because the issue reproduced on both.
 */

const TIMING_ENV = [
  'DB_WAKE_RETRY_BUDGET_MS',
  'DB_WAKE_RETRY_BASE_MS',
  'DB_WAKE_RETRY_MAX_MS',
  'DB_POOL_CONNECT_TIMEOUT_MS',
  'HEALTH_DEEP_TIMEOUT_MS',
  'DB_ACTIVITY_BUDGET_MS',
] as const;

/** A TCP port nothing is listening on: bind an ephemeral one, then release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const saved: Record<string, string | undefined> = {};

describe('checkDeepHealth — a refused bring-your-own database, default settings', () => {
  beforeEach(async () => {
    for (const k of [...TIMING_ENV, 'DATABASE_URL', 'REDIS_URL', 'KNEXT_DB_DRIVER']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    (await import('../clients')).resetClients();
  });

  afterEach(async () => {
    (await import('../clients')).resetClients();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const driver of ['pg', 'bun'] as const) {
    it(`${driver} driver: refused connection ⇒ down, promptly, with no env tuning`, async () => {
      const port = await closedPort();
      process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${port}/app`;
      process.env.KNEXT_DB_DRIVER = driver;

      const { checkDeepHealth } = await import('../health');
      const started = Date.now();
      const res = await checkDeepHealth();
      const elapsedMs = Date.now() - started;

      expect(res.checks.postgres).toBe('down');
      expect(res.status).toBe('down');
      // Not "after the whole deep-check window": a refusal is known on the first
      // attempt, so the verdict must not wait out the 8 s wake-retry budget.
      expect(elapsedMs).toBeLessThan(3000);
    }, 20_000);
  }
});
