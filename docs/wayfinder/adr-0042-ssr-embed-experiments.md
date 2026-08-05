# ADR-0042 — two experiments on the SSR-embedding blocker (Consequence 11)

**Questions, exactly as posed by the founder.**

1. Does a **post-build rewrite** of vinext's emitted `dist/server/index.js` — converting the two
   lazy `import(\`./ssr/index.js\`)` call sites into a **top-level static import in that same
   file** — make the compiled binary serve SSR from a clean directory with no `node_modules`?
2. Was the **split SSR sub-entry** (`dist/server/ssr/index.js`) introduced *after* the vinext
   version the founder originally used — i.e. is the blocker a **regression** rather than a design
   property?

**Answers.**

| | verdict | one line |
|---|---|---|
| **Experiment 1** | **NO** | Same 140 modules, same defect; the failure **moved from first render to startup**, with the canonical `Cannot find package 'react-dom' from <build-host path>/ssr/index.js`. |
| **Experiment 2** | **NO on the premise — but YES on the thing the premise was reaching for** | The split SSR sub-entry has existed since **`vinext@0.0.1`**, so it is *not* a regression. The **actual blocker is**, and it is not vinext's: holding vinext, `@vitejs/plugin-react`, `@vitejs/plugin-rsc` and the whole React closure **fixed at recorded exact versions**, a **Vite 7** build embeds and serves real SSR from a clean container with no `node_modules`, and a **Vite 8** build does not. |
| **Mechanism** | **ESTABLISHED** (mutation-proved) | Vite 8's SSR sub-entry reaches `react-dom` through `createRequire(import.meta.url)("react-dom")`. Bun's bundler does **not** rewrite `createRequire` requires to bundled modules; in a `--compile` binary `import.meta.url` is the **build-host source path**, so the resolver walks up from a directory that does not exist off the build host. Vite 7 emits no such call. |

**A YES on either was said to change Consequence 11 and Escalation 2′. One of them does — but not by
the route proposed.** Nothing here licenses shipping an old vinext: ADR-0042's *What must NOT be
done* forbids pinning `vinext@^0.0.19` as a shipping dependency, and beta.4 **peer-requires
`vite@^8`**, so "use Vite 7" is not available on the version this ADR targets. The finding reframes
the remedy from **"fork vinext"** to **"an upstream fix, in Vite 8 or in how vinext configures its
SSR environment under it"** — a far cheaper conversation, and one that is not knext's to own
permanently. **Not "one bug":** the first failure layer is mutation-proved (§2), the second is
not, and §4.1 states plainly that whether a single upstream change closes both is **unestablished**.

Environment: bun **1.3.5**, node **v24.14.0**, darwin 25.5.0 / Apple Silicon, OrbStack Docker
29.4.0, `alpine:3.22` + `apk add libstdc++ libgcc`, all container arms `--platform=linux/amd64`
(emulated; bun warns `CPU lacks AVX support`). Nothing was run against a cluster. No shipped code,
CRD, CLI or operator was modified. Every vinext patch below is spike-local, inside a throwaway
probe's `node_modules`.

---

## 0. Baseline reproduced first — and one correction to the #658 record

Same probe app as `adr-0042-p3a-vinext-prerender-compile.md`, same 3-line `prod-server` rscModule
seam, same entry.

```
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bun-entry-embedded.mjs --outfile e1-baseline-bin
  [109ms]  bundle  140 modules          <- matches #658 exactly
grep -ac "prerender-compile-probe" e1-baseline-bin   -> 3   <- app embedded, matches
```

Clean directory (binary + `dist/client` + `dist/server/prerendered-routes` + four manifests; **0
server `.js` files, 0 `node_modules`**), `alpine:3.22`, container path **`/opt/knextapp`**, which
does **not** exist on the build host:

```
/                                      200  cache=HIT       8306B
/blog/alpha                            200  cache=HIT       8497B
/blog/beta                             200  cache=HIT       8481B
/blog/gamma                            200  cache=HIT       8497B
/isr                                   200  cache=HIT       8380B
/img                                   200  cache=HIT       8899B
/api/health                            200  cache=-           70B
/blog/spike-dynamic-not-prerendered    500
/definitely-not-a-route                500
```

Prerendered routes + `/api/health` serve; **every rendering path 500s**. That is #658's result and
the baseline is reproduced.

