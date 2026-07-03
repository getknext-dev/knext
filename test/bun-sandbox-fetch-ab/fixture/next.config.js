export default {
  output: 'standalone',
  // The fixture lives inside the knext monorepo, so without this Next infers
  // the repo root (root lockfile) as the tracing root and nests the standalone
  // entry at .next/standalone/test/bun-sandbox-fetch-ab/fixture/server.js.
  // Pin the root so the layout is flat (.next/standalone/server.js) and stable
  // for run-trials.mjs on any checkout.
  outputFileTracingRoot: import.meta.dirname,
};
