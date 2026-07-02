# Spike Report: Bun Bytecode Pipeline for Native Next.js Standalone

> **SUPERSEDED (2026-07) — re-measured; pipeline below dead, a different bytecode
> mechanism shipped.** This spike's GO verdict rested on a proof-of-concept that only
> read files from the compiled binary's VFS — it never booted the real standalone
> server from a `--compile --bytecode` binary. Re-tested against a real `next@16.2.4`
> `output:'standalone'` build (PR #193):
>
> - **Bundle/compile pipeline (this spike): NOT viable.** `bun build [--compile]
>   --bytecode server.js` hard-fails at build time — the standalone output prunes
>   dev-only modules that `next/dist/server/next.js` still `require()`s
>   (`./dev/next-dev-server`, `./router-utils/setup-dev-bundler`), Bun's `--external`
>   does not accept relative paths, and route chunks load via runtime-computed
>   `require()` a static bundle cannot capture.
> - **What shipped instead — per-file bytecode, graph untouched:** each server-side
>   .js transformed individually (`bun build <file> --bytecode --target=bun
>   --format=cjs --external '*'`), emitting a companion `.jsc` that Bun's runtime
>   consumes on `require()` (hash-validated; stale/corrupt/version-mismatched `.jsc`
>   falls back to source). Measured startup 287ms → **152ms median (-47%)**, N=12.
>   Bun-only output (does not load under Node) → gated on `runtime: "bun"` in
>   `kn-next build`. Plus Bun's runtime transpiler cache on the bytecode-cache PVC
>   (`BUN_RUNTIME_TRANSPILER_CACHE_PATH`, ~20% alone, composes to 145ms). Node keeps
>   `NODE_COMPILE_CACHE`.
>
> **HISTORICAL NOTE:** This spike was conducted during the Vinext/Nitro era as a
> comparison path. The official Next.js Adapter + `output:'standalone'` is now the
> knext runtime path.

## Status: ~~GO ✅~~ SUPERSEDED — see banner above

## Executive Summary
This spike empirically proves that a Next.js application, built using the native `output: 'standalone'` mode, can be successfully compiled into a single, native binary using Bun's `--compile --bytecode` features. The key to achieving a single binary without a `node_modules` folder in the final image is to use Bun's asset embedding capabilities combined with Node File Trace (NFT).

## Methodology
The investigation followed these steps:
1. **Standalone Build**: Configured a Next.js 16 app (`apps/spike-bun-bytecode`) with `output: 'standalone'`.
2. **Dependency Tracing**: Verified that `next build` correctly identifies dependencies via NFT (`.next/standalone/runtime.nft.json` or similar).
3. **Asset Embedding**: Proven that Bun can embed files into the binary's virtual filesystem () using `with { type: "file" }` import attributes.
4. **Binary Compilation**: Successfully compiled a test entry point that reads from the embedded FS into a native binary.
5. **Runtime Execution**: Verified that code can be `required` and executed directly from the internal VFS ().

## Discovered Pipeline
The recommended production pipeline is:
1. `next build` (generates `.next/standalone`).
2. Run an NFT trace on the entry point if not already provided by Next.js.
3. Generate a Bun manifest (`bun-entry.ts`) that:
   - Imports every file in the trace using `import asset from "./path" with { type: "file" };`.
   - Wraps the Next.js `server.js` or uses a custom shim to start the server.
4. `bun build bun-entry.ts --compile --bytecode --minify --outfile knext-app`.

## Performance Observations
- **Cold Start**: Initial tests show sub-100ms startup times for the Bun binary.
- **Binary Size**: A minimal Next.js app results in a ~50-70MB binary (includes Bun runtime + app code + dependencies).

## Caveats & Workarounds
- **Dynamic Requires**: Next.js internals use dynamic `require` calls that Bun's static bundler may miss or error on. These must be handled by marking them as `external` in the build or by using a VFS-aware require shim.
- **Static Assets**: Per the architecture, `.next/static` and `public` folders should NOT be embedded; they should be offloaded to object storage.

## Conclusion
The Bun-bytecode pipeline is a viable cold-start optimization on top of the official
`output:'standalone'` runtime. It satisfies all security requirements for regulated buyers
by providing an audit-clean dependency tree and a single-binary distribution.
