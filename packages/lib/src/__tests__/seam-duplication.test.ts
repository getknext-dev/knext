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

// #1777 — fake cerbos for the lazy client-SDK seam below. Count constructions
// to prove the seam actually dedupes the client (not just evaluations: the
// module loader caches an `import()`/`require()` factory result regardless
// of which module instance asked, so "evaluated once" is a given — the thing
// worth pinning is "constructed once"). Cerbos only, deliberately: measured
// directly, bun's `mock.module` interception of the bare, unscoped `minio`
// specifier (reached through `createRequire(...)`-based `require()`) is
// unreliable once a few other resolutions have already run in the same
// file — see `clients-lazy-sdk.test.ts`'s file-level comment for the full
// finding. The minio test below proves the seam the same way without
// depending on that: via the REAL client's object IDENTITY across copies,
// which needs no mock at all.
let cerbosCtorCalls = 0;
class FakeCerbosGRPC {
  constructor(
    public target: string,
    public opts: unknown,
  ) {
    cerbosCtorCalls += 1;
  }
  // `close()` — a real, zero-arg GRPC method (used here only as a trigger).
  close(): void {}
}
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
    cerbosCtorCalls = 0;
  });

  afterEach(async () => {
    const mod = await import('../clients');
    mod.resetClients();
  });

  it('getMinioClient() on instance A returns the SAME real client as on instance B (object identity)', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const clientA = instanceA.getMinioClient(); // synchronous — real client, loaded eagerly on this first call

    const instanceB = await freshImport<Clients>('../clients');
    expect(instanceB).not.toBe(instanceA); // genuinely two module instances
    const clientB = instanceB.getMinioClient();

    // The globalThis-anchored seam means both copies get the IDENTICAL real
    // client back — instance B did not build (or load) a second one once A
    // already has.
    expect(clientB).toBe(clientA);
  });

  it('getCerbosClient() on instance A returns the SAME client as on instance B, and only one real client is built', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const clientA = instanceA.getCerbosClient();

    const instanceB = await freshImport<Clients>('../clients');
    expect(instanceB).not.toBe(instanceA);
    const clientB = instanceB.getCerbosClient();

    expect(clientB).toBe(clientA);
    expect(cerbosCtorCalls).toBe(1);
  });

  it('resetClients() on any instance clears the shared cache for the next load', async () => {
    type Clients = typeof import('../clients');
    const instanceA = await freshImport<Clients>('../clients');
    const clientA = instanceA.getMinioClient();

    // Reset from a DIFFERENT instance — must clear the shared globalThis slot.
    const instanceB = await freshImport<Clients>('../clients');
    instanceB.resetClients();

    const instanceC = await freshImport<Clients>('../clients');
    const clientC = instanceC.getMinioClient();
    expect(clientC).not.toBe(clientA); // a fresh client was built after reset
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
