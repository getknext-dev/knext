# P3 — vinext capability blockers: image optimisation, static generation, dev React

**ADR-0042 Phase 3.** Findings only. No shipped code, CRD, CLI, or operator was modified.

**Status per question**

| # | Question | Verdict |
|---|---|---|
| 1 | `next/image` optimisation | **Reproduced.** Passthrough confirmed. **No in-process path exists** on the Node/standalone target; two candidate paths were built and both failed, and the reason is structural. |
| 2 | Build-time static generation | **Refuted as a defect — it is a configuration gap, with a hard conflict.** `--prerender-all` works and prerenders `generateStaticParams` routes. It is **mutually exclusive with `output: 'standalone'`**, which is the shape the bun-compile bridge consumes. |
| 3 | Dev React in a production server | **Reproduced.** `react.development.js`, `react-jsx-runtime.development.js` **and** `react-dom.development.js` load in the vinext production standalone server. The Next control loads none. |

---

## Method and environment

**One machine, all arms.** macOS 26.5.2, Apple Silicon arm64 · Node **v24.14.0** · npm.

| Arm | Toolchain |
|---|---|
| **A — control** | `next@16.2.11`, Turbopack, `output: 'standalone'`, `react@19.2.8`, `sharp@0.34.5` |
| **B — vinext** | **`vinext@1.0.0-beta.4` on `vite@8.2.0`**, `react@19.2.8`, `next@16.2.11` present as a peer |

**Every answer below applies to `vinext@1.0.0-beta.4` + Vite 8.2.0 only.** The older
`vinext@^0.0.19` + `nitro@3.0.1-alpha.2` pin was **not** tested — ADR-0042 forbids shipping it, so
the current combination is the one that decides the flip. Whether the older pin behaves differently
is **not established**.

**Subject app** — a purpose-built minimal probe rather than `apps/file-manager`, so that each answer
turns on one variable. Identical sources in both arms:

- `app/page.tsx` — static
- `app/blog/[slug]/page.tsx` — `generateStaticParams()` returning `alpha`, `beta`, `gamma`
- `app/isr/page.tsx` — `export const revalidate = 60`
- `app/img/page.tsx` — `next/image` on `/knext-optimize-fixture.png`
- `app/api/health/route.ts` — `force-dynamic`
- `public/knext-optimize-fixture.png` — **the same 181,277 B fixture #607 used**
  (`apps/file-manager/public/knext-optimize-fixture.png`)

Reproduction scripts and the app live under `knext-plan-out/` (gitignored, machine-local). They are
listed verbatim in §5 so the runs can be rebuilt from this document alone.

`curl` is blocked by this repo's hooks, so probes go through a 15-line `fetch` script that prints
status, `content-type`, and byte length.

---

## 1. `next/image` — reproduced; no in-process path found

### 1.1 The measurement reproduces

Arm A (control), Next standalone, same fixture, `Accept: image/avif,image/webp,image/apng,*/*`:

```
{"status":200,"contentType":"image/webp","bytes":1880,"xNextCache":"MISS","vary":"Accept"}
{"status":200,"contentType":"image/webp","bytes":1880,"xNextCache":"HIT","vary":"Accept"}   # 2nd hit
raw source: {"status":200,"contentType":"image/png","bytes":181277}
```

Arm B, `node dist/standalone/server.js`:

```
{"status":200,"contentType":"image/png","bytes":181277,"xNextCache":null,"vary":null}
raw source: {"status":200,"contentType":"image/png","bytes":181277}
```

**181,277 B → 181,277 B, byte-for-byte the source.** #607's finding reproduces exactly. The ratio
here is **96×** (1,880 B webp) rather than #607's 112× (1,609 B avif) — this Next build negotiated
webp, not avif, for the same `Accept` header. The ratio differs; the capability difference does not.

### 1.2 The request *does* reach vinext's image handler

This matters, because "the endpoint is unrouted" and "the endpoint is routed but has no optimiser"
imply different fixes. Full headers from arm B:

