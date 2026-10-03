import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

// Matches the REAL knext scaffold shape (packages/kn-next/templates/app/vite.config.ts.hbs,
// apps/file-manager/vite.config.ts): `rollupConfig.output.inlineDynamicImports` is REQUIRED,
// not a style choice. Nitro on rolldown reads `output.codeSplitting`, not rollup's
// `manualChunks`; `inlineDynamicImports: true` is how it gets disabled. Without it the server
// bundle splits into multiple chunks and the compiled exec crashes at BOOT on this vinext
// version — a split-off chunk (nitro's own SSR renderer) uses `import.meta.filename`, which
// `--bytecode` cannot carry for a non-entry chunk, the same class of bug entry-asset-anchor.mjs
// fixes for `new URL(lit, import.meta.url)`, but for a different anchor this app does not touch.
// No custom entry (knext-bun-entry.mjs): this fixture only needs a compilable
// `.output/server/index.mjs` to exercise cluster C4 (next/og's ImageResponse inside a
// `bun build --compile --bytecode` single executable); it does not need knext's own
// runtime-contract entry.
export default defineConfig({
    plugins: [
        vinext(),
        nitro({
            preset: "bun",
            rollupConfig: { output: { inlineDynamicImports: true } },
        }),
    ],
});
