# ADR-0031 — The app template owns guarded-instrumentation; the adapter owns the edge `IgnorePlugin` fence

- **Status:** Accepted
- **Date:** 2026-07-18
- **Issue:** #356 (deferred from #344 item 3; Tier-A correctness).
- **Relates to / upholds:** ADR-0027 (the `globalThis`-anchored seam pattern the
  generated wiring depends on), ADR-0012 (OTel default-off gate — the generated
  body keeps `resolveOtelOptions` as the single switch). Extends the #342/#344
  fence from one hand-written app (`apps/file-manager`) to every generated app.
- **Scope:** the knext app template (`turbo/generators/templates/zone/`, the
  `pnpm generate` / `turbo gen zone` scaffolding), the package-shipped knext
  adapter's `modifyConfig` (`packages/kn-next/src/adapters/next-adapter.ts`),
  the graduated per-app guards (template-shipped
  `instrumentation-edge-safe.test.ts` + `standalone-seam-alive.test.ts`), and
  `apps/file-manager` (its hand-written webpack hook is removed; its guard now
  asserts the adapter-owned fence).

## Context

Three shipped observability features were silently inert in production because
app instrumentation must follow two non-obvious invariants that the platform did
not generate or enforce for new apps:

1. **Edge-safety (#342).** Next.js compiles `instrumentation.ts` for BOTH the
   `nodejs` AND the `edge` runtimes (any `middleware.ts` forces an edge build).
   The knext observability/db-wake wiring is Node-only (`@knext/lib/clients` →
   `@cerbos/grpc`/`@grpc/grpc-js`/`pg`/`minio`). It must live in a separate
   `instrumentation-node.ts`, loaded via a dynamic `await import(...)` guarded
   by `NEXT_RUNTIME === 'nodejs'`. Crucially (#344), the runtime guard stops
   EXECUTION on the edge but not BUNDLING — webpack statically traces the
   literal specifier into both runtime bundles, so an edge-scoped webpack
   `IgnorePlugin` is the load-bearing exclusion. Without all three pieces the
   production `next build` fails with `Module not found`.
2. **Seam-alive (#352, ADR-0027).** `@knext/lib`'s collaborator seams
   (`setPoolInstrumentor`, `setTraceIdProvider`, `setCorrelationIdProvider`)
   must be anchored on `globalThis` via `Symbol.for('knext.lib.*')` (done in
   `@knext/lib`), AND `@knext/lib` must stay bundled, not externalized, or the
   standalone bundle's webpack-layer duplication silently disconnects the seam.
   **The general rule (codified in ADR-0027, restated here because it is this
   template's rationale): in code that ships inside the Next.js standalone
   bundle, prefer pure functions, direct-pass wiring, and
   `globalThis`-anchored singletons over module-level `setXProvider` seams** —
   the #352 disconnect class, where the instrumentation layer's copy of a
   module and the app-server's copy hold independent state and the wiring
   silently dies in production while unit tests (one module instance) stay
   green. The shipped `standalone-seam-alive` guard (#344) is the
   build-artifact tripwire for that class.

Until this ADR both invariants were enforced only by per-app guards in
`apps/file-manager` (#344). A NEW app scaffolded from the template inherited
none of it — the template emitted no instrumentation at all — so a generated
app could reintroduce the #342/#352 footguns invisibly (unit tests pass; only a
live deploy catches it). #354 codified the pattern as a written rule; a rule
documents the invariant for humans but leaves generated apps able to silently
break observability. This ADR makes generated apps correct by construction.

## Decision

1. **The template emits the guarded-instrumentation pair by default.** Every
   `turbo gen zone` app gets:
   - `src/instrumentation.ts` — edge-clean: no top-level Node-only import, the
     `NEXT_RUNTIME === 'nodejs'` guard, and the static-literal dynamic
     `await import('./instrumentation-node')`.
   - `src/instrumentation-node.ts` — the full platform wiring
     (`registerNode()`): OTel via `registerOTel` behind the default-off
     `resolveOtelOptions` gate, golden-signal/cold-start/db-wake metrics, the
     activity-gated deep-health scrape hook, the `globalThis`-anchored
     `@knext/lib` seam writers, and the correlation response echo. The body is
     app-agnostic (package imports only), so it is platform-authored, not
     app-authored.
   - `next-adapter.ts` + `adapterPath` wiring in `next.config.ts`, and both
     graduated guards (`instrumentation-edge-safe.test.ts`,
     `standalone-seam-alive.test.ts`, parameterized for the app name) so every
     generated app carries the gate file-manager had to grow by hand.

2. **The edge `IgnorePlugin` fence moves INTO the knext adapter's
   `modifyConfig`** (`packages/kn-next/src/adapters/next-adapter.ts`). On
   `phase-production-build` the adapter now returns a `webpack` fn that —
   composed AFTER any webpack hook the app still owns — pushes
   `IgnorePlugin({ resourceRegExp: /instrumentation-node(\.[cm]?[jt]s)?$/ })`
   on the edge compile only. App authors never hand-write the webpack hook; any
   app wired through `adapterPath` gets the exclusion by construction. The
   plugin is a no-op for apps without an `instrumentation-node` module.
   `instrumentation-node` becomes a RESERVED module name on the edge compile
   for adapter-wired apps (the pattern's own name — same as when it was
   hand-written).

3. **file-manager's hand-written hook is removed** (graduated to the adapter);
   its guard now asserts the fence is adapter-owned (`adapterPath` wired, the
   app adapter re-exports `@knext/core/adapter`, no hand-written
   `IgnorePlugin`). The end-to-end tripwires are unchanged: the PR-gated
   production `next build --webpack` still fails if the Node-only subtree ever
   reaches the edge bundle, and `standalone-seam-alive.test.ts` still proves
   the seams in the shipped artifact.

4. **What stays app-owned:** whether to enable tracing
   (`spec.observability.tracing.enabled` on the NextApp CR — default off),
   any app-specific instrumentation ADDED behind the same guard discipline,
   and the app's own webpack customizations (composed, never replaced, by the
   adapter). What stays platform-owned: the seam anchors (`@knext/lib`), the
   edge fence (the adapter), the pair shape (the template), and the guards.

## Options considered

| Approach | New apps correct by construction | No app hand-writing | Verdict |
| --- | --- | --- | --- |
| Template emits pair + adapter injects fence | yes | yes | **Accepted** |
| Template emits pair + hand-written webpack hook in generated `next.config.ts` | yes, but the fence is one deletion away from silently breaking the build | **no** | Rejected — keeps the footgun load-bearing in app code |
| Written rule only (#354) | **no** | no | Rejected — documents, does not enforce |
| CLI `kn-next create` scaffolding command | yes | yes | Deferred — the template is the existing scaffolding path; a CLI create flow can adopt the same emitted shape later |

## Consequences

- Every generated app inherits edge-safety + seam-alive by default; deleting
  the fence now requires deleting platform code guarded by
  `packages/kn-next/src/__tests__/adapter-edge-ignore-plugin.test.ts` and the
  template-shape guard
  `packages/kn-next/src/__tests__/template-guarded-instrumentation.test.ts`.
- The adapter's `modifyConfig` is load-bearing for the fence (it already was
  for `output: 'standalone'` in the compat harness). A Next.js upgrade that
  changes adapter-config handling is caught by the PR-gated production
  `next build --webpack`.
- Apps NOT wired through `adapterPath` (external apps following
  `docs/QUICKSTART.md` without the adapter) still hand-write the fence per
  `docs/observability/tracing.md`; the docs now say so explicitly.
- The zone template was modernized as enabling hygiene: it referenced a
  nonexistent `@kn-next/config` package, `@opennextjs/aws`, and the removed
  `experimental.dynamicIO` flag — a generated app could not have inherited
  anything. It now mirrors the current platform contract (`@knext/core`
  `KnativeNextConfig`, `next build --webpack`, standalone + deploy-env
  `next.config` keys).