**Correction to #658's error string.** #658 records the baseline failure as
`Cannot find package 'react-dom' from …/dist/server/ssr/index.js`. In this run the *lazy* shape
fails as:

```
TypeError: undefined is not an object (evaluating 'qm.preload')
      at <anonymous> (/$bunfs/root/e1-baseline-bin:176:363)
```

Both messages are real and both were reproduced here — they are **two layers of one defect**, and
§2 proves the ordering by mutation. The `Cannot find package` form appears when the SSR chunk is a
**static** dependency; the `.preload`-undefined form when it is a **lazy** one. #658 attributed the
first message to the lazy shape; that is the part corrected.

---

## 1. Experiment 1 — post-build rewrite to a top-level static import: **NO**

This is genuinely different from what #658 tried. #658 rewrote the *dynamic* call's specifier to a
literal, and separately added a static import **from the entry**. Neither converted the call site
**inside `dist/server/index.js`** into a top-level static import **in that same file**.

The rewrite (`spike-vinext-ssr-embed/rewrite-ssr-import.mjs`) asserts each anchor occurs **exactly
once** and aborts otherwise, and asserts its post-conditions — a silently-failed substitution here
would produce a green run that proves nothing:

```
anchors: ssrLoader(){return import(`./ssr/index.js`)}       x1
         loadSsrHandler(){return import(`./ssr/index.js`)}  x1
insert : import * as __knext_ssr_ns from "./ssr/index.js";   (module scope)
loaders: return Promise.resolve(__knext_ssr_ns)
post   : lazy import() call sites remaining = 0 ; static imports inserted = 1
```

Compile and run:

```
 [110ms]  bundle  140 modules            <- IDENTICAL count to baseline
grep -ac "prerender-compile-probe"  -> 3

# container, /opt/knextapp, no node_modules:
error: Cannot find package 'react-dom' from
  '/private/tmp/.../scratchpad/pcprobe/dist-e1/server/ssr/index.js'
Bun v1.3.5 (Linux x64)
```

**The failure moved: startup, not first render.** The process never binds a port. The module count
is unchanged, which says the SSR chunk was *already* in the graph — the rewrite changed **when** it
is evaluated, not **whether** it is bundled. Note the path in the error contains `dist-e1`, the
directory this experiment created: the resolution is rooted at the **SSR chunk's build-host source
path**, not at the entry's, not at the binary's.

**What this technique is, stated plainly.** It is post-build patching of a dependency's emitted
output. It is legitimate — patch-package territory — but it is a **maintenance burden that
re-breaks on every vinext release**: the anchors above are *minified* text emitted by vinext's
build, with no stability contract whatsoever. That cost belongs in the record next to the result,
and here the result does not even buy anything.

### 1.1 The prescribed negative control does NOT go red — and that matters

ADR-0042's container rule says to rename the build tree as a negative control. Run against
Experiment 1's host-compiled binary, from a clean directory:

| arm | `/` | `/blog/spike-dynamic-not-prerendered` (SSR) | 404 |
|---|---|---|---|
| host, build tree present | 200 HIT | **200, 8881 B** | **404 correct** |
| host, **build tree renamed** | 200 HIT | **200, 8881 B** | **404 correct** |

The rename control **stays green**. The false green here is not fed by the build tree; it is fed by
the build host's **ancestor `node_modules`**, which `createRequire`'s walk-up still reaches after
`dist-e1` is renamed. The control that does go red is renaming **`node_modules`**:

```
node_modules RENAMED  -> every route: fetch failed (process dead)
   log: Cannot find package 'react-dom' from '…/pcprobe/dist-e1/server/ssr/index.js'
node_modules restored -> /api/health 200 · SSR 200 8881B · 404 correct
```

Mutation-proved in both directions. **Recommendation:** ADR-0042's verification rule should say
*run in a container* (which removes the whole host filesystem, ancestors included) rather than
*rename the build tree* — the latter is a control this failure class walks straight past. A
container arm is what caught it here.

---

## 2. Mechanism — established, not inferred

Bun **can** bundle react-dom: a bare entry importing `react-dom` and `react-dom/server.edge`,
compiled with the same flags and run in the same container, prints `preload: function`
(8 modules). So this is not a general bun limitation. It is also not directory-dependent — the same
bare probe placed at `dist/server/` and at `dist/server/ssr/` compiles and runs identically.

