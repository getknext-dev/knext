# V2 — Is the Next.js build heavier and Vercel-specific, and is vinext better?

> Wayfinder ticket **#607** (child of map **#605**).
> **Measurement date: 2026-08-03.** Every number below was produced on this machine by the exact
> commands in §9. Nothing is quoted from memory, a changelog, or a benchmark someone else ran.
> Where something could not be measured it says **not measured** rather than being estimated.

## The claim under test

> *"the nextjs build is heavier and vercel specific; vinext seems to be better compared to next
> standalone build."*

Three separable claims. Measured separately, they do not all land the same way:

| Claim | Verdict |
|---|---|
| The Next.js build is **heavier** | **Partly true, and mostly self-inflicted.** True against knext's *current* `--webpack` build. Against `next build` on Turbopack — same Next version, one flag different — the shipped artifact is **44.22 MB vs vinext's 37.14 MB**, and once you hold *capability* constant (vinext does no image optimisation) Next is **28.36 MB vs vinext's 37.14 MB**, i.e. **vinext is 31% larger**. |
| The Next.js build is **Vercel-specific** | **Not established — the evidence runs the other way.** The Next standalone artifact ships **zero** `@vercel/*` runtime packages, **zero** `process.env.VERCEL*` reads and **zero** `x-vercel-*` header handling. The vinext artifact ships **`@vercel/og` and its 14.50 MB dependency stack unconditionally** — 39% of everything it ships — for an app that uses no OG images. |
| vinext is **better** than next standalone | **Better on three axes, worse or absent on four.** It boots ~2.2× faster and its cold import graph is 3.2× smaller — which is real, and is the one place the intuition is substantiated. It also does no image optimisation, no build-time static generation, and ignores the official Deployment Adapter API that knext's north star is built on. |

---

## 1. Subject app and why

**`apps/file-manager`.** It is the canonical knext demo: it is what the repo's `Dockerfile` builds,
what the OKE deployments run, and the only app that exercises every knext integration at once —
Redis `cacheHandler`, the official `adapterPath` adapter, OTel instrumentation, `sharp` image
optimisation, `middleware`, `deploymentId` skew protection, `assetPrefix`, and the `knext-smoke/isr`
ISR route. 25 pages, 2 layouts, 8 route handlers.

`apps/db-demo` was rejected: it has five runtime dependencies (`@getknext/db`, `@getknext/lib`,
`next`, `react`, `react-dom`) and no adapter/cache/image/OTel wiring. A weight comparison on it
would mostly measure `next` and `react` and say nothing about knext.

**Environment** (one machine, all arms, nothing else running during timed runs):
macOS 26.5.2, Apple Silicon arm64, 32 GB RAM · Node **v24.14.0** · pnpm **10.4.1** ·
Next **16.2.10** · vinext **1.0.0-beta.4** on Vite **8.2.0** (rolldown) · Docker/OrbStack 29.4.0
(linux/arm64).

**Three arms, not two.** The ticket asked for two. A third was added after the first result,
because comparing vinext against knext's `--webpack` pin would have attributed a knext
configuration choice to Next.js:

| Arm | Command | Why |
|---|---|---|
| **A — webpack** | `next build --webpack` | What knext ships today (`apps/file-manager/package.json:8`, and what the `Dockerfile` runs) |
| **A′ — Turbopack** | `next build` | Control. Same Next, same config, same app; the only difference is the bundler. |
| **B — vinext** | `vinext build` | The alternative under test |

---

## 2. Headline: what is actually shipped

Apparent byte totals (`stat -f %z` summed over regular files — not `du`, which rounds to 4 KB
blocks and so penalises whichever arm has more small files; vinext has 42% more files, so `du`
would have flattered Next by ~3 MB).

