# P3a — can the prerendering vinext build be compiled? (ADR-0042 Escalation 2)

**Question, exactly as posed:** can the non-standalone build output (`dist/`, produced with
`--prerender-all` and **without** `output: 'standalone'`) be fed to
`bun build --compile --minify --bytecode` and produce a working self-contained binary that
**serves the prerendered HTML**?

P3 (`adr-0042-p3-vinext-capability-blockers.md` §2.4, §6) flagged this as the cheap experiment to
run before the founder is asked anything, because P3 established that under `vinext@1.0.0-beta.4`
prerendering and the standalone artifact are mutually exclusive.

**Answer: YES, with one material qualification and one correction to ADR-0042.**

- **YES** — the prerendering `dist/` compiles, and the compiled `bun-linux-x64-musl` binary serves
  every prerendered route **byte-identical** to the build output, from an `alpine:3.22` container.
  Prerendering and compiling are **not** mutually exclusive. Escalation 2's premise dissolves.
- **Qualification** — the shape that works is **binary + `dist/` + `node_modules/`**. The app code
  and React are *not* in the binary; vinext's production server `import()`s them off disk at
  runtime. So **none of the app is bytecode-compiled**, and ADR-0042 makes bytecode the mandatory
  objective. "It compiles" ≠ "the app is bytecode".
- **Correction** — `bun build --compile --minify` **constant-folds `import.meta.dirname` to the
  build-host absolute path**. Compiling vinext's own `dist/standalone/server.js` — the shape
  ADR-0042's action items assume — therefore produces a binary that runs **only on the build
  machine**. Measured: exit 1 in a container, and a **false green** on the build host, where it
  serves happily from an *empty* directory by silently reading the build tree.

Environment: bun **1.3.5**, node **v24.14.0**, `vinext@1.0.0-beta.4`, `vite@8.2.0`,
`react@19.2.8` / `react-dom@19.2.8`, darwin 25.5.0 / Apple Silicon, OrbStack Docker 29.4.0.
Container arms ran `--platform=linux/amd64` (emulated; bun warns `CPU lacks AVX support`).
Nothing was run against a cluster. No shipped code, CRD, CLI, or operator was modified.

---

## 1. Baseline reproduced first, exactly as P3 measured it

Same probe app shape as P3: `app/page.tsx`, `app/blog/[slug]/page.tsx` (`generateStaticParams` →
alpha/beta/gamma), `app/isr/page.tsx` (`revalidate = 60`, prints `isr-rendered-at-{Date.now()}`),
`app/img/page.tsx` (`next/image`), `app/api/health/route.ts` (`force-dynamic`), and the same
181,277 B `apps/file-manager/public/knext-optimize-fixture.png`.

| arm | `next.config.ts` | build | `*.html` | `*.rsc` |
|---|---|---|---|---|
| B1 | `output: 'standalone'` | `vinext build --prerender-all` | **0** | **0** |
| B2 | *(no `output`)* | `vinext build --prerender-all` | **7** | **6** |