The vinext SSR chunk is different. `dist/server/ssr/index.js` (beta.4) contains:

```js
import { createRequire as e } from "node:module";
import * as h from "react-dom";
...
var D = e(import.meta.url);                       // module scope
...
var oa = C((e) => { var t = D(`react-dom`), ... }) // the react-server-dom-webpack CJS shim
```

`D(\`react-dom\`)` is a **runtime require through a createRequire handle**. Bun's bundler does not
rewrite those to bundled modules — react-dom *is* in the bundle (the plain
`bun build --target=bun` output inlines `node_modules/react-dom/cjs/…`), and this one access path
bypasses it. In a `--compile` binary `import.meta.url` for that module is the **build-host source
path**, exactly as ADR-0042 §4 found for `import.meta.dirname`. Hence the error text, including its
build-host path.

**Mutation proof.** Replace that single call with the chunk's own already-present static namespace
(`var t = (h.default ?? h)`), anchor asserted unique, everything else held constant:

```
before:  error: Cannot find package 'react-dom' from '…/dist/server/ssr/index.js'
after :  TypeError: undefined is not an object (evaluating 'h6.default')
             at loadAndEvaluateModule
```

The resolver error disappears — so that call **is** the resolver's caller. What it exposes
underneath is the *second* layer: the `react-dom` namespace binding is `undefined` at that point in
the chunk's evaluation. That is the same shape as the baseline's `qm.preload` failure, which is why
§0 calls them two layers of one defect rather than two defects.

**Not established:** *why* bun leaves that binding uninitialised. Reproduced consistently; cause not
isolated.

---

## 3. Experiment 2 — the version archaeology

### 3.1 The split SSR sub-entry is NOT new. First version: `0.0.1`.

72 published versions (`npm view vinext versions`). Scanning the published tarballs for the
emitting-side evidence, and reading `prod-server`'s own doc comment:

| vinext | **files in the tarball containing** `ssr/index.js` | note |
|---|---|---|
| `0.0.0` | 0 | 1 MB placeholder; no deps, no `prod-server` |
| **`0.0.1`** | **2** | `dist/server/ssr/index.js — SSR entry (imported by RSC entry at runtime)` |
| `0.0.3` … `0.0.19` | 3 | unchanged |
| `0.0.40` … `1.0.0-beta.4` | 4–8 | unchanged in kind |

**Column label corrected.** `e2-scan.sh` computes `grep -rl … | wc -l` — that is the number of
**files containing** the string, not the number of references. The counts above are therefore
file counts, and a version that mentions the sub-entry twice in one file scores 1. The conclusion
does not depend on the metric: it is independently confirmed by **building** `0.0.19` below, which
emits the sub-entry on disk.

Confirmed by **building the same probe app against `vinext@0.0.19`** (vite 7.3.6):

```
[5/5] build ssr environment...
dist/server/ssr/index.js    245.52 kB
$ ls dist/server            -> __vite_rsc_assets_manifest.js  index.js  ssr
$ grep -o '…ssr/index.js…' dist/server/index.js
      const ssrEntry = await import("./ssr/index.js")
```

**So the premise is falsified.** `0.0.19` — the version ADR-0042 names as the old pinned one —
already emits a separate `dist/server/ssr/index.js`, lazily imported by the RSC entry, exactly like
beta.4. It is a design property of the two-environment `@vitejs/plugin-rsc` build, not a regression.
Escalation 3′ does not get cheaper by this route.

### 3.2 …but the *blocker* IS new, and it is **Vite's**, not vinext's

`0.0.19`'s emitted SSR chunk contains **zero** `createRequire` and **zero** `require("react-dom")`.
beta.4's contains both.

> ### ⚠ First attempt was CONFOUNDED — retracted, then re-run and re-established
>
> The original single-variable claim rested on `e2-vite78.sh`, whose loop reads
> `for pair in "7:^7.0.0:^5.0.0" "8:^8.0.0:^6.0.0"`. That varies **`@vitejs/plugin-react` ^5 → ^6
> alongside vite ^7 → ^8**, and the script printed only `vite=` and `plugin-rsc=`, so the confound
> was **invisible in the output this section quoted**. It is not cosmetic:
> `@vitejs/plugin-react@6.0.5` peer-requires `@rolldown/plugin-babel` and
> `babel-plugin-react-compiler`, which npm auto-installs — so the vite-8 arm ran a **different
> transform pipeline**, not merely a different bundler. It was also avoidable:
> `@vitejs/plugin-react@5.2.0` peer-accepts `vite ^4.2.0 || ^5 || ^6 || ^7 || ^8`, one version
> valid on **both** arms.
>
> The claim was withdrawn and the experiment re-run as a genuine single-variable test
> (`e2-vite78-fixed.sh`). **The result survives**, and is now backed by recorded resolved
> versions rather than by ranges in a manifest.

