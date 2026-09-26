# ADR-0060: The vinext single-executable build base: nitro bun preset or vinext's own prod server

- **Status:** **Proposed, DRAFT (2026-09-24).** This ADR is trigger-class because it changes what the shipped vinext artifact is built from
  (ADR-0048's target) and the compile path in `packages/kn-next/src/adapters/`. It needs founder review
  before it merges. The data comes from a time-boxed spike plus an OKE cold-start A/B, which did **not** show a win.
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
| OKE cold start, true scale-from-zero, TTFB `/api/health` (n=10 each) | **median 1 886 ms, p90 2 357 ms** | median 2 221 ms, p90 2 473 ms (+335 ms at the median; permutation p = 0.16, not significant) |

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

**OKE A/B (2026-09-24, added after the first draft).** Setup:

- True scale-from-zero on Knative: both services were at 0 pods before every sample.
- ABBA-interleaved, 10 cold starts per arm. All 20 app pods landed on the same node (10.0.1.169).
- The same file-manager app, with digest-pinned linux-x64-musl images pulled from the node-local registry.
- An in-cluster curl client on the other node, measuring the time to first byte of `GET /api/health`.

| Arm | median | p90 | min–max |
|---|---|---|---|
| nitro base | **1 886 ms** | **2 357 ms** | 1 386–2 824 |
| prod-server base (embedded) | 2 221 ms | 2 473 ms | 1 406–2 557 |

The prod-server base is **not faster on the cluster**. It is 335 ms slower at the median, with a permutation p of 0.16 at n = 10,
so it is not a proven regression either. The local darwin advantage (183 ms against 241 ms) did not carry over. That is plausibly because
Kubernetes cold start is dominated by pod start, image layers (this image is 22 MB larger with 49 MB of `node_modules`) and
runtime externals read from disk, not by the in-process boot measured locally. The difference is not yet attributed. The nitro arm also
runs knext's RuntimeContract entry, which the prod-server arm does not. Revised jev: "cold start proven faster on k8s"
**0.10**; "at parity or better" 0.41; "slower" 0.82. It still picks B-as-opt-in at 0.96 (keep nitro 0.03). Cold-start parity is therefore
a **hard gate** in the decision below, not a formality.

## Decision (recommended, pending founder review)

1. **Adopt option B as the direction.** It builds the single executable from vinext's own Node prod-server
   output with the server bundle embedded as ESM bytecode, and it replaces the nitro bun preset as the build base.
2. **Land it as an opt-in build base first** (for example `vinextBase: 'prod-server'`; the name is to be decided at
   implementation). **It becomes the default only when all of these exit criteria are met:**
   - an OKE cold-start A/B shows it at parity or better against the nitro binary, with the RuntimeContract wrapper on both.
     The first A/B (n = 10 per arm) has it **335 ms slower at the median** (not significant). The gap must be attributed
     (image size and `node_modules`, externals read from disk, ESM bytecode use) and closed before this criterion can pass;
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
- **Measured against it:** OKE cold start is not better on the first A/B (+335 ms median, not significant).
- **Unknown until measured:** what causes that gap; keep-alive behaviour on linux-x64 under load (the old reset
  cluster was x64-specific; the spike measured darwin only); flake attribution (one run, not a window).

## Action items

1. ~~Run the OKE cold-start A/B~~ **Done (2026-09-24)**: nitro 1 886 / 2 357 ms against prod-server 2 221 / 2 473 ms (median / p90).
   Next: attribute the gap. Measure in-pod time from process start to listen for both arms, prune `node_modules` to the
   runtime-require closure, and confirm ESM bytecode is actually used at runtime. Then re-run at n ≥ 20 with the
   RuntimeContract wrapper on both arms.
2. Implement the opt-in base. Scope: `vinext-build.ts` builder switch, the knext entry template, the RuntimeContract listener
   wrapper, an image-optimizer hook ahead of `startProdServer`'s handler, and sharp staging. Use TDD, with the drain and hardcap e2e tests on the new base.
3. Add a compat lane for the prod-server base (a real workflow, not the spike's throwaway copy) and start its window.
4. Triage the 3 new reds: whether the `react-version` conditions come from Bun re-bundling, a second React copy in
   `use-server-inserted-html`, and the referer on the no-JS action POST.
5. Upstream, filed on cloudflare/vinext:
   - U10 **cloudflare/vinext#3442**: `output: "standalone"` skips prerender.
   - U11 **#3443**: the standalone dependency copier copies the wrong version of a dependency (a mismatched `react` in a monorepo).
   - U12 **#3444**: the generated `server.js` should default `NODE_ENV=production`.
   - U1 **#3445**: the output path is hard-coded (`import.meta.dirname`), so the binary cannot be relocated. It also asks to document the `startProdServer` options.
   - U3 **#3446**: the Node prod server ignores `setImageOptimizer()`.
   - U13 (opt-in bundling of server externals) is **proposed, not filed**. It is held until the founder decides on this ADR.
6. Founder-gated (Bun), **not filed**: ESM bare-specifier resolution from `$bunfs` modules to `<execDir>/node_modules`, and
   `new URL(rel, import.meta.url)` inside embedded modules.
7. Once the base is the default: delete S1, S3, S4, S5, S6 and S9 and their guards in one PR, and update `docs/compat-matrix.md`.
