---
"@getknext/core": patch
---

The vinext target's Bun single executable now embeds a file that any dependency reads from beside its own code (`readFileSync(new URL('./x.wasm', import.meta.url))`, directly or through `fileURLToPath`). Previously only `@vercel/og` was covered, so another package with the same pattern failed with ENOENT once the binary left the build machine. The build decides by what the URL is used for: file reads are embedded, while `new Worker(...)`, `fetch(...)` and dynamic `import(...)` URLs are left unchanged. The build log lists each embedded file. `@getknext/core` now depends on `acorn`, which it uses to analyse those reads.
