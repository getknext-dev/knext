import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #352 — the module-state seams (setPoolInstrumentor / setTraceIdProvider /
 * setCorrelationIdProvider) MUST survive @knext/lib being DUPLICATED across
 * separate bundle graphs.
 *
 * Live failure: in the Next.js standalone build, `instrumentation.ts` compiles
 * in a SEPARATE webpack layer from the app server bundles, and `@knext/lib` is
 * bundled (not externalized) into each — so instrumentation-node's
 * `@knext/lib/clients` (webpack module 78719) and the app's server-component
 * `@knext/lib/clients` (module 98144) are TWO PHYSICAL COPIES with independent
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
vi.mock('pg', () => ({ Pool: FakePool }));

/** Import a FRESH instance of a module (new module-level state), mimicking a
 * second bundle copy. */
async function freshImport<T>(spec: string): Promise<T> {
  vi.resetModules();
  return (await import(spec)) as T;
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
    const fn = vi.fn();
    instanceA.setPoolInstrumentor(fn);

    // Reset from a DIFFERENT instance — must clear the shared store.
    const instanceB = await freshImport<Clients>('../clients');
    instanceB.resetPoolInstrumentor();

    const instanceC = await freshImport<Clients>('../clients');
    instanceC.getDbPool();
    expect(fn).not.toHaveBeenCalled();
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
