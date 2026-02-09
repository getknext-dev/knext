import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * ARCHITECTURAL NOTE:
 * This script generates a Bun entry point that embeds all dependencies discovered
 * via Node File Trace (NFT). By using 'with { type: "file" }' imports, Bun pulls
 * these files into the compiled binary's virtual filesystem ($bunfs),
 * achieving a single-binary distribution with sub-100ms cold starts.
 */

async function main() {
  const tracePath = process.env.TRACE_PATH || 'runtime.nft.json';
  const outputFile = process.env.OUTPUT_FILE || 'bun-entry.ts';
  const handlerPath =
    process.env.HANDLER_PATH || './packages/cli/internal/shim/next-runtime-entry.ts';

  if (!existsSync(tracePath)) {
    console.error(`❌ Trace file not found: ${tracePath}. Run bundle-assets.ts first.`);
    process.exit(1);
  }
  const trace = JSON.parse(readFileSync(tracePath, 'utf-8'));
  const files: string[] = trace.files || [];

  const importStatements = files
    .filter((f) => {
      // Filter out unnecessary or problematic files
      if (f.endsWith('.d.ts') || f.endsWith('.map')) return false;
      if (f.includes('bun-linux')) return false;
      // Don't embed the handler itself twice if it's in the trace
      if (f.includes('next-runtime-entry')) return false;
      return true;
    })
    .map((f, i) => {
      // Use 'with { type: "file" }' to embed in the binary's VFS
      // We use a relative path from the project root (where this entry point will live)
      return `import _dep${i} from "./${f}" with { type: "file" };`;
    })
    .join('\n');

  const entryPointContent = `
// AUTO-GENERATED MANIFEST BY KNATIVE-NEXT-BUILDER
// This ensures Bun bundles all traced dependencies into the binary VFS.

${importStatements}

// Import the runtime handler shim
import { handler } from "${handlerPath}";

console.log("🚀 Bun Bytecode Server Starting...");
console.log("📦 VFS dependencies embedded via NFT manifest Ingestion.");

// Initialize the Bun Server
Bun.serve({
  port: parseInt(process.env.PORT || "3000"),
  async fetch(req) {
    try {
      return await handler(req);
    } catch (err: any) {
      console.error("❌ Runtime Error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
});
`;

  writeFileSync(outputFile, entryPointContent);
}

main().catch(console.error);