**The corrected test.** Every dependency is an **exact** pin, `@vitejs/plugin-react` is held at
**5.2.0 on both arms**, and vite is the only input that differs. Resolved versions, read out of
each arm's `node_modules` after install:

| resolved package | vite-7 arm | vite-8 arm |
|---|---|---|
| `vinext` | 0.0.30 | 0.0.30 |
| **`vite`** | **7.3.6** | **8.2.0** |
| `@vitejs/plugin-react` | 5.2.0 | 5.2.0 |
| `@vitejs/plugin-rsc` | 0.5.32 | 0.5.32 |
| `react` | 19.2.8 | 19.2.8 |
| `react-dom` | 19.2.8 | 19.2.8 |
| `react-server-dom-webpack` | 19.2.8 | 19.2.8 |
| `@rolldown/plugin-babel` | ABSENT | **ABSENT** |
| `babel-plugin-react-compiler` | ABSENT | **ABSENT** |
| bundler | `rollup@4.62.4`, `esbuild@0.28.1` | `rolldown@1.2.3` |
| native bindings | `@rollup/rollup-darwin-arm64@4.62.4`, `@esbuild/darwin-arm64@0.28.1` | `@rolldown/binding-darwin-arm64@1.2.3` |

A "held fixed" claim is only as good as what was recorded, so the script does not stop at the
enumerated list above — it dumps the **entire resolved package set** of each arm's `node_modules`
and diffs them, which catches an input nobody thought to enumerate. The complete diff is:

```
< @esbuild/darwin-arm64@0.28.1          > @oxc-project/types@0.143.0
< @rollup/rollup-darwin-arm64@4.62.4    > @rolldown/binding-darwin-arm64@1.2.3
< esbuild@0.28.1                        > detect-libc@2.1.2
< rollup@4.62.4                         > lightningcss@1.33.0
< vite@7.3.6                            > lightningcss-darwin-arm64@1.33.0
                                        > rolldown@1.2.3
                                        > vite@8.2.0
```

Every differing package is **vite itself or vite's own transitive bundler/CSS closure**. Nothing
in the React or plugin closure varies. *This* is what makes it a single-variable test.

**Result — unchanged, and now established:**

```
vinext@0.0.30  vite=7.3.6  plugin-react=5.2.0  plugin-rsc=0.5.32  ssrChunk=87362  require("react-dom")=0  createRequire=0
vinext@0.0.30  vite=8.2.0  plugin-react=5.2.0  plugin-rsc=0.5.32  ssrChunk=86220  require("react-dom")=1  createRequire=2
```

The SSR-chunk byte counts (87362 / 86220) are **identical to the confounded run's**, which says
the plugin-react difference never reached this artifact — but that is an observation after the
fact, not what licensed the claim. What licenses it is the resolved-version table and the diff
above.

**The boundary is Vite 7 → Vite 8.** Supporting bisect points, all `require("react-dom")`=0 under
vite 7: `0.0.20 · 0.0.24 · 0.0.28 · 0.0.29 · 0.0.30 · 0.0.31 · 0.0.32`; and =1 under vite 8:
`0.0.30 · 0.0.32 · 0.0.38 · 1.0.0-beta.4`. (`vinext@0.0.39` is separately the first version to emit
`vinext-externals.json`; that is a *different* boundary and is **not** the one that matters —
`0.0.38` has no externals file and still emits the shim under vite 8.)

**Caveat on those supporting points, stated rather than buried.** They come from `e2-bisect.sh`
via `e2-build-version.sh`, which hardcodes `@vitejs/plugin-react: ^6.0.5` for **every** arm. That
makes the bisect internally consistent (plugin-react constant across its own points) but it is a
*different* plugin-react from the corrected test above, and pairing plugin-react 6 with vite 7
violates 6.x's own peer range. They are corroboration, not evidence: the single-variable claim
rests on `e2-vite78-fixed.sh` alone.

