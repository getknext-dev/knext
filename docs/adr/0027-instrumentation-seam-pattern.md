# ADR-0027 — Instrumentation→app collaborator wiring: prefer direct-pass; anchor unavoidable module-state seams on `globalThis`

- **Status:** Accepted
- **Date:** 2026-07-17
- **Relates to / upholds:** ADR-0012 (OTel tracing backend — the
  `registerOTel` direct-pass path this ADR endorses), ADR-0001 (operator =
  single source of truth; unchanged — this is a runtime-bundling rule, not a
  cluster-state one). Depends on the `@knext/lib`-stays-OTel-free dependency
  inversion that motivates the seams.
- **Scope:** Any collaborator wired from `apps/*/src/instrumentation.ts` and
  read by the app server — specifically the `@knext/lib` seams
  `setPoolInstrumentor` (`packages/lib/src/clients.ts`) and
  `setTraceIdProvider` / `setCorrelationIdProvider`
  (`packages/lib/src/context/index.ts`); and the build-artifact guard
  `apps/file-manager/standalone-seam-alive.test.ts` (#344).

## Context

Three shipped observability features — `knext_db_wake_*` (#345) and
correlation-id propagation (#318/#346) — were silently INERT in production
despite green unit tests. Root cause (#352):

- `@knext/lib` exposes **dependency-inversion seams** so the library stays
  OTel-free: `instrumentation.ts` installs a collaborator
  (`setPoolInstrumentor(...)`, `setTraceIdProvider(...)`,
  `setCorrelationIdProvider(...)`) and the app later reads it
  (`getDbPool()` etc.).
- Next.js compiles `instrumentation.ts` in a **separate webpack layer** from the
  app-server bundles and **bundles** `@knext/lib` into each layer (it is not
  externalized). In the production standalone build the two layers therefore
  hold **two physical copies** of `@knext/lib/clients` with independent
  module-level `let` state. Evidence: distinct webpack module ids **78719** vs
  **98144** for `@knext/lib/clients` across the layers.
- The writer set the seam on copy A; the reader read the still-no-op copy B. The
  pool was never wrapped; the metrics/correlation were dead. Unit tests passed
  because a single test process has ONE module instance — the duplication only
  exists in the split standalone bundle.

By contrast, the metrics that **never broke** (golden signals #315, cold_start
#317) are passed **directly** into `registerOTel(...)` inside
`instrumentation.ts` (ADR-0012). They cross no module-state seam, so no
duplicated-state hazard exists for them.

## Decision

1. **Prefer direct-pass across the instrumentation→app boundary.** Where a
   collaborator can be handed directly to the consumer at the point of wiring —
   as OTel `SpanProcessor`s are passed into `registerOTel(...)` — do that. A
   value passed by reference cannot be desynchronized by webpack-layer
   duplication, so this path is structurally immune to the #352 class.

2. **A module-state setter seam is a last resort, permitted only when direct-pass
   is genuinely impossible** — e.g. keeping `@knext/lib` OTel-free via dependency
   inversion, where the library must NOT import the OTel SDK and so cannot receive
   the collaborator through its own construction.

3. **When a seam is unavoidable, its mutable state MUST be anchored on
   `globalThis` via a namespaced `Symbol.for('knext.lib.*')` key — NEVER a bare
   module-level `let`.** `Symbol.for(...)` uses the process-global symbol
   registry, so every physical copy of the module resolves the SAME cell
   regardless of how many webpack layers bundled it. This is the #352 fix
   (`Symbol.for('knext.lib.clients.poolInstrumentor')`,
   `Symbol.for('knext.lib.context.state')`).

4. **Every such seam MUST be covered by the build-artifact guard**
   (`apps/file-manager/standalone-seam-alive.test.ts`, #344), which asserts the
   seam symbols co-occur in BOTH the instrumentation (writer) chunk and an
   app-server (reader) chunk of the REAL `next build` standalone output. **And
   `@knext/lib` MUST stay bundled, not externalized** — it must never be added to
   `serverExternalPackages`, since externalizing changes dedup and re-splits the
   state.

## Options considered

| Approach | Survives webpack-layer duplication | Keeps `@knext/lib` OTel-free | Verdict |
| --- | --- | --- | --- |
| **Direct-pass into `registerOTel`** | yes (by reference) | yes | **Preferred** |
| Module-state seam on `globalThis` + `Symbol.for` | yes (process-global cell) | yes | **Accepted for unavoidable seams** |
| Module-state seam with a bare module-level `let` | **no** (per-copy state) | yes | **Rejected — the #352 bug** |
| Import the OTel SDK directly into `@knext/lib` | yes | **no** | Rejected — violates the dependency inversion |

## Consequences

- The two existing `@knext/lib` seams were migrated to the `globalThis` +
  `Symbol.for` pattern in #352 (`clients.ts`, `context/index.ts`); the
  duplicated-state mechanism is proven at the unit level by
  `seam-duplication.test.ts` and in the shipped artifact by the #344 guard.
- New instrumentation→app wiring defaults to direct-pass; a reviewer treats a
  new bare-`let` seam as a defect. Any new seam must ship its guard coverage and
  must not move `@knext/lib` into `serverExternalPackages`.
- ADR-0012 is unchanged and reinforced: its `registerOTel` direct-pass is the
  reference for the preferred path; the `@knext/lib`-OTel-free dependency
  inversion that ADR-0012 relies on is exactly what makes the (now-safe) seams
  necessary.
