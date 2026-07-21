# `bun-exec` build recipe (opt-in, experimental)

> **⚠ NOT DEPLOYABLE AS-IS — see [#460](https://github.com/getknext-dev/knext/issues/460).**
> The compiled binary is **not portable**: `bun --compile` bakes the build machine's *absolute*
> `.output/` path into the executable, and it loads its SSR/route chunks from that path at runtime.
> Run anywhere but the exact build directory — including a container, the ship path documented below —
> and it serves a 404 for **every** route. The "single self-contained executable, ship it in a bare
> Alpine image" framing in this README is **aspirational and currently false**; it was only ever
> exercised by running the binary from its build directory. Do not ship this until #460 is fixed.

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
win is exactly what the OKE A/B on this PR must measure: **no speedup is claimed
yet.** ADR-0036 authorises this as an **opt-in, compat-gated** alternative target
— never a default, never a silent flip.

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
| `knext-bun-entry.mjs` | The bespoke **Nitro server entry** the build wraps around vinext's handler. Provides the `RuntimeContract`: two `Bun.serve` listeners (app + in-process `:9091` metrics) and SIGTERM/SIGINT graceful drain. |
| `runtime-contract.mjs` | Pure, dependency-free contract helpers (Prometheus exposition, fail-closed Bearer guard, drain orchestration + `after()`/waitUntil registry). Shared by the entry **and** the tests, so the binary and the tests enforce identical logic. |
| `vite.config.ts` | Wires `nitro({ preset: "bun", entry: "./knext-bun-entry.mjs" })` so the build inlines our entry. |
| `build.sh` | The reproducible `bun install` → `vite build` → `bun build --compile --bytecode` sequence. Parameterised by target arch. |
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
`bun-exec`-ineligible and fall back to `node` (see eligibility above). The
`after()` **drain wiring** is present and tested here; connecting vinext's actual
`waitUntil`/`after()` emission into it is a follow-up for the OKE validation.

## Beta-on-beta toolchain risk ⚠️

The pipeline rides **two coupled betas**: `vinext@1.0.0-beta.2` is locked to
`nitro@3.0.260610-beta`, with `@vitejs/plugin-rsc@0.5.28` (exact-pinned) and
`vite@^8`. **These pins are exact and load-bearing** (and enforced by the
committed `bun.lock` + `bun install --frozen-lockfile`) — an unpinned/`^`-resolved install silently
breaks the build (stable nitro renames the SSR service bundle so vinext's
RSC↔SSR dynamic import can't resolve; `@vitejs/plugin-rsc@0.4.x` fails with
`RUNTIME_MODULE_SYMBOL_NOT_FOUND`). **Re-validate this entire recipe on every pin
bump.** vinext is MIT but beta; a shipping target cannot ride an unmaintained
upstream — that exit stance is tracked in ADR-0036 P1b.

## Binary size

`bun --compile` embeds the ~57 MB Bun runtime, so the executable is **~90–110 MB**
(the pre-compile `.output/` tree is ~1 MB — the size is entirely the runtime; the
"5 MB alpine" idea is wrong). **The intended ship path — a bare `FROM alpine` image, cosign-signed
and digest-pinned — does NOT currently work: the binary 404s all routes when run outside its build
directory ([#460](https://github.com/getknext-dev/knext/issues/460)).** Once that is fixed, because
the binary is opaque to Trivy/syft, the SBOM + HIGH/CRITICAL
scan run against the **pre-compile dependency closure** (lockfile), not the binary
(ADR-0036 supply-chain consequence).

## Build & run

Requires [Bun](https://bun.sh) (≥1.3).

```bash
# Build the single executable for a target arch:
#   linux-x64 | linux-arm64 (alpine, -musl) | darwin-arm64 | darwin-x64
./build.sh linux-x64
# → ./knext-bun-exec-linux-x64  (~90-110 MB)

# Run it (operator injects these envs in production):
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

The e2e spawns `test/drain-harness.mjs` under bun — the **same** two `Bun.serve`
listeners + shared `runtime-contract.mjs` as the real entry, with a stub router in
place of vinext's handler. It proves the net-new knext code (metrics, drain,
auth) over real sockets. The **vinext handler composition** and the **compiled
Linux binary in-image** were exercised by the ADR-0036 P1a/P2 feasibility spikes;
the OKE cold-start A/B is the **pending P1b gate on this PR**, not a result the
recipe can cite yet. Running the full compiled-binary e2e in CI is deliberately
out of scope here (too heavy for the main gates).