```
=== /_next/image?...&w=640&q=75 ===
200 181277
  cache-control: public, max-age=3600
  content-disposition: inline
  content-security-policy: script-src 'none'; frame-src 'none'; sandbox;
  content-type: image/png
  x-content-type-options: nosniff
=== /_next/image?...&w=637&q=75   (width not in deviceSizes ∪ imageSizes) ===
400
=== /knext-optimize-fixture.png  (plain static) ===
200 181277
  cache-control: public, max-age=3600
  (no CSP, no content-disposition)
```

The 400 on a disallowed width and the image-specific security headers prove the handler runs. It
validates the request and then serves the original.

### 1.3 Two candidate recovery paths were built. Both failed.

**Path A — vinext's own `images.optimizer` adapter config.** vinext ships a *runtime-agnostic*
optimizer contract, not a Cloudflare-only one
(`node_modules/vinext/dist/image/image-adapters-virtual.js`):

```
images: { optimizer: { adapter: "<module>", options } }
   → adapter default-exports ({ env, options }) => { transformImage(body, {width, format, quality}) => Promise<Response> }
   → registered via setImageOptimizer() from "vinext/server/image-optimization"
```

I wrote a `sharp`-backed adapter to that contract and configured it in `vite.config.ts`. The build
succeeded and the behaviour did not change: still 181,277 B `image/png` on every `Accept` variant.

Cause, from the built artifact and the package:

```
$ grep -c sharp dist/server/index.js
0
$ grep -rn "generateImageAdaptersModule" node_modules/vinext/dist | grep -v image-adapters-virtual.js
(no hits)
```

**The codegen that turns `images.optimizer` into the virtual module has zero callers in the
published beta.4 bundle.** The option is types + dead codegen; the plugin accepts it silently and
emits nothing.

**Path B — the `globalThis` seam.** vinext anchors the optimizer exactly the way ADR-0027 prescribes
(`node_modules/vinext/dist/server/image-optimization.js:241-242`):

```js
const _IMAGE_OPTIMIZER_KEY = Symbol.for("vinext.imageOptimizer");
const _gImageOptimizer = globalThis;
```

so a knext-owned entry could in principle register across the bundled-copy boundary without any
plugin support. I wrote that entry (set the global, then `await import('./dist/standalone/server.js')`).
Still 181,277 B `image/png`.

Cause:

```
$ grep -c "vinext.imageOptimizer" dist/server/index.js dist/standalone/server.js dist/standalone/dist/server/index.js
dist/standalone/server.js:0
dist/server/index.js:0
dist/standalone/dist/server/index.js:0
```

The symbol never appears in the built server, because the Node production server never reads it.

### 1.4 Why both failed — the structural reason

`node_modules/vinext/dist/server/prod-server.js:870-889` — vinext's **Node** production server:

```js
if (isImageOptimizationPath(pathname)) {
    const params = parseImageParams(...);        // validate (this is the 400 above)
    ...                                          // set CSP / nosniff / content-disposition
    if (await tryServeStatic(req, res, clientDir, params.imageUrl, false, staticCache, imageSecurityHeaders)) return;
    res.end("Image not found");
}
```

It never calls `getImageOptimizer()` or `handleConfiguredImageOptimization`. Those appear **only** in
`server/app-router-entry.js:28` and `server/pages-router-entry.js:87` — the Cloudflare Worker
entries, which fetch assets through `env.ASSETS`.

**So on the Node/standalone target there is no registration point at all.** It is not that no
optimiser is configured; it is that the code path never asks for one. That is the same target
`bun build --compile --bytecode` consumes, so the compiled default path inherits it.

### 1.5 What paths remain, and what they cost

Neither of these was built or measured. Stated as options with their cost, not as recommendations.