### 3.3 Does an older build embed cleanly end-to-end? **YES — with the right entry.**

Two things had to be separated to answer this, and separating them is most of the finding.

**`startProdServer` is not usable on the old line.** `vinext@0.0.19`'s and `0.0.30`'s
`dist/server/prod-server.js` both `import { computeLazyChunks } from "../index.js"` — the **Vite
plugin entry** — so compiling through it drags the whole build toolchain into the binary. Measured,
in order: `--bytecode` fails to generate (`Failed to generate bytecode`, then
`Expected CommonJS module to have a function wrapper` at runtime); without bytecode,
`ENOENT: no such file or directory, open '/package.json'` (Vite's own constants module reading its
package.json through a folded `import.meta.url`); stub that, and
`Cannot find module @rollup/rollup-linux-x64-musl` — a **native addon**. beta.4's `prod-server` has
no such import; on this axis **beta.4 is strictly better for compiling than the old line**, which is
the opposite of the hoped-for shape.

**A bespoke knext entry — the shape ADR-0042 Consequence 4 already mandates — bypasses all of it.**
~20 lines: static `import * as rscModule from './dist/server/index.js'`, serve `dist/client`
statics, delegate everything else to `rscModule.default`. No `vinext/server/prod-server`.

The controlled comparison. **Re-run under the corrected matrix of §3.2, and made single-variable
in the process.** The original version of this table compared `vinext@0.0.30`+vite7 against
`vinext@1.0.0-beta.4`+vite8 — two varying inputs. The arms below hold **vinext at 0.0.30** and
`@vitejs/plugin-react` at **5.2.0** on both sides, so vite is again the only difference. Same
entry file, byte-identical, over the two builds from `e2-vite78-fixed.sh`
(`e2e-container-arm.sh`, `alpine:3.22`, `--platform=linux/amd64`):

| build (all else pinned identical) | container, clean dir, **no `node_modules`**, no server JS |
|---|---|
| `vinext@0.0.30` + **vite 7.3.6** | `/` 200 · `/blog/alpha` 200 · `/blog/beta` 200 · `/blog/gamma` 200 · `/isr` 200 MISS · `/img` 200 · `/api/health` 200 · dynamic `/blog/spike-…` **200** · unknown route **404** |
| `vinext@0.0.30` + **vite 8.2.0** | `/api/health` 200 · unknown route 404 · **every render 500**, container log: `error: Cannot find package 'react-dom' from '<build-host path>/fix78-0030-vite8/dist/server/ssr/index.js'` |

This is a **stronger** result than the original table: with vinext held fixed, the 200-with-real-SSR
vs 500 split is attributable to vite alone. Note also that the failure now presents as the
*resolver* error rather than the `rF.preload` `TypeError` — §0's two layers, selected by whether
the SSR chunk is reached statically or lazily, exactly as §0 predicts.

Both arms compile to **15 modules**. The `52` that appeared in the original table belonged to the
beta.4 build, not to a vite-8 build as such; see §3.4 for what that number does and does not mean.

**And it is real SSR, not a shell.** The original claim rested on a 1565 B document while §0's
comparable documents are 8306–8899 B, a ~5× gap the doc did not address. Measured rather than
asserted, on the same container response:

```
GET /blog/alpha   200  text/html  1565 B    (container path /opt/knext-fix7, absent on the host)
  references a /assets/ or /_next/ client bundle : true
  carries an RSC/flight payload inline           : true   (self.__VINEXT_RSC_CHUNKS__)
  <script> tags: 5   script bytes: 996   markup outside scripts: 569 B
```

The document carries three `modulepreload` links to `/assets/…`, an
`<script id="_R_">import("/assets/index-….js")</script>` bootstrap, and the full flight payload
(`__VINEXT_RSC_CHUNKS__` with the rendered `main`/`h1`/`p` tree). So the claim holds in its strong
form: server-rendered **and** hydratable, not a shell.

**The ~5× gap is fully accounted for, and it is not a rendering difference.** Breaking both
documents down:

| | markup outside `<script>` | inline script bytes | total |
|---|---|---|---|
| beta.4 prerendered `/blog/alpha` (§0) | 524 B | 7973 B (16 tags) | 8497 B |
| `0.0.30`+vite7 live-rendered `/blog/alpha` | **569 B** | 996 B (5 tags) | 1565 B |

