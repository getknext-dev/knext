# Experiment log — how the vinext single-executable decision was reached

Every experiment behind ADR-0048, including the ones that failed, produced a null result, or
overturned an earlier conclusion. Recorded in the order they were run, because the order is part of
the argument: two of these corrected the one before it.

Host for the local runs: Darwin/arm64 laptop under load. **Absolute milliseconds are not deploy
numbers** — the ratios between arms on identical hardware are the signal. Cluster runs are marked.

---

## E1 — Does Bun 1.4 change the compile-cache probe shape? (#807)

**Question.** Bun 1.4.0 was reported to return a path where 1.3.x returned `undefined`. Does that
make knext's `NODE_COMPILE_CACHE` diagnostic mis-classify a healthy directory as refused?

**Method.** Installed Bun 1.4.0 alongside the local 1.3.5 and ran the real module under each, on a
healthy writable directory and on `/dev/null`.

**Result.**

| | healthy dir | refused (`/dev/null`) |
|---|---|---|
| bun 1.3.5 | `undefined` | `undefined` |
| bun 1.4.0 | **a path** | `undefined` |
| node 24 | a path | `undefined` |

**Answer: no.** The diagnostic returned `unknown` (silent) in *both* directions on 1.4, because it
rejected all Bun by version. There was no false alarm to fix — only silence to lift.

**What mattered more than the question asked.** The *refused* column is not in the issue, and it is
what made the fix safe. Bun 1.4 is Node's shape exactly, so `degraded` is earned too. Had only the
healthy case been checked, enabling the diagnostic would have silenced real volume faults on every
1.4 pod — the original false alarm inverted.

---

## E2 — Can the Bun keep-alive reset bug (#188) be reproduced locally?

**Question.** The guard self-disables on Bun ≥1.4 "where the underlying bug is fixed upstream". Does
the bug actually not reproduce on the 1.4.0 *release*, as opposed to the canary it was checked
against?

**Method.** Three progressively more faithful harnesses against a known-affected Bun 1.3.5:
1. `Bun.serve` + Node `http.Agent`, 60 back-to-back keep-alive requests.
2. `node:http` — the layer Next's standalone server actually uses under `bun -r`.
3. node-fetch@2 over Node ≥19's keep-alive `globalAgent` — the exact #188 client.

**Result: all three returned `resets: 0` on the known-affected version.**

**Answer: null result, and the harness is the reason.** A harness that cannot see red on the
affected version certifies nothing about the fixed one, so the identical `0` returned on 1.4.0 is
worthless and is not reported as a pass. The likely cause is platform: #188 was observed on
`ubuntu-latest`, and Bun's socket layer differs between epoll and kqueue. **This re-verification
requires Linux CI and remains open.**

---

## E3 — Can node execute the vinext artifact? (the claim that broke)

**Question.** ADR-0036 states vinext "runs on either runtime — nitro `node-server` preset for node,
`--compile`d binary for bun". Is that true of the artifact this repo builds?

**Method.** Ran it.

```
$ node examples/bun-exec/.output/server/index.mjs
exit 1 — ReferenceError: Bun is not defined
$ node -e 'console.log(require("./examples/bun-exec/.output/nitro.json").preset)'
bun
```

**Answer: no.** The built entry is nitro's **bun** preset and calls that runtime's global `serve()`
at module top level. `.output/nitro.json` says so plainly.

**Consequence.** A nitro `.output` is not one artifact shape — it is **one shape per preset**. The
contract now models `nitro-output-bun`, and `node` accepts only `next-standalone`. There is no node
fallback from ADR-0048, and ADR-0042's exclusion of `node + vinext` needs no amendment: the cell is
not capable, not merely disallowed.

---

## E4 — Cold start and throughput across five build×runtime variants

**Question.** What do the supported combinations actually cost?

**Method.** `examples/bun-exec`, app id `app-6bf934d9091b5c24` **identical across all arms**. Cold
start = `spawn(t=0)` → first HTTP response carrying a status, fresh process and fresh port per
sample, n=10. Deliberately **not** "time to log ready", which flatters an in-process entry that logs
before it can serve. Throughput = completed req/s, concurrency 20, 5 s, after 200 discarded warmup
requests. Route `/api/health` (`force-dynamic`), responses verified **byte-identical**: 35 bytes,
sha256 `7b872305fef5c052`, no compression on any arm.

**Result.**

