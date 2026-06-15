---
name: grpc-services
description: Proto-first polyglot gRPC business-logic layer for knext — Protobuf as single source of truth, Connect + buf tooling, codegen, and the Next.js gateway glue (server-only Connect clients, Server Actions, JSON-over-HTTP route handler). Use when designing/building the gRPC layer, writing .proto contracts, wiring buf codegen, or generating gateway glue. Decisions: docs/adr/0002-0004, docs/design/grpc-layer.md. Design-now / build-later (after Tier-A correctness).
---

# gRPC Business-Logic Layer (knext)

Optional, opt-in module: run business logic as **language-agnostic services** while **Next.js
stays the HTTP gateway**. **Protobuf is the single source of truth** for contracts (consistent
with operator = SSOT). **Sequencing: design now, build after Tier-A correctness** (ADR-0002) —
do not let it jump ahead of the adapter migration / compat suite.

## Transport & tooling: Connect + buf (ADR-0003)
- **buf** manages protos: `buf.yaml` (lint), `buf.gen.yaml` (codegen), `buf breaking` (back-compat
  in CI). Proto packages are versioned (`service.v1`).
- **Connect** (connectrpc.com): `connect-go` (backends), `connect-es` (the TS client the gateway
  uses). The Connect protocol speaks **gRPC + gRPC-Web + HTTP/1.1-JSON from one handler** — so the
  JSON facade needs **no separate transcoding gateway** (rejected grpc-gateway: Go-centric, extra
  transcoding + annotations, weaker TS DX; tRPC: TS-only, not polyglot).

## Codegen → `kn-next generate` (new CLI command, mirrors build.ts/deploy.ts)
Runs `buf generate`. Outputs:
- **Backend stubs** into the scaffolded service (Go `connect-go`, TS `connect-es`; Python/Rust
  fast-follow).
- **Client + message types** → `packages/lib/src/generated/` (gitignored, regenerated).
- **Gateway glue generators** (match house style — see `apps/file-manager/src/app/actions.ts`,
  `packages/lib/src/clients.ts`):
  1. **server-only client wrappers** in `packages/lib/src/grpc-clients.ts` — singleton lazy-init
     reading `<NAME>_SERVICE_URL` (same pattern as `getDbPool`/`getMinioClient`), file begins with
     `import 'server-only'` (keeps the client out of the browser bundle).
  2. **Server Actions** — `'use server'` wrappers per mutation RPC, adding `revalidateTag(...)`.
  3. **JSON facade** — one catch-all `app/api/[service]/[...connect]/route.ts` mounting the
     Connect router (no per-route hand-rolling; browsers/3rd parties get JSON natively).
- **Drift gate:** `kn-next generate --check` fails CI if generated output ≠ committed contract.

## Deployment (ADR-0004)
Each backend = a `BackendService` CR → operator creates a **cluster-local, scale-to-zero Knative
Service over h2c** (port named `h2c`, `visibility: cluster-local` → no public ingress).
`NextApp.backends` → operator injects `<NAME>_SERVICE_URL`. See knative-kubernetes skill.

## Security
Cluster-local by default. Gateway→backend auth: Phase-1 shared signed token via a generated
Connect interceptor (operator-provisioned Secret) + NetworkPolicy; Phase-2 **mTLS** via Istio.
**No unauthenticated mutating endpoints** — applies to backends too.

## Request flow
Server Component / Action → generated **server-only** Connect client → `http://<name>.<ns>.svc`
over **h2c** → backend (scales from zero) → returns; Action calls `revalidateTag`. Browsers hit
the Connect route handler (JSON) → same backend.

## Local dev
`buf generate` (watch) + `next dev` for the gateway + run backends locally or on kind via the
operator. Generated code is never hand-edited; `--check` catches drift.

## Gotchas
- Generated code runs under the **official adapter**, not Vinext.
- Pin proto `vN` packages; `buf breaking` against `main` in CI.
- Don't expose backends publicly — `cluster-local` is the default and the security boundary.
