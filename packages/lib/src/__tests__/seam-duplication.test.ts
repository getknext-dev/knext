import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * #352 — the module-state seams (setPoolInstrumentor / setTraceIdProvider /
 * setCorrelationIdProvider) MUST survive @getknext/lib being DUPLICATED across
 * separate bundle graphs.
 *
 * Live failure: in the Next.js standalone build, `instrumentation.ts` compiles
 * in a SEPARATE webpack layer from the app server bundles, and `@getknext/lib` is
 * bundled (not externalized) into each — so instrumentation-node's
 * `@getknext/lib/clients` (webpack module 78719) and the app's server-component
 * `@getknext/lib/clients` (module 98144) are TWO PHYSICAL COPIES with independent
 * module-level state. `setPoolInstrumentor(...)` wrote copy A's `let
 * poolInstrumentor`; `getDbPool()` read copy B's — still the no-op — so the pool
 * was never wrapped and `knext_db_wake_*` never fired.
 *
 * We reproduce two copies with `vi.resetModules()` + a fresh dynamic import:
 * each import evaluates the module body afresh (a NEW module instance, its own
 * module-level `let`s), exactly as two bundles would. The seam must bridge the
 * two — SET on instance A, READ on instance B — which only a shared
 * `globalThis`-backed store can guarantee.
 */

// Minimal fake Pool: constructible, records nothing.
class FakePool {
  constructor(public config: unknown) {}
  end() {
    return Promise.resolve();
  }
}
mock.module('pg', () => ({ Pool: FakePool }));

// #1777 — fakes for the lazy client-SDK seam below. Count constructions
// (not module evaluations: the module loader caches the factory result
// across `import()`s of the same specifier regardless of which module
// instance asked, so "evaluated once" is a given here and the thing worth
// pinning is "constructed once" — i.e. the seam actually dedupes the client).
let minioCtorCalls = 0;
let cerbosCtorCalls = 0;
class FakeMinioClient {
  constructor(public config: unknown) {
    minioCtorCalls += 1;
  }
  // `listBuckets()` — a real, zero-arg, Promise-returning minio.Client method
  // (used here only as a trigger for the lazy load, not for its real shape).
  async listBuckets(): Promise<[]> {
    return [];
  }
}
class FakeCerbosGRPC {
  constructor(
    public target: string,
    public opts: unknown,
  ) {
    cerbosCtorCalls += 1;
  }
  // `close()` — a real, zero-arg GRPC method (used here only as a trigger).
  async close(): Promise<void> {
    return;
  }
}
mock.module('minio', () => ({ Client: FakeMinioClient }));
mock.module('@cerbos/grpc', () => ({ GRPC: FakeCerbosGRPC }));

/**
 * Import a FRESH instance of a module — new module-level state, mimicking a
 * second bundle copy.
 *
 * A QUERY SUFFIX, not `vi.resetModules()`. bun has no module-registry reset,
 * and this file was written off as unportable for that reason — but a distinct
 * specifier is a distinct module key, and bun honours it: verified directly,
 * `import('…/clients')` and `import('…/clients?copy=2')` return namespaces whose
 * exported functions are NOT identical, which is exactly the two-copies-with-
 * separate-`let`s condition this file needs.
 *
 * It is arguably a better reproduction than the registry reset was. Two bundle
 * copies coexist; `resetModules` replaced one with the other, so instance A was
 * gone by the time B existed. Here both are live at once, which is the real
 * shape of the #352 bug.
 */
let freshCopy = 0;
async function freshImport<T>(spec: string): Promise<T> {
  freshCopy += 1;
  return (await import(`${spec}?seam-copy=${freshCopy}`)) as T;
}

describe('#352 — pool-instrumentor seam survives module duplication', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    delete process.env.DATABASE_URL_RO;
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_RO;
    // Clear cross-instance state so we don't leak into other suites.
    const mod = await import('../clients');
    mod.resetPoolInstrumentor();
  });

  it('an instrumentor SET on instance A is seen by getDbPool on instance B', async () => {
    // Instance A — the "instrumentation-node" copy — installs the instrumentor.
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const seen: Array<{ role: string }> = [];
    instanceA.setPoolInstrumentor((_pool, role) => seen.push({ role }));

    // Instance B — the "app server component" copy — creates the pool. It must
    // observe A's instrumentor through the shared globalThis-backed seam.
    const instanceB = await freshImport<Clients>('../clients');
    expect(instanceB).not.toBe(instanceA); // genuinely two module instances

    instanceB.getDbPool();

    expect(seen).toHaveLength(1);
    expect(seen[0].role).toBe('writer');
  });

  it('resetPoolInstrumentor on any instance clears the shared state', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const fn = mock();
    instanceA.setPoolInstrumentor(fn);

    // Reset from a DIFFERENT instance — must clear the shared store.
    const instanceB = await freshImport<Clients>('../clients');
    instanceB.resetPoolInstrumentor();

    const instanceC = await freshImport<Clients>('../clients');
    instanceC.getDbPool();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('#1777 — lazy client-SDK seam (getCerbosClient/getMinioClient) survives module duplication', () => {
  beforeEach(() => {
    minioCtorCalls = 0;
    cerbosCtorCalls = 0;
  });

  afterEach(async () => {
    const mod = await import('../clients');
    mod.resetClients();
  });

  it('getMinioClient() on instance A returns the SAME facade as on instance B, and only one real client is built', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const facadeA = instanceA.getMinioClient(); // synchronous — no real client yet

    const instanceB = await freshImport<Clients>('../clients');
    expect(instanceB).not.toBe(instanceA); // genuinely two module instances
    const facadeB = instanceB.getMinioClient();

    // The facade itself is anchored on globalThis, so both copies get the
    // IDENTICAL object back before either has loaded the real SDK.
    expect(facadeB).toBe(facadeA);
    expect(minioCtorCalls).toBe(0);

    // Using the facade from instance B, then from instance A, must share the
    // SAME real client — instance A does not pay to build (or load) a second
    // one once B has already triggered the load.
    await facadeB.listBuckets();
    await facadeA.listBuckets();
    expect(minioCtorCalls).toBe(1);
  });

  it('getCerbosClient() on instance A returns the SAME facade as on instance B, and only one real client is built', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const facadeA = instanceA.getCerbosClient();

    const instanceB = await freshImport<Clients>('../clients');
    expect(instanceB).not.toBe(instanceA);
    const facadeB = instanceB.getCerbosClient();

    expect(facadeB).toBe(facadeA);
    expect(cerbosCtorCalls).toBe(0);

    await facadeB.close();
    await facadeA.close();
    expect(cerbosCtorCalls).toBe(1);
  });

  it('resetClients() on any instance clears the shared cache for the next load', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const facadeA = instanceA.getMinioClient();
    await facadeA.listBuckets(); // trigger the real load

    // Reset from a DIFFERENT instance — must clear the shared globalThis slot.
    const instanceB = await freshImport<Clients>('../clients');
    instanceB.resetClients();

    const instanceC = await freshImport<Clients>('../clients');
    const facadeC = instanceC.getMinioClient();
    expect(facadeC).not.toBe(facadeA); // a fresh facade was built after reset
    await facadeC.listBuckets();

    expect(minioCtorCalls).toBe(2); // one before reset, one after
  });
});

describe('#352 — context provider seams survive module duplication', () => {
  afterEach(async () => {
    const mod = await import('../context');
    mod.resetTraceIdProvider();
    mod.resetCorrelationIdProvider();
  });

  it('setTraceIdProvider on instance A is read on instance B', async () => {
    type Ctx = typeof import('../context');
    const instanceA = await freshImport<Ctx>('../context');
    instanceA.setTraceIdProvider(() => 'trace-abc');

    const instanceB = await freshImport<Ctx>('../context');
    expect(instanceB).not.toBe(instanceA);

    // createRequestContext reads the trace id through the injected provider.
    const ctx = instanceB.createRequestContext({ correlationId: 'c1' });
    expect(ctx.traceId).toBe('trace-abc');
  });

  it('setCorrelationIdProvider on instance A is read on instance B', async () => {
    type Ctx = typeof import('../context');
    const instanceA = await freshImport<Ctx>('../context');
    instanceA.setCorrelationIdProvider(() => 'corr-xyz');

    const instanceB = await freshImport<Ctx>('../context');
    expect(instanceB).not.toBe(instanceA);

    // With no ALS store active, correlationLogFields() falls through to the
    // injected correlation-id provider (the real #346 request path).
    const fields = instanceB.correlationLogFields();
    expect(fields.correlation_id).toBe('corr-xyz');
  });

  it('reset*Provider on any instance clears the shared provider', async () => {
    type Ctx = typeof import('../context');
    const instanceA = await freshImport<Ctx>('../context');
    instanceA.setTraceIdProvider(() => 'trace-abc');
    instanceA.setCorrelationIdProvider(() => 'corr-xyz');

    const instanceB = await freshImport<Ctx>('../context');
    instanceB.resetTraceIdProvider();
    instanceB.resetCorrelationIdProvider();

    const instanceC = await freshImport<Ctx>('../context');
    expect(instanceC.createRequestContext({ correlationId: 'c1' }).traceId).toBeUndefined();
    expect(instanceC.correlationLogFields()).toEqual({});
  });
});