| Path | Cost | Assessment |
|---|---|---|
| **Patch vinext upstream** — have `prod-server.js` consult `getImageOptimizer()`, as the CF entries do | Small diff (~5 lines), but it is a **fork or an upstream PR** on a beta project with no stability promise. ADR-0042 §7 already names drift as knext's problem. | Cheapest *technically*. Adds a standing upstream dependency on a change knext does not control. |
| **Intercept `/_next/image` in front of vinext** — knext-owned optimiser in the reverse proxy or a sidecar | New long-lived component that decodes/re-encodes images. This is ADR-0042 Escalation 1 option (c), and `CLAUDE.md` §1 calls that class of scope PaaS drift. | Works without touching vinext. Largest new scope. |
| **Per-component `loader` prop** — vinext's `Image` shim honours `loader` (`shims/image.js:426`) | **`images.loaderFile` is not supported** — `grep loaderFile node_modules/vinext/dist/shims/*.js` → no hits. So it cannot be applied globally from config; it is an edit to **every `<Image>` in every user app**, plus an external optimiser to point at. | Not viable as a framework-level answer. |

**No path preserves ADR-0006 on the default path without either forking vinext or building a
knext-owned optimiser.** That is the answer Escalation 1 was waiting for.

---

## 2. Build-time static generation — a configuration gap, and a conflict with standalone

### 2.1 The 0-HTML measurement reproduces, twice

Control, arm A:

```
$ find .next/server -name '*.html' | wc -l
10
.next/server/app/index.html   blog/alpha.html   blog/beta.html   blog/gamma.html
              img.html        isr.html          _not-found.html  _global-error.html
.next/server/pages/404.html   500.html
```

Arm B, `vinext build` with `output: 'standalone'`, exactly as #607 ran it:

```
$ find dist -name '*.html' | wc -l
0
```

**And with `--prerender-all` explicitly passed, still 0** — the build log shows no prerender step at
all. That silent no-op is itself a finding.

### 2.2 The mechanism

`node_modules/vinext/dist/cli.js:370-378`:

```js
if (outputMode === "standalone") {
    const standalone = emitStandaloneOutput({ ... });
    console.log(`  Generated standalone output in ...`);
    return process.exit(0);          // <-- returns BEFORE the prerender block
}
let prerenderResult;
const prerenderDecision = resolveVinextPrerenderDecision({ prerenderAllFlag: parsed.prerenderAll, ... });
if (prerenderDecision) { ... runPrerender ... }
```

**`output: 'standalone'` exits the build before prerendering can run.** The `--prerender-all` flag
and `vinext({ prerender: true })` are parsed, then never consulted. No warning is emitted.

### 2.3 Prerendering itself works

Same app, same toolchain, `output: 'standalone'` removed, `vinext build --prerender-all`:

```
  Pre-rendering all routes...
  Prerendered 7 routes (1 skipped).
  Seeded 7 pre-rendered routes into memory cache
  Discovered 6 CDN warmup path(s).

  Route (app)
  ┌ ○ /          
  ├ λ /api/health
  ├ ƒ /blog/:slug
  ├ ○ /img       
  └ ◐ /isr         (60s)

$ find dist -name '*.html'
dist/server/prerendered-routes/index.html
dist/server/prerendered-routes/blog/alpha.html
dist/server/prerendered-routes/blog/beta.html
dist/server/prerendered-routes/blog/gamma.html
dist/server/prerendered-routes/img.html
dist/server/prerendered-routes/isr.html
dist/server/prerendered-routes/404.html
$ find dist -name '*.rsc' | wc -l
6
```

**7 HTML + 6 `.rsc`.** `generateStaticParams` is honoured — all three `blog/*` slugs are emitted.
The ISR route is prerendered and reported with its 60 s window. So the capability exists and #607's
0 is fully explained by the standalone flag.

Two caveats worth carrying: the route table prints `/blog/:slug` as `ƒ Dynamic` even though its
three params were prerendered, and vinext labels its static classification "confirmed by speculative
prerender (attempted render succeeded without dynamic API usage)" — a different derivation from
Next's, which is a compat-lane question, not a Phase 3 one.

### 2.4 Why this is still a blocker, not a fixed problem