| | **A — webpack** | **A′ — Turbopack** | **B — vinext** |
|---|---:|---:|---:|
| standalone dir | 50.83 MB / 2,393 files | 43.21 MB / 2,263 | 37.14 MB / 3,490 |
| client assets (`.next/static`) | 1.05 MB / 64 | 0.83 MB / 29 | *(inside standalone)* |
| `public/` | 0.18 MB / 7 | 0.18 MB / 7 | *(inside standalone, 0.18 MB)* |
| **TOTAL SHIPPED** | **52.05 MB / 2,464** | **44.22 MB / 2,299** | **37.14 MB / 3,490** |
| runtime `node_modules` | 42.19 MB / 2,095 | 31.41 MB / 1,499 | 33.65 MB / 3,286 |
| app's own server code | 8.58 MB / 282 | 8.94 MB / 609 | 3.31 MB / 195 |
| installed runtime packages | 47 | 51 | 97 |
| …plus packages vendored inside `next/dist/compiled` | 112 | 153 | 0 |

**Raw:** vinext ships 28.7% less than arm A, 16.0% less than arm A′.

### The normalisation that changes the answer

Arm A/A′ ship `sharp` + `@img/sharp-libvips` — **15.85 MB**, 30% of arm A's entire artifact — and
that buys a working image optimiser (§5). vinext ships no image optimiser at all. Subtracting it
from Next so both arms describe the same capability:

| At image-optimisation parity | shipped |
|---|---:|
| A — webpack, minus sharp | 36.20 MB |
| **A′ — Turbopack, minus sharp** | **28.36 MB** |
| **B — vinext** (never had one) | **37.14 MB** |

**vinext is +2.6% against arm A and +31.0% against arm A′.** The "heavier" result is entirely
produced by (a) knext's `--webpack` pin and (b) counting a capability vinext does not have.

### Dead weight, both sides

Neither framework looks good here, and the two piles are comparable:

- **Arm A** ships 13.36 MB of vendored packages in `next/dist/compiled`. Instrumenting the boot
  (§6) shows **2.04 MB across 25 files is actually loaded** — **11.3 MB never executes**. Arm A′
  cuts this to 4.21 MB, one of the two reasons its artifact is 7.8 MB lighter (the other: Turbopack
  bundles Next's server runtime into the app chunks, so the traced `next` package drops from
  22.78 MB to 12.84 MB, and `caniuse-lite` — 2.38 MB — disappears from the runtime closure).
- **Arm B** ships **14.50 MB** of `@vercel/og` and its transitive OG-rendering stack — `satori`,
  `@shuding/opentype.js`, `@resvg/resvg-wasm`, `yoga-layout`, `linebreak`, `pako`, `fflate`,
  `unicode-trie`, `tiny-inflate` and ten `css-*` helpers. `@vercel/og` is a hard entry in vinext's
  own `dependencies`. **The app imports no `next/og` and zero of those files load at boot.**
  That is **39.0% of everything the vinext arm ships**.

---

## 3. Build cost

| | **A — webpack** | **A′ — Turbopack** | **B — vinext** |
|---|---:|---:|---:|
| cold build, wall clock | **31.19 s** | **17.15 s** | **16.84 s** |
| cold build, peak RSS | 1,354 MiB | 1,160 MiB | **792 MiB** |
| warm rebuild, wall clock | 20.13 s | 17.45 s | **4.96 s** |
| warm rebuild, peak RSS | 1,204 MiB | 1,064 MiB | 820 MiB |
| build dir on disk | **401.29 MB** | 85.13 MB | **40.45 MB** |
| …of which build cache | 338.94 MB (`.next/cache`) | 0.55 MB | 0.14 MB (`.vinext`) |

Reading these honestly:

- **Cold build wall clock: the gap is a webpack gap, not a Next gap.** 17.15 s vs 16.84 s is a
  1.8% difference — inside run-to-run noise. The 1.85× advantage vinext appears to have over arm A
  is knext's `--webpack` flag, recoverable without changing framework.
- **Peak build memory is a genuine Next cost.** 792 MiB vs 1,160 MiB (1.46×) survives the
  Turbopack control.
- **Warm rebuild is a genuine vinext win.** 4.96 s vs 17.45 s (3.5×) — Turbopack's persistent cache
  is nearly empty here (0.55 MB) so it barely beats its own cold build.
- **Arm A's 338.94 MB webpack cache is a local-disk and CI-cache cost, not a shipped cost.** It is
  8× the *entire* vinext build directory. Turbopack removes it.

