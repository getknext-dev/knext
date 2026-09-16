# Feasibility: co-located backend + directive/decorator → packaged as a function

> **Status: PARKED behind ADR-0052 (founder decision, 2026-09).** Not being built. The extraction
> compiler is real work and is **not on the verified-adapter critical path** (CLAUDE.md §1). The
> default backend model stands: (1) logic in the Next.js server (Server Actions, already scale-to-zero)
> → (2) a proto-first `BackendService` (ADR-0052 Option A) when isolation / cross-app reuse / polyglot
> is genuinely needed. **Revisit trigger:** a concrete app that needs to *graduate* an in-server
> function to its own independently-scaled/deployed service **without a rewrite** — the one unique value
> of the directive idea (Option A′ below). Until such an app exists, this stays a design note; do not
> re-litigate. The polyglot backend story is unaffected — it lives in ADR-0052 Option A.

Research spike (founder-directed) into a DX where a developer writes backend logic **inside** the
Next.js app, marks it with a **directive** (`'use server'`-style) or **decorator**, and knext's build
**extracts** it into a Knative function (`BackendService`) and rewrites the call site into a generated
typed client. Grounded in the actual vinext/adapter build pipeline + the accepted ADRs.

## Bottom line
- **Mechanically feasible — but only on the vinext (Vite/Rollup) build path, with a *directive*, not a
  decorator.** The extract-and-rewrite pattern already exists in this codebase.
- **The literal ask (extract marked code, *infer* the client from the TS signature, no proto) is
  Option B — signature-first — which ADR-0052 (Accepted) explicitly rejected** as the TS-only/tRPC
  model ADR-0003 already ruled out for polyglot. Building it as-is reverses an accepted decision.
- **There is a clean reconciliation (Option A′): co-located TS + directive as the *authoring
  front-end*, but knext *derives a `.proto`* at extraction.** The wire contract stays proto (polyglot
  interop + ADR-0052 preserved), the DX is the co-located directive the founder wants. This does not
  reverse ADR-0052's core; it adds an authoring mode. **Recommended path — via a new ADR amending 0052,
  through the design gates. Design, not build.**

## What the pipeline actually allows (mechanism)
- vinext does **not** own `'use server'` — it delegates to the official `@vitejs/plugin-rsc`, and
  layers its own directive tooling on top. Two in-repo precedents are almost exactly the shape we need:
  - `packages/vinext/src/plugins/use-cache-callable.ts` — a directive transform (`transform` + oxc AST +
    `@vitejs/plugin-rsc/transforms` helpers + `MagicString`) that detects a directive and rewrites the
    export into a **client proxy** (`createServerReference("key#name", callServer)`) on one side and a
    **registered implementation** on the other. This is directive → call-site-proxy → RPC, already working.
  - `packages/vinext/src/plugins/action-owner-manifest.ts` — walks the **whole module graph**
    (`getModuleInfo`), discovers directive-marked code across the app, emits a **companion artifact**
    (virtual module), and rewrites references at build. This is the "discover + generate + rewrite" half.
  - `packages/vinext/src/index.ts` `multi-stage-server-output` — uses `this.emitFile({type:"chunk"})`
    to emit **independently deployable entries** mid-build. This is the "extract into a separate
    deployable artifact" half.
  So the extraction feature is a new Vite plugin composing patterns that already ship here — not from scratch.
- **Not feasible on the stock Next.js path.** knext's official `NextAdapter` exposes only
  `modifyConfig` (webpack-only; Turbopack — the Next 16.2 default — ignores it) and `onBuildComplete`
  (fires *after* compile; output already exists). Neither can discover directive-marked modules or
  rewrite call sites. **The feature is vinext-only.**
- **Decorators are a dead end today.** No `experimentalDecorators`/stage-3 decorator config in either
  repo; the directive-transform helpers operate on leading string-literal AST, which does not
  generalize to a `Decorator` node. `@rpc`/`@backend` would be net-new parser + transform work.
  **Directive first; decorator is a later ergonomic layer at best.**

## The contract fork (the real decision)
| Option | Authoring | Wire contract | Polyglot | vs ADR-0052 |
|---|---|---|---|---|
| A (current ADR-0052) | hand-authored `.proto` + separate backend | proto | yes | as accepted |
| B (the literal ask) | co-located TS, client inferred from signature | none (TS types) | **no (TS-only)** | **rejected (D1/ADR-0003)** |
| **A′ (recommended)** | **co-located TS + directive** | **proto *derived* from the TS** | **yes** | **amendment, not reversal** |

A′ keeps `connect-es` as the client and proto as the wire contract (any language can still call the
derived contract), while giving the founder the co-located directive DX. The extracted function is a
**Bun single-exec** serving connect-es/h2c (proven in `bun-func-runtime-spike.md`). Co-location is
inherently a TS authoring experience, so "only TS/Bun functions can be *co-located*" is not a real
limitation — separately-authored polyglot backends remain Option A.

## Constraints any implementation must carry
- **ADR-0027 / #352 two-graph hazard (load-bearing).** Extraction creates two module graphs (app +
  function). Any shared stateful library (`@getknext/lib`, cache clients, request-context) will
  **silently desync**. Safest: a **clean RPC boundary with no shared process state** (natural — it's a
  separate process); anything genuinely shared must use the `globalThis`+`Symbol.for` anchor, plus a
  guard scoped to the new two-artifact topology.
- **Security invariants don't get a pass for being co-located** (ADR-0052 D5/D13): the extracted
  function still needs the fail-closed token interceptor, and any mutating call still needs end-user
  auth in the generated wrapper. Backends stay cluster-local.
- **Serialization/closure boundary** (same limit as Server Actions): a co-located function that closes
  over app scope or takes non-`proto-able` types must **fail the build with a clear error**, not
  produce a broken split. "Proto-able TS" is a constrained subset (no arbitrary unions/generics; map
  `Date`/`bigint` explicitly).
- **Local dev**: the extracted function must run as a local Bun process and the client hit it without a
  cluster (Server Actions run in-process in dev — parity matters or the DX regresses).

## Precedents (this shape is well-trodden)
Next.js Server Actions / React Server Functions (`'use server'`) — the exact directive→extract→RPC
mechanism; Vercel's emerging `'use workflow'`; Encore.ts (API objects → extracted services, build-time);
Modal (Python decorators → cloud functions); Wing (inflight/preflight). tRPC/NestJS are the
signature-first/decorator points of comparison — and the reason ADR-0003 chose proto for polyglot.

## Recommendation / sequence
1. **Author an ADR amending ADR-0052** adding Option A′ (co-located TS directive → derive proto →
   extract Bun function). Run the architect + system-designer gates (this reopens the contract SoT
   question and the ADR-0027 topology — trigger-class).
2. **Directive, not decorator** (`'use backend'`/`'use function'`, TBD name); decorator deferred.
3. **Prototype after the ADR:** a vinext plugin modeled on `use-cache-callable.ts` +
   `action-owner-manifest.ts` + `emitFile`, plus the TS→proto deriver on a constrained subset, plus the
   kind-cluster activator check from `bun-func-runtime-spike.md`. vinext-only; not on the webpack/Turbopack path.
4. **`kn-next generate`** remains the CLI home (ADR-0052 already reserves it); orchestration lives in
   the opt-in `@getknext/grpc` module, never core.
