# P3 — Can a knext-owned bun entry recover `next/image` under vinext, in-process?

**ADR-0042 Escalation 1 / Consequence 1.** Investigation only: no shipped code, CRD, CLI or
operator was touched, and nothing was run against a cluster. Artifacts for reproduction are in
`docs/wayfinder/spike-vinext-image-intercept/`.

## Answer

| # | Question | Verdict |
|---|---|---|
| 1 | Interception returns an **optimised** image, not the passthrough | **YES** |
| 2 | Delegation intact — SSR, route handler, dynamic route, 404 | **YES** (byte-identical to unmodified vinext) |
| 3 | Survives `bun build --compile --minify --bytecode` | **YES with WASM codecs. NO with `sharp`** — and the `sharp` failure is structural |
| 4 | The optimisation itself is correct | **YES for `w`, `q`, `Accept`, and invalid-param rejection.** Two real gaps: no cache at all, and one format-negotiation delta vs Next |

**Phase 3's conclusion that image optimisation is "not recoverable in-process" does not hold.** The
reviewer's correction is the right one: what Phase 3 established is that vinext exposes no optimizer
*registration* hook on the Node target. It does not follow that no in-process implementation is
reachable — and measurement says one is.

## Why it works — the thing Phase 3 missed

Phase 3 looked for `setImageOptimizer` / `Symbol.for("vinext.imageOptimizer")` and correctly found the
Node prod-server never consults them. But the *implementation* those hooks feed is a **separate public
export** that anyone can call directly:

```
node_modules/vinext/package.json  "./server/image-optimization"  ->  dist/server/image-optimization.js
```

`image-optimization.d.ts:186` exports, publicly:

```
handleImageOptimization(request, handlers, allowedWidths, imageConfig)
parseImageParams, negotiateImageFormat, isImageOptimizationPath, isSafeImageContentType,
IMAGE_CACHE_CONTROL, IMAGE_CONTENT_SECURITY_POLICY, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES
```

`handleImageOptimization` (`image-optimization.js:203-240`) is complete and runtime-agnostic: it
validates params, fetches the source through a caller-supplied `fetchAsset`, negotiates the output
format from `Accept`, refuses unsafe content types, calls a caller-supplied `transformImage`, and sets
the cache + security headers. The **only** thing missing on the Node target is the two callbacks. Its
own doc comment names Node as an intended caller — *"the single entry point every runtime/router seam
(App Router worker, Pages worker, **Node prod server**) should call"* — and the Node prod server is
simply the seam that does not call it (`prod-server.js:870-889`, `tryServeStatic` then `404`, exactly
as Phase 3 reported).

So there is nothing to fork and nothing to register. A knext entry supplies `fetchAsset` (filesystem)
and `transformImage` (an encoder) and calls the public function.

The listener swap the reviewer described is exactly what the shim permits — `startProdServer` returns
`{ server, port }` (`prod-server.js:1394-1398`) and the server is built with a single anonymous
`request` listener (`prod-server.js:925`):

```js
const { server } = await startProdServer({ port, host, outDir });
const originalListeners = server.listeners('request');
if (originalListeners.length !== 1) throw new Error(...);   // fail loud if vinext changes shape
const delegate = originalListeners[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (!isImageOptimizationPath(pathname)) return delegate(req, res);   // everything else untouched
  handleImageOptimization(request, { fetchAsset, transformImage }, ALLOWED_WIDTHS, IMAGE_CONFIG)
    .then((response) => sendWebResponse(response, req, res, false));
});
```

`sendWebResponse` is also a public `prod-server` export, so even the node-response writing is vinext's
own.

## Q1 + Q2 — the measurements

Same app in every arm (SSR page, route handler, dynamic route with param binding, `next/image` page),
same fixture `apps/file-manager/public/knext-optimize-fixture.png` (**181,277 B**, 256×256 PNG),
`images.qualities: [20, 75]` in both configs. `next@16.2.11` Turbopack standalone control;
`vinext@1.0.0-beta.4` on Vite 8.2.0. Harness: `spike-vinext-image-intercept/probe.mjs`.

**The Phase 3 baseline reproduced exactly before anything else was measured** — 1,880 B webp control,
181,277 B passthrough — so this is not an environment mismatch.

