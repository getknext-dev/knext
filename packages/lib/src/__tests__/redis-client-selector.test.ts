/**
 * Which Redis client a process gets, and on what terms.
 *
 * The interesting assertions are about the OPTIONS, not the selection. ioredis
 * and Bun spell the same intent with different keys, so handing Bun the ioredis
 * object applies none of it: every key is ignored as unknown and the client
 * comes up on Bun's defaults while the calling code reads as though it were
 * bounded. That is how a client documented as "bounded retry, 2s connect
 * timeout" ends up retrying forever — the failure #802 was filed about.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { bunRedisAvailable, createRedisClient, toBunRedisOptions } from '../redis/client';
import { attachQuietErrorListener, quietRedisOptions } from '../redis/quiet';

/** Minimal stand-in satisfying QuietRedisClient. */
class FakeClient {
  static calls: Array<{ url: string; options?: Record<string, unknown> }> = [];
  status = 'ready';
  constructor(url: string, options?: Record<string, unknown>) {
    FakeClient.calls.push({ url, options });
  }
  on() {
    return this;
  }
  async connect() {
    return undefined;
  }
}

/**
 * Build the injectable scope both entry points accept, instead of swapping
 * `globalThis.Bun`.
 *
 * The previous version assigned the real global and restored it in a `finally`.
 * That worked only under Node, where no such global exists; under `bun:test`
 * `Bun` is readonly AND non-configurable, so every case here failed with
 * "Attempted to assign to readonly property" (#871).
 *
 * Injecting is the better test regardless of runtime: the old version could
 * only exercise the "Bun absent" branch on a runtime where Bun IS absent, which
 * is precisely the environment this selector is not written for.
 */
function scopeWith(bun: unknown) {
  return { Bun: bun } as Parameters<typeof bunRedisAvailable>[0];
}

describe('redis client selection', () => {
  it('reports availability honestly in both directions', () => {
    // A probe that only ever returns one answer is not a probe.
    expect(bunRedisAvailable(scopeWith(undefined))).toBe(false);
    expect(bunRedisAvailable(scopeWith({ RedisClient: class {} }))).toBe(true);
    expect(bunRedisAvailable(scopeWith({ RedisClient: 'nope' }))).toBe(false);
  });

  it('prefers Bun when present', () => {
    FakeClient.calls = [];
    createRedisClient(
      'redis://h:1',
      'events',
      {},
      undefined,
      scopeWith({ RedisClient: FakeClient }),
    );
    expect(FakeClient.calls).toHaveLength(1);
    expect(FakeClient.calls[0]?.url).toBe('redis://h:1');
  });

  it('falls back to the injected ioredis constructor when Bun is absent', () => {
    FakeClient.calls = [];
    createRedisClient('redis://h:1', 'events', {}, FakeClient as never, scopeWith(undefined));
    expect(FakeClient.calls).toHaveLength(1);
    // The Node path gets the ioredis-shaped options verbatim.
    expect(FakeClient.calls[0]?.options?.maxRetriesPerRequest).toBe(1);
    expect(FakeClient.calls[0]?.options?.lazyConnect).toBe(true);
  });
});

describe('option translation into Bun vocabulary', () => {
  it('carries the connect timeout across under Bun’s name', () => {
    const mapped = toBunRedisOptions(quietRedisOptions());
    // ioredis: connectTimeout. Bun: connectionTimeout. Same unit, different key.
    expect(mapped.connectionTimeout).toBe(2000);
  });

  it('turns the retryStrategy cap into an explicit attempt budget', () => {
    // ioredis encodes "give up after 5" inside a closure Bun cannot read, so the
    // cap has to be restated as a number or it is simply lost.
    expect(toBunRedisOptions(quietRedisOptions()).maxRetries).toBe(5);
  });

  it('drops ioredis-only keys instead of forwarding them', () => {
    // The load-bearing one. Forwarding `maxRetriesPerRequest`/`retryStrategy`
    // to Bun does nothing — they are silently ignored — and leaves the client
    // unbounded while the code reads as bounded.
    const mapped = toBunRedisOptions(quietRedisOptions());
    expect(mapped.maxRetriesPerRequest).toBeUndefined();
    expect(mapped.retryStrategy).toBeUndefined();
    expect(mapped.lazyConnect).toBeUndefined();
  });

  it('honours a caller override of the connect budget', () => {
    // Health checks tighten this; the override must survive translation.
    const mapped = toBunRedisOptions(quietRedisOptions({ connectTimeout: 500 }));
    expect(mapped.connectionTimeout).toBe(500);
  });

  it('gives Bun a bounded client, not merely a constructed one', () => {
    FakeClient.calls = [];
    createRedisClient(
      'redis://h:1',
      'events',
      {},
      undefined,
      scopeWith({ RedisClient: FakeClient }),
    );
    const options = FakeClient.calls[0]?.options ?? {};
    // Constructing with NO options at all is what the previous inline copy did.
    expect(Object.keys(options).length).toBeGreaterThan(0);
    expect(options.connectionTimeout).toBe(2000);
    expect(options.maxRetries).toBe(5);
  });
});

describe('attachQuietErrorListener across BOTH client shapes', () => {
  it('subscribes via .on() on an ioredis-shaped client', () => {
    const events: string[] = [];
    const client = {
      on(event: string, listener: (...a: unknown[]) => void) {
        events.push(event);
        listener({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });
        return this;
      },
      async connect() {
        return undefined;
      },
    };
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      attachQuietErrorListener(client, 'ioredis-shaped');
      expect(events).toEqual(['error']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('ETIMEDOUT');
    } finally {
      spy.mockRestore();
    }
  });

  it('assigns onclose on a Bun-shaped client that has no .on at all', () => {
    // The regression this exists for: Bun's client is not an EventEmitter, so
    // the old implementation threw into its own catch and attached NOTHING.
    // Nothing failed loudly — the #802 log noise simply came back on the
    // runtime the platform is moving to.
    const client: { onclose?: unknown; connect(): Promise<unknown> } = {
      onclose: undefined,
      async connect() {
        return undefined;
      },
    };
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      attachQuietErrorListener(client, 'bun-shaped');
      expect(typeof client.onclose, 'no handler was attached — the Bun path is unquieted').toBe(
        'function',
      );

      (client.onclose as (e: unknown) => void)({ code: 'ECONNREFUSED', message: 'nope' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    } finally {
      spy.mockRestore();
    }
  });

  it('still reports each error class only once on the Bun shape', () => {
    // The dedupe is the whole point of the function; it must not be lost in
    // the branch that was added second.
    const client: { onclose?: unknown; connect(): Promise<unknown> } = {
      onclose: undefined,
      async connect() {
        return undefined;
      },
    };
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      attachQuietErrorListener(client, 'bun-dedupe');
      const fire = client.onclose as (e: unknown) => void;
      fire({ code: 'ETIMEDOUT', message: 'a' });
      fire({ code: 'ETIMEDOUT', message: 'b' });
      fire({ code: 'ECONNREFUSED', message: 'c' });
      // Two classes seen, three events fired.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails open on a client that supports neither shape', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        attachQuietErrorListener(
          {
            async connect() {
              return undefined;
            },
          },
          'stub',
        ),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
