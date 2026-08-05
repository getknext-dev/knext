# ADR-0042 Phase 3 — vinext capability blockers: image optimisation, static generation, dev React

**ADR-0042 Phase 3 / action item A4.** Findings only. No shipped code, CRD, CLI, or operator was
modified.

> Filename note: `p3-` in `docs/wayfinder/p3-provisioning-cost.md` means *wayfinder question 3*, not
> ADR-0042 Phase 3. This file is prefixed `adr-0042-` so the two are not conflated.

**Status per question**

| # | Question | Verdict |
|---|---|---|
| 1 | `next/image` optimisation | **Reproduced.** Passthrough confirmed. **vinext exposes no optimizer *registration* hook on the Node target** — two registration paths were built and both failed, for a structural reason. An **interception** path in a knext-owned entry is structurally available and **was not measured here**. |
| 2 | Build-time static generation | **Refuted as a defect — it is a configuration gap, with a hard conflict.** `--prerender-all` works and prerenders `generateStaticParams` routes. It is **mutually exclusive with `output: 'standalone'`**, which is the shape the bun-compile bridge consumes. |
| 3 | Dev React in a production server | **Reproduced.** `react.development.js`, `react-jsx-runtime.development.js` **and** `react-dom.development.js` load in the vinext production standalone server. The Next control loads none. |

---

## Method and environment

**One machine, all arms.** macOS 26.5.2, Apple Silicon arm64 · Node **v24.14.0** · npm.

| Arm | Toolchain | `sharp` |
|---|---|---|
| **A — control** | `next@16.2.11`, Turbopack, `output: 'standalone'`, `react@19.2.8` | declared `^0.34.2`; **resolved version not recorded** |
| **B — vinext** | **`vinext@1.0.0-beta.4` on `vite@8.2.0`**, `react@19.2.8`, `next@16.2.11` present as a peer | **absent** for the §1.1 passthrough measurement; **`0.34.5`, installed by me**, for the §1.3 adapter experiments |

That `sharp` column is the first thing a skeptic should check, because "vinext auto-stubs `sharp`" is
the stated mechanism for the loss. The honest answer is that **arm B's passthrough result in §1.1 was
produced with no `sharp` in the tree at all** — so §1.1 alone cannot distinguish "stubbed" from
"absent". §1.3 closes that: `sharp@0.34.5` was then installed and wired two different ways, and the
passthrough did not change. §1.4 gives the reason, which is neither stubbing nor absence.

**Subject app** — a purpose-built minimal probe rather than `apps/file-manager`, so that each answer
turns on one variable. **Byte-identical `app/` trees in both arms** (§5.1 carries them in full):

- `app/page.tsx` — static
- `app/blog/[slug]/page.tsx` — `generateStaticParams()` returning `alpha`, `beta`, `gamma`
- `app/isr/page.tsx` — `export const revalidate = 60`
- `app/img/page.tsx` — `next/image` on `/knext-optimize-fixture.png`
- `app/api/health/route.ts` — `force-dynamic`
- `public/knext-optimize-fixture.png` — **the same 181,277 B fixture #607 used**, copied from
  `apps/file-manager/public/knext-optimize-fixture.png`

**The probe app and all scripts lived in a machine-local scratch directory that has since been
deleted.** §5 therefore carries every source file **in full**, not by description — for question 3 in
particular the result depends on the probe's semantics, and this document is now the only surviving
record of them.

`curl` is blocked by this repo's hooks, so probes go through the `fetch` scripts in §5.2.

---

## 1. `next/image` — reproduced; no *registration* hook on the Node target

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

### 1.3 Two *registration* paths were built. Both failed.

**Path A — vinext's own `images.optimizer` adapter config.** vinext ships a *runtime-agnostic*
optimizer contract, not a Cloudflare-only one
(`node_modules/vinext/dist/image/image-adapters-virtual.js`):

```
images: { optimizer: { adapter: "<module>", options } }
   → adapter default-exports ({ env, options }) => { transformImage(body, {width, format, quality}) => Promise<Response> }
   → registered via setImageOptimizer() from "vinext/server/image-optimization"
```

I wrote a `sharp`-backed adapter to that contract (§5.3) and configured it in `vite.config.ts`. The
build succeeded and the behaviour did not change: still 181,277 B `image/png` on every `Accept`
variant.

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
plugin support. I wrote that entry (§5.3: set the global, then
`await import('./dist/standalone/server.js')`). Still 181,277 B `image/png`.

Cause:

```
$ grep -c "vinext.imageOptimizer" dist/server/index.js dist/standalone/server.js dist/standalone/dist/server/index.js
dist/standalone/server.js:0
dist/server/index.js:0
dist/standalone/dist/server/index.js:0
```

The symbol never appears in the built server, because the Node production server never reads it.

