# `bun-exec` build recipe (opt-in, experimental)

> **✅ SELF-CONTAINED (fixed in [#460](https://github.com/getknext-dev/knext/issues/460); re-proved
> on the CURRENT toolchain, ADR-0042 A1).**
> The compiled binary embeds all routes and serves them from ANY directory — ship it as
> **`binary` + `.output/public`** (the static-asset dir), not binary-only. This is no longer a
> hand-run claim: `test/alpine-image.docker-e2e.test.ts` (`bun run test:image`, CI job
> `bun-exec-alpine-image`) builds the binary, builds `Dockerfile`, runs the container with `/app`
> holding ONLY the binary + `.output/public` (`.output/server` asserted absent), and probes SSR, a
> route handler, a **dynamic** page and handler, a 404, a **static asset fetched from the page's own
> `<script src>`**, the fail-closed `POST /api/cache/invalidate`, and `:9091/metrics`.
>
> **Three** root causes have now been fixed. The third (below) was found by adding that static-asset
> probe — until then, the shipped image served correct SSR HTML and **500'd every single JS chunk**,
> so the page rendered and never hydrated. Every earlier verification, including #460's, probed only
> `/`, `/api/health`, `:9091/metrics` and the auth route, so nothing ever noticed:
>
> 1. **Versions / bundling.** `vinext@1.0.0-beta.2` emitted a runtime-CHUNKED server
>    (`.output/server/index.mjs` a ~7 KB loader that reads route chunks from `.output/server/` at
>    runtime), so `bun --compile` couldn't embed the routes. The fix at the time was to pin back to
>    `nitro@3.0.1-alpha.2` / `vinext@0.0.19` / `vite@7`. **That pin is gone (ADR-0042 A1):
>    `vinext@1.0.0-beta.4` + `vite@8` + `nitro@3.0.260610-beta` is self-contained** — see
>    "Toolchain / version risk" below for the measurement. Chunked-on-disk no longer implies
>    not-embeddable: beta.4's `.output/server/` still shows `_ssr/rsc.mjs` / `_ssr/ssr.mjs`, and
>    `bun build` bundles and embeds them anyway.
> 2. **The custom entry dropped the route wiring.** `knext-bun-entry.mjs` overrides nitro's `entry`,
>    which drops vinext's route injection unless the entry re-imports `#nitro/virtual/polyfills`
>    (registers `globalThis.__nitro_vite_envs__` → the ssr/rsc render chunks). It also now serves the
>    app through srvx's `serve` (`srvx/bun`) — the SAME path nitro's default bun entry uses — instead
>    of a raw `Bun.serve` → `useNitroApp().fetch`, which answered a framework 404 for every route.
> 3. **Static assets resolved against the BUILD MACHINE's absolute path.** Nitro prepends
>    `globalThis.__nitro_main__ = import.meta.url` to the entry and reads public assets from
>    `dirname(fileURLToPath(__nitro_main__))/../public/…`. `bun build --compile` **bakes** that URL,
>    so the shipped container tried to open
>    `/Users/<whoever-built-it>/…/examples/bun-exec/.output/public/_next/static/chunks/index-*.js`
>    and returned `500 {"error":true,"unhandled":true}` (ENOENT) for **every** asset. The entry now
>    re-anchors `__nitro_main__` through `resolveAssetAnchor` (`runtime-contract.mjs`), which
>    keeps a baked root that really exists **only when this is not a compiled binary** — so a
>    non-compiled `bun run …/.output/server/index.mjs` from any cwd is untouched — and otherwise
>    anchors on **`dirname(process.execPath)`**: the executable's own directory, which is the layout
>    this README and the `Dockerfile` document. The compiled-binary carve-out matters most on the
>    machine that BUILT it, where the baked build tree still exists: without it the binary would
>    silently serve the build tree's assets rather than the ones shipped beside it, so "I copied the
>    binary and `.output/public` somewhere and it served" would prove nothing. When both roots are
>    present the co-located one wins and the runtime says so.
>    Anchoring on the EXECUTABLE rather than the working directory is what makes the binary
>    portable (`docker run -w /elsewhere` still serves). If neither has `.output/public`, it
>    **warns loudly on startup** instead of failing silently — being silent is the whole reason
>    this bug survived five verifications. Note what this means for the word "self-contained": the
>    **routes** are embedded in the binary, but `.output/public` is read from disk at runtime — so
>    the binary is portable and the two must ship **together, side by side**.

> **Maintainer example.** This directory is an in-repo recipe for knext
> maintainers, not user-facing documentation — so it references ADRs and the
> `RuntimeContract` directly. It implements **P3 increment 1 of ADR-0036**: a
> self-contained, reproducible recipe that compiles a [vinext](https://github.com/…/vinext)
> App-Router app into a **single Bun executable** via `bun build --compile --bytecode`.
>
> **This does not touch the default build path.** knext's default and only
> all-apps-verified target is still **node/turbopack** (`.next/standalone` +
> the node supervisor). Nothing here is wired into `kn-next build`, the
> operator, the CRD, or CI's main gates. It is a standalone proof that the
> two-target pipeline is reproducible in-repo.

## Why this exists

The node path has a hard cold-start floor ≈ Next.js's own `server.js` boot
(~1957 ms on OKE) that knext cannot optimise below. A vinext build compiled to a
Bun single executable **never boots Next's server**, so *in principle* it
side-steps that floor — the ADR-0036 P1 feasibility spike booted a **trivial**
compiled binary in ~2–4 ms (bypassing the ~1957 ms), which is the whole reason to
try this. Whether the **real** recipe delivers a distribution-separated cold-start
win **remains unmeasured**: the build is now self-contained (#460), so the P1b OKE
A/B (benchmark run 16) can run — but the result is not in yet. **No speedup is
claimed until that A/B is run.** ADR-0036 authorises this as an **opt-in,
compat-gated** alternative target — never a default, never a silent flip.

## Eligibility boundary (read before using)

`bun-exec` is the **fast path for a narrow app set**. An app is eligible only if
it does **not** use:

- **`next/image` optimization** — vinext auto-stubs `sharp` in prod (ADR-0006
  image optimization is lost).
- **ISR / `revalidate` / a Redis `cacheHandler`** — a known-uncovered vinext
  surface; likely needs vinext-side support the binary can't add.
- **Middleware** or knext webpack/turbopack **adapter hooks** — vinext is
  Vite/rolldown and ignores them.

Apps that need any of these **fall back to the default `node` build** — the same
north-star bar as today. Eligibility is enforced by the official compatibility
suite (a later P3/P4 increment), not by this recipe. When in doubt, use `node`.

## What's in here

| File | Role |
|---|---|
| `app/` | Minimal App-Router sample: home page, `GET /api/health` (shallow), `GET /slow` (~2s, for the drain test), `POST /api/cache/invalidate` (Bearer-auth, fail-closed), and — added for ADR-0042 A1 — a **dynamic page** `GET /item/[id]` and a **dynamic handler** `GET /api/echo/[slug]`, the dimension the self-containment proof was previously missing. |
| `Dockerfile` | The reference ship image: `FROM alpine` **+ `apk add libstdc++ libgcc`** (mandatory — see the warning under "Binary size") + the binary + `.output/public`, non-root. |
| `knext-bun-entry.mjs` | The bespoke **Nitro server entry**. Imports `#nitro/virtual/polyfills` (keeps vinext's routes in the bundle), serves the app through srvx's `serve` (nitro's real request path) with an in-flight-counting middleware, runs a second `Bun.serve` for in-process `:9091` metrics, and owns SIGTERM/SIGINT graceful drain. |
| `runtime-contract.mjs` | Pure, dependency-free contract helpers (Prometheus exposition, fail-closed Bearer guard, drain orchestration + `after()`/waitUntil registry). Shared by the entry **and** the tests, so the binary and the tests enforce identical logic. |
| `vite.config.ts` | Wires `nitro({ preset: "bun", entry: "./knext-bun-entry.mjs" })` so the build inlines our entry. |
| `build.sh` | The reproducible `bun install` → `vite build` → `bun build --compile --minify --bytecode` sequence. Parameterised by target arch. |
| `test/` | Vitest RuntimeContract tests (unit + a real-sockets drain/metrics/auth e2e under bun). |

## The `RuntimeContract` this recipe provides

ADR-0036 requires both targets satisfy one contract. This recipe covers:

1. **Health** — shallow `GET /api/health` (no PG/Redis dial).
2. **Metrics** — Prometheus on **`:9091`, in-process, bound at listen-time** (a
   second `Bun.serve`). Hand-rolled exposition (no `prom-client`) to stay
   self-contained and compile-safe.
3. **SIGTERM/SIGINT graceful drain** — `server.stop()` lets in-flight requests
   finish, then `after()`/waitUntil tasks drain, then the metrics listener
   closes, then `exit(0)`. A `server.stop(true)` **hardcap** (`SHUTDOWN_GRACE_MS`,
   default 25000) forces exit(1) if drain overruns.
5. **Bearer-authenticated, fail-closed** `POST /api/cache/invalidate`
   (`CACHE_INVALIDATE_TOKEN`) — security.md hard rule; 401 without/with a wrong
   token, including when the server token env is unset.
6. **Env-injection contract** — `PORT`, `HOSTNAME`, `METRICS_PORT`,
   `SHUTDOWN_GRACE_MS`, `CACHE_INVALIDATE_TOKEN` (operator-supplied). `HOSTNAME`
   is honoured as a bind host **only when it is an explicit bind/loopback
   address** (`0.0.0.0`, `::`, `127.0.0.1`, `::1`, `localhost`); a non-bind
   value — notably the `HOSTNAME=<pod-name>` Kubernetes injects into every pod —
   is treated as `0.0.0.0`, matching the node path (`env.ts` `isBindOrLoopback`)
   so the listener stays reachable in-cluster instead of binding to the pod name.
7. **Module-state seam (ADR-0027)** — the `after()`/waitUntil pending-task set is
   anchored on `globalThis` via `Symbol.for("knext.bunexec.pendingTasks")`,
   never a bare module-level `let`.

**Deferred / fallback:** item **4 (Redis ISR/data-cache handler)** is *not*
implemented — it is a known-uncovered vinext surface, so ISR-dependent apps are
`bun-exec`-ineligible and fall back to `node` (see eligibility above). Two drain
paths now cover background tasks: our `after()`/waitUntil registry (item 7), AND —
because the app is served through srvx's `serve` — srvx's own per-request
`waitUntil`, which our `appServer.stop()` (srvx `close()`) awaits. End-to-end
confirmation of vinext's actual `after()` emission draining under load is a
follow-up for the OKE validation.

## Toolchain / version risk ⚠️

The pipeline rides the **current** vinext line: `vinext@1.0.0-beta.4` / `vite@^8` /
`nitro@3.0.260610-beta` / `@vitejs/plugin-rsc@0.5.x`. The committed `bun.lock` +
`bun install --frozen-lockfile` pin the resolved graph.

**The `vinext@^0.0.19` / `nitro@3.0.1-alpha.2` pin is GONE (ADR-0042 A1).** It existed because
`vinext@1.0.0-beta.2` emitted a runtime-chunked server `--compile` could not embed (#460), and
pinning a shipping recipe to two abandoned pre-releases was never a defensible posture. Measured on
beta.4, x64-musl: `vite build` → `bun build --compile --minify --bytecode
--target=bun-linux-x64-musl .output/server/index.mjs` bundles **34 modules** and the container
serves every probed route from a `/app` that contains only the binary + `.output/public`.

Upgrading vinext is a **toolchain migration, not a bump**: beta.4 fails on Vite 7
(`does not provide an export named 'parseSync'`) and hard-requires **Vite 8**. It also no longer
depends on `nitro` — this recipe still uses the nitro Vite plugin (`nitro({ preset: 'bun', entry })`)
because that is what lets the bespoke `knext-bun-entry.mjs` provide the `RuntimeContract`; nitro is
now a direct devDependency of the example rather than something vinext drags in.

**Self-containment no longer needs re-validating by hand on a pin bump** — `bun run test:image`
does it, and the `bun-exec-alpine-image` CI job runs that on every push. vinext is MIT but beta; a
shipping target cannot ride an unmaintained upstream — that exit stance is tracked in ADR-0036 P1b
and ADR-0042 (A6/A8).

## Binary size

`bun --compile` embeds the ~57 MB Bun runtime, so the executable is **~90–110 MB**
(the pre-compile `.output/` tree is ~1 MB — the size is entirely the runtime; the
"5 MB alpine" idea is wrong). **Ship the binary + the `.output/public` static-asset dir**
(the routes are IN the binary; only static assets live outside it — that is exactly what the
founder's original working build shipped). The ship path is the `Dockerfile` in this directory
(cosign-signed, digest-pinned in production) copying `binary` + `.output/public` **into the same
directory**. The runtime anchors static assets on the EXECUTABLE's own directory, not on the
working directory, so any cwd works (`docker run -w /elsewhere` included) as long as the two
travel together.

> ⚠️ **`FROM alpine` + the binary alone DOES NOT RUN (ADR-0042 A9).** bun's `-musl` targets are
> **not statically linked**. Without `libstdc++`/`libgcc` the container dies with
> `Error loading shared library libstdc++.so.6`, ~30 relocation errors, and **exit 127** — so the
> image row in ADR-0036 ("`FROM alpine` + the single binary") is wrong as written. The `Dockerfile`
> here carries `RUN apk add --no-cache libstdc++ libgcc` (+~2 MB), and `test/alpine-image.docker-e2e.test.ts`
> fails with that container's own exit code if the line is removed (mutation-proved).
Because the binary is opaque to Trivy/syft, the SBOM + HIGH/CRITICAL scan run against the
**pre-compile dependency closure** (lockfile), not the binary (ADR-0036 supply-chain consequence).

## Build & run

Requires [Bun](https://bun.sh) (≥1.3).

```bash
# Build the single executable for a target arch:
#   linux-x64 | linux-arm64 (alpine, -musl) | darwin-arm64 | darwin-x64
./build.sh linux-x64
# → ./knext-bun-exec-linux-x64  (~90-110 MB) + ./.output/public (static assets)

# Run it (operator injects these envs in production). Any cwd works — assets are
# anchored on the BINARY's own directory — but SHIP the binary and .output/public
# side by side, in one directory:
PORT=3000 METRICS_PORT=9091 CACHE_INVALIDATE_TOKEN=changeme \
  ./knext-bun-exec-linux-x64
```

Then:

- `GET  http://localhost:3000/`                    → the sample page
- `GET  http://localhost:3000/api/health`          → `{"status":"ok","target":"bun-exec"}`
- `GET  http://localhost:9091/metrics`             → Prometheus exposition
- `POST http://localhost:3000/api/cache/invalidate` → **401** without
  `Authorization: Bearer $CACHE_INVALIDATE_TOKEN`, **200** with it
- `SIGTERM` the process while a `GET /slow` is in flight → it still completes
  200, then the process exits 0.

## Test

```bash
bun install
bun run test        # vitest: contract unit tests + bun-harness drain/metrics/auth e2e
bun run test:image  # the compiled binary in a clean alpine container (needs docker + bun)
```

The e2e spawns `test/drain-harness.mjs` under bun — the **same** two listeners +
shared `runtime-contract.mjs` as the real entry, with a stub router in place of
vinext's handler. It proves the net-new knext code (metrics, drain, auth) over
real sockets. `test/self-contained-entry.test.ts` additionally guards the two #460
root causes (the `#nitro/virtual/polyfills` import and srvx-based app serving) so
neither can silently regress.

`bun run test:image` is the **compiled-binary** half, and it is no longer out of
scope for CI: `test/alpine-image.docker-e2e.test.ts` compiles the binary (via `build.sh`
if absent), builds the reference `Dockerfile`, and probes the running container.
It has **no skip path** — a missing docker or bun is a failure, never a silent
pass — which is why it is kept out of the fast `bun run test` and given its own
`bun-exec-alpine-image` CI job. `tests/bun-exec-alpine-image-ci.test.ts` guards
that wiring, so deleting the job reddens the main suite instead of quietly
disarming the gate. The OKE cold-start A/B remains the **pending P1b gate**; this
proves the artifact runs, not that it is faster.
