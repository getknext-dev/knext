import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Target the deployed app's node_modules
const nodeModulesPath = process.argv[2];

if (!existsSync(nodeModulesPath)) {
  console.error(`Directory not found: ${nodeModulesPath}`);
  process.exit(1);
}

// Next.js ships with massive SWC binaries for different architectures.
// Since we are using Vinext (Vite/Rollup), we do not need ANY of the SWC binaries at runtime.
const pathsToDelete = [
  // Unused SWC binaries
  ".pnpm/@next+swc-linux-x64-gnu@16.0.3",
  ".pnpm/@next+swc-win32-x64-gnu@16.0.3",
  ".pnpm/@next+swc-darwin-x64@16.0.3",
  ".pnpm/@next+swc-darwin-arm64@16.0.3",
  ".pnpm/@next+swc-linux-arm64-gnu@16.0.3",
  ".pnpm/@next+swc-linux-arm64-musl@16.0.3",
  ".pnpm/@next+swc-linux-x64-musl@16.0.3", // Added this one as well

  // Unneeded native binaries
  ".pnpm/@img+sharp-libvips-linux-x64@1.2.4",
  ".pnpm/lightningcss-linux-x64-gnu@1.30.2",

  // Webpack and swc are not needed at runtime for Vinext
  ".pnpm/webpack@5.105.4",

  // Vite native build tools are not needed at runtime
  ".pnpm/@esbuild+linux-x64@0.27.3",
  ".pnpm/lightningcss-linux-x64-musl@1.30.2",
  ".pnpm/esbuild@0.27.3",
];

for (const p of pathsToDelete) {
  const fullPath = join(nodeModulesPath, p);
  if (existsSync(fullPath)) {
    console.log(`Pruning ${p}...`);
    rmSync(fullPath, { recursive: true, force: true });
  }
}

// We can also aggressively prune Next.js's own dist/compiled folder
// since Vinext replaces Webpack
const nextDistCompiledPath = join(
  nodeModulesPath,
  ".pnpm/next@16.0.3_@babel+core@7.29.0_@opentelemetry+api@1.9.0_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/next/dist/compiled",
);

if (existsSync(nextDistCompiledPath)) {
  console.log(`Pruning Next.js compiled tooling (Webpack, SWC)...`);
  const toolingToDelete = ["webpack", "babel", "terser", "edge-runtime"];
  for (const tool of toolingToDelete) {
    const p = join(nextDistCompiledPath, tool);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

// Prune Next.js SWC bindings
const nextDistBuildSwcPath = join(
  nodeModulesPath,
  ".pnpm/next@16.0.3_@babel+core@7.29.0_@opentelemetry+api@1.9.0_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/next/dist/build/swc",
);

if (existsSync(nextDistBuildSwcPath)) {
  console.log(`Pruning Next.js SWC build tooling...`);
  rmSync(nextDistBuildSwcPath, { recursive: true, force: true });
}

console.log("Done pruning node_modules.");