The **rendered markup is the same size** (569 B vs 524 B). The entire difference is beta.4's
inline `vinext.navigationRuntime` client-navigation bootstrap — 14 script tags, one of them 5021 B
of route manifest — which `0.0.30` does not emit. That is a **vinext version difference in the
client-navigation payload**, not evidence about SSR.

App marker in the binary: **3**. Clean dir: **0** `node_modules`, **0** server `.js` — both asserted
by `e2e-container-arm.sh`, which aborts rather than proceeding if either is non-zero, and which
also aborts if the container `WORKDIR` exists on the build host.
`--compile --minify --bytecode` completed with **no** bytecode warning on this arm (whether bytecode
is actually present is Phase 3(d)'s question — see §5).

The container is a stronger control than any rename: the host filesystem, ancestors included, is
simply not present. And the vite-8 row is the proven-red negative control for the entry itself —
same entry, same flags, same probe app, same vinext, red.

### 3.4 The two "52 modules" — reconciled

§3.3's original table and §6 both reported **52 modules**, for the bespoke-entry graph and for the
SSR chunk **alone**. The challenge was that one graph must contain the other, so they cannot both
be 52 — and that one number was therefore probably a reused measurement.

**It was not reused.** Both were separately built and both genuinely print 52. Two facts explain
it, and the second is the one that matters:

1. **The two chunks are mutually reachable**, so both roots have the *same* closure:

   ```
   dist/server/index.js      ->  import(`./ssr/index.js`)   (lazy)
   dist/server/ssr/index.js  ->  import(`../index.js`)      (lazy)   <- the cycle
   ```

   Containment holds in **both** directions, so equality is the correct answer, not a defect.

2. **bun's headline "N modules" is not a graph size**, so it should never have been quoted as if it
   distinguished the arms. Three different roots all print 52 under `--compile`, while the module
   list that actually differs — the sourcemap `sources` array, i.e. modules with emitted output —
   is not equal at all:

   | root | `bun --compile` headline | sourcemap `sources` |
   |---|---|---|
   | SSR chunk alone | 52 modules | **20** |
   | RSC entry alone | 52 modules | **50** |
   | bespoke entry (§3.3) | 52 modules | **50** |

   Containment then verifies directly: every module in the SSR-chunk-alone set is in the
   bespoke-entry set except its own entry file, and the bespoke-entry set has **31** the
   SSR-chunk set does not.

`module-count-reconcile.sh` is committed and reproduces all of the above.

---

## 4. What this changes

Findings only; sequencing is the sprint gate's call.

1. **Consequence 11's remedy line — *"Remedy: a vinext fork or upstream PR"* — is mis-aimed, and
   less pessimistic than it looks, but "one defect away" is NOT established.** What *is*
   established: the application **can** be embedded, with SSR working, in a compiled binary today
   (§3.3, Vite-7 arm, container, no `node_modules`), and the **first** failure layer under Vite 8
   is `createRequire(import.meta.url)("react-dom")` in the emitted SSR chunk — mutation-proved in
   §2. That defect is in the **Vite 8 / rolldown** SSR output (or in how vinext configures its SSR
   environment under it), not in vinext's architecture, so a `vinext` **fork** would fork the wrong
   project.

   **What is not established is that one upstream change closes both layers.** §2 replaced that
   `createRequire` call with the chunk's already-present static namespace `(h.default ?? h)` —
   which is precisely the remedy §4.3 proposes upstream — and the resolver error was replaced by
   `TypeError: undefined is not an object (evaluating 'h6.default')`. §5 lists the cause of that
   second layer as **not established**. An earlier draft of this section said the second layer was
   unexplained *and* that embedding was "one upstream defect away", while proposing as the fix the
   transformation it had measured failing. Corrected: **the first layer is established; whether a
   single upstream change closes both is not.** The honest statement of the ask is "file the
   `require("react-dom")` issue and find out", not "it is one patch away".
2. **Consequence 11's stated mechanism needs amending.** It reads *"a dynamic import of a computed
   path is unbundleable by construction, so this is a design property of beta.4's production
   server."* The dynamic import is **not** the blocker: Experiment 1 removed it entirely and the
   defect survived, unchanged in kind. The blocker is `createRequire(import.meta.url)("react-dom")`
   inside the emitted SSR chunk. Same conclusion for beta.4, different cause — and the difference
   is what makes it fixable.
3. **Escalation 2′ / Escalation 3′.** The founder does not need to choose between "fork vinext" and
   "abandon embedding". The open question is much narrower: *is the Vite 8 SSR output's
   `require("react-dom")` intended, and can it be a static import or a `noExternal`?* That is an
   issue to file, with a two-line reproduction (§3.2) and a working Vite-7 control.
4. **Do not read this as "pin an old vinext".** ADR-0042 forbids it, beta.4 peer-requires
   `vite@^8`, and §3.3 shows the old line's `prod-server` is *worse* for compiling. The Vite-7 arm
   is a **diagnostic control**, not a shipping plan.
5. **ADR-0042's container-verification rule should be tightened** (§1.1): rename-the-build-tree is
   not a sufficient negative control for this failure class, because the build host's ancestor
   `node_modules` is what the false green reads. Say *container*, and mutation-prove with
   `node_modules` renamed when a host arm is unavoidable.
6. **`bun --compile` inherits a bespoke-entry requirement twice over.** ADR-0042 already mandates a
   knext-owned entry because of `import.meta.dirname` folding. §3.3 shows the same entry is what
   makes the old line compilable at all. Consequence 4 is load-bearing in more places than it
   claims.

---

## 5. Not established

Listed so absence is not read as a negative result.

- **Why bun leaves the SSR chunk's `react-dom` namespace binding `undefined`** (the second layer,
  §2). Reproduced on both the lazy and the static shape; cause not isolated.
