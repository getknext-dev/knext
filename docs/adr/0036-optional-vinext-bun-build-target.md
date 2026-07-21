# ADR-0036: Optional vinext + Bun single-executable build target

- **Status:** Proposed (founder-directed 2026-07-20; node/turbopack remains the default)
- **Supersedes (in part):** the blanket "vinext/`bun --compile` path is deprecated" stance in
  `.claude/rules/architecture.md` §4 and `CLAUDE.md` §3 — narrowly, for a *compiled build target*,
  not a return to hand-rolling a Nitro runtime.
- **Relates to:** ADR-0035 (baked compile cache, the node path's own cold-start fix),
  the runtime decision recorded in memory `knext-runtime-decision-coldstart` (2026-06-20).

## Context

### The measured wall
Cold-start decomposition on OKE this session (benchmark `docs/benchmarks/scale-to-zero-oke.md`,
runs 8–12) attributed the node/official-adapter path's warm-cache boot:

| segment | median | owner |
|---|---|---|
| node process floor | ~75 ms | node |
| **Next.js `standalone/server.js` own boot** | **~1957 ms (≈70%)** | **upstream — knext cannot cross it** |
| knext supervisor (bundle load) | ~847 ms | knext (#441/#443) |

Even after ADR-0035 (baked `NODE_COMPILE_CACHE`, −393 ms) and #443 (supervisor deferral, chasing
~790 ms), the node path has a **hard floor ≈ Next's own server boot (~2 s)**. knext cannot optimise
below it without upstream changes.

### Why the June "keep Node" decision does not refute this
Memory `knext-runtime-decision-coldstart` recorded "Bun ≈ Node cold start, keep Node." That bench —
and the existing `spec.runtime: bun` knob (`nextapp_types.go:105`) and the `runtime=bun` path in
`packages/kn-next/src/cli/build.ts` — compare node vs bun **both running the same Next.js
`standalone/server.js`**. They tie because both boot Next's server. That is a *different thing* from a
**vinext build compiled to a Bun `--compile --bytecode` single executable**, which does not boot Next's
standalone server at all and is therefore not subject to the ~1957 ms. The founder's prior experience
(vinext + `bun --bytecode` single executable on a ~5 MB alpine image, "amazing" cold start) is this
second path. So the ask is genuinely new territory, not a re-run of a settled comparison.

### P1 feasibility spike findings (2026-07-20 — corrects earlier assumptions in this ADR)
A feasibility spike (`scratchpad/vinext-bun-feasibility.md`) returned **CONDITIONAL-GO**:
- **Core premise CONFIRMED:** `bun build --compile --bytecode` works and cross-compiles to
  `linux-x64-musl` / `linux-arm64-musl`; a trivial compiled app boots in **~2–4 ms** — i.e. it does
  bypass Next's ~1957 ms server boot. This is the whole reason to do it, and it holds.
- **The ADR's build pipeline is NOT a native path.** vinext (currently **1.0.0-beta.2**) emits only
  Cloudflare Workers + Nitro presets — it has **no bun/single-executable output**. The only bridge is
  `vinext (Nitro node preset) → .output/server/index.mjs → bun build --compile`, which is **unproven**.
  **This is the #1 risk P1 must retire before anything else.** If that bridge can't produce a running
  binary, that is the NO-GO trigger.
- **`next/image` optimization is LOST under vinext** (it auto-stubs `sharp` in prod) — so apps that use
  optimized images (ADR-0006) are **`bun-exec`-ineligible and fall back to `node`**, caught by the
  compat gate. This narrows `bun-exec`'s addressable app set.
- **The knext webpack adapter hooks don't apply** — vinext is Vite/rolldown and ignores
  webpack/turbopack config, `adapterPath`, and the `next build --webpack` pin. The `RuntimeContract`
  must be re-provided by a **bespoke knext bun entry** wrapping vinext's handler (net-new work).
- **`file-manager` is a poor FIRST target** (uses `sharp`; relies on adapter hooks). P1 proves the
  pipeline + bun entry on a **minimal App-Router sample** (no sharp, no adapter hooks) first;
  `file-manager` may simply be a fallback-to-node app under this ADR's own rule.

### State of the world in-repo (grounding)
- vinext is **not** a dependency today (no `packages/vinext`, no reference in manifests). Adding it is
  part of this work. The `migrate-to-vinext` skill provides the migration tooling.
- `kn-next build` exists (`build.ts`) with a `runtime=bun` branch — the run-Next-standalone-under-bun
  path, **not** vinext-compile. Target B below is additive to it, not a replacement.

## Decision

Support an **optional** build target that produces a Bun `--compile --bytecode` single executable from
a **vinext** build, shipped in a minimal alpine image — while **keeping node/turbopack as the default
and only verified-for-all-apps target**. One `kn-next.config.ts`, one `NextApp` CRD, one operator, one
runtime contract. The targets differ ONLY at the build+image layer.

| | Target `node` (default) | Target `bun-exec` (opt-in) |
|---|---|---|
| build | turbopack / `next build` → `.next/standalone` | `vinext build` |
| compile | — | `bun build --compile --bytecode --target=bun-linux-<arch>-musl` |
| image | multi-stage alpine, node runtime + baked compile cache (ADR-0035) | `FROM alpine` + the single binary (**~90–110 MB** — `bun --compile` embeds the ~57 MB Bun runtime; the "5 MB" idea is wrong, corrected by the P1 spike) |
| runtime process | supervisor spawns `server.js`; `:9091` metrics in the supervisor | the binary IS the server (no Next standalone, no spawn); `:9091` served **in-process** at listen-time |
| verification | official compat suite (shipped) | official compat suite against the bun image (gate) |

## Options considered

| Option | Cold start vs ~2s node floor | Maintenance | Compat risk | Verdict |
|---|---|---|---|---|
| Node-only, keep optimising (#443, warm floors) | bounded by ~1957 ms Next boot | lowest | none | keep as default, not sufficient alone |
| `runtime: bun` (existing: Next standalone under bun) | ~ties node (same server boot) | low | low | already exists; not the win |
| **vinext → bun `--compile --bytecode` single-exec** | **potentially bypasses the 1957 ms** | **higher (vinext fidelity + a 2nd runtime contract impl)** | **higher (vinext feature coverage)** | **chosen, OPT-IN, compat-gated, measure-first** |
| Rewrite a bespoke Nitro-style runtime | unknown | highest — the exact thing prior ADRs forbid | high | rejected |

## Consequences

- **Two build targets, one everything-else.** The cost the old "don't rewrite the runtime twice" rule
  feared is capped by forcing both targets through a single `RuntimeContract` and one CRD/operator.
  **If `bun-exec` ever needs its own CRD/operator/config, that is a STOP signal** — the decision is
  invalid at that point.
- **`RuntimeContract` — full enumeration (both targets MUST satisfy all of it).** Under-specifying
  this is how the two targets silently drift; this session already saw deferring the `:9091` listen
  break `sigterm-drain-e2e`. The contract:
  1. **Health:** shallow `/api/health` (no PG/Redis dial, ADR-0026); deep health where applicable.
  2. **Metrics:** Prometheus on **`:9091`, served in-process at listen-time** (node: in the supervisor;
     bun-exec: in the binary) — bound early so a scrape while the runtime is up is answered.
  3. **Graceful shutdown on SIGTERM:** drain in-flight requests **and run Next.js `after()` callbacks**
     before exit (security.md / graceful-shutdown rule), within the grace cap.
  4. **Redis ISR/data-cache handler** wiring (`cache-handler.js` equivalent) — present and functional.
  5. **Bearer-authenticated, fail-closed mutating routes** `POST /api/cache/invalidate` and
     `DELETE /api/cache/events` (`CACHE_INVALIDATE_TOKEN`) — **dropping or unauthenticating these in the
     bun binary is a security.md hard-rule violation (no unauthenticated mutating endpoints).**
  6. Operator env-injection contract (DATABASE_URL, cache, HOSTNAME/PORT, etc.).
  7. **ADR-0027 module-state seam:** state the bun-exec equivalent of the `globalThis`
     `Symbol.for('knext.lib.*')` seam + the standalone-seam-alive guard, or an explicit N/A with reason.
  P2 extracts this contract; CI's `sigterm-drain-e2e` / `sigterm-hardcap-e2e` gates are parameterised
  over BOTH images, and a compat/contract check asserts routes 1–6 on the bun image.
- **Supply chain — a `bun --compile` binary is OPAQUE to Trivy/syft.** Scanning the shipped image goes
  blind, defeating security.md's SBOM-per-image + fail-on-HIGH gate. Therefore for `bun-exec`: the
  **SBOM is generated from the lockfile / pre-compile dependency closure** and attached as a **cosign
  attestation**; the **HIGH/CRITICAL scan runs against that pre-compile closure**, not the compiled
  binary; **cosign image signing + digest pinning apply unchanged**. Record this as a build-pipeline
  requirement, not an afterthought.
- **vinext fidelity bounds honesty.** vinext is a separate Vite-based reimplementation; not every Next
  feature is covered. `bun-exec` is only offered for apps that pass the **official compat suite** on the
  bun image. An app that fails compat on `bun-exec` **falls back to `node`** — same north-star bar as
  today. This is an explicit opt-in per app, never a silent default flip.
- **Default unchanged.** `node`/turbopack stays the default and the only path assumed to work for every
  app. No existing deployment changes. `bun-exec` is selected explicitly.
- **New external dependency (vinext) + Bun cross-compile/musl surface** (`sharp`/native deps for
  next/image must work under bun+musl or be excluded from the bun-exec target). Both are real risks the
  spike must retire.
- **The whole case rests on one measurement.** If the P1 OKE A/B does not show `bun-exec` decisively
  beating the ~2 s node floor **with distribution separation** (the bar this project adopted after two
  burst-knob conclusions failed to reproduce), the target is not shipped — the ADR is then recorded as
  "measured, did not deliver," and node-only stands.

## Action items (phased; measure gates the build)

- **P0** — this ADR (founder approves the vinext-deprecation amendment; done by acceptance).
- **P1a — retire the pipeline risk FIRST (feasibility done → build-through next).** On a **minimal
  App-Router sample** (no `sharp`, no adapter hooks), prove `vinext (Nitro node preset) →
  .output/server/index.mjs → bun build --compile --bytecode --target=…-musl` produces a **running
  binary** that serves requests. If it cannot, **NO-GO** — stop and record it.
- **P1b — bun entry + measure.** Add the bespoke bun entry providing the `RuntimeContract` (health;
  `:9091` in-process; SIGTERM drain + `after()`; auth cache routes). Then OKE cold-start A/B
  (`node`-baked vs `bun-exec`) via the alternating-pairs method (run 6), published as a benchmark run.
  **Gate: distribution-separated win, or stop.** Record **vinext's license + maintenance posture +
  abandonment exit stance** (it is currently beta) — a shipping target cannot depend on an unmaintained
  upstream.
- **P3 config decision:** resolve whether `bun-exec` is a new `buildTarget` field or a third
  `spec.runtime` value **in the P3 PR** (architect flagged that `spec.runtime: bun` vs `bun-exec` will
  confuse users — prefer folding into one knob). Amend this ADR in place with the outcome.
- **P2 — `RuntimeContract`.** Extract the full contract (all 7 items above); implement it for the
  bun-exec binary; parameterise CI `sigterm-drain-e2e` / `sigterm-hardcap-e2e` over both images; add a
  contract check asserting the health/metrics/auth-cache routes on the bun image. **Add a startup-order
  test (both targets):** the binary must not accept its first request before the health/`:9091`
  listeners are up — nothing covers readiness-vs-metrics-vs-first-request ordering today.
- **P3 — build pipeline.** `kn-next build --target bun-exec` (or via a new `buildTarget` config field /
  the existing `spec.runtime`); the second Dockerfile (Dockerfiles are hand-maintained, not templated —
  #439 context).
  - **P3 increment 1 (landed, #447):** a self-contained, opt-in recipe under `examples/bun-exec/` proves
    the `vinext → .output/server/index.mjs → bun --compile --bytecode` sequence and the bespoke bun entry
    providing the `RuntimeContract` (health / in-process `:9091` / SIGTERM drain + `after()` / fail-closed
    Bearer cache route). Reproducible in-repo proof **only** — NOT wired into `kn-next build`, the
    operator, the CRD, or CI's main gates, and it cites no cold-start number (the P1b OKE A/B is still the
    gate).
  - **P1b OUTCOME (2026-07-21, #460 — the recipe is NOT container-deployable; the "self-contained"
    claim is WITHDRAWN):** the P1b OKE A/B could not run. Deployed as a container (the recipe's own
    documented ship path — binary in a bare Alpine image), the compiled binary serves the framework
    404 for *every* route. `bun --compile` bakes the build machine's **absolute `.output/` path** into
    the binary, which loads its SSR/route chunks from that path at runtime — absent anywhere but the
    exact build directory (`strings`-confirmed; reproduced across three image builds as real ksvcs on
    OKE). #447's RuntimeContract validation, the P1a/P2 spikes, and benchmark run 13 all ran the binary
    **from its build directory**, where that path still resolves, masking a non-portable artifact.
    **The `bun-exec` distribution-separated-win gate cannot be evaluated until #460 is fixed** (make
    the binary portable — bundle `.output/server` into it, or resolve binary-relative). Node arm
    end-to-end cold start measured at ~2.4s median with an intermittent ~11s tail (benchmark run 16);
    the bun arm is unmeasurable. **`bun-exec` status: NOT deployable pending #460** — not "validated".
- **P4 — compat gate.** Official compat suite against the bun image; document supported feature subset +
  fallback-to-node guidance.
- **P5 — docs + benchmark.** User-facing "choosing a build target" page (qualitative); benchmark A/B.

## What is explicitly NOT authorised by this ADR
- Making `bun-exec` the default, or flipping any app to it without explicit opt-in.
- A second CRD, operator, or config surface for the bun path.
- Resurrecting the old vinext epic (#11) wholesale, or a bespoke Nitro runtime.
- Presenting `bun-exec` as faster before the P1 OKE A/B produces a separated result.
