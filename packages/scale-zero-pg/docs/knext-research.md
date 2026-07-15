# knext platform — research notes for KS-PG integration

> Gathered 2026-07-02 from /Users/banna/alpheya/pocs/knext (+ knext-docs).
> Purpose: integrate KS-PG's single-DB scale-to-zero Postgres with knext.

## 1. What knext is

knext (aka **kn-next**) is a **scale-to-zero Next.js deployment framework for Knative/Kubernetes** — architecturally closer to OpenNext than to a PaaS, and deliberately *not* a general PaaS (`CLAUDE.md` §1, `.claude/rules/architecture.md` §5). It builds a standard Next.js app via the official Next.js Adapter API (`NextAdapter`, `experimental.adapterPath`) with `output:'standalone'`, ships it as a distroless Node/Bun image, and runs it as a **Knative Service** that scales 0↔N. Differentiators: Knative scale-to-zero ≈ Vercel Fluid Compute, V8 bytecode cold-start caching (`NODE_COMPILE_CACHE`), Redis ISR/tag cache, GCS/S3 static assets, multi-cloud/no-lock-in. TypeScript monorepo + a Go Kubernetes operator. Sources: `README.md`, `CLAUDE.md`, `ROADMAP.md`, `docs/ARCHITECTURE.md`.

## 2. Architecture

Monorepo (`pnpm-workspace.yaml`, `turbo.json`) under `packages/`:
- `kn-next` (`@knext/core`) — adapter, generators, TS CLI (`src/cli/{deploy,cr-builder,preview,cleanup}.ts`)
- `kn-next-operator` — Go operator (kubebuilder)
- `lib` (`@knext/lib`) — runtime clients incl. `getDbPool`
- `ui`; dead `admin`/`knext`
- Example app: `apps/file-manager` (Next.js 16, uses Postgres+MinIO+Redis)

Control-plane model (**ADR-0001**): the Go operator is the *single source of truth*; the CLI only builds/pushes + emits a `NextApp` CR. Per app, the operator reconciles a Knative Service, ServiceAccount, optional PVC (bytecode cache), NetworkPolicy, and opt-in KafkaSource (`packages/kn-next-operator/internal/controller/nextapp_controller.go`).

**ADRs** (`docs/adr/`): 0001 operator = single source of truth; 0002 optional polyglot gRPC business-logic layer (design-only); 0003 transport = Connect + buf; 0004 `BackendService` CRD (cluster-local h2c, no ingress); 0006 image optimization; 0007 Next.js compat suite in CI; 0008 app-namespaced object-store assets + deletion finalizer; 0009 operator-managed Kourier ingress-class; 0010 operator-managed Knative PVC feature flags; 0011 build-id-versioned assets + retention GC + skew protection; 0012 OTel tracing default-off; 0013 per-PR preview lifecycle + data isolation; 0014 rollback via Knative revision traffic split; 0015 bounded-aggregator ingest exception; 0016 async ISR revalidation + Kafka (deferred consumer); 0017 CRD stays v1alpha1.
Rules: `.claude/rules/{architecture,scs-zones,security}.md`.

## 3. Scale-to-zero story today (app tier)

Pure **Knative Serving (KPA), not KEDA**. `NextApp.spec.scaling` maps to `autoscaling.knative.dev/min-scale|max-scale` annotations + `containerConcurrency` (defaults 0/10/100). Cold-start wake = **Knative activator** (queues request, spins Pending→Running ~1s, forwards) — `docs/runbooks/incident.md`. Cold-start mitigation = V8 bytecode PVC (`spec.cache.enableBytecodeCache` → `{app}-bytecode-cache` PVC at `/cache/bytecode`; needs `spec.cache.provider`). Deep dive: `docs/operator/scaling-cold-start.md`; also `docs/knowledge/bun-bytecode-strategy.md`, `docs/spikes/0001-bun-bytecode-pipeline.md`.

## 4. Database story today (the on-point part)

