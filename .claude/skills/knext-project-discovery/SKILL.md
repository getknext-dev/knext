---
name: knext-project-discovery
description: Orientation map for the knext repo — what it is, the package layout, the key files, and where the strategy/rules live. Use at the start of any knext task to locate code fast instead of re-exploring, or when asked "where is X", "how is the build/deploy/cache/operator wired", or "what are the project's rules".
---

# knext — Project Discovery

**What it is:** the scale-to-zero **Next.js Deployment Adapter for Knative/Kubernetes** —
Next.js-specific (closer to OpenNext than a PaaS). Runtime targets the **official Next.js Adapter
API**; the **Go operator is the single source of truth** for cluster state. Read `CLAUDE.md`
(strategy + hard rules), `ROADMAP.md` (tiers), `.claude/rules/architecture.md` + `security.md`,
and `docs/adr/` before non-trivial work.

## Package layout (`packages/`)
| Package | Lang | Role |
|---|---|---|
| `kn-next` (`@kn-next/core`) | TS | Framework: adapters, CLI (`src/cli/`), generators, config |
| `kn-next-operator` | Go | Kubebuilder operator — `NextApp` CRD + reconciler (**source of truth**) |
| `lib` (`@knative-next/lib`) | TS | Shared clients (Postgres/MinIO/Cerbos), health, logger |
| `ui` | TS | shadcn/ui components |
| `cli` | Go | Older deploy CLI (overlaps `kn-next/src/cli` — duplication to resolve) |
| `admin`, `knext` | — | Likely dead/duplicate (naming drift vs `kn-next`) — audit |

App: `apps/file-manager/` (demo). Docs: `docs/` (ARCHITECTURE.md is **stale** re: cache provider).

## Key files (verified)
- **Adapter:** `apps/file-manager/next-adapter.ts` — `NextAdapter` with `modifyConfig`
  (forces `output:'standalone'`) + `onBuildComplete` (uploads static/prerenders by `buildId`).
  Registered via `experimental.adapterPath` in `apps/file-manager/next.config.ts:21-23`.
- **Cache:** `packages/kn-next/src/adapters/cache-handler.js` — **Redis-backed** ISR/data cache
  (in-memory fallback when `REDIS_URL` unset). *ISR cache is Redis, NOT GCS.*
- **Runtime:** `packages/kn-next/src/adapters/node-server.ts` — **still Nitro-coupled** (legacy;
  to be retired by the adapter migration).
- **Clients:** `packages/lib/src/clients.ts` — `getDbPool()` (pg.Pool), `getMinioClient()`,
  `getCerbosClient()` (`@cerbos/grpc` — already gRPC).
- **CLI:** `packages/kn-next/src/cli/{build,deploy,shared,validate,cleanup}.ts`. `deploy.ts`
  shells docker/kubectl directly (**ADR-0001 violation** — should emit a CR);
  `generators/knative-manifest.ts:183` hardcodes `containerConcurrency: 100`.
- **Operator:** `packages/kn-next-operator/api/v1alpha1/nextapp_types.go` (`NextAppSpec`:
  image/scaling/resources/storage/cache/revalidation/secrets/observability/preview;
  `status.Conditions` defined at :144 but **unpopulated**). Reconciler
  `internal/controller/nextapp_controller.go` creates ServiceAccount + bytecode PVC + Knative
  Service + (Kafka) KafkaSource + image cache; rejects `:latest` (:66); injects
  `NODE_COMPILE_CACHE=/cache/bytecode/latest` (:201).

## Build & runtime facts
- Monorepo: **pnpm** + **Turborepo**. App build: `next build --webpack` → `output:'standalone'`.
- Runtime image: **distroless Node 22**, run `node server.js` with `NODE_COMPILE_CACHE`
  (see node-bytecode-caching skill). Also runs under **Bun** (node:http compat).
- Knative networking gotcha: **Kourier failed to program ingress on k8s 1.34** during OKE
  validation (Serving worked; route didn't) — used a direct LoadBalancer→pod as workaround.

## Hard rules (full list in CLAUDE.md §10)
Official adapter API (not Nitro reverse-engineering) · operator = single source of truth ·
proto = single source of truth for services · don't rewrite the runtime twice · gate parity on
the official compat suite · **no unauthenticated mutating endpoints** · narrow adapter, not a PaaS.

## Known issues to not propagate (CLAUDE.md §9)
Image optimization missing · `/api/cache/invalidate` unauthenticated · provider shells
(S3/Azure/MinIO thin; DynamoDB/Kafka config-only; real plane = GCS+Redis) · license MIT vs
Apache-2.0 · npm scope drift (`@kn-next` vs `@knative-next`) · light tests on core paths.

## Related skills
`nextjs-deployment-adapter`, `knative-kubernetes`, `grpc-services`, `node-bytecode-caching`,
`bun-bytecode-caching`, `turborepo`.
