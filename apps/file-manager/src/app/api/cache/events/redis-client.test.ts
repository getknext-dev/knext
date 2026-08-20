import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #802 — the module-scope Redis client must be quiet and bounded.
 *
 * Ledger row 3's Appendix C captured four `[ioredis] Unhandled error event:
 * connect ETIMEDOUT` lines on a stalled pod and proved they could NOT be the
 * cache handler's (it always has an error listener). The emitter that fits is
 * this route's client: constructed at MODULE EVALUATION, dialling immediately,
 * with no error listener and an unbounded default retry — ~8–10 s of reconnect
 * loop churning across the pod's life, and log noise that actively contaminated
 * the stall investigation.
 *
 * What is testable here, honestly: the CONSTRUCTION contract. The route module
 * is imported with `ioredis` mocked, so this asserts what the app asks ioredis
 * for — lazy (no dial at import), an error listener attached at construction,
 * and a retry strategy that gives up. It does NOT prove ioredis honours
 * `lazyConnect`; that is ioredis's own contract, and asserting it here would be
 * testing the dependency, not the app.
 */

const instances: FakeRedis[] = [];

class FakeRedis {
  readonly options: Record<string, unknown>;
  readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  connectCalls = 0;
  commands: string[] = [];
  /** ioredis's own state machine, in miniature: `end` = the retry gave up. */
  status = 'wait';

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
    return Promise.resolve();
  }

  async lrange(..._a: unknown[]) {
    this.commands.push('lrange');
    return [];
  }

  async del(..._a: unknown[]) {
    this.commands.push('del');
    return 1;
  }
}

vi.mock('ioredis', () => ({ default: FakeRedis }));
// The route pulls in the cache handler through `cache-init`; neither is the
// subject here, and importing it would dial for real.
vi.mock('../../../../cache-init', () => ({}));

describe('#802 — cache-events route Redis client', () => {
  beforeEach(() => {
    vi.resetModules();
    instances.length = 0;
    process.env.REDIS_URL = 'redis://redis.default.svc.cluster.local.:6379';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.REDIS_URL;
  });

  it('does NOT dial at module import — the client is lazy', async () => {
    await import('./route');

    expect(instances).toHaveLength(1);
    expect(instances[0].options.lazyConnect).toBe(true);
    expect(instances[0].connectCalls).toBe(0);
  });

  it('attaches an error listener at construction — no unhandled ioredis errors', async () => {
    await import('./route');

    const errorListeners = instances[0].listeners.get('error') ?? [];
    expect(errorListeners).toHaveLength(1);
    // An error must be absorbed, not thrown out of the emitter.
    expect(() =>
      instances[0].emit(
        'error',
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      ),
    ).not.toThrow();
  });

  it('logs a repeated error class ONCE, not once per retry (the 4-line capture)', async () => {
    await import('./route');
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });

    for (let i = 0; i < 4; i++) instances[0].emit('error', err);

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('ETIMEDOUT'));
    expect(logged).toHaveLength(1);
  });

  it('still reports a DIFFERENT error class (the other half — not simply muted)', async () => {
    await import('./route');
    instances[0].emit(
      'error',
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );
    instances[0].emit('error', Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }));

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => String(c[0]),
    );
    expect(logged.filter((l) => l.includes('ETIMEDOUT'))).toHaveLength(1);
    expect(logged.filter((l) => l.includes('ECONNREFUSED'))).toHaveLength(1);
  });

  it('bounds the retry strategy — it gives up instead of looping forever', async () => {
    await import('./route');
    const retryStrategy = instances[0].options.retryStrategy as (times: number) => number | null;

    expect(typeof retryStrategy).toBe('function');
    // Early attempts back off…
    expect(retryStrategy(1)).toBeTypeOf('number');
    // …and it eventually returns null, which is how ioredis is told to stop.
    expect(retryStrategy(100)).toBeNull();
  });

  it('re-dials ON DEMAND after the bounded retry gave up — bounding must not strand it', async () => {
    // Bounding the retry stops the background churn, but would otherwise leave
    // the client in `end` for the pod's life: the events view would go
    // permanently blind. Recovery is paid by a request that wants the data.
    const route = await import('./route');
    const client = instances[0];
    client.status = 'end';

    await route.GET();

    expect(client.connectCalls).toBe(1);
  });

  it('does NOT re-dial a client that is already usable (the other half)', async () => {
    const route = await import('./route');
    const client = instances[0];
    client.status = 'ready';

    await route.GET();

    expect(client.connectCalls).toBe(0);
  });

  it('never logs the Redis URL or its credentials', async () => {
    process.env.REDIS_URL = 'redis://:hunter2@redis.default.svc.cluster.local.:6379';
    vi.resetModules();
    instances.length = 0;
    await import('./route');
    // The DSN must arrive the way it actually can — inside the error MESSAGE.
    // An error that never carried one cannot prove the line is stripped, which
    // is exactly how the first version of this test passed vacuously.
    instances[0].emit(
      'error',
      new Error('connect ETIMEDOUT redis://:hunter2@redis.default.svc.cluster.local.:6379'),
    );

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.map((a) => String(a)).join(' '))
      .join('\n');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('redis://');
  });

  it('still serves GET, failing open to the in-memory events when Redis errors', async () => {
    const route = await import('./route');
    const client = instances[0];
    vi.spyOn(client, 'lrange').mockRejectedValue(new Error('connection is closed'));

    const res = await route.GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});
