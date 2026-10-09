# ADR-0002: Optional polyglot gRPC business-logic layer

Status: Proposed (design only — not scheduled before core maturity) · Date: 2026-06 · Amended 2026-10-09: build re-sequenced into v2, scope fence (see the amendment at the end)

## Context
Users want to run business logic as **language-agnostic backend services** while **Next.js stays
the HTTP gateway**. knext already leans on gRPC internally (`getCerbosClient()` uses
`@cerbos/grpc`, `packages/lib/src/clients.ts`). The ask: contract-first Protobuf services, CLI
scaffolding per language, CLI-generated Next.js glue (server-only typed clients, Server Actions,
JSON-over-HTTP routes), and each backend deployable as its own scale-to-zero Knative service.

## Decision
**Design now, build later as an optional, separately-versioned module** (`@getknext/grpc` package +
a `BackendService` CRD). Contract-first: `.proto` is the single source of truth; all codegen
flows from it (consistent with ADR-0001's single-source principle). Default tooling **Connect +
buf** (ADR-0003); deployment via a new **`BackendService` CRD** reconciled by the operator
(ADR-0004); backends are **cluster-local** scale-to-zero Knative services.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Design now, build post-maturity, opt-in module (chosen)** | Keeps north-star focus; lets early adopters see the roadmap; clean boundary | gRPC users wait |
| B. Build now | Differentiates immediately | Diverts from compat-suite/verification north star; doubles surface before core is mature; "general PaaS" drift |
| C. Don't design at all | Max focus | Misses a real need; ad-hoc later |

## Scope fit (required strategic check)
This **expands scope** beyond "narrow Next.js+Knative adapter." On a fame-first timeline, the
credible win is a **verified** adapter (Phase 1), not breadth. Therefore: **do not build before
Phases 0–5.** When built, keep it opt-in and isolated so it never gates or complicates the core
adapter. Recommendation: **build later**, module-shaped, behind a feature flag/CRD.

## Consequences
- New package `packages/grpc` (`@getknext/grpc`): codegen orchestration, generated client runtime,
  generators for gateway glue.
- New `kn-next generate` CLI command (mirrors `build.ts`/`deploy.ts`) running `buf generate`.
- New `BackendService` CRD + operator controller (ADR-0004); env-based service discovery
  injected into the `NextApp` gateway.
- Generated artifacts live in `packages/lib/src/generated/` (gitignored, regenerated), with
  server-only singleton wrappers in `grpc-clients.ts` matching `clients.ts` style.

## Action items (when scheduled)
- [ ] `proto/` layout + `buf.yaml`/`buf.gen.yaml`; breaking-change CI (`buf breaking`).
- [ ] `kn-next generate` command; Go (connect-go) + TS (connect-es) outputs.
- [ ] Generators: server-only client wrappers, Server Actions, Connect Next.js route handler.
- [ ] `BackendService` CRD + controller; cluster-local h2c Knative services.
- [ ] Gateway↔service authz (ADR-0004 §security).

## Amendment (2026-10-09) — build in v2; scope fence

**Status of this amendment: Accepted.** It encodes founder decisions of 2026-10-09 (v2 plan Q10,
Q13, Q15, Q16, Q17; jev scores in the plan) that the architect and system-designer gates signed off
as part of the plan. The base ADR's own status line is left as written. Trigger-class (ADR, CRD,
security, core-vs-app boundary); per the 2026-09-22 workflow amendment it is reviewed at sprint
close, not as a merge gate. **The build it unlocks does not start until the founder's `CLAUDE.md`
sections 4, 5 and 6 edits are merged** — that is the exit criterion of the task that carries this
amendment.

### Context

The Decision above chose Option A: design now, build post-maturity. The conditions behind it have
moved. The official-adapter migration has merged, the compat gate is running, and the founder has
made zone functions the headline of the next major: each zone gets Go or Rust backend functions
called from the Next.js zone, scale-to-zero, with Next.js still the HTTP gateway.

### Decision

1. **Option A's sequencing is superseded; the module itself is unchanged.** Design and a cold-start
   spike run in the first v2 sprint; the **build starts in the second** (Q10; the plan scored
   "design and spike, then build" 0.48 against "wait for the credentials" 0.47, so this was a
   founder call, not a metric). It stays an opt-in module (`@getknext/grpc`) plus the `BackendService`
   CRD (ADR-0004), shipped at **Beta** in 2.0 (Q17: Beta 0.94). The "do not build before Phases 0–5"
   line in *Scope fit* no longer applies; its other half — opt-in, isolated, never gating the core
   adapter — still does.
2. **Contracts are proto-only.** `.proto` is the single source of truth. No OpenAPI import, no
   signature-first inference (Q15: proto-only 1.00).
3. **A function belongs to exactly one zone.** It is reachable only through that zone's generated
   glue, is cluster-local with no public ingress, and has no JSON facade by default (ADR-0052 D5).
   Bindings are **same-zone only**, enforced by the operator (ADR-0004), not by convention.
4. **Reads, writes and streams map differently.** Reads become cached server functions, writes
   become `'use server'` actions, and no stream goes through an action (details in ADR-0003).
5. **Identity travels as a short-lived signed token** (a 60 s Ed25519 JWT), verified by every
   function, with a required user-supplied `authorize()` hook; the token, not the network, is the
   authoritative control (ADR-0004). Q16: JWT 0.97, `authorize()` hook 0.91.
6. **Wake-ahead:** when a zone starts, it warms every bound function, with a per-function opt-out;
   per-route targeting is later work (Q13: all-bound 0.43 against all-plus-opt-out-then-per-route
   0.38 — a coin flip the founder settled).

### Scope fence (binding for the build)

- Not a general function platform. **No** event or cron triggers, queues, or a standalone "deploy a
  function" product; a function deploys as part of `knext deploy` of its owning zone. Anything else
  is Option B above and needs its own ADR.
- **No cross-zone calls and no cross-zone data** (`scs-zones.md`): zone A calling zone B's function
  is forbidden, and a function may not mount another zone's Secret or name another zone's database
  host. The operator rejects both.
- **No WASM in 2.0** (a future ADR is not scheduled), **no sidecar placement** (deferred), and **no
  Python, Java or TypeScript templates in 2.0**; ADR-0052 D10–D12 stays the long-term language
  matrix.
- Orchestration stays in `@getknext/grpc`; none of it leaks into `packages/kn-next` core or the
  operator's required path (ADR-0052 D8). The positioning bound is unchanged: knext is a narrow
  Next.js-on-Knative adapter, and this layer is held to that by the fence above and by the
  sprint-close drift check.

### Consequences

- gRPC users no longer wait on maturity; they wait on the second v2 sprint and on the founder's
  `CLAUDE.md` edit.
- The Consequences and Action items above stand, except that "when scheduled" is now "from the
  second v2 sprint", the generated-artifact location is governed by ADR-0052 D8, and `kn-next
  generate` is the `knext generate` verb dispatched lazily by core.
