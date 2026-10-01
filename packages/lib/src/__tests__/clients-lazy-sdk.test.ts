import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * #1777 — `@cerbos/grpc` (→ `@grpc/grpc-js`) and `minio` must not be loaded
 * until a method is actually CALLED on the client `getCerbosClient()` /
 * `getMinioClient()` returns.
 *
 * Measured in #1773's instrumentation boot trace: together these two SDKs were
 * ~60% of the ~0.8–0.9s `@getknext/lib/clients` cost, paid at module-import
 * time even for an app that never touches either client. This file pins the
 * fix: both are `import()`ed lazily, memoized on first success, and the
 * import never happens just from loading `../clients` OR from calling the
 * getter itself — `getCerbosClient()`/`getMinioClient()` stay SYNCHRONOUS
 * (the public API is frozen for v1.0) and hand back a facade; the real SDK is
 * only reached when a method on that facade is called.
 *
 * `mock.module` factories run lazily, on the FIRST actual `import()` of the
 * specifier — not at `mock.module(...)` registration time (verified directly:
 * registering a factory with a side-effecting flag leaves the flag `false`
 * until something really imports the module). That is what makes the first
 * test below a real assertion rather than a tautology.
 */

let cerbosEvaluated = false;
let minioEvaluated = false;
let cerbosCtorCalls: Array<{ target: string; opts: unknown }> = [];
let minioCtorCalls: Array<Record<string, unknown>> = [];

class FakeCerbosGRPC {
  target: string;
  opts: unknown;
  constructor(target: string, opts: unknown) {
    this.target = target;
    this.opts = opts;
    cerbosCtorCalls.push({ target, opts });
  }
  async close(): Promise<boolean> {
    return true;
  }
}

class FakeMinioClient {
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    minioCtorCalls.push(config);
  }
  async bucketExists(): Promise<boolean> {
    return true;
  }
}

mock.module('@cerbos/grpc', () => {
  cerbosEvaluated = true;
  return { GRPC: FakeCerbosGRPC };
});

mock.module('minio', () => {
  minioEvaluated = true;
  return { Client: FakeMinioClient };
});

describe('#1777 — @getknext/lib/clients loads @cerbos/grpc and minio lazily (sync facade)', () => {
  beforeEach(() => {
    cerbosCtorCalls = [];
    minioCtorCalls = [];
    delete process.env.CERBOS_URL;
    delete process.env.MINIO_ENDPOINT;
    delete process.env.MINIO_PORT;
    delete process.env.MINIO_USE_SSL;
    delete process.env.MINIO_ACCESS_KEY;
    delete process.env.MINIO_SECRET_KEY;
  });

  afterEach(async () => {
    const mod = await import('../clients');
    mod.resetClients();
  });

  // MUST run before any other test in this process calls a getter — it is
  // the only test asserting the pre-first-use state, so it also fixes the
  // describe/file's test order as load-bearing: putting it later would read
  // the post-first-use world instead.
  it('importing the module and calling the getters does not evaluate @cerbos/grpc or minio', async () => {
    const { getCerbosClient, getMinioClient } = await import('../clients');
    // The getters themselves are synchronous and must not trigger the load —
    // only CALLING a method on what they return does.
    const cerbos = getCerbosClient();
    const minio = getMinioClient();
    expect(cerbos).toBeDefined();
    expect(minio).toBeDefined();
    expect(cerbosEvaluated).toBe(false);
    expect(minioEvaluated).toBe(false);
  });

  it('getCerbosClient() is synchronous and returns the same facade on every call', async () => {
    const { getCerbosClient } = await import('../clients');
    const a = getCerbosClient();
    const b = getCerbosClient();
    expect(a).toBe(b);
    expect(cerbosEvaluated).toBe(false); // getting the facade alone loads nothing
  });

  it('calling a method on the cerbos facade loads @cerbos/grpc and forwards to a working client', async () => {
    process.env.CERBOS_URL = 'cerbos.test.svc:3593';
    const { getCerbosClient } = await import('../clients');
    await getCerbosClient().close();
    expect(cerbosEvaluated).toBe(true);
    expect(cerbosCtorCalls).toHaveLength(1);
    expect(cerbosCtorCalls[0].target).toBe('cerbos.test.svc:3593');
  });

  it('the real cerbos client falls back to the cluster-local default target', async () => {
    const { getCerbosClient } = await import('../clients');
    await getCerbosClient().close();
    expect(cerbosCtorCalls[0].target).toBe('cerbos.default.svc.cluster.local:3593');
  });

  it('calling a method on the minio facade loads minio and forwards to a working client', async () => {
    process.env.MINIO_ENDPOINT = 'minio.test.svc';
    const { getMinioClient } = await import('../clients');
    const result = await getMinioClient().bucketExists('assets');
    expect(minioEvaluated).toBe(true);
    expect(result).toBe(true);
    expect(minioCtorCalls).toHaveLength(1);
    expect(minioCtorCalls[0].endPoint).toBe('minio.test.svc');
  });

  it('the real cerbos client is memoized — a second call does not construct a second client', async () => {
    const { getCerbosClient } = await import('../clients');
    await getCerbosClient().close();
    await getCerbosClient().close();
    expect(cerbosCtorCalls).toHaveLength(1);
  });

  it('the real minio client is memoized — a second call does not construct a second client', async () => {
    const { getMinioClient } = await import('../clients');
    await getMinioClient().bucketExists('assets');
    await getMinioClient().bucketExists('assets');
    expect(minioCtorCalls).toHaveLength(1);
  });

  it('concurrent first callers single-flight the load — only one client is constructed', async () => {
    const { getCerbosClient } = await import('../clients');
    const client = getCerbosClient();
    await Promise.all([client.close(), client.close(), client.close()]);
    expect(cerbosCtorCalls).toHaveLength(1);
  });

  it('a REJECTED first load is not memoized — the next call gets a fresh attempt', async () => {
    const { getCerbosClient, resetClients: reset } = await import('../clients');
    // Force the FIRST attempt to fail by making construction throw once.
    const RealGRPC = FakeCerbosGRPC;
    class ThrowingGRPC extends RealGRPC {
      constructor(target: string, opts: unknown) {
        super(target, opts);
        throw new Error('simulated construction failure');
      }
    }
    mock.module('@cerbos/grpc', () => ({ GRPC: ThrowingGRPC }));
    reset();

    await expect(getCerbosClient().close()).rejects.toThrow('simulated construction failure');

    // Restore a working constructor and retry: must NOT still be wedged
    // behind the first rejection.
    mock.module('@cerbos/grpc', () => ({ GRPC: RealGRPC }));
    await getCerbosClient().close();
    // The retry actually reconstructed with the working class (2 ctor calls:
    // the failed attempt + the successful retry).
    expect(cerbosCtorCalls).toHaveLength(2);
  });
});
