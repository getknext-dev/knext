---
name: scs-zones
description: Self-Contained Systems (SCS) + Next.js Multi-Zones architecture on knext — autonomous vertical slices that own UI+logic+data, deployed as independent Knative zones with their own PostgreSQL (CloudNativePG), integrating ONLY via async Kafka events + browser/UI composition. Use this skill whenever the user mentions zones, multi-zone, self-contained systems, SCS, domain boundaries, micro-frontends, splitting an app into independent deployables, per-zone databases, data sovereignty, or "how do zones talk to each other" — even if they don't say "SCS". The hard rules here (no shared DB, no cross-zone DB reads, no SQLite/Knex shortcuts) are non-negotiable.
---

# SCS + Zones on knext

> Contract (always-on): `.claude/rules/scs-zones.md`. The PWA stitching layer that makes zones
> feel like one SPA is a companion skill: `pwa-zones`.
>
> **North-star:** knext's end goal is a **comprehensive, full-stack SCS framework** — it
> **generates** micro-frontend zones (scaffolding + contracts), **isolates** them (independent
> deploy, asset/runtime isolation), and ships the **PWA stitching** layer as a first-class
> capability. **Current state:** knext is a Next.js-on-Knative **deployment adapter**; zone
> scaffolding, micro-frontend generation/isolation, and the PWA layer are **not built yet** and
> today live as app-level recipes/templates. Read every "knext generates/owns X" below as the
> **target**, and see *Current state vs end goal* for what exists today. (Honesty rule: never
> present an unbuilt generator/command as if it ships — it doesn't yet.)

## What knext is (context)
A **scale-to-zero Next.js deployment framework for Knative** (TypeScript + Go). Data plane:
**Postgres + Redis + GCS**. **Zone databases are PostgreSQL via CloudNativePG (CNPG).** The Go
operator is the single source of truth for cluster state (ADR-0001).

## Self-Contained Systems (SCS) — definition
An **SCS** is an autonomous web application that owns a complete vertical slice of a business
domain — its **UI, business logic, and data** — and keeps working even if other systems fail. It
is the larger-grained alternative to microservices: the unit is a **domain capability**, not a
single function. (Origin: scs-architecture.org; Simon Martinelli.)

### The five tenets every SCS must satisfy
1. **Autonomous web application** — fulfils its own use cases; survives adjacent-system failure.
2. **Domain-driven ownership** — one team owns it end-to-end (DB → UI); no shared release train.
3. **Data sovereignty** — owns its data store; **no shared database**. Needs another system's
   data? Receive a **redundant copy via async events** — never read the other system's DB.
4. **UI encapsulation** — renders its own UI; a logic change and its UI ship as **one unit**.
5. **Asynchronous integration** — minimise/eliminate synchronous cross-system calls; integrate
   via async backend messaging and via the **browser** (hyperlinks, UI composition).

### Why SCS for knext
It keeps each vertical slice **whole** (vs. a monolithic frontend coupled to many services),
giving independent deploy + blast-radius containment. And it bounds a full slice in one place —
which fits an **AI agent's context window** far better than a feature scattered across repos.

## Zones — the macro-architecture (each zone = one SCS)
**Next.js Multi-Zones:** a **host** zone routes path prefixes to independently-deployed zone apps
via `rewrites` (e.g. `/catalog/*` → the catalog zone). Each zone sets a unique **`assetPrefix`**
so compiled assets never collide on the shared domain (also a `basePath` for its routes).

### Per-zone stack on the knext cluster
```
Next.js zone app   →   its gRPC BackendService(s)   →   its own PostgreSQL
(Knative Service,       (cluster-local h2c, NO           (CNPG Cluster + Pooler; read-replica/HPA;
 scale-to-zero)          public ingress — ADR-0004)        hibernate idle zones)

cross-zone: async Kafka domain events + UI composition ONLY — never a shared DB.
```
- The zone app reaches its backend(s) over h2c via `<NAME>_SERVICE_URL` (operator-injected; see
  the `grpc-services` + `knative-kubernetes` skills).
- The zone's own DB is reached via **`DATABASE_URL` injected from a K8s Secret** — never a
  hardcoded host.

### Cross-zone integration (HARD RULE)
Data flows **async** (Kafka domain events; each consuming zone keeps its **own copy** of what it
needs) and via the **browser** (links, UI composition). A zone **must not** query another zone's
database service — i.e. never connect to another zone's CNPG `-rw` (primary) or `-ro` (replica)
service. Transient cross-zone UI state (auth/theme/cart) syncs via **BroadcastChannel** (see
`pwa-zones`), not a shared store.

> A hook (`protect-zone-data-sovereignty.sh`) blocks writing a hardcoded `*-rw`/`*-ro` CNPG host
> into source — that's the cross-zone-DB-read anti-pattern. Use a Kafka event instead.

### Adding a zone (recipe)
**End goal:** one command — `kn-next generate zone <name>` — scaffolds all six steps below from a
zone template (the framework owns this). **Today:** these are **manual** steps (no generator
exists yet; only `infrastructure.ts` + `knative-manifest.ts` generators ship). The steps are the
contract the future generator will automate:
1. **Scaffold the Next.js app** with a unique `basePath` + `assetPrefix`.
2. **Add host `rewrites`** routing `/<zone>/*` to the new zone.
3. **Declare its `ZoneDatabase`** (a CNPG `Cluster` + `Pooler`) — its own store.
4. **Define its `BackendService`(s)** with **proto contracts** (proto = SSOT; see `grpc-services`).
5. **Wire cross-zone needs as Kafka events** (publish/consume; keep a local projection) — not a
   sync call or DB read.
6. **Deploy as its own Knative Service** (scale-to-zero; operator reconciles).

### Micro-frontend generation & isolation (end goal — not built yet)
The north-star is for knext to **own** zone generation and isolation as framework features, not
hand-rolled app code:
- **Generation:** a `generate zone` scaffolder emits the Next.js app (basePath/assetPrefix), the
  `ZoneDatabase` + `BackendService` manifests, proto stubs, and host-`rewrites` wiring — from one
  template, so every zone is consistent and the SCS tenets are structurally enforced.
- **Isolation:** each zone is independently deployable and **asset-isolated** via per-zone
  `assetPrefix` (no bundle collisions on the shared domain). Stronger **runtime isolation**
  (Module Federation / version-pinned shared deps so independently-released zones don't break each
  other) is part of the target, layered in with the PWA stitch (see `pwa-zones`).
- **Status:** none of the above generators/commands exist today — they are the roadmap. Don't cite
  `kn-next generate zone` or a federation runtime as a current feature; gate them behind the
  adapter migration + Tier-A correctness (see *Sequencing*).

### Anti-patterns (reject these)
- Shared database, or **cross-zone DB reads** (connecting to another zone's `-rw`/`-ro`).
- **Synchronous cross-zone chains** for core user flows (couples availability; defeats
  autonomy). Async events + local copies instead.
- **Sharing runtime business logic** across zones (a code dependency re-couples them). Build-time
  **design tokens / static UI kit** are fine; runtime shared services are not.
- SQLite/Knex "just for now" shortcuts in a zone — zones use CNPG Postgres.

## Current state vs end goal (load-bearing)
The end goal is a **comprehensive full-stack SCS framework**; the boundary below is a **sequencing
line for today**, not a permanent "this never belongs to knext."

**knext owns today (current state):** Knative/scale-to-zero, the official Next.js adapter, per-zone
deploy, `assetPrefix` wiring, serving the App Shell, the `infrastructure.ts` + `knative-manifest.ts`
generators. The Service Worker / SWI / BroadcastChannel / Module-Federation machinery is **not in
the framework yet** — it lives as an **app-level recipe** (`pwa-zones`).

**knext will own (end goal / north-star):** zone **generation** (the `generate zone` scaffolder),
micro-frontend **isolation** (asset + runtime isolation, incl. Module Federation), and the **PWA
stitching** layer as a generated, first-class capability — so a team gets a whole SCS slice from a
template instead of wiring it by hand.

**The line for now:** until the framework absorbs them, keep that MFE/PWA *runtime* code out of the
core packages (`packages/kn-next`, `packages/cli`, the operator) and in the app template — a
**phasing guard**, not a verdict. (Advisory hook: `protect-core-vs-app-boundary.sh`.) This keeps
the adapter-migration + correctness work uncluttered before the framework grows into the full goal.

## Sequencing
Fame-first phase: zone generation, MFE isolation, and the PWA layer stay **design + app-level
template**, landed into core **after** the official-adapter migration (Phase 0) and Tier-A
correctness — then promoted into the framework toward the full-stack SCS goal (see `ROADMAP.md`).
North star for the credibility phase remains **verified-adapter status**; the comprehensive SCS
framework is the larger end-state that builds on it.

## Related
`pwa-zones` (the stitching layer), `grpc-services`, `knative-kubernetes`, `postgres`,
`nextjs-deployment-adapter`. Contract: `.claude/rules/scs-zones.md`.