| variant | cold median | min | p95 | vs node | req/s | vs node |
|---|---|---|---|---|---|---|
| node + turbopack (standalone) | 884 ms | 809 | 1029 | 1.00× | 630 | 1.00× |
| bun 1.4 + turbopack (standalone) | 703 ms | 593 | 882 | 1.26× | 714 | 1.13× |
| bun 1.4 + turbopack + bytecode | 554 ms | 288 | 692 | 1.59× | 537 | 0.85× |
| vinext single-exec (bun 1.3.5) | 121 ms | 85 | 286 | 7.28× | 1053 | 1.67× |
| **vinext single-exec (bun 1.4.0)** | **61 ms** | **38** | **131** | **14.50×** | **1103** | **1.75×** |
| bun 1.3.5 + turbopack | — | — | — | — | — | **does not serve** |

**Answers.**

- The single executable wins **both** axes. Its p95 (131 ms) beats node's *best* sample (809 ms) by
  6×, and for scale-to-zero the tail is what a user feels.
- **Bun 1.4 doubles the single-exec's cold-start advantage** over 1.3.5 — 61 ms vs 121 ms, same app,
  same recipe, only the compiling Bun differs. This is why ADR-0048 sets 1.4.0 as a floor.

---

## E5 — Why bun 1.3.5 cannot serve the standalone tree

**Question.** The smoke test returned HTTP 500 on bun 1.3.5 where 1.4.0 returned 200. Why?

**Method.** Captured the server log.

**Result.** `Error: Expected CommonJS module to have a function` /
`Error: Failed to load external module next`, thrown from `.next/server/app/_global-error/page.js`.

**Answer.** A module-loading incompatibility that Bun 1.4.0 fixes. On this app, 1.4 is not merely
faster than 1.3 — it is the difference between working and not. A second reason the floor is 1.4.0.

---

## E6 — Does the bytecode pass help or hurt?

**Question.** `bun build --bytecode` on the standalone tree improves cold start. Does it cost
anything?

**Method.** Ran `precompileBunBytecode` over a **copy** of the standalone tree (the pass makes files
Bun-only), then measured both metrics. 1105 files compiled, 0 skipped, entry guarded, 41.2 s.

**Result.** Cold start **1.59× faster**; throughput **0.85×** — slower. Because that is
counterintuitive, it was repeated three more times:

| rep | plain | bytecode |
|---|---|---|
| 1 | 635 req/s | 555 req/s |
| 2 | 674 req/s | 601 req/s |
| 3 | 595 req/s | 442 req/s |

**Answer: it is a real trade, not noise.** Bytecode buys startup and costs steady-state throughput.
That is the right trade for scale-to-zero and the wrong one for an always-warm service — worth
knowing, since the single-exec target takes this trade by construction.

---

## E7 — The throughput result that was wrong, and how it was caught

**Question (retrospective).** The first throughput run measured `/` and put the vinext single-exec
at **0.50× node** — half the throughput, alongside an 11× cold-start win. Is that real?

**Method.** Before publishing, compared the actual responses across arms.

**Result.**

| arm | bytes | sha256 (16) | content-encoding |
|---|---|---|---|
| node + turbopack | 6,646 | `6edfeaaf048bf8de` | gzip |
| bun 1.4 + turbopack | 6,646 | `6edfeaaf048bf8de` | gzip |
| bun 1.4 + bytecode | 6,646 | `6edfeaaf048bf8de` | gzip |
| **vinext single-exec** | **10,958** | `6dcb77945f665c2d` | **none** |

**Answer: the measurement was invalid.** The vinext arm was serving a different page — 65% more
bytes, uncompressed. It was being charged for work the other arms were not doing.

**Corrected on `/api/health`, where all arms are byte-identical: 1.75×, not 0.50×.** The sign of the
conclusion flipped.

**The lesson, which generalises past this table:** verify payload equivalence before believing a
throughput number. A cold-start comparison survives a payload difference because process boot
dominates; a throughput comparison does not.

---

## E8 — Is a Bun 1.4.0 build deployed anywhere? (cluster)

**Question.** Can the 1.4.0 single-exec be verified on the live cluster?

**Method.** Queried OKE (`context-ckmva7v7zvq`) for running services and inspected the container.

**Result.** Three vinext/bun-exec services are live and serving 200:
`p1b-bunexec`, `css-bunexec`, `fm-vinext` (~5 s scale-from-zero wake). `p1b-bunexec` runs
`/app/server`, a 103 MB compiled binary — genuinely the single-exec path.

