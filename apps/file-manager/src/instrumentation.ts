// NOTE: setCacheHandler is not exported from next/cache in Next.js 16.0.3.
// The Redis CacheHandler is registered via the `cacheHandler` field in
// next.config.ts (the correct mechanism for ISR caching).
// If Next.js adds a runtime setCacheHandler API in future versions, wire it here.

// #342: Next.js compiles `instrumentation.ts` for BOTH the `nodejs` AND the
// `edge` runtimes (this app has `middleware.ts`, which forces an edge build).
// All of our observability/db-wake wiring is Node-only by nature — the
// `./instrumentation-node` body reaches `@getknext/lib/clients` (→ `@cerbos/grpc`
// → `@grpc/grpc-js`, needing `zlib`/`stream`/`net`/`tls`/`fs`), plus `pg` and
// `minio`. If any of that is reachable from the edge bundle the production
// `next build` fails with `Module not found`.
//
// This file therefore stays EDGE-CLEAN: it has NO top-level static import of
// any Node-only client module. The Node-only body lives in
// `./instrumentation-node.ts` and is loaded via a dynamic `await import(...)`,
// and is CALLED only when `NEXT_RUNTIME === 'nodejs'` (the runtime guard below).
//
// IMPORTANT (#344): the dynamic `import('./instrumentation-node')` uses a STATIC
// string literal, so webpack STILL traces that module (and its `@cerbos/grpc` /
// `pg` / `minio` subtree) into BOTH runtime bundles — the runtime guard only
// stops it EXECUTING on the edge, NOT from being BUNDLED. The LOAD-BEARING edge
// exclusion is the `IgnorePlugin` the knext adapter injects from its
// `modifyConfig` (#356/ADR-0031, wired via `adapterPath` in next.config.ts →
// `./next-adapter.ts` → `@getknext/core/adapter`), which — for the edge compile
// ONLY — replaces `./instrumentation-node` with an empty module so its Node-only
// subtree never enters the edge bundle. On the edge runtime `register()` is a
// no-op anyway — the knext runtime runs the app on Node (the standalone
// server), so nothing is lost.
//
// The guard in `apps/file-manager/instrumentation-edge-safe.test.ts` enforces
// BOTH halves of the fence: this file never regains a top-level Node-only
// import, AND the adapter wiring stays in place (the app never hand-writes the
// webpack hook — the platform owns it). That class must fail the gate, not the
// deploy build — #342/#344/#356.
import { resolveOtelOptions } from '@getknext/core/adapters/otel-config';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  // Tracing is DEFAULT-OFF (enabled only by OTEL_TRACING_ENABLED=true, which
  // the operator sets from the NextApp CR's spec.observability.tracing.enabled).
  // Everything `./instrumentation-node` wires — OTel, the span processors, the
  // golden-signal/cold-start metrics that ride the spans, the log-correlation
  // seams — sits behind that same gate, so with tracing off there is nothing to
  // register. Check the gate BEFORE the import: evaluating that module pulls in
  // the whole OTel/metrics/client stack (~0.9 s of every cold start) even
  // though `registerNode()` would return at once. `otel-config` is
  // dependency-free, so this static import is edge-clean.
  if (!resolveOtelOptions(process.env)) {
    return;
  }

  // Static-literal dynamic import: webpack bundles `./instrumentation-node` into
  // the NODEJS instrumentation chunk (so it works at runtime). webpack traces
  // this literal specifier into the edge compile TOO; the adapter-injected
  // edge-scoped `IgnorePlugin` (#356/ADR-0031) is what replaces it with an empty
  // module there so its Node-only client subtree never enters the edge bundle —
  // #342.
  const { registerNode } = await import('./instrumentation-node');
  registerNode();
}
