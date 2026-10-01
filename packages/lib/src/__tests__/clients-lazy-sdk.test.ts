import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import Module, { createRequire } from 'node:module';

/**
 * #1777 — `@cerbos/grpc` (→ `@grpc/grpc-js`) and `minio` must not be loaded
 * until `getCerbosClient()` / `getMinioClient()` is actually CALLED.
 *
 * Measured in #1773's instrumentation boot trace: together these two SDKs were
 * ~60% of the ~0.8–0.9s `@getknext/lib/clients` cost, paid at module-import
 * time even for an app that never touches either client.
 *
 * Design (second round — see `clients.ts`'s block comment for why the first
 * round's `Proxy` facade was dropped): `getCerbosClient()`/`getMinioClient()`
 * stay fully SYNCHRONOUS — the public API is frozen for v1.0 — and return the
 * REAL SDK instance. The laziness is that `require('@cerbos/grpc')`/
 * `require('minio')` (via `createRequire`, bound to a literal `require`
 * identifier so bundler output-tracing still sees it) runs on first call only,
 * memoized on `globalThis` afterwards.
 *
 * Boot-time laziness is proven here via Node's own module cache
 * (`Module._cache`, keyed by resolved absolute path) rather than a
 * `mock.module` side-effect flag: measured directly in this suite, bun's
 * `mock.module` interception of a bare, unscoped specifier (`minio`) reached
 * through a `createRequire(...)`-bound `require()` is unreliable once a few
 * other `import()`/`require()` calls have already run earlier in the same
 * file — the mock stops being hit with no error, silently falling through to
 * the REAL package. `Module._cache` has no such failure mode: it is Node's
 * own bookkeeping of what has actually been loaded, independent of any mock.
 * The cerbos assertions below still use `mock.module` (proven reliable for a
 * SCOPED specifier throughout this file) for call-counting/memoization; the
 * minio assertions use the REAL SDK — which is exactly what needs proving
 * anyway, per the round-2 review (a `Proxy` facade cannot faithfully stand in
 * for a surface this module does not own).
 */

function isLoaded(specifierFragment: string): boolean {
  const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;
  return Object.keys(cache).some((p) => p.includes(specifierFragment));
}

// The SAME `require`, resolved the SAME way `clients.ts` resolves it — used
// below for identity comparisons. Comparing against a SEPARATELY `import()`ed
// copy of 'minio' is a real dual-module-instance hazard (CJS `require()` and
// ESM `import()` of a dual-format package can yield two distinct class
// objects in the same process); resolving through the identical
// `createRequire` path avoids it entirely.
const require = createRequire(import.meta.url);

let cerbosEvaluated = false;
let cerbosCtorCalls: Array<{ target: string; opts: unknown }> = [];

class FakeCerbosGRPC {
  target: string;
  opts: unknown;
  constructor(target: string, opts: unknown) {
    this.target = target;
    this.opts = opts;
    cerbosCtorCalls.push({ target, opts });
  }
  close(): void {
    // Mirrors the real GRPC#close(): synchronous, void.
  }
}

mock.module('@cerbos/grpc', () => {
  cerbosEvaluated = true;
  return { GRPC: FakeCerbosGRPC };
});