- **Whether `--bytecode` produced bytecode** on any binary here. No extraction was done — this is
  ADR-0042 Phase 3(d)'s item and it is untouched. On the `0.0.19` arm bun **explicitly failed** to
  generate bytecode; on the other arms it emitted no warning, which is not proof.
- **Prerendering on the Vite-7 arm.** §3.3's build was a plain `vinext build`, no `--prerender-all`.
  Whether the prerender + embed + SSR combination all holds together on that line is untested.
- **Whether the Vite-7 arm's app is *correct*, beyond the routes probed.** Nine routes, no compat
  suite. `/isr` returned `cache=MISS` rather than a seeded HIT, as expected without prerendering.
- **Cold start / RSS / throughput of anything here.** Nothing was benchmarked.
- **Whether the Vite 8 behaviour is a Vite bug, a rolldown bug, or vinext's SSR-environment
  configuration under Vite 8.** The measurement localises the boundary; it does not assign fault.
  The vinext repository's history/changelog was **not** reached — only the published npm tarballs.
- **Whether an upstream issue would be accepted**, and by whom.
- **arm64 containers.** All container arms ran emulated `linux/amd64` on Apple Silicon.
- **Nothing was run against a cluster.**
- **Whether ONE upstream change closes both failure layers.** §2 applied the very transformation
  §4.3 proposes upstream and hit the second layer. The first layer's cause is established; the
  sufficiency of fixing it is not. (Previously this doc asserted "one upstream defect away" while
  simultaneously listing the second layer as unexplained — that contradiction is now removed.)
- **Whether the same Vite 7 → 8 boundary holds on `1.0.0-beta.4`.** It cannot be tested the same
  way: beta.4 peer-requires `vite@^8`, so no single-variable arm exists on that version. The
  corrected §3.2/§3.3 tests are on `vinext@0.0.30`, which accepts both.
- **`@vitejs/plugin-react` 5 vs 6 as an independent factor.** The corrected test holds it at 5.2.0
  on both arms, which removes it as a confound but does not measure it. Whether plugin-react 6's
  babel/react-compiler pipeline *also* changes the SSR chunk is untested and not claimed.
- **Anything on the vite-8 arm beyond the nine probed routes**, on either arm. No compat suite ran.

---

## 6. Exact commands

Scripts are committed under
[`spike-vinext-ssr-embed/`](./spike-vinext-ssr-embed/).

