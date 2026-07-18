# Postgres scaling plan (post-1.0)

The canonical roadmap for how scale-zero-pg scales, and the improvements after
v1.0.0. Grounded in the intrinsic constraints of Postgres-on-Neon; every axis
states what SHIPPED vs what's PLANNED, evidence-first.

## The intrinsic constraints (why the axes are what they are)
- **Writes are single-node.** A timeline has exactly one writer producing one
  serialized WAL stream; the safekeeper quorum *enforces* single-writer (it is
  our fencing layer, CLAUDE.md rule 3). No horizontal write scaling on this
  foundation — that would be Spanner/CockroachDB, not Postgres. Write scaling is
  therefore VERTICAL (bigger writer) or ARCHITECTURAL (shard across databases).
- **Durability is offloaded to the WAL quorum** — which is exactly what makes
  compute stateless, scale-to-zero, and read replicas cheap.
- **No cross-database ACID.** Separate databases (per-app, per-zone) are
  independently consistent; coupling them is EVENTUAL (logical replication) or
  FEDERATED (FDW), never a distributed transaction.

## The four scaling axes

### 1. Write scaling — VERTICAL (per database)
| | Status |
|---|---|
| In-place CPU+mem resize of a running writer (k8s 1.33, zero restart) | ✅ proven (#67) |
| Automatic writer autoscaler (watch pressure → resize within min/max, per-app aware) | ✅ shipped (#103, v1.2) |
| Caveat: `shared_buffers` is boot-fixed → a buffer-cache-bound resize needs one bounce | ✅ handled — autoscaler *flags* (annotates) for a maintenance-window bounce, **never bounces a live writer silently** |

Ceiling honesty: one hot database's writes are bounded by the largest single
compute. Beyond that = shard (per-app / per-zone) or the wrong tool (#86 states
the measured envelope).

### 2. Read scaling — HORIZONTAL (within a database)
| | Status |
|---|---|
| RO replica pool on the PRIMARY db, HPA n>1, ~9s tip-following staleness contract | ✅ shipped (#99a) |
| Per-app RO pool (apps-gateway template-RO listener + per-app RO computes) | ✅ shipped (#127, v1.2) |
| `DATABASE_URL_RO` contract key (now LIVE → `compute-ro-<app>`, was fail-closed) | ✅ shipped (unified config + #127) |

### 3. Tenant scaling — HORIZONTAL (across apps)
| | Status |
|---|---|
| Branch-per-app: N apps, each own timeline + 0↔1 compute, one shared plane | ✅ shipped (#6) |
| Declarative provisioning (AppDatabase CRD operator) | ✅ shipped (#96) |
| ~~Unified config: `NextApp.spec.database` auto-provisions + wires~~ | ❌ **removed** 2026-07-15 (knext ADR-0025 / knext #303 — was ✅ v1.1.0); the AppDatabase CRD above stays — knext binds BYO `secretRef` only |
| Demonstrated ceiling: ~30 apps, footprint linear, WAL pin flat | ✅ measured (#86) |
| Higher ceiling (100s–1000s) = pageserver sharding | 🔮 v2 (Neon-cloud does this) |

This is the horizontal answer for aggregate write load: N apps = N independent
single-writers. Scales as long as writes partition by app/tenant.

### 4. Zone scaling — EVENTUAL consistency (across zones / SCS multi-system)
The frontier. Un-parks the original SCS ambition with a concrete mechanism.
| | Status |
|---|---|
| DB-per-zone, each own writer + read replicas (strong WITHIN zone) | ✅ Zone CRD **composes** an AppDatabase (v2-2, #139) |
| Cross-zone EVENTUAL consistency via **logical replication** (WAL-decoding: publish a table subset → subscribe) | ✅ shipping — `zone-operator` authors pub/sub (v2-2, #139) |
| Publisher scale-to-zero preserved: gateway-mediated replication-wake | ✅ v2-1 (#140); wired into subscriptions (v2-2) |
| Cross-zone LIVE reads via `postgres_fdw` foreign tables | ✅ `mode: federate` (v2-2, #139) |
| Declared data-dependencies (`Zone.spec.dataDependencies`) as the coupling contract | ✅ both-sides-agree governance gate (v2-2, #139) |

The zone axis **ships** (v2). A `Zone` CR (`deploy/86-zone-crd.yaml`,
`zones.scale-zero-pg.dev/v1alpha1`) composes an in-zone `AppDatabase` and declares
`publishes[]` (the opt-in export boundary) + `dataDependencies[]` (`{fromZone,
tables, mode: replicate|federate}`). The `zone-operator`
(`deploy/87-zone-operator.yaml`) is the sole author of the cross-zone fabric: the
per-zone `repl_<zone>` role, publications, and — per dependency — a logical-
replication subscription (conninfo → apps-gateway, so a sleeping publisher is woken
by the subscriber, #140) or `postgres_fdw` foreign tables. A dependency is wired only
when **both sides agree** (requested tables ∈ the peer's `publishes`), and a table may
be published by **at most one zone** (single-writer-per-replicated-table). Live e2e:
`deploy/_verify-zones.sh`; numbers in `docs/BENCHMARKS.md`.

Consistency model: **strong in-zone, eventual across-zone.** No cross-zone
transactions (sagas/compensation instead). The make-or-break unknown: does
`neon:8464` OSS support logical replication (`wal_level=logical`, pub/sub across
branch computes) AND survive scale-to-zero (subscriber lags asleep, catches up on
wake, bounded by publisher WAL retention — interacts with the #19 janitor). The
spike is the gate; if 8464 can't, a newer tag is a manifest-bump (#98 proved it).

## Phased roadmap
- **v1.2 (read + write axis completion):** #127 per-app read replicas · ✅ #103
  writer autoscaler (shipped — `writer-autoscaler` controller,
  `deploy/85-writer-autoscaler.yaml`, runbook in operations.md) · #104 write-heavy
  tuning docs.
- **Security & hygiene tail (parallel):** #116 wake side-channel · #117 md5→SCRAM ·
  #118 policy-CNI · #122 operator child ownerRefs · #132 cold-boot role race.
- **v2 (zone axis — the SCS frontier):** ✅ logical-replication spike (#133) →
  ADR-0007 zoned-consistency → v2-1 gateway-mediated replication-wake (#140) → v2-2
  Zone CRD + operator (#139: compose AppDatabase, publish, subscribe/federate,
  governance guards, deprovision hygiene) — SHIPPED. Remaining v2: cross-cluster /
  multi-region replication (a further spike, ADR-0007 §4e — intra-cluster only for
  now). Also: pageserver sharding for the tenant-count ceiling.

## Standing decision points
- Writer autoscaler stays a v1.x feature, not a GA gate (perf, not correctness).
- The zone axis is v2 and gated on the logical-replication spike — it reintroduces
  cross-zone data coupling (the SCS-parked trade-off), so it ships behind an ADR
  that states the consistency model plainly, never as a silent default.