`/usr/bin/time -l` reports the maximum RSS of the process and its waited-for children; for a
multi-worker build this is the largest single worker, not the sum. It under-reports all three arms
in the same direction.

---

## 4. Container images

Two comparisons: a controlled one that isolates the artifact, and the real one.

**Controlled** — identical digest-pinned base (`node:22-alpine@sha256:16e22a5…`), identical
`apk upgrade + curl`, identical npm/corepack strip, `COPY` the arm's artifact, nothing else:

| | image total | app payload layer |
|---|---:|---:|
| A — webpack | 211.2 MB | 54.6 MB |
| A′ — Turbopack | 203.2 MB | 46.2 MB |
| B — vinext | **196.3 MB** | **38.9 MB** |

Shared base + apk is 156.6 / 157.0 / 157.4 MB — identical to within layer-rounding. The payload
deltas track §2: the 15.7 MB between arm A
and arm B is, to within rounding, the sharp stack.

**Real** — the repo's own `apps/file-manager/Dockerfile`, built end-to-end (pnpm install →
lib→db→core→app build → musl sharp → baked V8 compile cache), arm A: **381.7 MB**. Its layers:

| layer | size |
|---|---:|
| base `node:22-alpine` + entrypoint | ~150 MB |
| `apk upgrade && apk add curl vips` | 56.9 MB |
| `COPY .next/standalone` | **73.8 MB** |
| `COPY /knext-core-runtime` (`pnpm deploy --prod` of `@getknext/core`) | **63.7 MB** |
| `COPY /sharp-runtime/node_modules` (musl sharp) | 29.3 MB |
| baked V8 compile cache (`warm-compile-cache.sh`) | 14.4 MB |
| `.next/static` + `public` | 1.3 MB |

**The Next build output is 19% of the production image.** 164 MB — 43% — is knext's own packaging:
the self-contained `@getknext/core` runtime, the second musl `sharp` install, the `vips` apk, and
the baked compile cache. **No change of build tool touches any of it.** If image size is the
motivation, the largest single lever available today is the 63.7 MB `@getknext/core` deploy layer,
not the bundler.

Note the musl sharp costs **29.3 MB** in the real linux image versus the 15.85 MB darwin build
measured in §2 — so on the platform that actually ships, the image-optimisation capability that
arm B lacks is worth roughly twice what §2 credits it.

---

## 5. What each arm can actually do

Both servers boot and serve. 21 routes probed against each; **both** returned 200 on all of them
except `GET /api/rum` → 405, which is correct in both (the route is POST-only). Arm A′ was probed
on 18 routes, all 200. On that basis the artifacts are comparable — but four capabilities are not.

| | A / A′ | B — vinext |
|---|---|---|
| **Image optimisation** | `/_next/image` → **200, `image/avif`, 181,277 B → 1,609 B** (112×) | **200, `image/png`, 181,277 B — byte-for-byte the source.** Passthrough. |
| **Build-time static generation** | **15 routes prerendered, 14 HTML files** incl. `knext-smoke/isr.html` | **0 prerendered HTML** |
| **Official Deployment Adapter API** | `adapterPath` honoured; build log: `Running onBuildComplete from knext-adapter` | **0 references to `adapterPath` / `next-adapter` anywhere in the output.** Silently ignored. |
| **Production React** | production builds | loads **`react/cjs/react.development.js`** and `react-jsx-runtime.development.js` in the production standalone server |

`vinext check` states the image position itself: optimisation is available *"via `images.optimizer`
(Cloudflare Images), passthrough otherwise"*. On Node/Knative there is no optimiser. knext treats
image optimisation as shipped and required (ADR-0006; `CLAUDE.md` §9).

