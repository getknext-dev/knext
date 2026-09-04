import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { runAllTimersAsync } from '../../../../tests/helpers/bun-test-helpers';

/**
 * #310 — knext-client-side wake-path resilience: bounded retry/backoff so a
 * DB-backed request arriving DURING the scale-zero-pg cold-wake window resolves
 * as bounded latency (a successful acquisition) instead of surfacing a raw
 * connection error (→ 5xx). This is the client-side complement to the
 * scale-zero-pg gateway's own bounded wake-retry (#190).
 *
 * Contract pinned here:
 *  - A TRANSIENT connect/query failure during the wake window is retried with
 *    capped backoff and ultimately SUCCEEDS within the bounded retry budget.
 *  - A PERSISTENT failure surfaces the last error DETERMINISTICALLY once the
 *    retry budget is exhausted (bounded latency, not an unhandled rejection).
 *  - The retry path STILL stamps activity (the #361/#348 contract): a caller that
 *    is retrying keeps the stuck-`waking` alert probing.
 *  - Retry composes with the #339 single-flight: followers of a retrying leader do
 *    NOT each independently retry-storm — only the leader retries.
 *
 * These tests use fake timers so backoff sleeps don't make the suite slow.
 */

// A controllable fake pg Pool. Each connect()/query() consumes the next queued
// outcome from `outcomes` (resolve or reject), so a test scripts a sequence like
// [reject, reject, resolve] to model "wake window, then up". We also count total
// underlying acquisitions so we can prove followers don't independently retry.
type Outcome = { kind: 'ok' } | { kind: 'err'; err: unknown };

let outcomes: Outcome[] = [];
let acquireCount = 0;

function nextOutcome(): Outcome {
  acquireCount += 1;
  // If the script is exhausted, keep replaying the last outcome (so a persistent
  // failure stays failing, and a persistent success stays succeeding).
  const ok: Outcome = { kind: 'ok' };
  const o = outcomes.length > 0 ? (outcomes.shift() as Outcome) : ok;
  return o;
}

class FakePool {
  constructor(public config: unknown) {}

