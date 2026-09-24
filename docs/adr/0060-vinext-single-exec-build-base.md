# ADR-0060: The vinext single-executable build base: nitro bun preset or vinext's own prod server

- **Status:** **Proposed, DRAFT (2026-09-24).** This ADR is trigger-class because it changes what the shipped vinext artifact is built from
  (ADR-0048's target) and the compile path in `packages/kn-next/src/adapters/`. It needs founder review
  before it merges. The data comes from a time-boxed spike; one measurement (the OKE cold-start A/B) is still open.
- **Relates to:** ADR-0036 and ADR-0042 (the bun-exec target and bytecode), ADR-0048 (vinext single-exec is the shipped
  target), ADR-0051 (ESM-only vinext app contract), ADR-0054 Amendment 7 and ADR-0058 (bytecode is mandatory per cell).
- **Evidence:** `.claude/research/vinext-standalone-base-spike.md` (spike),
  `.claude/research/vinext-upstream-alignment-plan.md` (the S1–S15 shim inventory). The compat runs are
  36008799337 (spike) and 35986509462 (nitro baseline).

## Context

knext builds the vinext single executable from **nitro's bun preset**: `vite build` → `.output/server/index.mjs`
→ `vinext-compile.mjs` → `bun build --compile --bytecode`. That path works, but it carries a stack of
knext-side shims whose root cause is nitro or `Bun.serve` rather than knext. They are S1 (an `import.meta` rewrite), S3 (entry-require
staticize), S4 (the externals sidecar, ≈450 lines), S5 (a `Bun.serve` keep-alive guard), S6 (a cache-control guard) and S9
(disabled code splitting). Nitro is also **not** the path upstream tests. Cloudflare's nightly deploy suite runs
`vinext build --prerender-all` → `vinext start`, which is vinext's Node prod server (`startProdServer`). Every
Nitro-only bug we have filed upstream (#3197, #3219–#3223, #3427, #3431, #3439) comes from that gap.

The founder's goal (2026-09-24) is to align with Cloudflare's direction with the minimum knext-side modification.

## What the spike measured

vinext 1.0.0-beta.12 and Bun 1.4.2 were used for everything below. Details are in the spike doc.

| | nitro base | prod-server base (embedded) |
|---|---|---|
| Official deploy suite, same 778 corpus, 16/16 shards, 0 notRun | 717 / 61 | **746 / 32** (32 files fixed, 3 new reds) |
| knext compile shims needed | S1, S3, S4, S5, S6, S9 (+ S2, S7, S8, S10) | S2, S7, S8, S10 + a ~40-line entry |
| App server JS in the binary (file-manager) | yes | **100 %** (all 159 server chunks deleted from disk, all routes still served) |
| Relocatable binary | via the S1 rewrite | via knext's entry (`outDir` from `process.execPath`) |
| Keep-alive | `Connection: close` guard | `node:http` sends a Keep-Alive header; 2400/2400 requests ok |
| Local cold start, darwin (median, noisy host) | 241 ms | 183 ms |
| OKE cold start | not measured | not measured |

The prod-server base is: plain `vinext build` output (**not** `output: "standalone"`, which skips prerender and
mis-copies dependencies in a monorepo), plus a knext entry that calls
`startProdServer({ outDir: <execDir>/dist, rscEntryPath: '/$bunfs/root/dist/server/index.js' })` with a
`Module._resolveFilename` fallback to `<execDir>/node_modules`. It is compiled with
`bun build --compile --bytecode --format=esm --compile-autoload-package-json <entry> dist/server/index.js`.
Passing the server bundle as a second entrypoint is what puts the app code into bytecode. Without it,
the whole app loads from disk as source.

## Options considered

| Option | Compat (measured) | knext code | Bytecode coverage | Upstream alignment | Risk |
|---|---|---|---|---|---|
| **A. Keep nitro base** | 717 / 61 | highest (S1, S3–S6, S9 stay) | full | low: a path upstream does not test | Nitro-only bugs keep landing on knext |
| **B. Prod-server base, app bundle embedded** (recommended) | **746 / 32** | lowest: an entry + S2/S7/S8/S10 | full (measured 100 %) | high: the path Cloudflare's nightly runs | 3 new reds from Bun re-bundling vite's externals; RuntimeContract wrapper not built yet |
| C. Prod-server base, app loaded from disk | not run | lowest | **0 % of app code** (runtime only) | high | loses the bytecode cold-start win that ADR-0042 and ADR-0058 require |
| D. Wait for upstream U1 before switching | n/a | unchanged | n/a | high, later | nothing is gained by waiting: B needs no upstream change to work |

jev (jev-1.13.0) on the spike evidence picks B at 0.99 (A 0.00, C 0.01, D 0.00). It also scores "embedding ready to be the
default without further work" at **0.12** and "cold start proven on Kubernetes" at **0.05**. Hence the gated
decision below.

## Decision (recommended, pending founder review)

1. **Adopt option B as the direction.** It builds the single executable from vinext's own Node prod-server
   output with the server bundle embedded as ESM bytecode, and it replaces the nitro bun preset as the build base.
2. **Land it as an opt-in build base first** (for example `vinextBase: 'prod-server'`; the name is to be decided at
   implementation). **It becomes the default only when all of these exit criteria are met:**
   - an OKE cold-start A/B shows it at parity or better against the nitro binary, with the RuntimeContract wrapper on both;
   - a compat window on the prod-server lane has zero cells worse than the nitro lane's
     (the 3 new reds are fixed, or each is attributed and manifest-recorded);
   - the RuntimeContract (health, `:9464` metrics, SIGTERM drain, byte cap) is re-provided around
     `startProdServer`'s returned `server`, with the existing drain and hardcap e2e tests passing on it;
   - image optimization (S7) and sharp (S2) are re-wired on the new base.
3. **Do not use `output: "standalone"` as the base.** Use `vinext build` plus the knext entry. The standalone
   copier and its skipped prerender are upstream issues (U10–U12), not something knext should work around.
4. **Retire the nitro-only shims** (S1, S3, S4, S5, S6, S9) once the prod-server base is the default, not before. The nitro base stays buildable until then.

## Consequences

- **Positive:** +29 net passing files on the same corpus, from a single run. The shipped path becomes the one
  upstream conformance-tests every night, so upstream fixes reach knext without knext-side patches. About 1 000
  lines of shim code and tests become deletable. Bytecode covers the app itself, not only the framework
  runtime.
- **Negative:** the RuntimeContract moves from a nitro entry to a listener wrapper around a `node:http` server.
  The embed step re-resolves vite's server externals with Bun's export conditions (`react-version`), and externals that
  cannot be bundled fail the compile (`esm-externals`). Keeping them external instead needs a Bun fix: ESM bare
  imports from `$bunfs` cannot reach `node_modules` on disk. The image still carries a `node_modules` beside the
  binary for runtime requires, and it should be pruned.
- **Unknown until measured:** OKE cold start; keep-alive behaviour on linux-x64 under load (the old reset
  cluster was x64-specific; the spike measured darwin only); flake attribution (one run, not a window).

## Action items

1. Refresh the OKE session and run the cold-start A/B. The images are already built (spike doc §3). It is cluster work, so it runs as a queue of one.
2. Implement the opt-in base. Scope: `vinext-build.ts` builder switch, the knext entry template, the RuntimeContract listener
   wrapper, an image-optimizer hook ahead of `startProdServer`'s handler, and sharp staging. Use TDD, with the drain and hardcap e2e tests on the new base.
3. Add a compat lane for the prod-server base (a real workflow, not the spike's throwaway copy) and start its window.
4. Triage the 3 new reds: whether the `react-version` conditions come from Bun re-bundling, a second React copy in
   `use-server-inserted-html`, and the referer on the no-JS action POST.
5. Upstream (vinext authorisation): U1 (document the `startProdServer` options and add a `VINEXT_OUT_DIR` override), U10 (standalone
   skips prerender), U11 (standalone dependency copier picks the wrong version), U12 (generated `server.js` should default
   `NODE_ENV=production`), U13 (opt-in inlining of server externals), U3 (image optimizer on the Node prod server).
6. Founder-gated (Bun): ESM bare-specifier resolution from `$bunfs` modules to `<execDir>/node_modules`, and
   `new URL(rel, import.meta.url)` inside embedded modules.
7. Once the base is the default: delete S1, S3, S4, S5, S6 and S9 and their guards in one PR, and update `docs/compat-matrix.md`.
