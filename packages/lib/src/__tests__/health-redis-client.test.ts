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

  ping() {
    return this.pingImpl();
  }
}

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

    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    for (let i = 0; i < 4; i++) instances[0].emit('error', err);

    const lines = [...error.mock.calls, ...warn.mock.calls].map((c: unknown[]) =>
      c.map((a) => String(a)).join(' '),
    );
    expect(lines.filter((l) => l.includes('ETIMEDOUT'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).not.toContain('redis://');
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
