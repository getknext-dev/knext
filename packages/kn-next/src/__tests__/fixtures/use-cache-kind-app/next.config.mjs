/**
 * The shape of a stock knext scaffold with Cache Components turned on:
 * `output: 'standalone'`, the knext adapter, the singular `cacheHandler` and
 * `cacheMaxMemorySize: 0`, and NO `cacheHandlers` -- the adapter wires the
 * shared Redis `'use cache'` backend itself.
 *
 * KNEXT_E2E_NO_USE_CACHE_HANDLER=1 is the lane's own mutation: it drops
 * `cacheHandler`, so the adapter has nothing to key the wiring on and Next's
 * built-in (no-op, with cacheMaxMemorySize 0) `'use cache'` handler stays. The
 * two-pod test must go red against that build. Read at BUILD time.
 */
const withHandler = process.env.KNEXT_E2E_NO_USE_CACHE_HANDLER !== "1";

export default {
  output: "standalone",
  typescript: { ignoreBuildErrors: true },
  // The build id is the deploy tag, exactly as the scaffold wires it.
  generateBuildId: () =>
    process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  adapterPath: new URL("./next-adapter.mjs", import.meta.url).pathname,
  cacheComponents: true,
  ...(withHandler
    ? {
        cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,
      }
    : {}),
  cacheMaxMemorySize: 0,
};
