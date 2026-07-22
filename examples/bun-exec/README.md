# `bun-exec` build recipe (opt-in, experimental)

> **✅ SELF-CONTAINED (fixed in [#460](https://github.com/getknext-dev/knext/issues/460)).**
> The compiled binary embeds all routes and serves them from ANY directory — ship it as
> **`binary` + `.output/public`** (the static-asset dir), not binary-only. Verified locally by
> running the binary from a clean dir containing only `.output/public`: `/`, `/api/health`,
> `:9091/metrics`, and the Bearer-auth `/api/cache/invalidate` all respond correctly, and SIGTERM
> drains an in-flight request then exits 0. Two root causes were fixed (both proven on OKE):
>
> 1. **Versions / bundling.** The old pins (`nitro@3.0.260610-beta` / `vinext@1.0.0-beta.2`) emitted
>    a runtime-CHUNKED server (`.output/server/index.mjs` a ~7 KB loader that reads route chunks from
>    `.output/server/` at runtime), so `bun --compile` couldn't embed the routes. This recipe now pins
>    `nitro@3.0.1-alpha.2` / `vinext@0.0.19` / `vite@7` / `@vitejs/plugin-rsc@0.5.x` — the combo that
>    BUNDLES the server so `--compile` embeds every route (the versions the founder's original working
>    single-binary shipped).
> 2. **The custom entry dropped the route wiring.** `knext-bun-entry.mjs` overrides nitro's `entry`,
>    which drops vinext's route injection unless the entry re-imports `#nitro/virtual/polyfills`
>    (registers `globalThis.__nitro_vite_envs__` → the ssr/rsc render chunks). It also now serves the
>    app through srvx's `serve` (`srvx/bun`) — the SAME path nitro's default bun entry uses — instead
>    of a raw `Bun.serve` → `useNitroApp().fetch`, which answered a framework 404 for every route.

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
| `app/` | Minimal App-Router sample: home page, `GET /api/health` (shallow), `GET /slow` (~2s, for the drain test), `POST /api/cache/invalidate` (Bearer-auth, fail-closed). |
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

The pipeline rides an **early nitro/vinext** combo, chosen because it BUNDLES the
server so `bun --compile` embeds all routes (self-containment, #460): `nitro@3.0.1-alpha.2`
/ `vinext@0.0.19` / `vite@^7` / `@vitejs/plugin-rsc@0.5.x` — the versions the founder's
original working single-binary shipped. The committed `bun.lock` + `bun install --frozen-lockfile`
pin the resolved graph. **The newer betas do NOT work for this recipe:** `nitro@3.0.260610-beta`
/ `vinext@1.0.0-beta.2` emit a runtime-CHUNKED server (routes loaded from `.output/server/` at
runtime) that `--compile` cannot embed → the binary 404s outside its build dir. **Re-validate
self-containment (build, run the binary from a clean dir with only `.output/public`, hit `/`) on
every pin bump.** vinext is MIT but beta; a shipping target cannot ride an unmaintained upstream —
that exit stance is tracked in ADR-0036 P1b.

## Binary size

`bun --compile` embeds the ~57 MB Bun runtime, so the executable is **~90–110 MB**
(the pre-compile `.output/` tree is ~1 MB — the size is entirely the runtime; the
"5 MB alpine" idea is wrong). **Ship the binary + the `.output/public` static-asset dir**
(the routes are IN the binary; only static assets live outside it — that is exactly what the
founder's original working build shipped). The ship path is a bare `FROM alpine` image (cosign-signed,
digest-pinned) copying `binary` + `.output/public`, run from a dir where `./.output/public` resolves.
Because the binary is opaque to Trivy/syft, the SBOM + HIGH/CRITICAL scan run against the
**pre-compile dependency closure** (lockfile), not the binary (ADR-0036 supply-chain consequence).

## Build & run

Requires [Bun](https://bun.sh) (≥1.3).

```bash
# Build the single executable for a target arch:
#   linux-x64 | linux-arm64 (alpine, -musl) | darwin-arm64 | darwin-x64
./build.sh linux-x64
# → ./knext-bun-exec-linux-x64  (~90-110 MB) + ./.output/public (static assets)

# Run it (operator injects these envs in production). Run from a dir where
# ./.output/public resolves — SHIP the binary + .output/public together:
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
```

The e2e spawns `test/drain-harness.mjs` under bun — the **same** two listeners +
shared `runtime-contract.mjs` as the real entry, with a stub router in place of
vinext's handler. It proves the net-new knext code (metrics, drain, auth) over
real sockets. `test/self-contained-entry.test.ts` additionally guards the two #460
root causes (the `#nitro/virtual/polyfills` import and srvx-based app serving) so
neither can silently regress. The **full vinext handler composition served from a
self-contained binary run in a clean dir** was verified manually during #460 (build
→ run binary + `.output/public` from `/tmp` → `/`, `/api/health`, `:9091/metrics`,
Bearer `/api/cache/invalidate`, and SIGTERM drain all correct); the OKE cold-start
A/B is the **pending P1b gate**. Running the full compiled-binary e2e in CI is
deliberately out of scope here (too heavy for the main gates).