**knext binds a DB, it does not run one.** Apps reach Postgres via `DATABASE_URL` from a K8s Secret, injected through `NextApp.spec.secrets.envMap` (or `envFrom`). Runtime helper: `packages/lib/src/clients.ts` `getDbPool()` = `pg.Pool` from `process.env.DATABASE_URL`, with scale-to-zero-sane bounds (`DB_POOL_MAX` default 5, `DB_POOL_IDLE_TIMEOUT_MS`) and `closeDbPool()` for SIGTERM drain (PGS-1, PR #135). Default zone DB is **PostgreSQL via CloudNativePG** (hard rule, `scs-zones.md`). `KN_DATABASE_URL` env overrides at deploy (`cli/deploy.ts:477`).

**Directly on-point docs:**
- `docs/operator/postgres-scale-to-zero.md` — CloudNativePG `Pooler`/PgBouncer transaction-mode recipe; §5 covers Neon serverless Postgres and flags "Neon self-hosting is unsupported for production".
- `knext-plan-out/database-engine/` (`assessment.md`, `issues.md`, `adr-draft-database-engine-posture.md`) — evaluates **Option C: self-hosted Postgres that scales to zero** via `xataio/cnpg-i-scale-to-zero` (hibernate-only) + a SkySQL-style connection-holding wake-on-connection proxy — *exactly the KS-PG TCP-gateway wake design*. The **draft ADR decision: knext stays engine-agnostic and builds NO DB scale-to-zero machinery itself — documents it as a recipe only.**

## 5. Deployment / reconcile model

CRD: `NextApp` (`apps.kn-next.dev/v1alpha1`), `packages/kn-next-operator/api/v1alpha1/nextapp_types.go`. Reconcile (`internal/controller/nextapp_controller.go`, ~line 125): ServiceAccount → optional bytecode PVC → Knative Service → NetworkPolicy → optional KafkaSource; `SetControllerReference` for GC; deletion finalizer `apps.kn-next.dev/external-cleanup` (`finalizer.go`, `external_cleaner.go`); admission webhook (`internal/webhook/v1alpha1/`); rejects `:latest`. Known gap: status `Conditions` partly unpopulated. **Caveat:** `nextapp_types.go` in the working tree currently has unresolved git stash conflict markers (duplicated `ResourcesSpec`/`ObservabilitySpec`/`EnvMapEntry`) — a live merge in progress, not the real schema.

## 6. Tech stack + conventions

TS (Node 20+/Bun — CLI is Bun-only), Go (kubebuilder operator). Biome, Vitest, Turbo, changesets, pnpm. New platform services belong in the Go operator (if they reconcile cluster state) or a new package under `packages/` — but per `scs-zones.md`/ADR-0002/0004, DB-running machinery is flagged as **PaaS-drift / out-of-core**.

## 7. Zones / data sovereignty (`.claude/rules/scs-zones.md`)

Each **zone** = a Self-Contained System (own UI+logic+data) = one Knative Service. Hard rules: a zone owns its data store; **no shared database**; a zone must never connect to another zone's CNPG `-rw`/`-ro` service (enforced by `protect-zone-data-sovereignty.sh`); cross-zone data only via async Kafka domain events or the browser; DB reached via `DATABASE_URL` Secret, never a hardcoded host. This constrains a DB service to per-zone/per-namespace ownership.

## 8. Integration surface for KS-PG (database-per-app, scale-to-zero)

- **App config schema:** `packages/kn-next/src/config.ts` (`KnativeNextConfig`, incl. `infrastructure.postgres`, `secrets`) and `loader.ts`.
- **CR emission:** `packages/kn-next/src/cli/cr-builder.ts` (~line 113) translates `config.secrets.envMap` → `NextApp.spec.secrets.envMap`.
- **Env injection:** operator `nextapp_controller.go:427-441` renders `envMap` → `SecretKeyRef` and `envFrom` → secret envFrom onto the Knative pod. **This is where `DATABASE_URL` pointing at the KS-PG TCP gateway gets injected.**
- **Scaling knobs to co-tune:** `NextApp.spec.scaling` (`maxScale` × `DB_POOL_MAX` bounds backend connections) + app-side `getDbPool` (`packages/lib/src/clients.ts`).
- **Sanctioned pattern (per knext's draft ADR):** bind the gateway's `DATABASE_URL` via `spec.secrets.envMap`; run the Neon-storage StatefulSets + KEDA + TCP-gateway wake **as cluster infrastructure alongside knext, not inside the knext operator**. KS-PG is essentially the "Option C wake-on-connection proxy" that `knext-plan-out/database-engine/assessment.md` deems buildable but out-of-scope for knext core.