### 1.4 Why both failed — the structural reason, stated at its true width

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

**The claim this earns, exactly:** on the Node/standalone target — the same target
`bun build --compile --bytecode` consumes — **vinext exposes no optimizer *registration* hook.** It
is not that no optimiser is configured; it is that the code path never asks for one, so neither the
documented config surface nor the `globalThis` seam can reach it.

**The claim it does NOT earn:** that no in-process optimisation is possible. An earlier revision of
this document said "no in-process path exists". **That was an inference from an absence, and it is
withdrawn.** Interception is a different mechanism from registration, and it is structurally
available — verified against a fresh `vinext@1.0.0-beta.4` tarball:

- `dist/standalone/server.js` is a **generated ~15-line shim**
  (`dist/build/standalone.js:105-121`) whose entire body is
  `startProdServer({ port, host, outDir: join(import.meta.dirname, "dist") })`;
- **`./server/prod-server` and `./server/fetch-handler` are public `exports`** of the package;
- `startProdServer` **returns the server**:
  `declare function startProdServer(options?): Promise<{ server: import("node:http").Server; port: number }>`
  (`dist/server/prod-server.d.ts:119-122`).

So a knext-owned entry can call `startProdServer` itself and handle `/_next/image` ahead of vinext's
listener — no fork, no sidecar, no per-app change. **Path B already proved knext can run code inside
that process**; I used that foothold for a registration that does not exist rather than for
interception. And **ADR-0042 Consequence 4 already mandates "a bespoke knext bun entry wrapping
vinext's handler"**, so a blanket "not recoverable in-process" would have contradicted a premise of
the ADR this document is answering.

**Whether interception actually works end-to-end is NOT established here** — it was not built, not
measured, and the open risk is `sharp` as a native module under `bun build --compile`. A separate
spike is measuring it. Nothing in this document should be read as pre-empting that result.

### 1.5 The candidate paths, and what each costs

**None of these was built or measured.** Options with their costs, not recommendations.

| Path | Cost | Assessment |
|---|---|---|
| **In-process interception** — knext entry calls `startProdServer` (public export, returns the `http.Server`) and handles `/_next/image` before vinext's listener | No fork, no extra process, no per-app change. Adds an optimiser dependency (`sharp` or equivalent) to the knext entry; **the open risk is a native module under `bun --compile`.** Structurally verified above; **behaviour unmeasured.** | Cheapest *if* it works, and it is the variant an earlier revision of this document omitted entirely. Being measured by a separate spike. |
| **Patch vinext upstream** — have `prod-server.js` consult `getImageOptimizer()`, as the CF entries do | Small diff (~5 lines), but it is a **fork or an upstream PR** on a beta project with no stability promise. ADR-0042 §7 already names drift as knext's problem. | Cheapest *diff*. Adds a standing dependency on a change knext does not control. |
| **Intercept in front of the process** — knext-owned optimiser in the reverse proxy or a sidecar | New long-lived component that decodes/re-encodes images. This is ADR-0042 Escalation 1 option (c), and `CLAUDE.md` §1 calls that class of scope PaaS drift. | The **expensive** variant of interception. Only worth considering if the in-process variant fails. |
| **Per-component `loader` prop** — vinext's `Image` shim honours `loader` (`shims/image.js:426`) | **`images.loaderFile` is not supported** — `grep loaderFile node_modules/vinext/dist/shims/*.js` → no hits. So it cannot be applied globally from config; it is an edit to **every `<Image>` in every user app**, plus an external optimiser to point at. | Not viable as a framework-level answer. |

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
on both arms. **The probe's exact semantics matter to this result and are in §5.2**: the hook is
installed by a `--require` preload before any application module loads, records the `url` argument
into a `Set` (so the counts are **de-duplicated module identities**, not load events), and the dump
is triggered *after* the three requests complete.

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

1. **ADR-0042 Escalation 1 is narrowed, not closed.** What is settled: the documented config surface
   and the `globalThis` seam are both dead on the Node target, so image optimisation cannot be
   restored by *configuring* vinext. What is **not** settled is whether a knext-owned entry can
   intercept `/_next/image` in-process (§1.4) — that is being measured separately, and until it
   reports, no option should be described as the only one. **Three** candidates preserve ADR-0006
   without a permanent dual track: in-process interception, an upstream patch/fork, and a
   proxy/sidecar. They differ by roughly an order of magnitude in cost and **none has been measured**.
   ADR-0042 option (b) — keep node+turbopack for image apps — remains the only option that needs *no*
   new work, at the price of making dual-track permanent.
2. **Escalation 2 changes shape.** The question is no longer "is losing static generation
   acceptable"; it is "can the artifact that prerenders also be compiled". That is a cheap
   experiment and it should run before the founder is asked anything.