B2's build log: `Prerendered 7 routes (1 skipped)` / `Seeded 7 pre-rendered routes into memory
cache` / `Discovered 6 CDN warmup path(s)`, route table `○ / · λ /api/health · ƒ /blog/:slug ·
○ /img · ◐ /isr (60s)`, and all three `blog/*` slugs emitted. **P3's baseline matches on the
nose**, including the `ƒ Dynamic` label on the prerendered `/blog/:slug`.

---

## 2. The experiment

`startProdServer` (`node_modules/vinext/dist/server/prod-server.js:634-657`) takes an `outDir`,
derives `rscEntryPath = <outDir>/server/index.js`, `fs.existsSync`-checks it, and then
`import()`s it at runtime (`importServerEntryModule`, :120-122). The non-standalone `dist/` has the
identical layout to the standalone tree's inner `dist/` — so the same entry serves it:

```js
// knext-bun-entry.mjs  (a knext-owned entry; see §5 for why the vinext one cannot be used)
import { dirname, join, resolve } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
const outDir = process.env.VINEXT_OUT_DIR
  ? resolve(process.env.VINEXT_OUT_DIR)
  : join(dirname(process.execPath), "dist");
startProdServer({ port, host, outDir });
```

```bash
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bun-entry.mjs --outfile knext-pc-linux-x64      # 98,095,898 B, 93 modules
```

### 2.1 It serves the prerendered HTML — measured in a container, not on the build host

`alpine:3.22` + `apk add --no-cache libstdc++ libgcc` + binary + `dist/` + `node_modules/`
(**143 MB image**), `docker run --platform=linux/amd64`:

| route | status | `x-vinext-cache` | bytes vs `dist/server/prerendered-routes/*` |
|---|---|---|---|
| `/` | 200 | **HIT** | **IDENTICAL** 8,306 B |
| `/blog/alpha` | 200 | **HIT** | **IDENTICAL** 8,497 B |
| `/blog/beta` | 200 | **HIT** | **IDENTICAL** 8,481 B |
| `/blog/gamma` | 200 | **HIT** | **IDENTICAL** 8,497 B |
| `/isr` | 200 | **HIT** (`s-maxage=60`) | **IDENTICAL** 8,380 B |
| `/img` | 200 | **HIT** | **IDENTICAL** 8,899 B |
| `/api/health` | 200 | — | dynamic, fresh each call |
| `/definitely-not-a-route` | **404** | — | 3,947 B |

Byte-identity is asserted against the files on disk (sha256, full-buffer `Buffer.equals`), so this
is the prerendered artifact, **not** an SSR re-render that happens to look similar.

**ISR revalidates.** `/isr` embeds its render timestamp:

```
t0        200  HIT     sha 9895e85e…   marker 1785934334100   <- build time
t0+65s    200  STALE   sha 9895e85e…   (stale served, background revalidate kicked off)
t0+68s    200  HIT     sha 61de99a4…   marker 1785935310566   <- re-rendered in the container
```

All four acceptance checks in the brief pass: prerendered route serves prerendered bytes, a
`generateStaticParams` slug resolves, ISR serves and revalidates, 404 is correct.

### 2.2 …but the binary is not self-contained, and the app is not bytecode

The 93-module binary contains **vinext's server shell only**:

```
$ grep -ac "prerender-compile-probe" knext-pc-linux-x64     # app route-handler marker
0
$ grep -rl "prerender-compile-probe" dist
dist/server/_next/static/route-BbneRwcp.js                  # app lives in on-disk chunks
```

Remove `node_modules/` and every rendering path collapses while the prerendered ones keep working —
which is exactly the trap, because a smoke test that only hits `/` would pass:

```
[vinext] Server error: error: Cannot find module 'react/jsx-runtime'
         from '…/dist/server/ssr/index.js'
GET /definitely-not-a-route  -> 500   (with node_modules: 404)
```

So on this path `--compile --bytecode` bytecode-compiles vinext's HTTP shell and **nothing of the
application**. ADR-0042's stated objective — *"the compile is required because the bytecode is
mandatory"* — is not met by this artifact. The measured cold-start advantage attributed to
bytecode was established on the `vinext@^0.0.19` + **nitro bun preset** shape
(`.output/server/index.mjs`), where nitro emitted a genuinely bundled entry. beta.4 has no nitro
(ADR-0042 finding 3), so that property does not carry over untested — and this is the test.

---

## 3. Trying to make it genuinely self-contained: how far it gets, and where it stops

Two changes, both spike-local (a patched copy of `prod-server.js` inside the probe's
`node_modules`, never in the repo):

1. `startProdServer({ rscModule })` — accept a **preloaded** app module instead of always
   `import()`ing the path. Three lines:
   `const preloadedRscModule = options.rscModule` · `isAppRouter = preloadedRscModule !== undefined || fs.existsSync(...)` ·
   `const rscModule = preloadedRscModule ?? await importServerEntryModule(rscEntryPath)`.
2. An entry that `import * as rscModule from "./dist/server/index.js"` statically, so bun bundles
   the app.

**Result — the app does embed.** 140 modules (vs 93), 105,529,006 B, and the app marker is now
present (`grep -ac prerender-compile-probe` → **3**, vs 0 before). From a directory containing
**only** the binary + `dist/client` + `dist/server/prerendered-routes` + four manifests
(`BUILD_ID`, `vinext-prerender.json`, `vinext-prerender-paths.json`, `vinext-server.json`) — **no
`node_modules`, no server JS** — it boots, logs `Seeded 7 pre-rendered routes`, and serves all six
prerendered routes byte-identical plus `/api/health`. That is the P0 "binary + `.output/public`"
shape, reached from a prerendering build.

**Where it stops:** every path that actually renders 500s **in the container**:

```
[vinext] Server error: error: Cannot find package 'react-dom'
         from '/private/tmp/.../pcprobe/dist/server/ssr/index.js'
```

The app entry loads the SSR half through `ssrLoader(){return import(`./ssr/index.js`)}` /
`loadSsrHandler(){…}` (two sites in `dist/server/index.js`). Established about this:

- Rewriting both to plain string-literal specifiers **changes nothing** — same 140 modules, same
  failure. (A minimal repro confirms bun *does* normally bundle both literal and template dynamic
  imports reached through a statically-imported dependency, so the rule is not the general one.)
- The SSR chunk **is** in the binary (`handleSsr` present, react-dom's `renderToReadableStream`
  present) — so this is not "bun refused to bundle it".
- Statically importing `./dist/server/ssr/index.js` from the entry as well makes it worse: the
  server now fails at **startup** with the same message.
- Importing the SSR chunk **alone** into a throwaway entry bundles cleanly (52 modules) and runs
  from a clean directory. So the breakage appears only when the RSC entry and the SSR entry are in
  one graph.

**The precise mechanism is NOT established.** What is established is the effect and its shape: with
both vinext entries in one bundle, `react-dom` ends up as a runtime-external reference resolved
against a **build-host absolute path**, and no bun warning is emitted at build time.

---

## 4. The correction to ADR-0042: `import.meta.dirname` is folded to the build host

vinext's emitted standalone wrapper is:

```js
startProdServer({ …, outDir: join(import.meta.dirname, "dist") });
```

Under `bun build --compile --minify --bytecode`, `import.meta.dirname` is **constant-folded at
build time to the real source directory**:

```
$ ./metadir2-bin
bare import.meta.dirname   = /private/tmp/.../scratchpad     <- build host, minified build
join(import.meta.dirname)  = /private/tmp/.../scratchpad/dist
```

(Without `--minify`, the same probe prints `/$bunfs/root` — i.e. the *other* wrong answer. Neither
value is the directory the binary is deployed into.)

Consequences, both measured:

- **False green on the build host.** The compiled standalone wrapper, copied into an *empty*
  directory, starts and serves SSR, dynamic routes and a correct 404 — because it is silently
  reading the original build tree. Renaming that tree turns it into
  `[vinext] No build output found in /private/tmp/.../standalone/dist`. A host-only verification
  would have accepted this artifact.
- **Exit 1 in a container.** Same binary, `alpine:3.22` + `libstdc++`/`libgcc` + the full
  standalone tree at `/srv`: `No build output found in /private/tmp/.../standalone/dist`,
  `Run \`vinext build\` first.`, container exits 1.

So ADR-0042 action items that assume `dist/standalone/server.js` can be handed to
`bun build --compile` are **wrong as written**. A knext-owned entry resolving from
`process.execPath` (or an explicit env var) is required — which is what every arm above used, and
which is consistent with P0 having used "a bespoke bun entry" rather than the framework's own.

---

## 5. What this means for Escalation 2

Reported as findings; sequencing is the sprint gate's call.

1. **The either/or is gone.** Prerendered HTML and a `bun --compile` binary coexist today, verified
   in a container, byte-identical, with ISR revalidating. **Escalation 2 as framed does not need
   the founder.**
2. **A different question takes its place, and it is closer to the ADR's core.** The shipping shape
   that works is binary + `dist/` + `node_modules/` (143 MB image), in which the application runs
   **interpreted from disk** and only vinext's shell is bytecode. If bytecode is mandatory —
   ADR-0042's own words — then this artifact does not deliver the thing the decision was made for,
   and that is a **discovered fact that invalidates the sprint plan's premise**
   (`workflow.md` trigger 5), not a scheduling detail.
3. **Cost of closing the gap.** The rscModule seam is ~3 lines and works. The SSR seam does not
   yield to anything available downstream of vinext: rewriting the specifier, static import, and
   both together all fail, with no build-time diagnostic. Closing it means a **vinext fork or
   upstream PR** — the same class of cost, and the same standing-dependency risk, that P3 §1.5
   reached for image optimisation. Two independent capability gaps now converge on the same
   remedy; that is worth weighing as one decision rather than two.
4. **A verification rule falls out of §4, and it is cheap.** Any `bun --compile` artifact must be
   validated **in a container**, never only on the build host — the build-host run is not a weaker
   test, it is a test that can pass for a reason that guarantees production failure.

---

## 6. Exact commands (reproducible)

```bash
# ---- probe app (same shape as P3) ------------------------------------------
npm i vinext@1.0.0-beta.4 vite@^8.0.0 @vitejs/plugin-react@^6.0.0 \
      @vitejs/plugin-rsc@^0.5.0 react@^19.2.6 react-dom@^19.2.6 \
      react-server-dom-webpack@^19.2.6
# vite.config.ts: import vinext from "vinext"; defineConfig({ plugins: [vinext()] })
#   (NOT "vinext/vite" — beta.4 has no such subpath export; it default-exports the plugin)

# ---- baseline --------------------------------------------------------------
# next.config.ts = { output: 'standalone' }
NODE_ENV=production npx vinext build --prerender-all
find dist -name '*.html' | wc -l                       # -> 0     (B1 reproduced)
# next.config.ts = {}
NODE_ENV=production npx vinext build --prerender-all
find dist -name '*.html' | wc -l                       # -> 7     (B2 reproduced)
find dist -name '*.rsc'  | wc -l                       # -> 6

# ---- the experiment --------------------------------------------------------
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bun-entry.mjs --outfile knext-pc-linux-x64        # 93 modules,  98,095,898 B
# alpine:3.22 + `apk add --no-cache libstdc++ libgcc` + app + dist + node_modules
docker build --platform=linux/amd64 -t knext-pc-full:musl . # image 143 MB
docker run -d --platform=linux/amd64 -p 3332:3000 knext-pc-full:musl
node probe-routes.mjs      http://127.0.0.1:3332 / /blog/alpha … # all HIT, 404 correct
node compare-prerender.mjs http://127.0.0.1:3332 ./dist/server/prerendered-routes
#   -> IDENTICAL on all six
node isr-test.mjs          http://127.0.0.1:3332 65              # HIT -> STALE -> HIT(new bytes)

# ---- app is not in the binary ---------------------------------------------
grep -ac "prerender-compile-probe" knext-pc-linux-x64            # -> 0
grep -rl "prerender-compile-probe" dist                          # -> dist/server/_next/static/route-*.js
# and with node_modules removed:
#   [vinext] Server error: Cannot find module 'react/jsx-runtime' from …/dist/server/ssr/index.js
#   GET /definitely-not-a-route -> 500

# ---- self-contained attempt (spike-local prod-server patch) ----------------
# prod-server.js: accept options.rscModule, use it instead of importServerEntryModule()
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bun-entry-embedded.mjs --outfile knext-emb-linux-x64   # 140 modules, 105,529,006 B
grep -ac "prerender-compile-probe" knext-emb-linux-x64           # -> 3   (app embedded)
# clean dir = binary + dist/client + dist/server/{prerendered-routes,BUILD_ID,vinext-*.json}
#   -> prerendered routes HIT + byte-identical, /api/health 200
#   -> container: every SSR path 500,
#      "Cannot find package 'react-dom' from <build-host path>/dist/server/ssr/index.js"

# ---- import.meta.dirname folding ------------------------------------------
bun build --compile --minify --bytecode ./metadir2.mjs --outfile metadir2-bin && ./metadir2-bin
#   -> /private/tmp/.../scratchpad          (build host; /$bunfs/root without --minify)
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./dist/standalone/server.js --outfile knext-sa-linux-x64
docker run --platform=linux/amd64 …          # -> "No build output found in <build-host path>", exit 1
```

---

## 7. Not established

Listed so absence is not read as a negative result.

- **The mechanism** by which `react-dom` becomes a build-host-path external once the RSC and SSR
  entries share one bun graph. Effect reproduced four ways; cause not isolated.
- **Cold start / RSS / throughput** of any arm here. Nothing was benchmarked; this experiment
  answers a capability question only. In particular the *value* of bytecode-for-the-shell-only is
  unmeasured — it may be small or may be most of the win.
- **Whether `--bytecode` produced bytecode** for the cross-compiled musl targets was not verified
  by extracting the binary, as ADR-0036 Run 26 did. Bun emitted no warning; that is not proof.
- **`vinext@^0.0.19` + `nitro@3.0.1-alpha.2`.** Untested here, as in P3. Everything above is a
  beta.4 / Vite-8 answer.
- **Whether an upstream vinext PR for the two seams (§3) would be accepted**, and the maintenance
  cost of a knext fork.
- **arm64 containers.** All container arms ran emulated `linux/amd64` on Apple Silicon; bun warns
  `CPU lacks AVX support, strange crashes may occur`. No crash was observed, but the emulated arm
  is not the ship environment.
- **Nothing was run against a cluster**, per the brief.
