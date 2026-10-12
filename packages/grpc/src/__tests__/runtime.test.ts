import { afterAll, describe, expect, it } from 'bun:test';
import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, createRouterTransport, type ServiceImpl } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { OrdersService } from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';
import { defineFunctionClient, type RuntimeDeps } from '../runtime';

/** The generated definition for the fixture, as protoc-gen-knext writes it. */
const DEFINITION = {
  service: OrdersService,
  function: 'orders',
  urlEnv: 'ORDERS_SERVICE_URL',
  contractVersion: '1.2.0',
  deadlineMs: 10000,
  gatewayTimeoutMs: 300000,
  methods: {
    getOrder: { kind: 'read', retry: { maxAttempts: 3 } },
    placeOrder: { kind: 'mutation', idempotencyKey: 'required' },
    cancelOrder: { kind: 'mutation', idempotencyKey: 'required' },
    watchOrders: { kind: 'stream' },
  },
} as const;

interface Seen {
  calls: Record<string, number>;
  headers: Headers[];
  timeouts: (number | undefined)[];
}

/** An in-memory function: each method fails UNAVAILABLE `failFirst` times, then answers. */
function fakeFunction(failFirst = 0): { deps: RuntimeDeps; seen: Seen } {
  const seen: Seen = { calls: {}, headers: [], timeouts: [] };
  const count = (
    name: string,
    ctx: { requestHeader: Headers; timeoutMs(): number | undefined },
  ) => {
    seen.calls[name] = (seen.calls[name] ?? 0) + 1;
    seen.headers.push(ctx.requestHeader);
    seen.timeouts.push(ctx.timeoutMs());
    if ((seen.calls[name] ?? 0) <= failFirst) {
      throw new ConnectError('cold function not ready', Code.Unavailable);
    }
  };
  const impl: ServiceImpl<typeof OrdersService> = {
    getOrder(req, ctx) {
      count('getOrder', ctx);
      return { id: req.id, status: 'open', totalCents: 1200n };
    },
    placeOrder(_req, ctx) {
      count('placeOrder', ctx);
      return { id: 'o-1' };
    },
    cancelOrder(_req, ctx) {
      count('cancelOrder', ctx);
      return {};
    },
    async *watchOrders(_req, ctx) {
      count('watchOrders', ctx);
      yield { id: 'o-1', status: 'open' };
    },
  };
  const transport = createRouterTransport(({ service }) => service(OrdersService, impl));
  return {
    seen,
    deps: {
      env: () => ({ ORDERS_SERVICE_URL: 'http://orders.shop.svc.cluster.local' }),
      createTransport: () => transport,
      sleep: async () => {},
    },
  };
}