**Answer: no.** The binary is dated **2026-08-09** and strings show Bun **1.3.5**. Bun 1.4.0 was
released 2026-08-20, so no deployed artifact can be the 1.4.0 build. **The cluster confirms the
single-exec approach works; it does not yet verify the 1.4.0 floor.** Producing that requires a
`bun-linux-arm64-musl` build, a push, and a new revision.

---

## Open, and deliberately not claimed

- **E2's Linux reproduction** of #188, required before the keep-alive guard's `then drop` step.
- **E8's 1.4.0 cluster verification.**
- **No vinext coverage in the official compatibility suite.** `docs/compat-matrix.md` carries zero
  vinext rows and the Bun axis is ❌ "first green pending". ADR-0048 makes this the largest
  outstanding cost of the decision, because verified-adapter status is the project's north star.

---

## E9 — Can the reference app (file-manager) build the mandated target? (2026-08-27)

**Question.** ADR-0048 makes vinext single-exec the only supported target, and file-manager is
knext's reference app — the one wired to scale-to-zero Postgres and the one the cluster runs. Can it
produce that artifact?

**Method.** Ported file-manager to the vinext toolchain: `vite.config.ts` (vinext + nitro bun
preset), `knext-bun-entry.mjs` and its `runtime-contract.mjs` sibling, the vite/nitro/plugin-rsc
devDependencies, and `build:vinext` / `build:exec` scripts. Then built and compiled.

**Three obstacles cleared, one not.**

