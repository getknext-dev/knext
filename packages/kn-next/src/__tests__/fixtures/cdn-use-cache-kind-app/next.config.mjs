/**
 * The shape of a stock knext scaffold with Cache Components turned on
 * (`output: 'standalone'`, the knext adapter, the singular `cacheHandler`,
 * `cacheMaxMemorySize: 0`, no `cacheHandlers`), for the CDN purge kind e2e.
 *
 * Its own app, apart from cdn-kind-app: `cacheComponents` changes how every page
 * renders, so the 'use cache' page cannot share an app with the classic ISR
 * pages (`export const revalidate`) the other CDN checks read.
 *
 * `/uc-tagged` takes its tag ONLY from a `'use cache'` function (`cacheTag`), no
 * fetch and no `unstable_cache`, so the tag can reach the edge only if Next
 * copies it into the page entry's `x-next-cache-tags` (ADR-0068 D5.1).
 */
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
  cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,
  cacheMaxMemorySize: 0,
};
