import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * #1777 — `@cerbos/grpc` (→ `@grpc/grpc-js`) and `minio` must not be loaded
 * until `getCerbosClient()` / `getMinioClient()` is actually called.
 *
 * Measured in #1773's instrumentation boot trace: together these two SDKs were
 * ~60% of the ~0.8–0.9s `@getknext/lib/clients` cost, paid at module-import
 * time even for an app that never touches either client. This file pins the
 * fix: both are `import()`ed lazily, memoized on first success, and the
 * import never happens just from loading `../clients`.
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
  async isAllowed(): Promise<boolean> {
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

describe('#1777 — @getknext/lib/clients loads @cerbos/grpc and minio lazily', () => {
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
  it('importing the module alone evaluates neither @cerbos/grpc nor minio', async () => {
    await import('../clients');
    expect(cerbosEvaluated).toBe(false);
    expect(minioEvaluated).toBe(false);
  });

  it('getCerbosClient() loads @cerbos/grpc on first use and returns a working client', async () => {
    process.env.CERBOS_URL = 'cerbos.test.svc:3593';
    const { getCerbosClient } = await import('../clients');
    const client = await getCerbosClient();
    expect(cerbosEvaluated).toBe(true);
    expect(client).toBeInstanceOf(FakeCerbosGRPC);
    expect(cerbosCtorCalls).toHaveLength(1);
    expect(cerbosCtorCalls[0].target).toBe('cerbos.test.svc:3593');
    expect(await (client as unknown as FakeCerbosGRPC).isAllowed()).toBe(true);
  });

  it('getCerbosClient() falls back to the cluster-local default target', async () => {
    const { getCerbosClient } = await import('../clients');
    await getCerbosClient();
    expect(cerbosCtorCalls[0].target).toBe('cerbos.default.svc.cluster.local:3593');
  });

  it('getMinioClient() loads minio on first use and returns a working client', async () => {
    process.env.MINIO_ENDPOINT = 'minio.test.svc';
    const { getMinioClient } = await import('../clients');
    const client = await getMinioClient();
    expect(minioEvaluated).toBe(true);
    expect(client).toBeInstanceOf(FakeMinioClient);
    expect(minioCtorCalls).toHaveLength(1);
    expect(minioCtorCalls[0].endPoint).toBe('minio.test.svc');
    expect(await (client as unknown as FakeMinioClient).bucketExists()).toBe(true);
  });

  it('getCerbosClient() memoizes — a second call does not construct a second client', async () => {
    const { getCerbosClient } = await import('../clients');
    const a = await getCerbosClient();
    const b = await getCerbosClient();
    expect(a).toBe(b);
    expect(cerbosCtorCalls).toHaveLength(1);
  });

  it('getMinioClient() memoizes — a second call does not construct a second client', async () => {
    const { getMinioClient } = await import('../clients');
    const a = await getMinioClient();
    const b = await getMinioClient();
    expect(a).toBe(b);
    expect(minioCtorCalls).toHaveLength(1);
  });

  it('concurrent first callers single-flight the load — only one client is constructed', async () => {
    const { getCerbosClient } = await import('../clients');
    const [a, b, c] = await Promise.all([getCerbosClient(), getCerbosClient(), getCerbosClient()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
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

    await expect(getCerbosClient()).rejects.toThrow('simulated construction failure');

    // Restore a working constructor and retry: must NOT still be wedged
    // behind the first rejection.
    mock.module('@cerbos/grpc', () => ({ GRPC: RealGRPC }));
    const client = await getCerbosClient();
    expect(client).toBeInstanceOf(RealGRPC);
  });
});