3. **Q3 is a Phase 4/5 blocker as ADR-0042 predicted**, but it is a *dependency-resolution* bug, not
   an architectural loss — the class of thing that can be fixed, unlike (1).

---

## 5. Sources, in full

The scratch directory these lived in has been deleted. Everything needed to rebuild the runs is
below.

### 5.1 The probe app (identical `app/` tree in both arms)

`app/layout.tsx`
```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`
```tsx
export default function Home() {
  return <main>p3-static-home</main>;
}
```

`app/blog/[slug]/page.tsx`
```tsx
export function generateStaticParams() {
  return [{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'gamma' }];
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main>p3-blog-{slug}</main>;
}
```

`app/isr/page.tsx`
```tsx
export const revalidate = 60;

export default function Isr() {
  return <main>p3-isr {new Date().toISOString()}</main>;
}
```

`app/img/page.tsx`
```tsx
import Image from 'next/image';

export default function ImgPage() {
  return (
    <main>
      <Image src="/knext-optimize-fixture.png" alt="fixture" width={640} height={480} />
    </main>
  );
}
```

`app/api/health/route.ts`
```ts
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true });
}
```

`public/knext-optimize-fixture.png` — copied verbatim from
`apps/file-manager/public/knext-optimize-fixture.png` (181,277 B).

**Arm A `next.config.ts`**
```ts
import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Without this, tracing walks up to the monorepo root and .next/standalone/server.js
  // is never emitted at the app root.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
};

export default nextConfig;
```

**Arm B `next.config.ts`** — `{ output: 'standalone' }` for §1 and §2.1/§2.2; `{}` (the field
removed) for the §2.3 prerender run.

**Arm B `vite.config.ts`** — plain for §1.1/§2/§3; with the adapter for §1.3 Path A:
```ts
import { fileURLToPath } from 'node:url';
import vinext from 'vinext';
import { defineConfig } from 'vite';

const optimizerAdapter = fileURLToPath(new URL('./knext-sharp-optimizer.mjs', import.meta.url));

export default defineConfig({
  plugins: [vinext({ images: { optimizer: { adapter: optimizerAdapter } } })],
  ssr: { external: ['sharp'] },
});
```

### 5.2 The probe scripts

`probe.mjs` — status / content-type / byte length. (`curl` is hook-blocked in this repo.)
```js
const [, , url, accept = 'image/avif,image/webp,image/apng,*/*'] = process.argv;

const res = await fetch(url, { headers: { Accept: accept } });
const buf = Buffer.from(await res.arrayBuffer());
console.log(
  JSON.stringify({
    url,
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: buf.length,
    xNextCache: res.headers.get('x-nextjs-cache'),
    vary: res.headers.get('vary'),
  }),
);
```

`headers.mjs` — full response headers (used for §1.2).
```js
const [, , url, accept = 'image/avif,image/webp,*/*'] = process.argv;
const res = await fetch(url, { headers: { Accept: accept } });
const buf = Buffer.from(await res.arrayBuffer());
console.log(res.status, buf.length);
for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
```

`waitup.mjs` — poll until the server answers at all.
```js
const [, , url, timeout = '30000'] = process.argv;
const deadline = Date.now() + Number(timeout);
while (Date.now() < deadline) {
  try {
    await fetch(url);
    console.log('up');
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
console.log('timeout');
process.exit(1);
```

`count-modules.cjs` — **the §3 module census.** Loaded via `--require`, so the hook is installed
before any application module. `registerHooks` sees **both CJS and ESM**; a `Module._load` hook alone
under-counts ESM output by ~2×. The `Set` means the totals are **de-duplicated module identities**,
not load events.
```js
const module_ = require('node:module');
const fs = require('node:fs');

const seen = new Set();
module_.registerHooks({
  load(url, context, nextLoad) {
    seen.add(url);
    return nextLoad(url, context);
  },
});

process.on('SIGUSR2', () => {
  fs.writeFileSync(process.env.MODLIST_OUT || 'modlist.txt', [...seen].sort().join('\n'));
});
```

### 5.3 The two image-recovery attempts

`knext-sharp-optimizer.mjs` — Path A, written to vinext's documented adapter contract.
```js
import sharp from 'sharp';

const EXT = {
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
};

export default function knextSharpOptimizer({ options } = {}) {
  return {
    async transformImage(body, { width, format, quality }) {
      const input = Buffer.from(await new Response(body).arrayBuffer());
      const ext = EXT[format] ?? 'jpeg';
      const out = await sharp(input)
        .resize({ width, withoutEnlargement: true })
        [ext]({ quality, ...(options?.[ext] ?? {}) })
        .toBuffer();
      return new Response(out, { headers: { 'Content-Type': format } });
    },
  };
}
```