The adapter row is the one that matters most for knext. `architecture.md` §4 makes the official
Deployment Adapter API the default and only all-apps-verified path, and `CLAUDE.md` §3 makes
verified-adapter status the north star. vinext does not implement it — consistent with what V1
(#606) found in Cloudflare's own announcement. A vinext build is not an adapter build.

**What did survive in arm B**, and is worth crediting: the Redis `cacheHandler` (its `[Cache] MISS`
lines appear in the vinext boot log), `assetPrefix`, `deploymentId`, `instrumentation`, and
`middleware`/proxy all carried over, and every probed route rendered.

---

## 6. Cold import graph and boot

Measured with `module.registerHooks()` (Node ≥22.15), which sees **both CJS and ESM** loads — this
matters because arm B's output is ESM and a `Module._load` hook alone under-counts it by ~2×.
Graph is captured at first 200 on `/api/health`.

| | A — webpack | A′ — Turbopack | B — vinext |
|---|---:|---:|---:|
| modules loaded at boot | 612 | 795 | **299** |
| files on disk | 574 | 757 | **271** |
| **bytes of source read** | **11.15 MB** | 10.85 MB | **3.47 MB** |
| after 4 more routes rendered | unchanged (eager) | not measured | 338 / 310 / 4.29 MB (lazy) |

Arm A's boot graph by origin: app chunks 6.31 MB (59 files), `next/dist/server` 1.26 MB (205),
`next/dist/compiled` 2.04 MB (25). Its single largest boot module is `.next/server/chunks/7627.js`
at 1.85 MB — that is **`@vercel/otel`**, which knext put in `apps/file-manager/package.json`, not
something Next added.

**Cold boot to first 200 on `/api/health`** (dependency-free route; median of 5 runs, quiet
machine, warm page cache):

| | plain | with `NODE_COMPILE_CACHE` |
|---|---:|---:|
| A — webpack | 578 ms | 488 ms |
| A′ — Turbopack | 603 ms | 521 ms |
| **B — vinext** | **262 ms** | 283 ms |

**This is the one place the founder's intuition is squarely substantiated.** vinext boots ~2.2×
faster, and it is the same ordering ADR-0036 was written around. Two caveats stated rather than
buried: `NODE_COMPILE_CACHE` gave vinext nothing (283 ms vs 262 ms — noise or slightly worse), and
Turbopack's much smaller artifact bought **no** boot improvement, so artifact size and boot time
are not the same lever. Time to first *rendered page* was **not measured cleanly** — with no
Postgres or Redis running, both arms spent ~8 s in connection timeouts on `/`, which measures the
absent dependencies, not the framework.

---

## 7. The Vercel-specificity claim, in detail

This was the part of the premise most worth checking against artifacts rather than asserting.

### Arm A / A′ — Next standalone

- **`@vercel/*` npm packages in the runtime closure: zero.** The single hit is
  `next/dist/compiled/@vercel/nft` (0.26 MB) — `node-file-trace`, MIT, Vercel-authored open source,
  used by `next build` to compute the standalone trace. It is vendored *build* tooling that landed
  in the runtime tree; the server never loads it.
- **`process.env.VERCEL*` reads in the shipped `next/dist`: zero.**
- **`x-vercel-*` header handling in the shipped `next/dist`: zero.**
- Every remaining occurrence of the string "vercel" in shipped `next/dist` — 39 files — is a
  **`github.com/vercel/next.js/…` URL** in a comment or error message: 11 `/pull/`, 8 `/issues/`,
  5 `/issues/new/`, 3 `/blob/`, 2 `/discussions/`, 3 `vercel/og` doc links, 2
  `vercel/turbopack-ecmascript-runtime`, 1 `vercel.sh`, plus one identifier `vercelImageGeneration`.
  That is a repository name in a hyperlink, not platform coupling.
- The one genuinely Vercel-branded runtime component in arm A's output is **`@vercel/otel@2.1.1`,
  which knext itself declares** in `apps/file-manager/package.json:26`. MIT, a thin wrapper over
  standard OpenTelemetry, `node`/`edge`/`workerd` export conditions, runs anywhere. It is arm A's
  largest boot module (1.85 MB). If anyone wants to remove Vercel-named code from the knext runtime,
  **this is the only item on the list, and it is knext's own dependency.**

### Arm B — vinext

- Ships **`@vercel/og`** as a declared runtime dependency of `vinext` itself, plus its transitive
  OG stack: **14.50 MB, 39.0% of the entire artifact**, for an app with no OG images and with none
  of it loaded at boot.

**The comparison inverts the premise.** Measured by Vercel-authored code actually present in the
shipped artifact, the vinext arm ships **more**, not less.

---

## 8. What these numbers do and do not establish

**They establish:**

1. Most of the "heavier" gap against arm A is knext's own `--webpack` pin. Turbopack recovers
   7.83 MB of artifact, 14.0 s of cold build, 338 MB of build cache, and 10.78 MB of traced
   runtime `node_modules` (42.19 → 31.41 MB; `caniuse-lite` leaves the runtime closure entirely),
   at zero framework risk — **and the resulting build is fully functional here**:
   18/18 routes 200, 14 pages prerendered, image optimisation working.
2. At capability parity, vinext's artifact is **not** smaller than a Turbopack standalone build —
   it is 31% larger.
3. The Vercel-specificity claim does not hold for the Next standalone artifact, and holds against
   vinext instead.
4. vinext's boot advantage is real and substantial (~2.2×), driven by a 3.2× smaller cold import
   graph. This is the measured fact that supports ADR-0036's motivation — and it is about **boot**,
   not about **build weight**.
5. Container-image weight is dominated by knext's own packaging (43% of the production image),
   which no build-tool change addresses.

**They do not establish:**

- **That arm B is production-viable for knext.** It is not, today: no image optimisation, no
  build-time static generation, no adapter API, dev React in the production server. Those are
  capability gaps, and three of them are the reason arm B's artifact is small.
- **That Turbopack is safe to adopt as knext's default.** One clean build on one app on one machine
  is not the compat gate. The `--webpack` pin has a stated reason (`next.config.ts`: Turbopack
  bundling `pino-elasticsearch`/`thread-stream` test files) and `serverExternalPackages` currently
  works around it. Switching the default is a hard-rule-adjacent change and belongs behind the
  compatibility suite, not behind this document.
- **Anything about linux/musl or about Knative.** All timings are macOS/arm64 with a warm page
  cache. The 262 ms and 578 ms figures are **not** comparable to the ~1957 ms OKE cold-start floor
  in `CLAUDE.md` §3 / ADR-0036; different kernel, different filesystem, no container, no scheduler.
  The *ordering* is evidence; the *magnitudes* are not transferable.
- **Anything about first-render latency**, which is what a scale-to-zero user actually feels. Not
  measured cleanly (no Postgres/Redis in this environment).
- **That arm B's 37.14 MB is a floor.** 14.50 MB of it is an unused OG stack that a future vinext
  could make optional; equally, 11.3 MB of arm A's `dist/compiled` never executes.
- **Reproducibility across machines.** Single-machine, single-run for build wall clock (n=1 per
  arm) and n=5 for boot. The build numbers should not be quoted to two significant figures.

---

## 9. Exact commands (reproducible)

Arm B was built in an **isolated git worktree** so the main tree was never modified. It required
dependency bumps the repo has not made — `react`/`react-dom` 19.2.4 → 19.2.6 and `vite` → 8.2.0
(vinext 1.0.0-beta.4 peers on `vite@^8`; its first build against the workspace's vite 7.3.6 died
with `SyntaxError: The requested module 'vite' does not provide an export named 'parseSync'`).

```bash
# ---- Arm A: next build --webpack (knext's current path) --------------------
cd apps/file-manager
mv .next /tmp/attic/                       # cold build
/usr/bin/time -l pnpm exec next build --webpack

# ---- Arm A': Turbopack control ---------------------------------------------
mv .next /tmp/attic/next-webpack-build
/usr/bin/time -l pnpm exec next build

# ---- Arm B: vinext ----------------------------------------------------------
git worktree add ../knext-v2-vinext --detach HEAD
cd ../knext-v2-vinext
pnpm install --frozen-lockfile
pnpm --filter "@getknext/lib" build && pnpm --filter "@getknext/db" build \
  && pnpm --filter "@getknext/core" build
cd apps/file-manager
npx vinext@1.0.0-beta.4 check                       # -> 88% compatible
pnpm add -D vinext@1.0.0-beta.4 @vitejs/plugin-rsc react-server-dom-webpack
pnpm add react@^19.2.6 react-dom@^19.2.6
pnpm add -D vite@^8.0.0 @vitejs/plugin-react@^6.0.0
printf "import vinext from 'vinext';\nimport { defineConfig } from 'vite';\n\
export default defineConfig({ plugins: [vinext()] });\n" > vite.config.ts
/usr/bin/time -l pnpm exec vinext build

# ---- artifact size: apparent bytes, not du ---------------------------------
find <dir> -type f -print0 | xargs -0 stat -f '%z' | awk '{s+=$1;n++} END {print s, n}'

# ---- runtime package closure (excluding next/dist/compiled vendored stubs) --
find <standalone> -name package.json -path '*node_modules*' | grep -v '/dist/compiled/' \
  | xargs -n1 node -e 'const p=require(process.argv[1]); p.name&&p.version&&console.log(p.name)' \
  | sort -u | wc -l

# ---- cold import graph (CJS *and* ESM) --------------------------------------
# preload registers module.registerHooks({load}) into a Set, dumps on SIGUSR2:
MODLIST_OUT=/tmp/modlist.txt PORT=3000 NODE_ENV=production \
  node --require ./count-modules.cjs server.js &
until curl -sf -o /dev/null localhost:3000/api/health; do sleep 0.05; done
kill -USR2 $!

# ---- image optimisation probe ----------------------------------------------
curl -s -o /tmp/o.bin -D - -H 'Accept: image/avif,image/webp,*/*' \
  'http://127.0.0.1:PORT/_next/image?url=%2Fknext-optimize-fixture.png&w=640&q=75'
#  source: 181,277 B   arm A/A': 1,609 B image/avif   arm B: 181,277 B image/png

# ---- Vercel-specificity audit ----------------------------------------------
grep -ril 'vercel' <standalone> --include='*.js' | grep -v 'compiled/@vercel'
grep -rho 'process\.env\.VERCEL[A-Z_]*' <next>/dist   # arm A: 0 hits
grep -rio 'x-vercel-[a-z-]*'            <next>/dist   # arm A: 0 hits

# ---- container images -------------------------------------------------------
docker build -f apps/file-manager/Dockerfile -t v2bench/next-standalone .   # 381.7 MB
docker build -t v2bench/nextmin       /tmp/nextctx    # same base, COPY payload -> 211.2 MB
docker build -t v2bench/nextmin-turbo /tmp/tpctx      #                          -> 203.2 MB
docker build -t v2bench/vinext-min    /tmp/vinctx     #                          -> 196.3 MB
docker image inspect <tag> --format '{{.Size}}'
docker history <tag> --format '{{.Size}}\t{{.CreatedBy}}'
```

`vinext check` full result, for the record: **88% compatible** — 14 supported, 2 partial
(`next/font/google` loads from CDN rather than self-hosting; `images` optimisation only via
Cloudflare Images), 1 issue (`__dirname`/`__filename` in two `scripts/*.mjs` files, which are
tooling, not app code).

---

## 10. If the goal is a lighter knext, in measured order of payoff

Stated as findings, not as a plan — sequencing is the sprint planning gate's call.

| Lever | Measured payoff | Risk |
|---|---|---|
| `@getknext/core` `pnpm deploy --prod` layer | **63.7 MB** of the production image | packaging only; no runtime change |
| `apk add vips` (musl sharp already bundles libvips; the `Dockerfile` keeps it as a "defensive fallback") | part of a 56.9 MB layer — **not separately measured** | needs a probe before removing |
| `next build --webpack` → Turbopack | **7.83 MB** artifact, **14.0 s** cold build, **338 MB** build cache | compat-gate work; a stated `pino-elasticsearch` reason exists |
| Drop `@vercel/otel` for direct OTel SDK wiring | 1.85 MB, and the *only* Vercel-branded runtime code in the artifact | app-level change |
| Switch build tool to vinext | **−0 MB at capability parity** (in fact +8.8 MB vs Turbopack); **−316 ms boot** | loses image optimisation, static generation, and the adapter API |
