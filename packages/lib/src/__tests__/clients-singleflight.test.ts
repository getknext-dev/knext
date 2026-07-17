import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #339 — single-flight the DB wake in the pool-acquire path.
 *
 * Failure (OKE, 2026-07-17): a single cold request (app+DB asleep) wakes in
 * ~6.4s; TWENTY concurrent cold requests took ~32s (~5x). Root of the wake half:
 * N concurrent first-connects each independently open a socket to the
 * scale-zero-pg gateway and each blocks on the 0→1 `compute-<app>` wake, with no
 * single-flight — so the burst serializes/contends instead of sharing ONE wake.
 *
 * Fix: single-flight the wake at `getDbPool()`'s acquire path. The FIRST client
 * acquisition (connect() OR query()) establishes ONE shared in-flight wake
 * probe; concurrent first-callers AWAIT that single probe rather than each
 * triggering their own 0→1 wake. Once the probe resolves (DB awake) the latch is
 * set and every later acquisition passes straight through (warm).
 *
 * Contract pinned here:
 *  - N simultaneous first-connects trigger the underlying wake probe exactly ONCE.
 *  - After the wake, subsequent acquisitions do NOT re-trigger the probe.
 *  - A REJECTED wake does NOT consume the latch (fail-open, mirrors #336): the
 *    next acquisition still single-flights a fresh wake.
 *  - Shared single-flight state is anchored on globalThis (ADR-0027), so it is
 *    not split by a duplicated bundle copy.
 */

/**
 * A controllable fake pg Pool. `connect()` and `query()` both acquire a client;
 * the fake counts the SLOW (cold) acquisitions so a test can assert how many
 * times the underlying 0→1 wake was actually triggered. We gate the first
 * acquisition on a manually-released deferred so we can line up N concurrent
 * first-callers BEFORE the wake resolves.
 */
let coldAcquires = 0;
let releaseWake!: () => void;
let rejectWake!: (err: unknown) => void;
let wakeGate!: Promise<void>;

function newGate() {
  wakeGate = new Promise<void>((resolve, reject) => {
    releaseWake = resolve;
    rejectWake = reject;
  });
}

class FakePool {
  constructor(public config: unknown) {}

  // The first (cold) acquisition blocks on `wakeGate`; later (warm) ones resolve
  // immediately. Counting `coldAcquires` = counting real 0→1 wake triggers.
  private acquire(): Promise<{ release(): void }> {
    coldAcquires += 1;
    return wakeGate.then(() => ({ release() {} }));
  }

  connect() {
    return this.acquire();
  }

  query() {
    return this.acquire().then((c) => {
      c.release();
      return { rows: [] };
    });
  }

  end() {
    return Promise.resolve();
  }
}
vi.mock('pg', () => ({ Pool: FakePool }));

describe('@knext/lib/clients — single-flight DB wake (#339)', () => {
  beforeEach(async () => {
    vi.resetModules();
    coldAcquires = 0;
    newGate();
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    delete process.env.DATABASE_URL_RO;
    const mod = await import('../clients');
    mod.resetDbActivity();
    mod.resetDbWakeSingleflight?.();
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_RO;
    const mod = await import('../clients');
    mod.resetDbWakeSingleflight?.();
  });

  it('collapses N concurrent first-connects onto ONE wake trigger', async () => {
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // 20 concurrent cold first-connects, all racing BEFORE the wake resolves.
    const N = 20;
    const inflight = Array.from({ length: N }, () => pool.connect());

    // Let the shared wake resolve.
    releaseWake();
    const clients = await Promise.all(inflight);
    for (const c of clients) c.release();

    // The underlying cold 0→1 wake must have been triggered exactly ONCE, not N.
    expect(coldAcquires).toBe(1);
    expect(clients).toHaveLength(N);
  });

  it('single-flights a mix of concurrent connect() and query() first-callers', async () => {
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    const inflight: Promise<unknown>[] = [
      pool.connect(),
      pool.query('SELECT 1'),
      pool.connect(),
      pool.query('SELECT 2'),
    ];

    releaseWake();
    const results = await Promise.all(inflight);
    // connect() results expose release(); release the two clients.
    for (const r of results) {
      if (r && typeof (r as { release?: unknown }).release === 'function') {
        (r as { release(): void }).release();
      }
    }

    // Only ONE of the four concurrent first-callers triggered the cold wake.
    expect(coldAcquires).toBe(1);
  });

  it('does NOT re-trigger the wake once the pool is warm', async () => {
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // Wake it (single cold acquire).
    const first = pool.connect();
    releaseWake();
    (await first).release();
    expect(coldAcquires).toBe(1);

    // Warm acquisitions must pass straight through — the gate is already resolved
    // so they resolve immediately, but they must NOT wait on / re-arm a new probe.
    const warm = await Promise.all([pool.connect(), pool.query('SELECT 1'), pool.connect()]);
    for (const r of warm) {
      if (r && typeof (r as { release?: unknown }).release === 'function') {
        (r as { release(): void }).release();
      }
    }
    // coldAcquires increments per underlying acquisition; the single-flight only
    // gates the FIRST wake — after that each call does its own acquire. The point
    // is that the WAKE (single-flight probe) fired once, not that warm calls are
    // deduped. Assert the pool is marked woken so no NEW probe was armed.
    expect(mod.isDbWoken?.()).toBe(true);
  });

  it('a REJECTED wake does not consume the latch — the retry re-wakes (fail-open, #336)', async () => {
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // First wake attempt rejects (gateway still waking / connect timeout).
    const failing = pool.connect();
    rejectWake(new Error('ECONNREFUSED: gateway still waking'));
    await expect(failing).rejects.toThrow(/ECONNREFUSED/);

    // The latch must NOT be consumed by the failed attempt.
    expect(mod.isDbWoken?.()).toBe(false);

    // A retry single-flights a FRESH wake and succeeds.
    newGate();
    const retry = pool.connect();
    releaseWake();
    (await retry).release();
    expect(mod.isDbWoken?.()).toBe(true);
  });
});