The bridge that ADR-0042 Phase 0 verified compiles **`dist/standalone/server.js`**. That output shape
is precisely the one that cannot prerender. The two capabilities ADR-0042 depends on — a compiled
single-executable artifact, and prerendered HTML for cheap cold paths — are **mutually exclusive in
beta.4**.

**Whether the non-standalone `dist/` layout can be fed to `bun build --compile --bytecode` is NOT
established.** I did not test it. It is the obvious next experiment and it decides whether this is a
scheduling problem or a real loss.

---

## 3. Dev React in production — reproduced

Probe: `module.registerHooks({ load })` in a `--require` preload (sees **both** CJS and ESM), dumped
on `SIGUSR2` after `/api/health`, `/`, and `/blog/alpha` have each returned 200. `NODE_ENV=production`
on both arms.

**Arm B — `node dist/standalone/server.js`:**

```
total modules loaded: 146
development-build modules loaded:
  .../standalone/node_modules/react-dom/cjs/react-dom.development.js
  .../standalone/node_modules/react/cjs/react-jsx-runtime.development.js
  .../standalone/node_modules/react/cjs/react.development.js
```

and the production copies load **as well** — both variants are resident:

```
  react-dom/cjs/react-dom-server-legacy.browser.production.js
  react-dom/cjs/react-dom-server.edge.production.js
  react-dom/cjs/react-dom.production.js
  react/cjs/react-jsx-runtime.production.js
  react/cjs/react.production.js
```

**Arm A — Next standalone, identical probe:**

```
total modules loaded: 489
development-build modules loaded:
  (none)
```

**Reproduced, and differential.** #607 saw `react.development.js` and
`react-jsx-runtime.development.js`; this run adds `react-dom.development.js`.

Two things this does **not** establish, stated rather than inferred:

- **The mechanism is not established.** `react/index.js` is a `NODE_ENV` branch that requires exactly
  one variant, so *both* being resident means at least one loader resolved with `NODE_ENV` not equal
  to `"production"`, or a second module registry resolved it independently. I did not isolate which.
- **The cost is not established.** No boot-time, RSS, or throughput delta was measured between the
  arms for this cause specifically. The claim here is presence, not price.

The static side is clean, which narrows it: `grep -rl "react\.development" dist/standalone/dist` →
no hits, and the minified server bundle contains no `development` string. It is a **runtime
resolution** of the externalised `react` / `react-dom` (both listed in
`dist/server/vinext-externals.json`), not a bundling mistake.

---

## 4. What this means for the flip

Reported as findings. Sequencing is the sprint gate's call, not this document's.

1. **ADR-0042 Escalation 1 now has its answer.** Image optimisation is not recoverable in-process on
   the compiled default path. Every remaining option is a fork, a new knext-owned component, or a
   per-app source change. Option (b) in the ADR — keep node+turbopack for image apps — remains the
   only one that preserves ADR-0006 without new scope, and it makes dual-track permanent.
2. **Escalation 2 changes shape.** The question is no longer "is losing static generation
   acceptable"; it is "can the artifact that prerenders also be compiled". That is a cheap
   experiment and it should run before the founder is asked anything.
3. **Q3 is a Phase 4/5 blocker as ADR-0042 predicted**, but it is a *dependency-resolution* bug, not
   an architectural loss — the class of thing that can be fixed, unlike (1).

---

## 5. Exact commands (reproducible)

