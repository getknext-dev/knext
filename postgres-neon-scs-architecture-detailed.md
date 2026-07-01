# Scale-to-Zero Postgres Platform on Knative — Detailed Architecture & System Design (Neon-based)

**Status:** Draft for review (supersedes the PGlite-based plan)
**Architecture style:** Self-Contained Systems (SCS) — one database per system
**Compute engine:** Native PostgreSQL (Neon compute — stock Postgres + the `neon` extension)
**Storage engine:** **Reused from Neon** (open source, Apache-2.0): safekeepers + pageserver + object storage
**Design intent:** reuse as much of Neon as possible; build only the thin glue that makes it
self-hostable and scale-to-zero on Knative/KEDA.

---

## Table of contents

1. What changed and why
2. Goals and non-goals
3. Architectural principles
4. Reuse-vs-build: the centerpiece
5. Topology — three planes
6. Component deep dive
7. Data flows
8. Consistency and correctness model
9. Scale and capacity
10. Reliability, failure modes, and DR
11. Self-hosting on Knative — specifics and the TCP-wake wrinkle
12. Trade-offs
13. Architecture Decision Records
14. Delivery roadmap
15. Open questions and due diligence

---

## 1. What changed and why

The previous plan used PGlite (embedded Postgres-in-WASM) and therefore had to **hand-build** the
durability and replication machinery PGlite lacks: an external WAL service, a snapshot/checkpoint
subsystem, a WAL-tailer for read replicas, and a lease/epoch fencing mechanism. That is a lot of
distributed-systems surface to own.

Switching the compute engine to **native PostgreSQL via Neon** removes nearly all of it, because
Neon already separates compute from storage and ships exactly those components as open source.
The new shape is:

- **Take Neon's storage plane wholesale** — safekeepers (durable WAL), pageserver (page
  materialization + object-storage offload), storage broker, storage controller. This *is* the WAL
  service, the snapshot subsystem, the replication channel, and the single-writer authority, all at
  once, already built and battle-tested.
- **Run native Postgres as the compute unit.** Neon compute is stock Postgres with the `neon`
  extension that redirects page reads to the pageserver and WAL to the safekeepers. It is
  **stateless**: it can be killed and restarted freely; cold start does **not** restore data, it
  just connects to storage and fetches pages on demand (~300–500ms).
- **Build only the Knative/KEDA glue**: per-system compute scale-to-zero, wake-on-connect routing,
  and SCS↔tenant provisioning. This is the part Neon's proprietary cloud control plane provides
  that is not turnkey in the self-host path — and it is small.

Two constraints from the PGlite plan **disappear**: cold start is now fast *regardless of database
size* (no more "small DB only" assumption), and read replicas are *cheap* (they share one
pageserver instead of each holding a full copy, so the per-replica memory ceiling is gone).

---

## 2. Goals and non-goals

### Goals

- **Scale-to-zero per system** — idle systems consume no compute; storage persists independently.
- **Fast cold start** — sub-second wake via Neon's lazy page fetch.
- **Cheap read scale-out** — multiple read-only computes per system share one pageserver.
- **Single-writer correctness** — intrinsic to Neon (one primary compute per timeline).
- **Self-hostable on our own Kubernetes/Knative**, not dependent on Neon's SaaS control plane.
- **Reuse over reinvention** — minimize bespoke distributed-systems code.

### Non-goals (this phase)

