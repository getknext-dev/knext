// NOTE: setCacheHandler is not exported from next/cache in Next.js 16.0.3.
// The Redis CacheHandler is registered via the `cacheHandler` field in
// next.config.ts (the correct mechanism for ISR caching).
// If Next.js adds a runtime setCacheHandler API in future versions, wire it here.

// #342: Next.js compiles `instrumentation.ts` for BOTH the `nodejs` AND the
// `edge` runtimes (this app has `middleware.ts`, which forces an edge build).
// All of our observability/db-wake wiring is Node-only by nature — the
// `./instrumentation-node` body reaches `@knext/lib/clients` (→ `@cerbos/grpc`
// → `@grpc/grpc-js`, needing `zlib`/`stream`/`net`/`tls`/`fs`), plus `pg` and
// `minio`. If any of that is reachable from the edge bundle the production
// `next build` fails with `Module not found`.
//
// This file therefore stays EDGE-CLEAN: it has NO top-level static import of
// any Node-only client module. The Node-only body lives in
// `./instrumentation-node.ts` and is loaded via a dynamic `await import(...)`
// with a runtime-computed specifier, ONLY when `NEXT_RUNTIME === 'nodejs'`.
// Because the specifier is not a static string literal, webpack does not trace
// that module (and its `@cerbos/grpc` / `pg` / `minio` subtree) into the edge
// bundle at all. On the edge runtime `register()` is a no-op — the knext
// runtime runs the app on Node (the standalone server), so nothing is lost.
//
// The static-import guard in
// `apps/file-manager/instrumentation-edge-safe.test.ts` enforces that this file
// never regains a top-level Node-only import (that class must fail the gate,
// not the deploy build — #342).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  // Static-literal dynamic import: webpack bundles `./instrumentation-node` into
  // the NODEJS instrumentation chunk (so it works at runtime). For the EDGE
  // compile, `next.config.ts` webpack config ignores this module (and its
  // Node-only client subtree) so it never enters the edge bundle — see #342.
  const { registerNode } = await import('./instrumentation-node');
  registerNode();
}