```bash
# ---- probe app (identical sources in both arms) -----------------------------
# app/page.tsx, app/blog/[slug]/page.tsx (generateStaticParams -> alpha,beta,gamma),
# app/isr/page.tsx (revalidate = 60), app/img/page.tsx (next/image),
# app/api/health/route.ts (force-dynamic), public/knext-optimize-fixture.png (181,277 B,
# copied from apps/file-manager/public/).

# ---- Arm A: control ---------------------------------------------------------
npm i next@16.2.11 react@^19.2.6 react-dom@^19.2.6 sharp@^0.34.2
# next.config.ts: { output: 'standalone', outputFileTracingRoot: path.resolve(import.meta.dirname) }
#   (without outputFileTracingRoot, tracing walks up to the monorepo root and
#    .next/standalone/server.js is never emitted at the app root)
NODE_ENV=production npx next build
cp -R public .next/standalone/public && cp -R .next/static .next/standalone/.next/static
PORT=3111 NODE_ENV=production node .next/standalone/server.js
find .next/server -name '*.html' | wc -l          # -> 10

# ---- Arm B: vinext ----------------------------------------------------------
npm i -D vinext@1.0.0-beta.4 vite@^8.0.0 @vitejs/plugin-react@^6.0.0 \
         @vitejs/plugin-rsc@^0.5.0 react-server-dom-webpack@^19.2.6
# vite.config.ts: defineConfig({ plugins: [vinext()] })
NODE_ENV=production npx vinext build                      # output:'standalone'  -> 0 HTML
NODE_ENV=production npx vinext build --prerender-all      # output:'standalone'  -> 0 HTML (flag ignored)
# remove output:'standalone' from next.config.ts:
NODE_ENV=production npx vinext build --prerender-all      # -> "Prerendered 7 routes (1 skipped)"
find dist -name '*.html' | wc -l                          # -> 7

# ---- image probe (curl is hook-blocked; 15-line fetch script instead) -------
node probe.mjs 'http://127.0.0.1:PORT/_next/image?url=%2Fknext-optimize-fixture.png&w=640&q=75'
#   arm A : 200 image/webp 1,880 B      arm B : 200 image/png 181,277 B
node headers.mjs 'http://127.0.0.1:PORT/_next/image?url=...&w=637&q=75'   # -> 400 (handler runs)

# ---- image recovery attempts -----------------------------------------------
# Path A: vinext({ images: { optimizer: { adapter: './knext-sharp-optimizer.mjs' } } })
grep -c sharp dist/server/index.js                                       # -> 0  (never wired)
grep -rn generateImageAdaptersModule node_modules/vinext/dist \
  | grep -v image-adapters-virtual.js                                    # -> no callers
# Path B: knext-entry.mjs sets globalThis[Symbol.for('vinext.imageOptimizer')] then imports the server
grep -c "vinext.imageOptimizer" dist/standalone/server.js dist/server/index.js   # -> 0, 0
# root cause:
sed -n '868,890p' node_modules/vinext/dist/server/prod-server.js         # tryServeStatic, no optimizer

# ---- prerender/standalone exclusivity --------------------------------------
sed -n '368,392p' node_modules/vinext/dist/cli.js   # standalone branch process.exit(0)s first

# ---- dev-React probe (CJS + ESM) -------------------------------------------
# count-modules.cjs registers module.registerHooks({load}) into a Set, dumps on SIGUSR2
MODLIST_OUT=modlist.txt NODE_ENV=production PORT=3223 \
  node --require ./count-modules.cjs dist/standalone/server.js &
# ...probe /api/health, /, /blog/alpha... then:
kill -USR2 $!; grep -i development modlist.txt
#   arm B: 3 hits (react, react-jsx-runtime, react-dom)     arm A: none
```

---

## 6. Not established

Listed so nobody reads absence as a negative result.

- Behaviour under **`vinext@^0.0.19` + `nitro@3.0.1-alpha.2`**. Not tested. All three answers above
  are beta.4/Vite-8 answers.
- Whether the **non-standalone `dist/` layout compiles** under `bun build --compile --bytecode`.
  Not tested; this is the pivotal follow-up for question 2.
- The **mechanism** by which both dev and prod React variants load (question 3).
- The **runtime cost** of the dev-React load — no boot/RSS/throughput delta measured.
- Behaviour of any of the three under **`bun`** rather than `node`. Everything here was measured on
  Node v24.14.0 against the uncompiled standalone output; the compiled binary was not built.
- Whether an **upstream patch to `prod-server.js` would be accepted**, and what a knext fork of
  vinext would cost to maintain.
- Nothing here was run **against a cluster**, per the Phase 3 brief.