```bash
# ---- Experiment 1 ----------------------------------------------------------
node rewrite-ssr-import.mjs <dist>          # asserts each anchor occurs exactly once
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bun-entry-e1.mjs --outfile e1-rewrite-bin      # 140 modules (same as baseline)
# clean dir: binary + dist/client + dist/server/{prerendered-routes,BUILD_ID,vinext-*.json}
#   0 server .js, 0 node_modules; container WORKDIR /opt/knextapp (absent on build host)
docker run --platform=linux/amd64 …
#   -> error: Cannot find package 'react-dom' from '<build-host>/dist-e1/server/ssr/index.js'
#      at STARTUP (baseline fails at first render instead)

# ---- the control that actually goes red (§1.1) -----------------------------
mv pcprobe/dist-e1 pcprobe/dist-e1-MOVED   # host arm STAYS GREEN  <- insufficient control
mv pcprobe/node_modules pcprobe/node_modules-MOVED
#   -> process dies: Cannot find package 'react-dom' from '…/dist-e1/server/ssr/index.js'

# ---- mechanism (§2) --------------------------------------------------------
# bun CAN bundle react-dom, from any directory:
bun build --compile --target=bun-linux-x64-musl ./mech-plain.mjs   # 8 modules -> preload: function
# the vinext SSR chunk ALONE cannot (this is #658's "52 modules and runs" arm --
# it was a build-host false green; in a container it is red):
bun build --compile --target=bun-linux-x64-musl ./mech-ssr.mjs     # headline "52 modules" -- but
#      that headline is NOT a graph size (§3.4); this graph's emitted module list is 20.
#   -> error: Cannot find package 'react-dom' from '…/dist/server/ssr/index.js'
# replace the ONE createRequire call, anchor asserted unique:
#   var t=D(`react-dom`)   ->   var t=(h.default??h)
#   -> resolver error GONE; underlying layer exposed:
#      TypeError: undefined is not an object (evaluating 'h6.default') at loadAndEvaluateModule

# ---- Experiment 2 (§3) -----------------------------------------------------
npm view vinext versions --json                       # 72 versions
bash e2-scan.sh 0.0.0 0.0.1 … 1.0.0-beta.4            # FILES CONTAINING ssr/index.js, 0.0.1 on
bash e2-build-version.sh 0.0.19 "^7.0.0" "^0.5.19" p19   # emits dist/server/ssr/index.js, 245 kB
#   grep createRequire -> 0 ; grep 'X("react-dom")' -> 0

# the single-variable test. e2-vite78.sh is SUPERSEDED -- it varied @vitejs/plugin-react ^5 -> ^6
# alongside vite and printed neither, so its output could not show the confound. Use:
bash e2-vite78-fixed.sh 0.0.30 5.2.0
#   vite=7.3.6  plugin-react=5.2.0  plugin-rsc=0.5.32  require("react-dom")=0  createRequire=0
#   vite=8.2.0  plugin-react=5.2.0  plugin-rsc=0.5.32  require("react-dom")=1  createRequire=2
#   + a full resolved-package diff of the two node_modules trees: the ONLY differing packages
#     are vite and vite's own bundler/CSS closure (rollup+esbuild vs rolldown+lightningcss).

# the bespoke-entry arms (§3.3), re-run single-variable: SAME entry, SAME vinext, only vite varies.
# The container invocation is committed (Dockerfile generated inline) rather than elided:
bash e2e-container-arm.sh "$SC/fix78-0030-vite7" fix7 3441
#   15 modules; asserts clean dir (0 node_modules, 0 server .js) and that /opt/knext-fix7 is
#   ABSENT on the build host, then alpine:3.22 --platform=linux/amd64:
#       / 200 · /blog/{alpha,beta,gamma} 200 · /isr 200 MISS · /img 200 · /api/health 200
#       · /blog/spike-dynamic-not-prerendered 200 · unknown 404
#       /blog/alpha 1565 B: client bundle referenced=true, __VINEXT_RSC_CHUNKS__=true,
#                           markup outside scripts 569 B
bash e2e-container-arm.sh "$SC/fix78-0030-vite8" fix8 3442
#   15 modules; /api/health 200 · unknown 404 · every render 500
#       container log: error: Cannot find package 'react-dom' from
#                      '<build-host>/fix78-0030-vite8/dist/server/ssr/index.js'

# ---- reconciling the two "52 modules" (§3.4) -------------------------------
bash module-count-reconcile.sh
#   dist/server/index.js <-> dist/server/ssr/index.js are MUTUALLY lazy-imported (a cycle),
#   so both roots have the same closure. And bun's headline count is not a graph size:
#     SSR chunk alone   52 modules headline / 20 sourcemap sources
#     RSC entry alone   52 modules headline / 50 sourcemap sources
#     bespoke entry     52 modules headline / 50 sourcemap sources
#   containment verified: SSR-chunk set \ bespoke-entry set = {its own entry file}
```
