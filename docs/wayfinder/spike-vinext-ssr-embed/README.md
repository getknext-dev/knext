# spike-vinext-ssr-embed — scripts

Committed **as the record of what was run** for
[`../adr-0042-ssr-embed-experiments.md`](../adr-0042-ssr-embed-experiments.md), not as tooling.

Read them before running them: several carry the **absolute scratchpad path** the spike used
(`/private/tmp/claude-501/.../scratchpad`) and expect a throwaway vinext probe app to already exist
there. Most are not parameterised, they are not on any CI path, and nothing in the repo imports
them.

**`e2-vite78.sh` is superseded and must not be cited** as a single-variable test — see its row
below and the retraction box in §3.2. `e2-vite78-fixed.sh` is the corrected replacement.

| file | what it does |
|---|---|
| `rewrite-ssr-import.mjs` | **Experiment 1.** Post-build rewrite of vinext's emitted `dist/server/index.js`: both lazy `import(\`./ssr/index.js\`)` call sites become a module-scope static import. Asserts each anchor occurs **exactly once** and asserts its post-conditions — a silently-failed substitution would produce a green run that proves nothing. |
| `knext-bare-entry.mjs` | The bespoke knext bun entry of §3.3 — no `vinext/server/prod-server`; static-imports the RSC entry, serves `dist/client`, delegates to `rscModule.default`. This is the entry that embeds and serves SSR on the Vite-7 build. |
| `probe-routes.mjs` | Hits the nine-route probe set and reports status + `x-vinext-cache` + bytes. |
| `e2-scan.sh` | Packs published vinext tarballs and greps for the emitting-side evidence of the split SSR sub-entry. |
| `e2-build-version.sh` | Builds the probe app against one published vinext/vite/plugin-rsc triple and reports the emitted `dist/server` layout. |
| `e2-bisect.sh` | Bisects which version emits a runtime `require("react-dom")` in the SSR chunk. |
| `e2-vite78.sh` | **SUPERSEDED — do not cite.** It was published as "the single-variable test", but its loop varies `@vitejs/plugin-react` **^5 → ^6** alongside vite ^7 → ^8 and prints neither, so the confound was invisible in its output. plugin-react 6 peer-requires vite ^8 *and* pulls `@rolldown/plugin-babel` + `babel-plugin-react-compiler`, so the vite-8 arm ran a different transform pipeline. Kept as the record of what was actually run. |
| `e2-vite78-fixed.sh` | **The corrected single-variable test — the one §3.2 now rests on.** Every dependency is an exact pin; `@vitejs/plugin-react` is held at **5.2.0**, a version whose peer range covers vite ^7 *and* ^8. Prints the resolved version of every held-fixed input and of whichever bundler each vite pulls, then **diffs the full resolved package set of the two `node_modules` trees** — so a confound nobody enumerated still shows up. |
| `e2e-container-arm.sh` | **The end-to-end container arm, committed rather than elided.** Compiles the bespoke entry, assembles a clean directory, and *asserts* (aborting, not warning) 0 `node_modules`, 0 server `.js`, and that the container `WORKDIR` does not exist on the build host — the control that §1.1 shows a build-tree rename fails to provide. Then builds/runs `alpine:3.22 --platform=linux/amd64`, probes the nine routes, and dumps the SSR body with its client-bundle and flight-payload checks. |
| `module-count-reconcile.sh` | Reconciles the two "52 modules" figures (§3.4): shows the `index.js` ↔ `ssr/index.js` lazy-import **cycle** that makes both closures equal, and shows via sourcemap `sources` that bun's headline count (52 for three different roots) is **not** a graph size — the real emitted-module lists are 20 / 50 / 50. |