1. **Root `pnpm.overrides` pinned `vite` to `>=7.3.5 <8`**, so `^8.0.0` silently resolved to 7.3.6
   and vinext failed on the missing `parseSync` export. The override is Trivy remediation (#199) —
   the **floor** is the security fix, the `<8` was major-pinning. Verified vite 8.2.2 carries **zero
   advisories at any severity**, and the workspace's only vite dependent is file-manager's own
   config, so the ceiling was lifted and the floor kept.
2. **Tailwind 4 via postcss failed** with `ENOENT … /apps/file-manager/tailwindcss` — postcss
   resolving the package as a relative path under Vite. Fixed with Tailwind's first-class
   `@tailwindcss/vite` plugin.
3. **The bun entry imported a missing sibling**, `runtime-contract.mjs`. Copied.

**Result: `vite build` succeeds** — `.output/server/index.mjs`, 22,352 bytes, `"preset": "bun"`.
**`bun build --compile` fails:**

```
error: "rsc_exports" is not declared in this file
  at .output/server/_ssr/rsc2.mjs
error: "ssr_exports" is not declared in this file
```

**Answer: no, and it is an upstream bug rather than a knext or Bun one.** Four measurements
establish that:

- **Not a Bun-compiler limitation.** The *uncompiled* output fails identically:
  `bun .output/server/index.mjs` → **HTTP 500**, same `"ssr_exports" is not declared`.
- **Not a flag interaction.** All four combinations of `--compile` / `--minify` / `--bytecode` fail
  the same way.
- **Not a version regression.** vinext **1.0.0-beta.4 and 1.0.0-beta.8** both fail identically.
- **App-shape specific.** `examples/bun-exec` compiles cleanly on the *same* toolchain versions;
  its `.output` contains no such symbol. file-manager is the real app, with the RSC surface
  ADR-0036 warned made it "a poor FIRST target".

Reading the emitted module: `rsc_exports as h` appears in an **export list** while the symbol is
declared nowhere in that file, and `_runtime.mjs` does not define it either (0 references). The
bundle exports something that does not exist.

**Consequence for ADR-0048.** Its consequence #1 — *"the sole supported path now depends on a
pre-1.0 dependency the project does not control"* — is not a future risk. It is the current
blocker. The target is declared, tooled and enforced in code, but **no production app in this repo
can build it**, and `examples/bun-exec` therefore cannot be deleted: it is the only thing that can
produce the mandated artifact, and the contract's reality test binds to it.

**What would unblock it:** an upstream fix in vinext's RSC code generation. Worth filing at
`github.com/cloudflare/vinext` — the reproduction is clean, since one app works and one emits an
undeclared export on identical versions.

### E9a — Narrowing it: the bug is CODE-SPLITTING, and it is not configurable away

**Question.** Why does `examples/bun-exec` compile and file-manager not, on identical versions?

**Method.** Compared the emitted RSC/SSR chunks.

| app | `_ssr/` chunks |
|---|---|
| `examples/bun-exec` | `rsc.mjs`, `ssr.mjs` |
| `apps/file-manager` | `rsc.mjs`, **`rsc2.mjs`**, `ssr.mjs`, **`ssr2.mjs`** |

**The undeclared exports live only in the `2` chunks.** bun-exec is small enough to emit one chunk
per environment and is therefore unaffected. So this is a **code-splitting** defect: when the
bundler splits, the second chunk's `export` clause lists symbols from the first without importing
them.

**Two workarounds attempted, both partial:**

1. Top-level `build.rollupOptions.output.manualChunks: () => 'index'` — **collapsed `ssr2.mjs`**
   (`ssr_exports` gone) but left `rsc2.mjs`. vinext configures the RSC environment itself, so the
   top-level option does not reach it.
2. Vite 8 `environments.rsc.build.rollupOptions.output.manualChunks` — **no effect**; `rsc2.mjs`
   still emitted.

**Answer: not configurable from the app.** vinext generates the RSC chunk internally, past the
override points a consuming app has. Halving the problem confirms the diagnosis without fixing it.

**Sharpened bug report for upstream** (`github.com/cloudflare/vinext`): on an app large enough to
split the RSC environment into two chunks, the second chunk exports symbols it neither declares nor
imports (`rsc_exports as h`), producing a bundle that fails on *any* runtime — `bun` returns HTTP
500 with `"rsc_exports" is not declared in this file`, and `bun build --compile` refuses it. Present
in **1.0.0-beta.4 and 1.0.0-beta.8**. A single-chunk app is unaffected.

### E9b — Exhausting the workarounds

Every lever available to a consuming app, tried and recorded so nobody repeats them:

| attempt | result |
|---|---|
| all 4 combinations of `--compile` / `--minify` / `--bytecode` | fail identically |
| vinext `1.0.0-beta.4` → `1.0.0-beta.8` | both fail identically |
| top-level `build.rollupOptions.output.manualChunks` | **partial** — collapsed `ssr2.mjs`, left `rsc2.mjs` |
| Vite 8 `environments.rsc.build.rollupOptions.output.manualChunks` | no effect |
| a vinext plugin option for chunking | **none exists** — `vinext()` takes no config argument |

**Conclusion: unreachable from the app.** vinext emits the RSC chunk internally, past every override
point a consumer has, and exposes no option to influence it. This requires an upstream fix.

**Status of the ADR-0048 target, stated exactly:**

- The **option surface** is vinext-only: `build` defaults to vinext, turbopack is retired and
  rejected with a migration message, and the contract exposes vinext as the sole available builder.
- The **target itself works**: `examples/bun-exec` builds, compiles, runs, and benchmarks at 61 ms
  cold / 1103 req/s. Older-Bun builds of it are deployed and serving on the cluster.
- **file-manager cannot build it**, on this upstream bug alone.

So the decision is implemented; one app is blocked by a third-party defect. That distinction matters
for planning: nothing here is waiting on knext work.

### E9c — Why no patch can fix it either

Before concluding, the last remedy was checked: could a post-build fixup add the missing import?

**No.** `rsc_exports` is declared **nowhere in the entire output**:

- `rsc2.mjs` lists it in its `export` clause (`rsc_exports as c`) and imports only `node:url`;
- `rsc.mjs` — the sibling chunk — neither declares nor exports it;
- `_runtime.mjs` does not define it.

It is a **dangling reference**, not a missing import. There is no module to import it from, so no
patch, `pnpm patch`, or post-build step can bind it. The generated bundle is simply invalid.

**Final status of ADR-0048's executability:** the decision is implemented in knext (option surface,
build path, image template, Bun 1.4.0 floor, validator, contract). The target is proven to work on
`examples/bun-exec` — 61 ms cold, 1103 req/s, deployed and serving. `apps/file-manager` cannot build
it, and **no change within this repository can make it**. This is upstream work.

### E9d — A hypothesis, tested and REFUTED: it is not server actions

**Hypothesis.** The broken chunk is imported by `actions-*.mjs`; file-manager has four files with
`'use server'` and `examples/bun-exec` has none. Do server actions trigger the split?

**Method.** Added one trivial server action to bun-exec — the app that builds cleanly — rebuilt, and
looked for the chunk and the dangling symbol.

