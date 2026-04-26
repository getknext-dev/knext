# ADR 0001: Embed Manifest Strategy

## Background
Next.js standalone output relies on several manifest files (e.g., `server-reference-manifest.json`, `middleware-manifest.json`, etc.) being present on the file system. When bundling with Bun, we need a reliable way to ensure these files are available to the bundled code at runtime, especially when running from a single binary.

## Options

### Option A: NFT-Driven Generator Script
Use the Next.js `required-server-files.json` and the output of `@vercel/nft` (Node File Trace) to identify all necessary manifest files. A generator script then creates a TypeScript file that imports these JSON files using Bun's `with { type: "file" }` syntax.

### Option B: Manual Static Embedding
Manually list known manifest files in the build configuration and use Bun's copy-file or embedding features.

### Option C: Dynamic File System Access
Rely on the files being present in a specific location on the host file system and access them using standard `fs` modules at runtime.

## Decision
**Option A: NFT-Driven Generator Script**

## Rationale
Spike #12 proved that `with { type: "file" }` imports allow embedding files into the binary VFS (`$bunfs`) and satisfying `require()` calls at runtime. This is the most deterministic approach for Next.js standalone output as it leverages Next.js's own tracing logic to ensure all required assets are included in the bundle and accessible via the virtual file system.

## Consequences
- Requires a generator script in the build pipeline to scan the standalone output and produce the embedding TypeScript file.
- Increases the size of the final binary as all manifests are embedded.
- Simplifies deployment as the binary becomes truly self-contained regarding its internal Next.js dependencies.

## Revisit triggers
- If Bun introduces native, built-in support for Next.js standalone output that handles manifest embedding automatically.
- Significant changes in Next.js's standalone output structure that make NFT-based tracing unreliable.