describe('#1777 — @getknext/lib/clients loads @cerbos/grpc and minio lazily (sync require)', () => {
  beforeEach(() => {
    cerbosCtorCalls = [];
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
    expect(isLoaded('/minio/')).toBe(false);
  });

  it('getCerbosClient() loads @cerbos/grpc on first call and returns a real instance', async () => {
    process.env.CERBOS_URL = 'cerbos.test.svc:3593';
    const { getCerbosClient } = await import('../clients');
    const client = getCerbosClient();
    expect(cerbosEvaluated).toBe(true);
    expect(client).toBeInstanceOf(FakeCerbosGRPC);
    expect(cerbosCtorCalls).toHaveLength(1);
    expect(cerbosCtorCalls[0].target).toBe('cerbos.test.svc:3593');
  });

  it('the cerbos client falls back to the cluster-local default target', async () => {
    const { getCerbosClient } = await import('../clients');
    getCerbosClient();
    expect(cerbosCtorCalls[0].target).toBe('cerbos.default.svc.cluster.local:3593');
  });

  it('getCerbosClient() is memoized — a second call returns the SAME instance, not a new one', async () => {
    const { getCerbosClient } = await import('../clients');
    const a = getCerbosClient();
    const b = getCerbosClient();
    expect(a).toBe(b);
    expect(cerbosCtorCalls).toHaveLength(1);
  });

  it('a throwing first call is not memoized — the next call gets a fresh attempt', async () => {
    const { getCerbosClient, resetClients: reset } = await import('../clients');
    const RealGRPC = FakeCerbosGRPC;
    class ThrowingGRPC extends RealGRPC {
      constructor(target: string, opts: unknown) {
        super(target, opts);
        throw new Error('simulated construction failure');
      }
    }
    mock.module('@cerbos/grpc', () => ({ GRPC: ThrowingGRPC }));
    reset();

    expect(() => getCerbosClient()).toThrow('simulated construction failure');

    // Restore a working constructor and retry: must NOT still be wedged
    // behind the first failure.
    mock.module('@cerbos/grpc', () => ({ GRPC: RealGRPC }));
    const client = getCerbosClient();
    expect(client).toBeInstanceOf(RealGRPC);
    // The retry actually reconstructed with the working class (2 ctor calls:
    // the failed attempt + the successful retry).
    expect(cerbosCtorCalls).toHaveLength(2);
  });

  // ── minio: against the REAL SDK (see the file-level comment for why) ─────

  it('getMinioClient() loads the REAL minio module on first call, not before', async () => {
    expect(isLoaded('/minio/')).toBe(false);
    process.env.MINIO_ENDPOINT = 'minio.test.svc';
    const { getMinioClient } = await import('../clients');
    // Resolved the SAME way clients.ts resolves it (see the `require` const
    // above) — avoids the dual-module-instance hazard of comparing against a
    // separately `import()`ed copy.
    const realMinio = require('minio') as { Client: new (opts: unknown) => unknown };
    const client = getMinioClient();
    expect(isLoaded('/minio/')).toBe(true);
    expect(client).toBeInstanceOf(realMinio.Client);
    expect(client.region).toBeUndefined(); // no 'region' option was passed
  });

  it('getMinioClient() is memoized — a second call returns the SAME instance, not a new one', async () => {
    const { getMinioClient } = await import('../clients');
    const a = getMinioClient();
    const b = getMinioClient();
    expect(a).toBe(b);
  });

  it('the real client handles every surface a Proxy facade would get wrong — list stream, notifications, extensions getter, property writes', async () => {
    const { getMinioClient } = await import('../clients');
    const client = getMinioClient();

    // listObjects() returns a real Readable SYNCHRONOUSLY, not a Promise — a
    // Proxy facade wrapping every method as `load().then(...)` would turn a
    // sync stream return into `Promise<stream>`. Constructing the call is
    // enough to prove the return type; no live MinIO target is reached until
    // the stream is actually consumed, which this test does not do.
    // Duck-typed, not `instanceof EventEmitter`: `client.listObjects` is
    // reached through the SAME `createRequire` path as `clients.ts`, but
    // `EventEmitter` here comes from this test file's own `node:events`
    // import — comparing class IDENTITY across that boundary is the same
    // dual-module hazard the minio-instance check above avoids by reusing one
    // `require`. Structural proof (an `.on`/`.emit` pair, no `.then`) is what
    // actually matters here: a Promise has neither.
    const stream = client.listObjects('assets', '', true);
    expect(typeof (stream as unknown as { then?: unknown }).then).toBe('undefined');
    expect(typeof stream.on).toBe('function');
    expect(typeof stream.emit).toBe('function');
    stream.on('error', () => {}); // swallow the inevitable ECONNREFUSED/ENOTFOUND

    // listenBucketNotification() — another sync-EventEmitter-returning method.
    const emitter = client.listenBucketNotification('assets', '', '', ['s3:ObjectCreated:*']);
    expect(typeof emitter.on).toBe('function');
    expect(typeof emitter.stop).toBe('function');
    emitter.on('error', () => {});
    emitter.stop();

    // extensions is a real object (a GETTER) — a Proxy facade's `get` trap
    // would return a bound FUNCTION for every property access, including
    // getters.
    expect(typeof client.extensions).toBe('object');
    expect(typeof client.extensions.listObjectsV2WithMetadata).toBe('function');

    // A property WRITE round-trips — a Proxy facade with no `set` trap would
    // silently drop writes to region/partSize/enableSHA256.
    client.region = 'us-east-1';
    expect(client.region).toBe('us-east-1');
  });
});