**Result.** `rsc.mjs`, `ssr.mjs`. Still one chunk per environment; **zero** dangling exports.

**Answer: no.** Server actions alone do not cause it. The probe was removed and bun-exec rebuilt to
its original output.

Recorded because it is the hypothesis anyone would form from the import graph, and it is wrong.
The remaining explanation is module-graph SIZE crossing a chunk-splitting threshold — file-manager
is a real app (335 KB + 130 KB across the two RSC chunks), bun-exec is a minimal sample. That is
harder to reduce to a minimal reproduction, and it is what the upstream report should say rather
than pointing at a feature that has been ruled out.

### E9e — Seventh mechanism: a post-enforce plugin mutating the resolved config

**Attempt.** A Vite plugin with `enforce: 'post'` and a `configResolved` hook, setting
`manualChunks` directly on `resolved.environments.rsc.build.rollupOptions.output` — the only
ordering that lands *after* vinext has configured its own environment.

**Result: no effect.** `rsc2.mjs` still emitted, dangling export intact, compile still fails.

**What that rules out.** The RSC chunk is not produced through the resolved config's
`rollupOptions` at all. vinext runs its own build for that environment, outside the output config a
Vite plugin can reach — which is why every declarative and imperative override lands on SSR and
never on RSC.

The dead plugin was removed rather than left in the config; a knob that provably does nothing is
worse than no knob.

**Mechanisms tried and exhausted (7):** compile flags · vinext beta.4 → beta.8 · top-level
`manualChunks` (fixed SSR only) · `environments.rsc.*` declarative · post-enforce `configResolved`
· vinext plugin options (none exist) · post-build patch (impossible — the symbol has no origin).

### E9f — Conclusive: the cycle is inside vinext, not in app code

**Question.** `rsc.mjs` imports from `./rsc2.mjs`, and `rsc2.mjs` exports `rsc_exports` — the
namespace of `rsc.mjs` itself. A circular chunk dependency. Which app module creates it?

**Method.** Rebuilt with `--minify false` to recover readable module attribution.

**Result — every module in the broken chunk is a vinext internal:**

```
app/api-reference/functions/cookies
app/api-reference/functions/headers
components/request-async-storage
lib/constants
src/client/components/app-router-instance
src/client/components/segment-cache/navigation
src/client/lib/javascript-url
src/client/request/io
```

These are vinext's own Next.js compatibility shims. **No file-manager source appears.**

**Answer: there is no app-level fix, and this is now certain rather than inferred.** The cycle is
between vinext's internal modules; an app can only influence *how many* of those shims get pulled
in, which is what crosses the split threshold. Nothing an app author can restructure removes it.

**The complete mechanism, for the upstream report:**

> When an app pulls in enough of vinext's Next-compat shims to split the RSC environment into two
> chunks, the chunks become mutually dependent: `rsc.mjs` imports from `rsc2.mjs`, while `rsc2.mjs`
> re-exports `rsc_exports` — the namespace object of `rsc.mjs` — which it never imports and which is
> declared in no emitted module. The bundle exports a symbol with no origin, so it fails on any
> runtime (`bun` → HTTP 500, `"rsc_exports" is not declared in this file`) and `bun build --compile`
> refuses it. Present in 1.0.0-beta.4 and 1.0.0-beta.8. Single-chunk apps are unaffected. Not
> reachable by `manualChunks` at any level, since vinext builds that environment outside the
> resolved Vite output config.

**Eight mechanisms exhausted.** Compile flags · beta.4 → beta.8 · top-level `manualChunks` (fixed
SSR only) · `environments.rsc.*` · post-enforce `configResolved` · vinext plugin options (none) ·
post-build patch (symbol has no origin) · app-level cycle break (cycle is not in app code).

### E9g — The chunk survives EVERY configuration surface in the toolchain

Two final attempts, both targeting layers not previously reached:

**Patched `@vitejs/plugin-rsc` directly** (`plugin-Cbs9j6lP.js`, the rsc environment definition).
This turned out to explain *why* the earlier config attempts were ignored: the plugin sets
`rollupOptions: { input: ... }`, **replacing the object wholesale** in its `config` hook, so any
user-supplied `output.manualChunks` is discarded. Adding `output: { manualChunks: () => "index" }`
at that exact site — **no effect**; `rsc2.mjs` still emitted. Patch reverted.