describe('generated client runtime — retry policy', () => {
  it('retries a NO_SIDE_EFFECTS read that fails UNAVAILABLE, up to maxAttempts', async () => {
    const { deps, seen } = fakeFunction(2);
    const client = defineFunctionClient(DEFINITION, deps);
    const res = await client.getOrder({ id: 'o-1' });
    expect(res.id).toBe('o-1');
    expect(seen.calls.getOrder).toBe(3);
  });

  it('gives up on a read after maxAttempts', async () => {
    const { deps, seen } = fakeFunction(5);
    const client = defineFunctionClient(DEFINITION, deps);
    await expect(client.getOrder({ id: 'o-1' })).rejects.toMatchObject({ code: Code.Unavailable });
    expect(seen.calls.getOrder).toBe(3);
  });

  it('NEVER retries a mutating method: one attempt, the error surfaces', async () => {
    const { deps, seen } = fakeFunction(1);
    const client = defineFunctionClient(DEFINITION, deps);
    await expect(
      client.placeOrder({ sku: 'a', quantity: 1 }, { idempotencyKey: 'k-1' }),
    ).rejects.toMatchObject({ code: Code.Unavailable });
    expect(seen.calls.placeOrder).toBe(1);
  });

  it('never retries an IDEMPOTENT (but not side-effect-free) method either', async () => {
    const { deps, seen } = fakeFunction(1);
    const client = defineFunctionClient(DEFINITION, deps);
    await expect(
      client.cancelOrder({ id: 'o-1' }, { idempotencyKey: 'k-2' }),
    ).rejects.toBeDefined();
    expect(seen.calls.cancelOrder).toBe(1);
  });

  it('does not retry a read on a non-UNAVAILABLE error', async () => {
    const seen: number[] = [];
    const transport = createRouterTransport(({ service }) =>
      service(OrdersService, {
        getOrder() {
          seen.push(1);
          throw new ConnectError('no such order', Code.NotFound);
        },
        placeOrder: () => ({}),
        cancelOrder: () => ({}),
        async *watchOrders() {},
      }),
    );
    const client = defineFunctionClient(DEFINITION, {
      env: () => ({ ORDERS_SERVICE_URL: 'http://orders' }),
      createTransport: () => transport,
      sleep: async () => {},
    });
    await expect(client.getOrder({ id: 'x' })).rejects.toMatchObject({ code: Code.NotFound });
    expect(seen).toHaveLength(1);
  });

  it('refuses a definition that turns retries on for a write, even if the generated file is edited', () => {
    const { deps } = fakeFunction();
    expect(() =>
      defineFunctionClient(
        {
          ...DEFINITION,
          methods: {
            ...DEFINITION.methods,
            placeOrder: { kind: 'read', retry: { maxAttempts: 3 } },
          },
        } as unknown as typeof DEFINITION,
        deps,
      ),
    ).toThrow(/placeOrder.*mutation/);
  });

  it('refuses a definition that leaves a method without a policy', () => {
    const { deps } = fakeFunction();
    const { cancelOrder: _dropped, ...rest } = DEFINITION.methods;
    expect(() =>
      defineFunctionClient({ ...DEFINITION, methods: rest } as unknown as typeof DEFINITION, deps),
    ).toThrow(/cancelOrder/);
  });
});

describe('generated client runtime — idempotency key, deadline, contract version', () => {
  it('a write without an idempotency key fails before any network call', async () => {
    const { deps, seen } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, deps);
    for (const bad of ['', ' ', 'a b', 'x'.repeat(256), 'é']) {
      await expect(
        client.placeOrder({ sku: 'a', quantity: 1 }, { idempotencyKey: bad }),
      ).rejects.toThrow(/idempotency key/);
    }
    await expect(
      (client.placeOrder as (r: object, o?: object) => Promise<unknown>)({ sku: 'a' }),
    ).rejects.toThrow(/idempotency key/);
    expect(seen.calls.placeOrder).toBeUndefined();
  });

  it('the types make the idempotency key mandatory on writes, optional elsewhere', () => {
    const { deps } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, deps);
    // Never called: the typecheck gate is what judges these lines.
    const compileOnly = () => {
      // @ts-expect-error a write without call options does not compile
      void client.placeOrder({ sku: 'a', quantity: 1 });
      // @ts-expect-error nor does a write whose options lack the key
      void client.cancelOrder({ id: 'o-1' }, {});
      void client.getOrder({ id: 'o-1' });
    };
    expect(typeof compileOnly).toBe('function');
  });

  it('a write sends its idempotency key and the zone contract version', async () => {
    const { deps, seen } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, deps);
    await client.placeOrder({ sku: 'a', quantity: 1 }, { idempotencyKey: 'order-form-7f3a' });
    const h = seen.headers[0] as Headers;
    expect(h.get('idempotency-key')).toBe('order-form-7f3a');
    expect(h.get('knext-contract-version')).toBe('1.2.0');
  });

  it('a read sends no idempotency key', async () => {
    const { deps, seen } = fakeFunction();
    await defineFunctionClient(DEFINITION, deps).getOrder({ id: 'o-1' });
    expect((seen.headers[0] as Headers).get('idempotency-key')).toBeNull();
  });

  it('every call carries an explicit deadline no longer than the configured one', async () => {
    const { deps, seen } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, deps);
    await client.getOrder({ id: 'o-1' });
    await client.placeOrder({ sku: 'a', quantity: 1 }, { idempotencyKey: 'k' });
    for await (const _ of client.watchOrders({})) {
      // drain
    }
    expect(seen.timeouts).toHaveLength(3);
    for (const t of seen.timeouts) {
      expect(t).toBeDefined();
      expect(t as number).toBeGreaterThan(0);
      expect(t as number).toBeLessThanOrEqual(DEFINITION.deadlineMs);
    }
  });

  it('retries share one deadline: a retry gets only the time that is left', async () => {
    const { deps, seen } = fakeFunction(1);
    let clock = 0;
    const client = defineFunctionClient(DEFINITION, {
      ...deps,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms + 4000;
      },
    });
    await client.getOrder({ id: 'o-1' });
    // The client's clock is injected; the transport converts each timeout back
    // to a deadline on the REAL clock, so the handler may see a few ms less.
    // First attempt: the whole 10 s. Second: 10 000 - (100 backoff + 4000
    // spent) = 5900 ms at most — not a fresh 10 s.
    expect(seen.timeouts[0] as number).toBeGreaterThan(9000);
    expect(seen.timeouts[0] as number).toBeLessThanOrEqual(10000);
    expect(seen.timeouts[1] as number).toBeGreaterThan(4900);
    expect(seen.timeouts[1] as number).toBeLessThanOrEqual(5900);
  });

  it('refuses a deadline that is not shorter than the gateway timeout', () => {
    const { deps } = fakeFunction();
    expect(() => defineFunctionClient({ ...DEFINITION, deadlineMs: 300000 }, deps)).toThrow(
      /shorter than the gateway timeout/,
    );
  });
});