- Building any storage-engine internals (we operate Neon's; we do not fork it).
- Horizontal **write** scaling within one system — single primary per system is accepted (SCS
  sizing makes this fine); writes route through safekeepers.
- Cross-region active/active. Single-region with object-storage-backed DR.
- Re-implementing Neon's managed HA/backup/monitoring UX (self-hosting requires setting these up).

### Non-functional assumptions (validate)

| # | Assumption | Consequence if false |
|---|---|---|
| A1 | We can operate a small Neon storage cluster (safekeepers ×3, pageservers, broker, controller) | Use managed Neon/Aurora instead of self-hosting |
| A2 | Per-system write rate fits one primary through the safekeeper WAL path | Benchmark; consider partitioning the system |
| A3 | Sub-second cold start is acceptable for first-request latency | Pin `minScale: 1` for always-hot systems |
| A4 | The community operator (or raw components) is maintainable for us | Fall back to raw component deployment / managed Neon |
| A5 | Local NVMe + S3-compatible object storage are available in our cluster | Storage performance and cost change materially |

---

## 3. Architectural principles

1. **Compute is disposable; storage is the database — literally (Neon's model).** Durable truth
   lives in safekeepers (recent WAL) and object storage (history), independent of any running
   compute. This is no longer a principle we implement; it is one we adopt by using Neon.
2. **Reuse the wheel; build only the axle.** Every component that is generic database
   infrastructure (WAL durability, page storage, replication, branching, PITR) comes from Neon.
   We build only what is specific to *our* platform: SCS mapping and Knative-native scale-to-zero.
3. **Single writer, many readers — native.** Neon is a single-writer/multi-reader system per
   timeline; the safekeeper/storage-controller layer is the single-writer authority. We do not
   build a lease.
4. **Durability is uniform and strong; tiering becomes a modeling choice.** Safekeepers give every
   system the same strong WAL durability cheaply, so the old per-system "durability dial" is gone.
   "Record vs projection" survives only as an SCS *modeling* distinction (is this DB the source of
   truth or a rebuildable view of an event log?), not as a storage knob.
5. **Knative owns the compute lifecycle; Neon owns everything below it.** The boundary is crisp:
   above the Postgres wire, Knative/KEDA scales and wakes; below it, Neon stores and serves.
6. **Stay at Neon's edge, honestly.** If we cannot operate Neon's storage cluster, the correct
   move is managed Neon or Aurora serverless — not a half-built clone.

---

## 4. Reuse-vs-build: the centerpiece

This is the heart of the revision. The left column is taken as-is from Neon (Apache-2.0); the
right column is what we build.

| Capability | **Reused from Neon (OSS)** | **We build / operate** |
|---|---|---|
| Durable WAL | Safekeepers (quorum-replicated WAL) | Deploy + size them (×3) |
| Page storage | Pageserver (GetPage@LSN, immutable layers, S3 offload) | Deploy + size them |
| Cold start | Stateless compute + lazy page fetch | — (free) |
| Read replicas | RO computes sharing the pageserver | Wake/scale them via KEDA |
| Single-writer | Storage controller + safekeeper protocol | — (free) |
| Branching / PITR | Native CoW timelines, GetPage@LSN at any LSN | Expose via provisioning API |
| Connection pooling | Built-in PgBouncer-based pooler | Wire it into the gateway |
| Object storage | S3/MinIO integration | Provide the bucket |
| Storage orchestration | Storage controller; `molnett/neon-operator` CRDs | Operate the operator |
| **Compute scale-to-zero** | (Neon's *cloud* control plane does this) | **Build on Knative/KEDA** |
| **Wake-on-connect routing** | (Neon's `proxy` does this in cloud) | **Gateway: route + wake + R/W split** |
| **SCS ↔ tenant mapping** | — | **System registry + provisioning** |

The takeaway: the genuinely novel work shrinks to three things — the **compute scale-to-zero
controller**, the **wake-on-connect gateway**, and the **SCS provisioning layer**. Everything else
is configuration and operation of existing software.

---

## 5. Topology — three planes

```
                         ┌──────────────────────────────────────────────┐
  external clients       │            ROUTING PLANE (we build)           │
   (pg wire / pooled)    │  gateway: system_id → tenant/timeline/compute │
        │                │  wake-on-connect · read/write split · pooling │
        ▼                └──────────────────────────────────────────────┘
   ┌──────────┐                    │ scale 0↔1 (writer) / 0↔N (readers)
   │ GATEWAY  │────────────────────┤
   └────┬─────┘                    ▼
        │            ┌──────────────────────────────────────────────┐
        │            │     COMPUTE PLANE (Knative/KEDA, we build)    │
        │  writes →  │  per-SCS PRIMARY compute (Postgres+neon ext)  │
        │  reads  →  │  per-SCS READ-REPLICA computes (RO)           │
        │            └──────────────────────────────────────────────┘
        │                    │ WAL out            ▲ GetPage@LSN
        ▼                    ▼                    │
   ┌──────────────────────────────────────────────────────────────────┐
   │                STORAGE PLANE  (reused from Neon, OSS)             │
   │  Safekeepers (WAL quorum)  →  Pageserver (pages, S3 offload)      │
   │  Storage broker · Storage controller · control-plane Postgres    │
   │                          Object storage (S3/MinIO)               │
   └──────────────────────────────────────────────────────────────────┘
```

**SCS mapping.** Each self-contained system = one Neon **tenant** (project) with a **main
timeline** (branch). Per system there is one primary compute (read-write) and zero or more
read-only computes. Future in-system multi-tenancy = additional timelines/branches (or tenants)
per sub-tenant; per-PR/preview databases come free from branching.

---

## 6. Component deep dive

### 6.1 Storage plane (reused from Neon)

- **Safekeepers** — the redundant WAL service; the primary compute streams WAL to a quorum, and a
  write is durable once the quorum acknowledges. Run **3** for production redundancy, ideally
  across failure domains. This *replaces the entire custom WAL service* from the PGlite plan and is
  also the single-writer authority (only the current primary streams WAL).
- **Pageserver** — ingests WAL from safekeepers, reorganizes it into immutable layer files,
  uploads to object storage, and serves `GetPage@LSN` to computes. It is the disk cache and the
  page-materialization engine; scaling out pageservers scales read I/O. Secondary pageservers hold
  up-to-date copies for fast failover. This *replaces the snapshot/checkpoint subsystem and the
  lazy-VFS* we would have built.
- **Storage broker** — lightweight coordination between safekeepers and pageservers.
- **Storage controller** — the orchestrator: assigns tenants/timelines to pageservers and
  safekeepers, monitors health, and reconfigures computes (notify-attach hooks) when their storage
  backend changes. This *replaces the custom control-plane assignment logic*.
- **Object storage (S3/MinIO)** — bottomless, immutable, ~11-nines-durable history and the basis
  for branching and PITR.
- **Control-plane Postgres** — a small, conventional Postgres the storage controller/operator use
  for their own metadata (required by the operator).
- **Deployment** — `molnett/neon-operator` provides CRDs (`NeonCluster`, `NeonProject`=tenant,
  `NeonBranch`=timeline) that stand up the above as Kubernetes workloads with persistent NVMe
  volumes and S3. (Maturity caveats: see ADR-004 and §15.) Raw component deployment via the Neon
  images + `neon_local`/Helm-style manifests is the fallback if the operator is unsuitable.

### 6.2 Compute unit (native Postgres, reused)

Stock PostgreSQL plus the `neon` extension and `compute_ctl`. **Stateless:** on start it attaches
to a tenant/timeline at an LSN and serves queries, fetching pages on demand from the pageserver
(with a local file cache for hot pages) and streaming WAL to safekeepers. There is exactly **one
primary** (read-write) per timeline and any number of **read-only** computes at a chosen LSN. Warm
query latency is comparable to ordinary Postgres; the compute↔pageserver hop adds single-digit ms
on cold page fetches, absorbed by the local cache for typical OLTP.

### 6.3 Compute scale-to-zero controller (we build — Knative/KEDA)

The glue that replaces Neon's proprietary suspend/resume. Responsibilities:

- Scale each system's **primary** compute 0↔1 and its **read-replica** computes 0↔N based on
  demand, using **KEDA** `ScaledObject`s (KEDA is the better fit than Knative Serving here because
  the trigger is a Postgres TCP connection, not HTTP — see §11).
- Drive scale-to-zero on idle (no connections for a configurable window) and scale-up on a wake
  signal from the gateway.
- Because compute is stateless, scaling to zero is safe: nothing is lost; storage persists.

### 6.4 Gateway / proxy (we build, reuse Neon `proxy` where possible)

**Responsibility.** Single Postgres-wire entry point. Resolves `system_id` → tenant/timeline and
the right compute endpoint; **wakes** a sleeping compute on connect (triggering the §6.3
controller) and buffers the connection during the ~300–500ms cold start; performs the **read/write
split** (writes → primary; reads → a read-replica caught up to the needed LSN); and provides
**pooling** (reuse Neon's built-in PgBouncer pooler, or PgBouncer directly).

**Build vs reuse.** Neon's own `proxy` component already does SNI-based routing + compute wake, but
is coupled to Neon's cloud control-plane API; evaluate reusing it versus a thin custom gateway that
calls the KEDA/Kubernetes API to wake computes. Start with whichever is less integration work for
our control plane (ADR-003).

### 6.5 SCS registry & provisioning (we build)

A small service + schema mapping `system_id → {tenant_id, timeline_id, tier}`, and a provisioning
API that creates a Neon tenant+timeline per new system (via operator CRDs or the storage-controller
API) and registers routing. Branch creation (for previews/PRs) is exposed here as an O(1)
operation.

### 6.6 Observability (we build, integrate Neon's)

- **Per system:** cold-start (wake) latency, primary vs replica routing, replica lag (LSN delta),
  connection counts, WAL throughput, pageserver cache hit ratio.
- **Storage plane:** pageserver/safekeeper metrics (exposed on their metrics endpoints), object
  storage error/restore rates, storage-controller assignment/failover events.
- **Fleet:** active compute count, scale-to-zero rate, per-system idle detection. Treat "never
  scales to zero" as alertable — frontend polling (health checks, query intervals, websockets) is
  the usual culprit.

---

## 7. Data flows

**Cold start (the headline).** request → gateway → compute is at zero → gateway triggers KEDA to
scale primary 0→1 and buffers the connection → compute starts, attaches to tenant/timeline, fetches
pages on demand from pageserver (no full restore) → gateway proxies the connection. Sub-second in
the typical case.

**Write.** client → gateway → primary compute → executes → streams WAL to safekeeper quorum →
durable on quorum ack → pageserver ingests WAL asynchronously and materializes pages. Single
primary per timeline guarantees one writer.

**Read (replica).** read → gateway → a read-only compute → serves from local cache or
`GetPage@LSN` against the pageserver. Eventually consistent relative to the primary; read-your-
writes via LSN-aware routing (to the primary, or a replica caught up to the client's last write
LSN).

**Branch / PITR.** provisioning API → create timeline as a CoW pointer at an LSN (O(1), no copy) →
spin a compute on it. PITR = attach a compute at a target historical LSN.

**Failover.** Primary compute lost → reschedule a new primary (storage persists; recovery is
seconds–minutes, no data loss). Pageserver lost → storage controller reassigns the tenant to a
secondary pageserver via heartbeat-driven failover. Safekeeper lost → WAL quorum tolerates it.

---

## 8. Consistency and correctness model

- **Within the primary:** full Postgres semantics (real MVCC, concurrent connections) — it is
  ordinary Postgres, so none of PGlite's single-user serialization limits apply.
- **Durability:** a committed write is durable once a safekeeper quorum acknowledges its WAL —
  survives any single safekeeper loss.
- **Read replicas:** eventually consistent, bounded by replication/ingest lag; strong
  read-your-writes via LSN-aware routing.
- **Single-writer invariant:** intrinsic — one primary compute per timeline, enforced by the
  storage layer. No bespoke fencing.

---

## 9. Scale and capacity

- **Writes per system:** one primary's throughput, with the safekeeper WAL path adding overhead
  versus co-located Postgres — fine for SCS-sized write rates; benchmark for any write-heavy system
  (event ingestion, logging) and partition that system if needed (A2).
- **Reads per system:** scale by adding read-only computes that **share** the pageserver — cheap,
  with no per-replica full-copy memory cost (the key improvement over the PGlite reader fan-out).
- **Storage:** scales independently — pageservers scale read I/O; object storage is effectively
  unbounded.
- **Fleet:** per-system isolation via tenants; shared backplanes (safekeepers, pageservers,
  storage controller, object storage) scale horizontally and are amortized across all systems.
- **Cold start:** sub-second regardless of DB size; pin `minScale: 1` only for always-hot systems.

---

## 10. Reliability, failure modes, and DR

| Failure | Behavior | Why it is safe |
|---|---|---|
| Primary compute crash | Reschedule new primary (secs–mins); storage intact | Compute is stateless; WAL durable in safekeepers |
| Read-replica crash | Drop from read pool; respawn and re-attach | Replicas are disposable |
| Pageserver loss | Storage controller fails tenant over to a secondary pageserver | Heartbeat-driven reassignment |
| Safekeeper loss | WAL quorum tolerates one loss | Quorum replication |
| Object storage outage | Running computes serve cached pages; new attaches/branches blocked | Durable history unaffected |
| Control-plane Postgres down | Steady-state serving continues; provisioning/failover pauses | Off the hot query path |

**DR.** Object storage holds durable history (optionally cross-region replicated); RPO is bounded
by WAL ingest/upload lag, RTO by compute attach time. PITR is native (attach at a target LSN).
**Caveat:** self-hosting means *you* set up cross-region replication, backup verification, and
monitoring — Neon's managed service does these for you; the OSS components provide the mechanisms,
not the turnkey operations.

---

## 11. Self-hosting on Knative — specifics and the TCP-wake wrinkle

- **Knative Serving is HTTP/gRPC-first; Postgres speaks TCP on 5432.** Knative's activator buffers
  *HTTP* requests during 0→1; it does not natively wake a pod on a raw Postgres TCP connection.
  Therefore the **compute plane uses KEDA** (scale 0↔1/0↔N on a connection-demand trigger surfaced
  by the gateway), while **Knative Serving remains the right tool for the HTTP-facing SCS
  application** workloads. "Self-host on Knative" in practice means: Knative for the app tier, KEDA
  for the DB-compute tier, both on the same cluster.
- **Wake path.** The gateway accepts the Postgres connection, checks compute liveness, triggers the
  KEDA scale-up (or reuses Neon `proxy`'s wake mechanism), holds the connection until the compute is
  ready (~300–500ms), then proxies. Tune KEDA cooldown and the gateway hold-timeout together.
- **Storage plane is *not* on Knative.** Safekeepers and pageservers are stateful, disk-bound
  services — run them as StatefulSets (via the operator), never as scale-to-zero Knative services.
- **Native sidecars are not needed here** (a departure from the PGlite plan): compute and storage
  are separate pods, so there is no in-pod DB sidecar lifecycle to manage.

---

## 12. Trade-offs

| Dimension | **Self-hosted Neon (this plan)** | PGlite-custom (prior plan) | Managed Neon / Aurora serverless |
|---|---|---|---|
| Build effort | Low (glue only) | High (build WAL/snapshot/replication) | Lowest |
| Ops effort | **High** (operate Neon storage cluster) | Medium | Lowest |
| Cold start | ~300–500ms, size-independent | ms but size-bounded | ~300–500ms (Neon) / secs (Aurora) |
| Read replicas | Cheap (shared pageserver) | Expensive (per-replica copy) | Cheap |
| Write ceiling | One primary (+safekeeper overhead) | One writer | One primary |
| Branching/PITR | Native, free | Build it | Native |
| Data sovereignty | Full (self-hosted) | Full | Vendor-hosted |
| Maturity risk | Operator is community/young | All-custom risk | Lowest |

**Reading:** this plan trades **higher operational burden** (you run a real distributed storage
system) for **dramatically lower build effort and far better capabilities** (instant cold start,
cheap replicas, native branching/PITR) than the PGlite-custom path. If the operational burden is
unacceptable, the honest alternative is managed Neon/Aurora — not the custom build.

---

## 13. Architecture Decision Records

### ADR-001 (revises prior): Native Postgres via self-hosted Neon — supersedes PGlite

**Status:** Proposed (supersedes the PGlite compute decision)
**Context:** PGlite forced hand-building WAL/snapshot/replication/fencing. Neon provides all of it
as Apache-2.0 OSS with stateless native-Postgres compute and sub-second, size-independent cold
start.
**Decision:** Use native Postgres (Neon compute) on a self-hosted Neon storage stack; build only
the Knative/KEDA scale-to-zero glue and SCS provisioning.
**Consequences:** far less bespoke code and better capabilities; in exchange, we operate a
distributed storage system. The single-user/serialization limits and reader-memory ceiling of
PGlite are gone. Revisit if operating the storage cluster proves too costly → managed Neon/Aurora.

### ADR-002 (revises prior): Reuse safekeepers + pageserver instead of JetStream + snapshots

**Status:** Proposed
**Decision:** Drop the JetStream WAL service and the custom snapshot/checkpoint subsystem; use
Neon safekeepers (durable WAL) and pageserver (page storage + S3 offload).
**Consequences:** one fewer bespoke subsystem to build and run; durability/replication/branching
come for free. Heavy-write workloads inherit the safekeeper-path overhead — benchmark.

### ADR-003 (revises prior): Compute scale-to-zero via KEDA + wake gateway; Knative for app tier

**Status:** Proposed
**Context:** Knative Serving's activator is HTTP-first; Postgres is TCP.
**Decision:** Scale DB computes with **KEDA** plus a wake-on-connect gateway (optionally reusing
Neon `proxy`); keep **Knative Serving** for HTTP-facing SCS apps. Both on one cluster.
**Consequences:** correct wake semantics for Postgres; a small amount of gateway glue; slight
heterogeneity (KEDA + Knative).

### ADR-004 (new): Deploy storage via `molnett/neon-operator` vs raw components

**Status:** Proposed — **needs evaluation**
**Context:** The operator (community, originated at Molnett, now under Lovable) deploys the full
storage plane via CRDs but is young and tracks Neon internals.
**Decision:** Pilot the operator on a throwaway cluster; pin versions; keep raw-component
deployment (Neon images + manifests) as the fallback. Do not depend on un-vetted operator behavior
in production without a maturity review.
**Consequences:** fast setup if it holds up; a tracked dependency on a third-party operator and on
Neon internal interfaces.

---

## 14. Delivery roadmap

**Phase 0 — spike.** Stand up the Neon storage plane (operator or docker-compose/raw) with MinIO;
create a tenant/timeline; connect a stock compute. *Prove:* native Postgres backed by Neon storage,
cold start after compute kill with no data loss.

**Phase 1 — SCS provisioning.** Registry + provisioning API mapping `system_id` → tenant/timeline;
create on demand. *Prove:* a new system gets an isolated database programmatically.

**Phase 2 — gateway + wake.** Wire the gateway: routing, pooling, and wake-on-connect via KEDA.
*Prove:* a connection to a slept system wakes its primary sub-second and succeeds.

**Phase 3 — scale-to-zero loop.** Idle detection → scale to zero; connection → scale up. *Prove:* a
clean 0→1→0 cycle per system under the gateway.

**Phase 4 — read replicas.** Spin RO computes; gateway read/write split + LSN-aware read-your-
writes. *Prove:* read throughput scales by adding replicas with bounded lag.

**Phase 5 — branching & PITR.** Expose O(1) branch creation and point-in-time attach. *Prove:*
instant per-PR/preview databases and a restore-to-LSN.

**Phase 6 — hardening.** HA across failure domains (3 safekeepers, secondary pageservers), DR
(cross-region object storage + restore drills), observability, and a write-throughput benchmark on
a representative system.

---

## 15. Open questions and due diligence

1. **License — resolved:** Neon storage + compute are **Apache-2.0** (verified on the repo and the
   org); Databricks has publicly committed to keeping it open. Re-confirm the license on the exact
   components/versions you ship.
2. **Operator maturity (ADR-004):** is `molnett/neon-operator` production-viable for us, or do we
   deploy raw components? Run a pilot before committing.
3. **TCP wake mechanism:** reuse Neon `proxy` vs a custom KEDA-triggering gateway — which is less
   integration work against our control plane?
4. **Heavy-write systems:** benchmark the safekeeper WAL path for any write-intensive SCS; decide
   the partitioning threshold (A2).
5. **Self-hosted HA/backup/monitoring:** scope the operational setup Neon's managed service would
   otherwise provide (cross-region replication, backup verification, alerting).
6. **Operating expertise:** do we have (or can we build) the capacity to run a Rust-based
   disaggregated storage system in production? If not, managed Neon/Aurora is the honest call.