**Set nitro's `rollupConfig`.** The chunks live in `.output/server/_ssr/`, which is *nitro's* output
path — nitro re-bundles what plugin-rsc produced, and there is no intermediate `dist/rsc`, so nitro
is the last stage before the emitted files. `nitro({ rollupConfig: { output: { manualChunks } } })`
— **no effect**. Dead config removed rather than left in place.

**Nine mechanisms, every layer of the toolchain:**

| layer | attempt | result |
|---|---|---|
| Bun | 4 flag combinations | no effect |
| vinext | beta.4 → beta.8 | no effect |
| Vite | top-level `manualChunks` | fixed SSR only |
| Vite | `environments.rsc.*` | no effect |
| Vite | post-enforce `configResolved` | no effect |
| vinext | plugin options | none exist |
| **plugin-rsc** | **direct source patch** | **no effect** |
| **nitro** | **`rollupConfig`** | **no effect** |
| output | post-build patch | impossible — symbol has no origin |
| app | break the import cycle | impossible — cycle is in vinext's own shims |

**Closed.** The split is produced somewhere no configuration surface reaches, by code that emits a
namespace reference it never declares. This requires an upstream fix in vinext (or in rolldown's
chunk linking, which vinext would need to carry). No consumer-side remedy exists, and this is now
demonstrated rather than asserted.

---

## E10 — The remedy EXISTS. E9's conclusion was wrong.

**E9g concluded "no consumer-side remedy exists" after nine attempts. That was wrong**, and the
error is worth naming precisely: every attempt used rollup's `manualChunks`, and **nitro on rolldown
does not read it**. It keys off `output.codeSplitting`. Nine attempts failed on the wrong knob, and
"I tried nine things" was mistaken for "nothing works".

**What found it.** Reading `nitro/dist/vite.mjs` instead of guessing:

```js
}, nitro.options.rolldownConfig, nitro.options.rollupConfig, commonConfig);
const outputConfig = rolldownConfig.output;
if (outputConfig.inlineDynamicImports || outputConfig.format === "iife") {
    delete outputConfig.inlineDynamicImports;
    outputConfig.codeSplitting = false;      // <-- the escape hatch
}
```

`nitro.options.rollupConfig` **was** being read all along. The key was wrong, not the mechanism.

**The fix, in `vite.config.ts`:**

```ts
nitro({
  preset: 'bun',
  entry: './knext-bun-entry.mjs',
  rollupConfig: { output: { inlineDynamicImports: true } },  // => codeSplitting: false
})
```

**Result — the original blocker is gone:**

| | before | after |
|---|---|---|
| `_ssr/` chunks | `rsc.mjs` + `rsc2.mjs` | single bundle |
| dangling `rsc_exports` | yes | **gone** |
| uncompiled output serves | **HTTP 500** | **HTTP 200** |
| `bun build --compile` | **refused** | **exit 0**, 67 MB binary |

One chunk means no cycle, so vinext never emits the undeclared namespace re-export.

**Where it stands now.** file-manager's vinext build works and the artifact serves. Two ordinary
single-executable issues remain, both unrelated to the original defect:

1. **`--bytecode` fails**: `import.meta is only valid inside modules`. Compiling without it
   succeeds, so bytecode is currently unavailable for this app — which costs cold start, since
   bytecode is what buys it.
2. **`Cannot find module '@ioredis/commands'`** at runtime: a dynamic `require` in ioredis that
   `--compile` cannot statically bundle. The binary boots and listens; this fails the cache path.

Both are tractable and ordinary. Neither is an upstream code-generation bug.

**The lesson, recorded against myself:** nine failed attempts on the same wrong assumption is not
evidence that a thing is impossible. It is evidence that the assumption was never checked. Reading
the source that consumes the option would have cost far less than the nine attempts did.

---

## E11 — The REFERENCE app, measured against itself (2026-08-28)

**Question.** E4 measured `examples/bun-exec`, a minimal sample. Does the single-executable win hold
on `apps/file-manager` — the real app, with RSC, Postgres, Redis and OTel?

**Method.** Same harness, same route (`/api/health`), n=6, both arms built from the same source.
The single-exec arm is **without `--bytecode`** (see E12).

**Result.**

| arm | cold median | p95 | req/s |
|---|---|---|---|
| node + standalone | 2670 ms | 2780 | 127 |
| **vinext single-exec (no bytecode)** | **753 ms** | **777** | **1092** |
| | **3.54× faster** | | **8.6× throughput** |

