const path = require("node:path");

// The workspace root is set EXPLICITLY, on both keys: this is a deliberate
// monorepo root, not a stray parent lockfile Next happened to find. That
// explicit setting is what tells knext to expect the nested standalone layout
// (`.next/standalone/apps/web/server.js`).
//
// knext READS these two values from this file (it does not run the config), so
// they are written in the forms it can evaluate: a string literal, or
// `path.join(__dirname, "…")` / `path.resolve(__dirname, "…")`.
module.exports = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  turbopack: { root: path.join(__dirname, "..", "..") },
  // A file in the shared package, outside the app directory, that the server
  // reads at runtime. Next traces it into `.next/standalone/packages/shared`.
  outputFileTracingIncludes: { "/": ["../../packages/shared/note.txt"] },
  typescript: { ignoreBuildErrors: true },
  generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
};