`/_next/image?url=/knext-optimize-fixture.png&w=640&q=75`, `Accept: image/avif,image/webp,…`:

| arm | status | content-type | bytes | vs source |
|---|---|---|---:|---:|
| **Next 16.2.11 control** (node, standalone) | 200 | `image/webp` | **1,880** | 96× |
| **vinext beta.4, unmodified** (node) | 200 | `image/png` | **181,277** | 1× (byte-for-byte the source) |
| **vinext beta.4, unmodified, `--compile --bytecode`** | 200 | `image/png` | **181,277** | 1× |
| **vinext + knext interception** (node, `sharp`) | 200 | `image/avif` | **2,118** | 86× |
| **vinext + knext interception** (bun JIT, `sharp`) | 200 | `image/avif` | **2,118** | 86× |
| **vinext + knext interception, `--compile --minify --bytecode`** (WASM) | 200 | `image/avif` | **1,463** | **124×** |
| **same binary, `bun-linux-arm64-musl`, in `alpine:3.20`** | 200 | `image/avif` | **1,463** | **124×** |

The **compiled-unmodified** row is the mutation proof: identical build shape, identical container,
interception removed → straight back to the 181,277 B passthrough. The win is attributable to the
interception, not to the compile.

Delegation, compiled binary vs unmodified vinext — **every non-image response byte-identical**:

| request | unmodified vinext | knext interception (compiled, linux-musl) |
|---|---|---|
| `GET /` (SSR) | 200 `text/html` 8,195 B | 200 `text/html` 8,195 B |
| `GET /api/hello` | 200 `application/json` 27 B | 200 `application/json` 27 B |
| `GET /blog/spike-42` (param binding) | 200 8,419 B, contains `spike-42` | 200 8,419 B, contains `spike-42` |
| `GET /definitely-not-here` | **404** `text/html` 3,938 B | **404** `text/html` 3,938 B |
| `GET /knext-optimize-fixture.png` (raw static) | 200 `image/png` 181,277 B | 200 `image/png` 181,277 B |

Interception does not swallow non-image traffic, and it does not swallow non-optimisable image traffic
either: the raw static path still serves the untouched source.

## Q3 — the compile. This is where the interesting finding is

### `sharp` does NOT survive `bun build --compile`. Measured, both platforms.

`darwin-arm64`, binary run from a directory containing only the binary and the assets:

```
error: Could not load the "sharp" module using the darwin-arm64 runtime
      at <anonymous> (/$bunfs/root/knext-server:28:4120)
```

`bun-linux-arm64-musl`, same entry, inside `alpine:3.20` with `libstdc++`/`libgcc` installed:

```
error: Could not load the "sharp" module using the linuxmusl-arm64 runtime
      at <anonymous> (/$bunfs/root/knext-server-sharp:28:4120)
```

**Two distinct failure layers, and it matters which is which:**

1. **sharp's loader is invisible to any bundler.** `sharp/dist/sharp.mjs:13` builds
   `createRequire(import.meta.url)` and then does `require("@img/sharp-darwin-arm64/sharp.node")` at
   *runtime*. Bun's bundler never sees that specifier, so nothing is embedded; inside the binary the
   `createRequire` base is frozen to the **build machine's** absolute path
   (`…/vx/node_modules/sharp/dist/sharp.mjs`, visible in the minified output above). Platform-independent
   by construction, and confirmed on both targets.
2. **Even bypassing the loader, the addon needs a companion shared library.** `bun --compile` *can*
   embed an N-API addon — a concrete-path `import` of `sharp-darwin-arm64-0.35.3.node` was embedded,
   extracted to `/private/tmp/.…node`, and `dlopen`ed. It then failed one layer down:

   ```
   error: dlopen(...): Library not loaded: @rpath/libvips-cpp.8.18.3.dylib
   ```

   because libvips lives in a *sibling npm package* (`@img/sharp-libvips-darwin-arm64/lib/`) that bun
   does not embed, and the extract-to-tmp location defeats the `@rpath` search.

   Layer 2 was measured on **darwin only** — the linux-musl arm64 prebuild would not install on this
   host (`npm install --os=linux --cpu=arm64 --libc=musl @img/sharp-linuxmusl-arm64` produced no
   package). Layer 1 alone is already fatal on both targets, so layer 2 is not load-bearing for the
   verdict, but it is **not established** on linux and should not be asserted.

