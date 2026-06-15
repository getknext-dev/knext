# ADR-0002: Optional polyglot gRPC business-logic layer

Status: Proposed (design only — not scheduled before core maturity) · Date: 2026-06

## Context
Users want to run business logic as **language-agnostic backend services** while **Next.js stays
the HTTP gateway**. knext already leans on gRPC internally (`getCerbosClient()` uses
`@cerbos/grpc`, `packages/lib/src/clients.ts`). The ask: contract-first Protobuf services, CLI
scaffolding per language, CLI-generated Next.js glue (server-only typed clients, Server Actions,
JSON-over-HTTP routes), and each backend deployable as its own scale-to-zero Knative service.

## Decision
**Design now, build later as an optional, separately-versioned module** (`@knext/grpc` package +
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
- New package `packages/grpc` (`@knext/grpc`): codegen orchestration, generated client runtime,
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