**Answer: the win is LARGER on the real app, and it does not depend on bytecode.**

Two things worth separating, because the toy sample understated both:

- **node's standalone arm costs 2.67 SECONDS to first response here**, against 884 ms on the minimal
  sample. Startup cost scales with the app; a real one pays far more. That is the number a user
  actually waits through on a scale-from-zero wake.
- **The single-exec arm reaches 1092 req/s against node's 127** — 8.6×, where the sample showed
  1.75×. The gap widens with app size in the same direction.

**Consequence for ADR-0048.** The decision was justified on a 14.5× cold start measured on a toy.
That number does not transfer (different app, and that one had bytecode). What transfers is the
direction, and it is stronger here than the original evidence claimed: 3.5× cold start and 8.6×
throughput on the reference app, with the bytecode optimisation still unavailable.

## E12 — Why `--bytecode` does not work on file-manager

**Question.** E11's arm ran without bytecode. Why, and what does it cost?

**Method.** Compiled with `--bytecode` under both the default and `--format=cjs`.

**Result.** Both compile (exit 0) with a build warning — `Failed to generate bytecode for
./index.js` — and the resulting binary dies at boot:

```
SyntaxError: import.meta is only valid inside modules.
```

**Cause.** `bun build --bytecode` emits CommonJS, where `import.meta` is a syntax error. The
generated bundle uses it in three places, and **none of them are knext's code**:

- vinext's `__vinext_module_identity` shim reads `import.meta.filename` / `.dirname`;
- nitro prepends `globalThis.__nitro_main__ = import.meta.url` to the server entry.

`examples/bun-exec` compiles WITH bytecode on the same toolchain, so this is triggered by something
in the larger app's module graph rather than by the entry itself.

**Answer: an upstream limitation, not a knext defect, and not a blocker.** E11 shows the target
already wins 3.5×/8.6× without it. Bytecode would improve cold start further — it bought the sample
1.59× on the standalone arm (E6) — so it is worth having, but nothing waits on it.

**Do not "fix" this by rewriting the generated bundle.** A post-build transform over
vinext/nitro-generated `import.meta` would be editing code we do not own, on every build, with no
guard that it stayed correct. The honest fix is upstream, or Bun supporting `import.meta` under
`--bytecode`.

---

## E13 — image optimization on the single executable: four routes, all closed

**Question.** ADR-0048 makes the vinext + `bun build --compile` single executable the
only build target. Does `/_next/image` still optimize there? `CLAUDE.md` records image
optimization as the project's biggest functional gap until ADR-0006 closed it, so a
build-system change that quietly reopened it would be a regression wearing the costume
of a migration.

**Answer: no, and it cannot be made to.** Four independent routes were tried and
measured, not reasoned about.

### Route 1 — vinext's plugin option

`vinext({ images: { optimizer } })`. No effect. The option is read on vinext's
Cloudflare init path only.

### Route 2 — vinext's public setter

`setImageOptimizer()` called from the server entry, with state anchored on `globalThis`
(so module duplication is not the problem). Also no effect. vinext's own types say
`InitImageOptimization = "cloudflare-images" | "none"` — there is no third option — and
the handler gates the route on the Cloudflare Workers assets binding:

```js
if (isImageOptimizationPath(url.pathname) && env?.ASSETS && getImageOptimizer())
```

On the node/bun platform `env.ASSETS` is undefined, so the branch is dead no matter what
is registered. Routes 1 and 2 both returned 181,277 bytes of `image/png` for a 640px
webp request — byte-identical to the source.

### Route 3 — intercept the route, load sharp dynamically

knext owns the server entry, so it can answer `/_next/image` before vinext sees it.
**This works, and it is what shipped** — but only on the uncompiled output. Two things
had to be true, and each was learned the hard way:

- `await import(computedSpecifier)` **does not work**. rolldown does not leave an
  unanalysable dynamic import alone; it replaces it with a stub that throws
  `Cannot find module as expression is too dynamic`. The opacity that defeats bundling
  also defeats resolution. `createRequire` is what survives.
- Inside a `bun build --compile` binary, `createRequire` reaches **only the embedded
  module graph**. Measured against a staged, npm-installed sharp beside the binary, all
  three of `require("sharp")`, `require("/abs/path/node_modules/sharp")` and
  `require("/abs/path/.../lib/index.js")` fail.

