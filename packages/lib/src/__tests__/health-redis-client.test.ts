import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #802, second emitter — the deep-health Redis client has the same shape as the
 * cache-events route's: constructed once, no error listener, unbounded default
 * retry. On a fresh pod with a troubled Redis it churns and prints
 * `[ioredis] Unhandled error event` on its own schedule, which is what
 * contaminated the ledger row-3 stall capture.
 *
 * Deep health is on-demand (the :9091 scrape), so `lazyConnect` costs nothing:
 * the first `ping()` connects. Behaviour is otherwise untouched — the check
 * still fails OPEN to `degraded`, and readiness is still shallow (ADR-0026).
 */

const instances: FakeRedis[] = [];

class FakeRedis {
  readonly options: Record<string, unknown>;
  readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  pingImpl: () => Promise<string> = async () => 'PONG';
  /**
   * ioredis's own state machine, in miniature. Without this the fake had NO
   * `status`, so `ensureDialable`'s re-dial branch was structurally unreachable
   * in every health test and the recovery contract was unproven on this path —
   * the coverage hole the review found.
   */
  status = 'wait';
  connectCalls = 0;

  constructor(_url: string, options: Record<string, unknown>) {
    this.options = options;
    instances.push(this);
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  connect() {
    this.connectCalls += 1;
    this.status = 'connecting';
    return Promise.resolve();
  }

  ping() {
    return this.pingImpl();
  }
}

// Mock the SEAM, not the package. `vi.mock('ioredis')` resolves by module id
// and cannot intercept the computed-specifier `require` that keeps ioredis out
// of the bundle graph — when the loader was inline, this mock silently stopped
// applying and these tests dialled a real Redis.
vi.mock('../redis/ioredis-ctor', () => ({ loadRedisCtor: () => FakeRedis }));
vi.mock('ioredis', () => ({ default: FakeRedis }));
vi.mock('pg', () => ({
  Pool: class {
    query() {
      return Promise.resolve({ rows: [{ healthy: 1 }] });
    }
    connect() {
      return Promise.resolve({ release() {} });
    }
    end() {
      return Promise.resolve();
    }
  },
}));

describe('#802 — deep-health Redis client is lazy, listened-to and bounded', () => {
  beforeEach(() => {
    vi.resetModules();
    instances.length = 0;
    process.env.REDIS_URL = 'redis://:hunter2@redis.default.svc.cluster.local.:6379';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.REDIS_URL;
  });

  it('constructs the client lazily, with an error listener and a bounded retry', async () => {
    const { checkDeepHealth } = await import('../health');

    // Nothing constructed until the check actually runs.
    expect(instances).toHaveLength(0);

    const result = await checkDeepHealth();

    expect(result.checks.redis).toBe('up');
    expect(instances).toHaveLength(1);
    expect(instances[0].options.lazyConnect).toBe(true);
    expect(instances[0].listeners.get('error') ?? []).toHaveLength(1);
    const retryStrategy = instances[0].options.retryStrategy as (t: number) => number | null;
    expect(typeof retryStrategy).toBe('function');
    expect(retryStrategy(100)).toBeNull();
  });

  it('absorbs a repeated background error class ONCE and never logs the URL', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { checkDeepHealth } = await import('../health');
    await checkDeepHealth();

    // The DSN arrives the way it actually can — inside the error MESSAGE.
    const err = Object.assign(
      new Error('connect ETIMEDOUT redis://:hunter2@redis.default.svc.cluster.local.:6379'),
      { code: 'ETIMEDOUT' },
    );
    for (let i = 0; i < 4; i++) instances[0].emit('error', err);

    const lines = [...error.mock.calls, ...warn.mock.calls].map((c: unknown[]) =>
      c.map((a) => String(a)).join(' '),
    );
    expect(lines.filter((l) => l.includes('ETIMEDOUT'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).not.toContain('redis://');
  });

  it('re-dials on the deep-health path when the bounded retry gave up', async () => {
    // The contract that stops #802's fix from trading a reconnect loop for a
    // permanently-blind deep-health check: a client stranded in `end` is
    // re-dialled by the scrape that wants the answer.
    const { checkDeepHealth } = await import('../health');
    await checkDeepHealth();
    expect(instances[0].connectCalls).toBe(0);

    instances[0].status = 'end';
    await checkDeepHealth();

    expect(instances[0].connectCalls).toBe(1);
  });

  it('does NOT re-dial a healthy client on the deep-health path (the other half)', async () => {
    const { checkDeepHealth } = await import('../health');
    await checkDeepHealth();

    instances[0].status = 'ready';
    await checkDeepHealth();

    expect(instances[0].connectCalls).toBe(0);
  });

  it('still fails OPEN to degraded when the ping fails (behaviour unchanged)', async () => {
    const { checkDeepHealth } = await import('../health');
    const first = await checkDeepHealth();
    expect(first.checks.redis).toBe('up');

    instances[0].pingImpl = () => Promise.reject(new Error('connect ETIMEDOUT'));
    const second = await checkDeepHealth();

    expect(second.checks.redis).toBe('down');
    expect(second.status).toBe('degraded');
  });
});
