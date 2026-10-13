/**
 * The shape of a stock knext scaffold (`output: 'standalone'`, the knext
 * adapter, the singular `cacheHandler`, `cacheMaxMemorySize: 0`), plus the
 * route shapes the CDN cache-tier e2e needs. Classic ISR, no Cache Components:
 * the pages use `export const revalidate`.
 *
 * `/cookie` gets a `Set-Cookie` from a plain (unconditional) `headers()` rule:
 * the page itself is an ordinary ISR page with `s-maxage`, so the cookie is the
 * only thing that must keep it off the edge.
 */
const buildMark = process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || "unset";

export default {
  output: "standalone",
  typescript: { ignoreBuildErrors: true },
  // The build id is the deploy tag, exactly as the scaffold wires it.
  generateBuildId: () =>
    process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
  // Inlined at build time: lets the rollout case tell one build's HTML from
  // another's by its body, not only by its build tag.
  env: { KNEXT_E2E_BUILD_MARK: buildMark },
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  adapterPath: new URL("./next-adapter.mjs", import.meta.url).pathname,
  cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,
  cacheMaxMemorySize: 0,
  async headers() {
    return [
      {
        source: "/cookie",
        headers: [{ key: "set-cookie", value: "knext-e2e=1; Path=/; HttpOnly" }],
      },
    ];
  },
};