### Route 4 — static import, letting Bun embed the N-API module

`import sharp from 'sharp'` compiles cleanly to a 62 MB binary and then dies on first
use: `Could not load the "sharp" module using the darwin-arm64 runtime`. The native
binding is not loadable from inside the executable.

### What it costs — measured, n=5, same app, same route

| target | cold start (median) | image optimization |
| --- | --- | --- |
| node + standalone | 2670 ms | yes |
| vinext, uncompiled, under bun | **879 ms** | **yes** |
| vinext single executable | **469 ms** | **no — impossible** |

Verified working on the uncompiled path, judged on bytes *and* on decoded magic bytes
rather than on the declared content-type:

```
source knext-optimize-fixture.png -> 181277b png
avif-capable client     2116b  declared=avif actual=avif   86x smaller
webp-only client        1880b  declared=webp actual=webp   96x smaller
legacy client (*/*)    23124b  declared=png  actual=png     8x smaller
```

**The trade this exposes.** Keeping image optimization costs ~410 ms of cold start
(469 → 879 ms) — and the uncompiled vinext path is still 3x faster than the node
standalone it replaces. Dropping it buys that 410 ms at the price of a Tier-A capability.
**That is a founder decision against ADR-0048, not an implementation detail**, and it is
recorded here rather than resolved.

### Two lessons about the instruments, not the subject

- **The first probe reported `PASSTHROUGH` on a working implementation.** It judged on
  `content-type === "image/webp"`; the server had correctly negotiated avif. A hardcoded
  expectation inside the measuring tool produced a false negative about correct code —
  the same defect class as asserting from assumption in the product.
- **A silent fail-open hid all of this.** The optimizer swallowed sharp's load error with
  a bare `catch {}`, so the only symptom was a response that looked fine and was 96x too
  big. It now logs once and says what broke. Failing open is right; failing open
  *silently* is what made this expensive to find.

---

## E14 — file-manager on the full Bun toolchain, re-measured

Same app, same machine, after the migration work: `@getknext/lib` and
`@getknext/db` rebuilt as bundled ESM, dependencies installed with `bun install`,
served by Bun.

### Time to first response (n=6, median)

| target | median | min | max |
| --- | --- | --- | --- |
| uncompiled `.output` under Bun | **186 ms** | 163 | 191 |
| compiled single executable | **170 ms** | 150 | 171 |

**What this measures, precisely:** process start → a static asset served. It
covers binding the listener and serving from `.output/public`. It does NOT cover
evaluating the application graph, because nitro serves static assets before that
happens. E11–E13 used the same probe, so the comparison is like-for-like.

Against E13's numbers on the same probe (879 ms uncompiled, 469 ms compiled),
this is roughly **4–5x faster**. The app did not change; its dependencies did.
The plausible cause is the ESM rebuild — `@getknext/lib` went from `tsc`-emitted
CommonJS to a tsup-bundled ESM graph, which is far fewer modules to resolve and
evaluate at boot. Recorded as an observation, not a proven mechanism: it was not
isolated by rebuilding only that one thing.

The gap between compiled and uncompiled has also closed to ~16 ms, from ~410 ms.
If that holds up, the central trade in **ADR-0048 Amendment 2** — image
optimization vs the single executable — is much cheaper than it looked, because
the uncompiled path now costs almost nothing. That deserves re-measuring
deliberately before the decision is taken on it.

### Throughput

**21,941 req/s** over 4 s at concurrency 20, static asset, zero errors.

### Image optimization (`/_next/image`)

Judged on decoded magic bytes, not the declared content-type:

| client | bytes | declared | actual | vs source |
| --- | --- | --- | --- | --- |
| avif-capable | 2,116 | avif | avif | 86x smaller |
| webp-only | 1,880 | webp | webp | 96x smaller |
| legacy `*/*` | 23,124 | png | png | 8x smaller (resized only) |

Source: 181,277 b PNG.

### One number that is NOT a cold-start figure

A first request to `/dashboard` takes **8.2 s** here. That is not boot cost — it
is the DB wake-retry budget (`DB_WAKE_RETRY_BUDGET_MS`, default 8 s) doing its
job against an environment with no Postgres at all. Reported because it is
exactly the kind of measurement that gets mistaken for a regression: the page
renders, it is simply waiting out a bounded retry for a database that is never
coming. On a cluster with a scale-to-zero DB the same budget covers the ~2.5 s
cold wake instead.