`knext-entry.mjs` — Path B, the `globalThis` seam.
```js
import sharp from 'sharp';

const EXT = { 'image/avif': 'avif', 'image/webp': 'webp', 'image/jpeg': 'jpeg' };

globalThis[Symbol.for('vinext.imageOptimizer')] = {
  async transformImage(body, { width, format, quality }) {
    const input = Buffer.from(await new Response(body).arrayBuffer());
    const ext = EXT[format] ?? 'jpeg';
    const out = await sharp(input)
      .resize({ width, withoutEnlargement: true })
      [ext]({ quality })
      .toBuffer();
    return new Response(out, { headers: { 'Content-Type': format } });
  },
};

await import('./dist/standalone/server.js');
```

### 5.4 Exact commands

```bash
# ---- Arm A: control ---------------------------------------------------------
npm i next@16.2.11 react@^19.2.6 react-dom@^19.2.6 sharp@^0.34.2
NODE_ENV=production npx next build
cp -R public .next/standalone/public && cp -R .next/static .next/standalone/.next/static
PORT=3111 NODE_ENV=production node .next/standalone/server.js
find .next/server -name '*.html' | wc -l          # -> 10

# ---- Arm B: vinext ----------------------------------------------------------
npm i -D vinext@1.0.0-beta.4 vite@^8.0.0 @vitejs/plugin-react@^6.0.0 \
         @vitejs/plugin-rsc@^0.5.0 react-server-dom-webpack@^19.2.6
NODE_ENV=production npx vinext build                      # output:'standalone'  -> 0 HTML
NODE_ENV=production npx vinext build --prerender-all      # output:'standalone'  -> 0 HTML (flag ignored)
# remove output:'standalone' from next.config.ts:
NODE_ENV=production npx vinext build --prerender-all      # -> "Prerendered 7 routes (1 skipped)"
find dist -name '*.html' | wc -l                          # -> 7

# ---- image probe ------------------------------------------------------------
node probe.mjs 'http://127.0.0.1:PORT/_next/image?url=%2Fknext-optimize-fixture.png&w=640&q=75'
#   arm A : 200 image/webp 1,880 B      arm B : 200 image/png 181,277 B
node headers.mjs 'http://127.0.0.1:PORT/_next/image?url=...&w=637&q=75'   # -> 400 (handler runs)

# ---- image recovery attempts (both registration-based; both failed) ---------
npm i sharp@^0.34.2                                                      # -> resolved 0.34.5
# Path A: vinext({ images: { optimizer: { adapter: './knext-sharp-optimizer.mjs' } } })
grep -c sharp dist/server/index.js                                       # -> 0  (never wired)
grep -rn generateImageAdaptersModule node_modules/vinext/dist \
  | grep -v image-adapters-virtual.js                                    # -> no callers
# Path B:
PORT=3226 NODE_ENV=production node knext-entry.mjs
grep -c "vinext.imageOptimizer" dist/standalone/server.js dist/server/index.js   # -> 0, 0
# root cause:
sed -n '868,890p' node_modules/vinext/dist/server/prod-server.js         # tryServeStatic, no optimizer

# ---- the interception path (structural check only; NOT measured) ------------
npm pack vinext@1.0.0-beta.4 && tar xzf vinext-1.0.0-beta.4.tgz
sed -n '105,121p' package/dist/build/standalone.js       # generated shim -> startProdServer(...)
sed -n '119,122p' package/dist/server/prod-server.d.ts   # -> Promise<{ server: http.Server; port }>
node -p "Object.keys(JSON.parse(require('fs').readFileSync('package/package.json')).exports) \
  .filter(k => /prod-server|fetch-handler/.test(k)).join(', ')"
#   -> ./server/prod-server, ./server/fetch-handler

# ---- prerender/standalone exclusivity --------------------------------------
sed -n '368,392p' node_modules/vinext/dist/cli.js   # standalone branch process.exit(0)s first

# ---- dev-React probe (CJS + ESM) -------------------------------------------
MODLIST_OUT=modlist.txt NODE_ENV=production PORT=3223 \
  node --require ./count-modules.cjs dist/standalone/server.js &
node waitup.mjs http://127.0.0.1:3223/api/health 40000
node probe.mjs http://127.0.0.1:3223/ ; node probe.mjs http://127.0.0.1:3223/blog/alpha
kill -USR2 $!; grep -i development modlist.txt
#   arm B: 3 hits (react, react-jsx-runtime, react-dom)     arm A: none
```

---

## 6. Not established

Listed so nobody reads absence as a negative result.

- **Whether in-process interception of `/_next/image` works.** Structurally available (§1.4) but not
  built and not measured; the open risk is `sharp` as a native module under `bun build --compile`. A
  separate spike is measuring it. This is the single most consequential open item in this document.
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
- Arm A's **resolved `sharp` version** (declared `^0.34.2`; not recorded at run time).
- Nothing here was run **against a cluster**, per the Phase 3 brief.