So: **`sharp` is structurally incompatible with the self-contained `--compile` shape.** It could only
ship by being shipped *alongside* the binary with its `@img/*` sibling packages intact — which is
exactly the self-containment property the compile is for.

### A WASM encoder DOES survive. Fully.

`@jsquash/*` (squoosh's codecs: mozjpeg, libwebp, libavif, oxipng, squoosh-resize) is pure WASM with no
native addon. Importing the `.wasm` files makes bun embed them:

```
WASM_PATH /$bunfs/root/squoosh_png_bg-p9r6p12y.wasm
WASM_PATH /$bunfs/root/squoosh_resize_bg-ghfvnjd0.wasm
WASM_PATH /$bunfs/root/webp_enc-1kmpeq9e.wasm
WASM_PATH /$bunfs/root/avif_enc-vywbdsjs.wasm
```

— run from an isolated directory containing nothing but the binary and one fixture, output
byte-identical to the JIT run. The full server binary then produced the 1,463 B AVIF above on both
`darwin-arm64` and `bun-linux-arm64-musl`-in-alpine.

**Constraint discovered while doing it:** `--bytecode` rejects top-level `await`
(`error: "await" can only be used inside an "async" function`). vinext's own generated
`dist/standalone/server.js` happens to avoid TLA; a knext entry must too. Cheap to satisfy, easy to
regress, so it belongs in whatever guards the entry.

### Self-containment: a correction that is NOT caused by the interception

ADR-0042 Phase 0 recorded self-containment as **binary + `.output/public`**. That was the **nitro bun
preset**. The `vinext build` **`dist/standalone`** shape this spike compiled needs more, and the
control binary needs exactly the same, so this is a property of the artifact, not of interception:

- **binary + `dist/client` only** → `[vinext] No build output found … Run 'vinext build' first.`
- **+ `dist/server` (620 KB)** → boots, but every SSR route 500s:
  `Cannot find module 'react/jsx-runtime' from …/dist/server/ssr/index.js`
- **+ `node_modules` (38 MB)** → all green.

`dist/server/**` is loaded from **disk** at runtime and externalises `react`/`react-dom`, so the
compiled binary is not self-contained in this shape at all. Whether the nitro-preset shape still is
under beta.4 was **not established here** — but Phase 1's deployment story depends on the answer and
Phase 0's row should not be read as covering `dist/standalone`.

## Q4 — correctness and the DoS surface

**Honoured, measured on the compiled linux-musl binary:**

| | result |
|---|---|
| `w=640` vs `w=64`, q=75 | 1,463 B vs **732 B** — width honoured, and never enlarged (source is 256 px, so `w=640` yields a 256 px image, matching Next) |
| `q=75` vs `q=20`, w=640 | 1,463 B vs **648 B** — quality honoured |
| `Accept: image/avif,image/webp,…` | `image/avif` |
| `Accept: image/*` | `image/jpeg` |
| `w=637` (not an allowed width) | **400** |
| missing `url` | **400** |
| `url=https://example.com/a.png` (absolute) | **400** |

The 400s are vinext's own `parseImageParams`, unchanged — the interception inherits them rather than
re-implementing them, which is the point of calling `handleImageOptimization`.

**A defect this spike introduced and measurement caught**, recorded because it is the whole argument
for measuring: the first cut passed `{ cqLevel }` to `@jsquash/avif`, which **silently ignores unknown
options** and encodes at its default quality 50. `q=20` and `q=75` both returned exactly 1,077 B. The
option is `{ quality }`. A "does it optimise?" check would have passed; only comparing `q` values
caught it.

**Format-negotiation delta vs Next — real, and not fixed by this spike.** vinext's
`negotiateImageFormat` (`image-optimization.js:130-135`) is three lines: avif → webp → **jpeg**. So a
client sending `Accept: image/*` gets a PNG source transcoded to **JPEG**, losing alpha. Next returns
`image/png` 23,124 B for the same request. Not a blocker, but a parity gap that belongs in the
exclusion set rather than being quietly inherited.

**The DoS surface is real, and the mechanism is the absence of a cache.**
`handleImageOptimization` does no caching whatsoever — every request re-encodes. Measured
(`spike-vinext-image-intercept/load.mjs`), linux-musl binary in alpine vs the Next control:

| | knext + WASM | Next 16.2.11 |
|---|---:|---:|
| 8 serial distinct widths (ms) | 83, 46, 42, 41, 40, 42, 45, 40 | 26, 11, 7, 8, 7, 7, 7, 7 |
| **same URL ×3** (ms) | **38, 41, 40** | **1, 1, 1** |
| 16 concurrent, wall | **576 ms** | 16 ms |
| SSR `/` for scale | 10 ms | 7 ms |

Two things follow. **(a)** WASM is ~5× slower per encode than Next's `sharp` — on a 256×256 source;
a large source will be much worse and was **not measured**. **(b)** Next's flat 1 ms on repeat is a
cache; knext has none, so an unauthenticated caller can pin CPU with `w`/`q` permutations that never
hit anything. The `deviceSizes × imageSizes × qualities` product bounds the *distinct* key space, but
nothing bounds the *rate*.

Bounds implemented in the spike entry and exercised by the concurrency run: a
`MAX_CONCURRENT_TRANSFORMS` semaphore (default 4 — visible in the 16-concurrent wall time, where
per-request latency spreads 43→575 ms as requests queue rather than the process melting), a 20 MB
source-size refusal, and a 40 MP decoded-pixel refusal. Path traversal out of the client dir is
refused before `stat`.

Bounds that would still be needed to ship, none of them measured here: **a cache** (this is the one
that matters — ADR-0006's `image-cache-sync.ts` and ADR-0037 are the obvious homes), a per-IP or
global rate limit at the reverse proxy `security.md` already requires, and a decode timeout. This is
not a mutating endpoint, so the "no unauthenticated mutating endpoints" rule is not engaged; the
exposure is CPU, not state.

## What this means for ADR-0042

**Escalation 1's premise — that an ADR-0006 app has no in-band fallback on the default runtime — is
refuted.** Image optimisation is recoverable in-process, in the compiled bytecode binary, on the
deployment target, without forking vinext, without an upstream patch, without a sidecar, and without a
per-app source change. It uses the bespoke knext bun entry that **Consequence 4 already mandates**, so
it adds no architectural scope.

What it costs, stated plainly rather than buried:

- **`sharp` is off the table on the default path** (structural, measured on both targets). knext would
  own a WASM codec stack — a new dependency surface, ~5.4 MB of embedded `.wasm` (binary 62.2 MB →
  67.7 MB darwin; 99.8 MB linux-musl), and a **second** image implementation to keep at parity with
  the node path's `sharp` one for as long as both targets exist.
- **A cache is not optional.** Without one this is slower than the node path on repeat requests by a
  factor of ~40 and is a standing CPU-exhaustion surface.
- **This is a spike, not a design.** It is one app, one fixture, one machine, PNG and JPEG sources
  only. Animated GIF, SVG-through-the-endpoint, 16-bit PNG, remote `remotePatterns` sources, and
  `minimumCacheTTL`/`Cache-Control` semantics were all **not established**.
- The interception swaps the listener *after* `startProdServer` has already begun listening. The window
  is sub-millisecond and no request was observed in it, but it is a real race and a production entry
  should close it rather than inherit it.
- The entry hardcodes `ALLOWED_WIDTHS`/`qualities` that a real knext build would emit from the app's
  `next.config`. Wiring, not research — but unwired here.

**None of that is an argument for a permanent dual track.** The strongest argument for one was that the
default runtime could not do image optimisation at all. It can.

## Not established

Layer-2 (`dlopen`/libvips) failure on linux · whether the **nitro-preset** `.output` shape is still
self-contained under beta.4 · large-source encode cost · animated/16-bit/SVG/remote sources · anything
under load beyond 16 concurrent requests on one laptop · anything on a cluster · whether a cache can
be added without violating ADR-0037 · the `^0.0.19` + nitro pin, which was not tested here either.
