import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 data-plane resilience — DB connection CHAOS test (CI-runnable, no live
 * Postgres). The @knext/db parity for the cache-handler chaos test
 * (packages/kn-next/src/__tests__/cache-handler-chaos.test.ts).
 *
 * The load-bearing reliability property here is BOUNDED FAILURE. `@knext/lib`'s
 * pools deliberately set a finite `connectionTimeoutMillis` (default 15s,
 * env-overridable via `DB_POOL_CONNECT_TIMEOUT_MS`) precisely so that when
 * Postgres is unreachable a request FAILS FAST with a clear pool error instead
 * of hanging forever (pg's default connect timeout is 0 = wait indefinitely —
 * see clients.ts). Until now this was only verified by READING the code.
 *
 * This test PROVES it by driving the REAL `pg` pool (unmocked) through the
 * @knext/db `getDb()` accessor against:
 *   - a DEAD loopback port  → the OS refuses the TCP connection immediately;
 *   - a SLOW-but-alive peer  → a socket that ACCEPTS then never speaks the
 *     Postgres protocol, so the connect-timeout guard is what must fire.
 *
 * Both must reject within the configured bound and NEVER report a false
 * success. We drive the connect timeout LOW (via DB_POOL_CONNECT_TIMEOUT_MS) so
 * the suite stays fast while asserting the guard is honored.
 *
 * Data-sovereignty (scs-zones.md): every DSN below is a private loopback port
 * this test itself owns — never another zone's CNPG service.
 *
 * `@knext/db` / `@knext/lib` read env + build the pool as module-level
 * singletons at first `getDb()`, so each case resets the module registry and
 * re-imports with a fresh environment.
 */
describe('db pool chaos: connection failure is BOUNDED, never a hang or false success', () => {
  const original = { ...process.env };

  // A short connect timeout keeps the suite fast while still proving the guard:
  // the assertions below require the rejection to land WELL under 15s and near
  // this bound, so a regression back to pg's infinite default would fail here.
  const CONNECT_TIMEOUT_MS = 800;

  // A ceiling with generous slack over the bound for scheduler/CI jitter, but
  // far below the 15s default — a reintroduced unbounded connect blows past it.
  const BOUNDED_CEILING_MS = 6_000;

  beforeEach(() => {
    vi.resetModules();
    process.env.DB_POOL_CONNECT_TIMEOUT_MS = String(CONNECT_TIMEOUT_MS);
    // Keep the pool tiny so a single failed connect surfaces immediately.
    process.env.DB_POOL_MAX = '1';
    // Isolate the CONNECT bound from the #310 wake-retry layer: getDbPool now
    // wraps acquire in retryWake, which classifies ECONNREFUSED / connect-timeout
    // as transient and retries for DB_WAKE_RETRY_BUDGET_MS (default 8s). This test
    // asserts the connect guard in isolation, so pin a 1ms retry budget = a single
    // attempt, no retry. (`toFinitePositiveInt` treats 0 as unset → default, so use 1.)
    process.env.DB_WAKE_RETRY_BUDGET_MS = '1';
    // Silence expected connection-error noise so suite output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...original };
    vi.restoreAllMocks();
  });

  it('dead loopback port (connection refused): getDb().execute rejects fast, well under the 15s default', async () => {
    // Nothing listens on this high loopback port — the OS refuses the TCP
    // connection on every attempt (ECONNREFUSED), a dead DB without a proxy.
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:6544/db';

    const { getDb, sql } = await import('../index');
    const db = getDb();

    const t0 = Date.now();
    let rejected = false;
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      rejected = true;
    }
    const elapsed = Date.now() - t0;

    // Load-bearing guarantees: it REJECTS (no false success) and does so within
    // a BOUNDED window far below pg's 15s (infinite-by-default) connect.
    expect(rejected).toBe(true);
    expect(elapsed).toBeLessThan(BOUNDED_CEILING_MS);
  });

  it('slow-but-alive peer (accept-then-hang): the connect-timeout guard fires, bounded by DB_POOL_CONNECT_TIMEOUT_MS', async () => {
    // A TCP server that ACCEPTS the connection but never speaks the Postgres
    // wire protocol — the refuse-fast path does NOT apply, so ONLY the
    // connectionTimeoutMillis guard can end the hang. This is the distinct
    // failure mode from the dead-port case above.
    const sockets: net.Socket[] = [];
    const server = net.createServer((sock) => {
      sockets.push(sock);
      // Intentionally never write: leave the client waiting on the handshake.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind the slow-but-alive test server');
    }
    process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${address.port}/db`;

    try {
      const { getDb, sql } = await import('../index');
      const db = getDb();

      const t0 = Date.now();
      let rejected = false;
      try {
        await db.execute(sql`SELECT 1`);
      } catch {
        rejected = true;
      }
      const elapsed = Date.now() - t0;

      // The connect-timeout guard must fire: a rejection (never a false
      // success), landing at/after the configured bound but still WELL under
      // the 15s default — proving the timeout, not an unbounded hang, ended it.
      expect(rejected).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(BOUNDED_CEILING_MS);

      // Clean up the client pool BEFORE the server so no socket outlives it.
      const { closeDbPool } = await import('@knext/lib/clients');
      await closeDbPool();
    } finally {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