  private acquire(): Promise<{ release(): void }> {
    const o = nextOutcome();
    if (o.kind === 'err') return Promise.reject(o.err);
    return Promise.resolve({ release() {} });
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
mock.module('pg', () => ({ Pool: FakePool }));

const TRANSIENT = () =>
  Object.assign(new Error('ECONNREFUSED gateway waking'), { code: 'ECONNREFUSED' });

describe('@getknext/lib/clients — wake-path retry/backoff (#310)', () => {
  beforeEach(async () => {
    // `resetClients()` replaces `vi.resetModules()`, which bun has no
    // equivalent of. It clears the four cached clients AND the three
    // globalThis-anchored slots — including the DB-wake single-flight, which is
    // what this file's retry assertions actually depend on.
    (await import('../clients')).resetClients();
    jest.useRealTimers();
    outcomes = [];
    acquireCount = 0;
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    delete process.env.DATABASE_URL_RO;
    delete process.env.DB_WAKE_RETRY_BUDGET_MS;
    delete process.env.DB_WAKE_RETRY_BASE_MS;
    delete process.env.DB_WAKE_RETRY_MAX_MS;
    const mod = await import('../clients');
    mod.resetDbActivity();
    mod.resetDbWakeSingleflight?.();
  });

  afterEach(async () => {
    jest.useRealTimers();
    delete process.env.DATABASE_URL;
    delete process.env.DB_WAKE_RETRY_BUDGET_MS;
    delete process.env.DB_WAKE_RETRY_BASE_MS;
    delete process.env.DB_WAKE_RETRY_MAX_MS;
    const mod = await import('../clients');
    mod.resetDbWakeSingleflight?.();
  });

  it('exposes a bounded default retry budget, resolved on each read', async () => {
    const mod = await import('../clients');
    expect(mod.dbWakeRetryBudgetMs()).toBeGreaterThan(0);
    // Comfortably above the ~2.5s scale-zero-pg cold wake.
    expect(mod.dbWakeRetryBudgetMs()).toBeGreaterThanOrEqual(2_500);

    // The budget is a FUNCTION now, not a constant frozen at import. It used to
    // be the latter, which only worked because vitest re-imported the module
    // between tests; with no registry reset the first value would win for the
    // whole run, and a test setting the env to isolate a bound would silently
    // get the 8s default. This asserts the override is live.
    process.env.DB_WAKE_RETRY_BUDGET_MS = '1234';
    try {
      expect(mod.dbWakeRetryBudgetMs()).toBe(1234);
    } finally {
      delete process.env.DB_WAKE_RETRY_BUDGET_MS;
    }
    expect(mod.dbWakeRetryBudgetMs()).toBeGreaterThanOrEqual(2_500);
  });

  it('retries a transient connect failure during the wake window and ultimately succeeds', async () => {
    jest.useFakeTimers();
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // Two transient failures (mid-wake), then the DB is up.
    outcomes = [
      { kind: 'err', err: TRANSIENT() },
      { kind: 'err', err: TRANSIENT() },
      { kind: 'ok' },
    ];

    const acquired = pool.connect();
    // Drain the backoff sleeps.
    await runAllTimersAsync();
    const client = await acquired;
    expect(client).toBeTruthy();
    // Three underlying acquisitions: 2 failures + 1 success.
    expect(acquireCount).toBe(3);
  });

  it('surfaces the last error deterministically once the retry budget is exhausted', async () => {
    jest.useFakeTimers();
    // A tiny budget so the retries exhaust quickly under fake timers.
    process.env.DB_WAKE_RETRY_BUDGET_MS = '200';
    process.env.DB_WAKE_RETRY_BASE_MS = '50';
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // Persistent failure — every acquisition rejects.
    outcomes = [{ kind: 'err', err: TRANSIENT() }];
    // (nextOutcome replays the last outcome when the script is exhausted.)
    outcomes = new Array(20).fill({ kind: 'err', err: TRANSIENT() });

    const failing = pool.connect();
    // The rejection is CLAIMED before the drain (so it is never an unhandled
    // rejection) but ASSERTED after it.
    //
    // Creating `expect(...).rejects.toThrow()` before advancing fake timers
    // hangs under bun — isolated to twenty lines: the same promise, same drain,
    // assertion after works and assertion before never returns. vitest is happy
    // either way, which is why the original ordering existed.
    failing.catch(() => {});
    await runAllTimersAsync();
    await expect(failing).rejects.toThrow(/ECONNREFUSED/);
    // It gave up in a bounded number of attempts (not infinite).
    expect(acquireCount).toBeGreaterThanOrEqual(1);
    expect(acquireCount).toBeLessThan(20);
  });

  it('stamps activity even while the wake path is retrying (preserves #361/#348)', async () => {
    jest.useFakeTimers();
    const mod = await import('../clients');
    const pool = mod.getDbPool();
    expect(mod.getLastDbActivityAt()).toBeUndefined();

    outcomes = [{ kind: 'err', err: TRANSIENT() }, { kind: 'ok' }];
    const acquired = pool.connect();
    // Activity must be stamped up front (outer wrapper), before the retry resolves.
    expect(mod.getLastDbActivityAt()).toBeDefined();
    await runAllTimersAsync();
    await acquired;
    expect(mod.isDbRecentlyActive(50_000)).toBe(true);
  });

  it('only the single-flight LEADER retries — followers do not each retry-storm (composes with #339)', async () => {
    jest.useFakeTimers();
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // The leader's wake takes 2 transient failures then succeeds. If followers
    // ALSO retried independently, acquireCount would blow past leader(3)+followers.
    outcomes = [
      { kind: 'err', err: TRANSIENT() },
      { kind: 'err', err: TRANSIENT() },
      { kind: 'ok' },
    ];

    const N = 5;
    const inflight = Array.from({ length: N }, () => pool.connect());
    await runAllTimersAsync();
    const clients = await Promise.all(inflight);
    expect(clients).toHaveLength(N);

    // Leader did 3 acquisitions (2 fail + 1 success). Followers awaited the shared
    // wake, then each did ONE warm acquisition. So total = 3 (leader) + 4 (warm
    // followers). Critically the followers did NOT each independently retry-storm.
    expect(acquireCount).toBe(3 + (N - 1));
    expect(mod.isDbWoken?.()).toBe(true);
  });

  it('a non-transient error is not retried indefinitely (bounded) and still surfaces', async () => {
    jest.useFakeTimers();
    process.env.DB_WAKE_RETRY_BUDGET_MS = '200';
    process.env.DB_WAKE_RETRY_BASE_MS = '50';
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    outcomes = new Array(20).fill({
      kind: 'err',
      err: new Error('password authentication failed'),
    });
    const failing = pool.connect();
    // Claimed before the drain, ASSERTED after it: creating
    // `expect(...).rejects.toThrow()` before advancing fake timers hangs
    // under bun (isolated; vitest is happy either way).
    failing.catch(() => {});
    await runAllTimersAsync();
    await expect(failing).rejects.toThrow(/password authentication failed/);
    // #373: fail-FAST — a permanent (auth) error short-circuits `isPermanentAcquireError`
    // on the FIRST attempt, so exactly ONE acquisition happens (no retry-until-budget).
    // Pins that a regression which made 28xxx/auth errors retry would fail here rather
    // than silently hammering a genuinely-failing DB for the whole budget.
    expect(acquireCount).toBe(1);
    // Fail-open single-flight: the failed wake did not latch woken.
    expect(mod.isDbWoken?.()).toBe(false);
  });

  it('short-circuits mid-retry when a permanent (auth) error follows a transient one (#373)', async () => {
    jest.useFakeTimers();
    process.env.DB_WAKE_RETRY_BUDGET_MS = '2000';
    process.env.DB_WAKE_RETRY_BASE_MS = '50';
    const mod = await import('../clients');
    const pool = mod.getDbPool();

    // A transient connect-race failure (retried), then a PERMANENT auth error
    // arrives on the second attempt. The retry loop must NOT keep going after the
    // permanent error even though the budget is far from exhausted — it fails fast.
    outcomes = [
      { kind: 'err', err: TRANSIENT() },
      { kind: 'err', err: new Error('password authentication failed') },
      // Anything queued after this must NEVER be consumed (would prove it kept retrying).
      { kind: 'ok' },
      { kind: 'ok' },
    ];

    const failing = pool.connect();
    // Claimed before the drain, ASSERTED after it: creating
    // `expect(...).rejects.toThrow()` before advancing fake timers hangs
    // under bun (isolated; vitest is happy either way).
    failing.catch(() => {});
    await runAllTimersAsync();
    await expect(failing).rejects.toThrow(/password authentication failed/);
    // Exactly two acquisitions: the transient (retried) + the permanent (short-circuit).
    // The queued OK outcomes are never reached → no further retries after the auth error.
    expect(acquireCount).toBe(2);
    expect(mod.isDbWoken?.()).toBe(false);
  });
});
