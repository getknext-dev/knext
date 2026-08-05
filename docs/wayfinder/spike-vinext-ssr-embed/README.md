# spike-vinext-ssr-embed — scripts

Committed **as the record of what was run** for
[`../adr-0042-ssr-embed-experiments.md`](../adr-0042-ssr-embed-experiments.md), not as tooling.

Read them before running them: several carry the **absolute scratchpad path** the spike used
(`/private/tmp/claude-501/.../scratchpad`) and expect a throwaway vinext probe app to already exist
there. They are not parameterised, they are not on any CI path, and nothing in the repo imports
them.

| file | what it does |
|---|---|
| `rewrite-ssr-import.mjs` | **Experiment 1.** Post-build rewrite of vinext's emitted `dist/server/index.js`: both lazy `import(\`./ssr/index.js\`)` call sites become a module-scope static import. Asserts each anchor occurs **exactly once** and asserts its post-conditions — a silently-failed substitution would produce a green run that proves nothing. |
| `knext-bare-entry.mjs` | The bespoke knext bun entry of §3.3 — no `vinext/server/prod-server`; static-imports the RSC entry, serves `dist/client`, delegates to `rscModule.default`. This is the entry that embeds and serves SSR on the Vite-7 build. |
| `probe-routes.mjs` | Hits the nine-route probe set and reports status + `x-vinext-cache` + bytes. |
| `e2-scan.sh` | Packs published vinext tarballs and greps for the emitting-side evidence of the split SSR sub-entry. |
| `e2-build-version.sh` | Builds the probe app against one published vinext/vite/plugin-rsc triple and reports the emitted `dist/server` layout. |
| `e2-bisect.sh` | Bisects which version emits a runtime `require("react-dom")` in the SSR chunk. |
| `e2-vite78.sh` | The **single-variable** test: vinext + plugin-rsc + react held fixed, only Vite 7 vs 8 varies. This is the script the §3.2 conclusion rests on. |