describe('generated client runtime — endpoint from the environment', () => {
  it('fails closed when the binding URL is not set', async () => {
    const { deps, seen } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, { ...deps, env: () => ({}) });
    await expect(client.getOrder({ id: 'o-1' })).rejects.toThrow(/ORDERS_SERVICE_URL is not set/);
    expect(seen.calls.getOrder).toBeUndefined();
  });

  it('rejects a binding URL that is not http(s)', async () => {
    const { deps } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, {
      ...deps,
      env: () => ({ ORDERS_SERVICE_URL: 'file:///etc/passwd' }),
    });
    await expect(client.getOrder({ id: 'o-1' })).rejects.toThrow(/http/);
  });

  it('reads the URL at call time, not at definition time', async () => {
    const { deps } = fakeFunction();
    const env: Record<string, string> = {};
    const urls: string[] = [];
    const client = defineFunctionClient(DEFINITION, {
      ...deps,
      env: () => env,
      createTransport: (url, version) => {
        urls.push(`${version} ${url}`);
        return (deps.createTransport as NonNullable<RuntimeDeps['createTransport']>)(url, version);
      },
    });
    env.ORDERS_SERVICE_URL = 'http://orders.shop.svc.cluster.local';
    await client.getOrder({ id: 'o-1' });
    env.ORDERS_SERVICE_HTTP_VERSION = '1.1';
    await client.getOrder({ id: 'o-1' });
    expect(urls).toEqual([
      '2 http://orders.shop.svc.cluster.local',
      '1.1 http://orders.shop.svc.cluster.local',
    ]);
  });

  it('rejects an unknown HTTP version for the binding', async () => {
    const { deps } = fakeFunction();
    const client = defineFunctionClient(DEFINITION, {
      ...deps,
      env: () => ({ ORDERS_SERVICE_URL: 'http://orders', ORDERS_SERVICE_HTTP_VERSION: '3' }),
    });
    await expect(client.getOrder({ id: 'o-1' })).rejects.toThrow(/ORDERS_SERVICE_HTTP_VERSION/);
  });
});

describe('generated client runtime — default transport is Connect over h2c', () => {
  let server: Http2Server | undefined;
  afterAll(() => {
    server?.close();
  });

  it('calls a real HTTP/2 cleartext Connect server', async () => {
    server = createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(OrdersService, {
            getOrder: (req) => ({ id: req.id, status: 'open', totalCents: 5n }),
            placeOrder: () => ({ id: 'o-9' }),
            cancelOrder: () => ({}),
            async *watchOrders() {},
          }),
      }),
    );
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = defineFunctionClient(DEFINITION, {
      env: () => ({ ORDERS_SERVICE_URL: `http://127.0.0.1:${port}` }),
    });
    const res = await client.getOrder({ id: 'h2c-1' });
    expect(res.id).toBe('h2c-1');
    expect(res.totalCents).toBe(5n);
  });
});
