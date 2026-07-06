# ADR-0007 — Zoned consistency: DB-per-zone, strong in-zone, eventual across-zone via logical replication

- **Status: PROPOSED — pending owner approval.** Design record only. This ADR
  is the design gate for the **zone-scaling axis** (`docs/SCALING.md` §4, the v2
  frontier). **No zone code is written against it until the owner ratifies** the
  open decisions below and gives an explicit go on building v2.
- **Date:** 2026-07-06
- **Deciders:** architecture owner (to ratify); design by the scale-zero-pg lane,
  grounded in spike #133 (live evidence on OKE, context `context-ckmva7v7zvq`,
  ns `scale-zero-pg`).
- **Gated by:** #133 — **spike COMPLETE, verdict VIABLE** (logical replication on
  `neon:8464`, survives scale-to-zero in every direction incl. worst case).
  Findings: `docs/spikes/133-logical-replication.md`.
- **Closes (design):** #134.
- **Relates to:** ADR-0003 (branch-per-app: template timeline, per-app compute,
  apps-gateway `template` routing); ADR-0004 (BUILD the AppDatabase CRD operator);
  ADR-0006 (the `AppDatabase`/`NextApp` cross-namespace delegation contract — zones
  extend this pattern); `docs/SCALING.md` §4; issue #19 (the wal-janitor).
- **Un-parks:** the SCS multi-system / data-sovereignty-zone ambition parked in
  ADR-0003 and MEMORY (`ks-pg-scope-pivot-single-db-knext`). This ADR re-opens it
  **deliberately and with eyes open** — it reintroduces cross-database data
  coupling, which is exactly the concern that parked SCS. See §5 (SCS trade-off).

---

## OPEN DECISIONS FOR THE OWNER (read first)

These are the load-bearing choices this ADR surfaces but does **not** decide. No
implementation should start until they are ratified.

1. **Go / no-go on building v2 (the zone axis) at all.** The spike proves it is
   *possible* on the shipped image; this ADR argues it is *coherent*. Building it
   re-introduces cross-zone data coupling (§5). **Owner call: proceed to v2, defer,
   or keep parked.**
2. **The publisher-wake-path (THE key open decision).** Replication connects
   *directly* to a peer compute Service, **bypassing the apps-gateway**, so nothing
   wakes a sleeping publisher for a subscriber. Three options in §4c.
   **Recommendation: (i) warm-publisher-while-subscribed for phase 1, (ii)
   gateway-mediated replication-wake as the phase-2 target.** Owner to pick.
3. **Is a zone a NEW `Zone` CRD, or an `AppDatabase` with a zone role?**
   **Recommendation: a new thin `Zone` CRD that *composes* an `AppDatabase`** (§1).
   Owner to confirm vs extending `AppDatabase.spec`.
4. **Phasing.** **Recommendation: intra-cluster (one storage plane) FIRST** —
   everything the spike proved. Cross-cluster / multi-region is a further spike
   (§4e) and MUST NOT be claimed until proven. Owner to confirm the phase-1 scope.
5. **Consistency model acceptance.** This axis is **strong in-zone, eventual
   across-zone, NO cross-zone ACID** (§5). Multi-zone workflows use
   sagas/compensation. Owner to accept this as the stated, documented contract
   (per the `docs/SCALING.md` standing rule: never a silent default).

---

## Context

The four scaling axes (`docs/SCALING.md`) are, by Postgres-on-Neon's intrinsic
constraints: (1) vertical write, (2) horizontal read within a DB, (3) horizontal
tenant across apps, and (4) **zone** — the frontier. Axes 1–3 all live *inside a
single writer's consistency domain*: a timeline has exactly one writer and one
serialized WAL stream (the safekeeper quorum is the fencing layer, CLAUDE.md rule
3), so everything within one database is **strongly consistent**. There is **no
cross-database ACID** on this foundation — that would be Spanner/CockroachDB, not
Postgres.

The zone axis is the answer to a different question than the tenant axis. Tenant
scaling (ADR-0003) partitions *unrelated* apps: app A's data and app B's data never
need to agree. **Zone scaling partitions ONE logical system across consistency /
sovereignty boundaries that DO share data** — e.g. an EU zone and a US zone of the
same product that each own their writes locally (low latency, data residency) but
must see an eventually-consistent view of a declared subset of each other's data.
This is the original SCS ("multi-system", data-sovereignty-zone) ambition, parked
in ADR-0003 precisely because coupling databases is hard.

Spike #133 removed the make-or-break unknown. On `neon:8464` exactly as shipped
(PostgreSQL 17.5, `neon` extension 1.6, `compute-node-v17:8464`):

- The compute **already boots `wal_level=logical`** (`deploy/compute-files/config.json`:
  `wal_level=logical`, `max_wal_senders=10`, `max_replication_slots=10`,
  `max_logical_replication_workers=4`). No image bump, no config change needed.
- `CREATE PUBLICATION` / `CREATE SUBSCRIPTION` across two branch computes on one
  plane **works** — the `neon` extension does not block logical decoding.
- **A logical slot survives scale-to-zero in every direction**, including the worst
  case (subscriber behind *and* publisher bounced through zero): the slot's
  `restart_lsn` was intact, the backlog WAL was durable via the safekeeper quorum,
  the subscriber caught up all 500 rows, and an ordered md5 checksum matched exactly
  (zero divergence) on every run.

The spike also surfaced **five design musts** this ADR must own (§4). The verdict
was PROCEED, and this ADR is the design that proceeds.

---

## Decision (proposed)

Adopt **DB-per-zone with strong in-zone consistency and eventual cross-zone
consistency via logical replication**, governed by a **declared-dependency
contract**. The mechanism is empirically grounded in spike #133; the topology
composes the three shipped axes and adds a cross-zone fabric on top.

### 1. Topology — DB-per-zone (recommend: a new `Zone` CRD composing `AppDatabase`)

**Each zone is one database = one Neon branch/timeline with its own writer and its
own read-replica pool.** In-zone, a zone is *exactly* what axes 1–3 already deliver:

- **Strong in-zone consistency** — one timeline, one writer, one serialized WAL
  stream. Reads inside the zone are strongly consistent against that writer (or
  bounded-staleness against the zone's RO pool, axis 2).
- **The zone's DB IS an `AppDatabase`** — a branch off the shared template
  timeline, a per-app/per-zone `compute-<zone>` Deployment that scales 0↔1
  (ADR-0003), provisioned by the AppDatabase operator (ADR-0004,
  `gateway/internal/appdb/`), routed by the apps-gateway `template` mode
  (`database=<zone>` → `compute-<zone>`). **A single-zone deployment of this ADR is
  byte-identical to today's branch-per-app** — the zone axis is additive.

**Recommendation (Open decision 3): model a zone as a new thin `Zone` CRD that
*composes* an `AppDatabase`, NOT as a role/field on `AppDatabase` itself.** A Zone
`HAS-A` in-zone `AppDatabase` (its strong-consistency primary + RO pool) and adds
the cross-zone fabric. Rationale:

- **`AppDatabase` is now a stable, public external-driver API** (ADR-0006 §6: knext
  depends on its Secret/status contract). Cross-zone replication concerns —
  publications, subscriptions, peer references, `dataDependencies` — are
  **multi-database governance**, not single-branch config. Bolting them onto
  `AppDatabase.spec` bloats a contract another repo consumes.
- **`dataDependencies` is inherently cross-object.** A Zone reconciler must reason
  about *peer* zones (create a publication on the peer, a subscription on itself,
  manage the slot lifecycle across both). That is a higher-altitude controller than
  the per-DB appdb operator, which owns exactly one branch's lifecycle.
- **It mirrors the ADR-0006 delegation pattern.** Just as the knext operator
  delegates DB lifecycle to `AppDatabase` and layers app-wiring on top, the `Zone`
  operator delegates DB lifecycle to `AppDatabase` and layers the cross-zone fabric
  on top. Layers stay independently ownable, testable, releasable. The appdb
  operator gets **zero** new responsibility.

```yaml
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: Zone
metadata: { name: zone-eu, namespace: scale-zero-pg }
spec:
  # In-zone DB (delegated 1:1 to an AppDatabase the Zone operator owns)
  database:
    tier: warm                 # see §4c — a PUBLISHING zone is not idle-irrelevant
    quotas: { cpu: "1000m", mem: "1Gi", maxConnections: 100 }
    readReplicas: true         # axis 2 — strong/bounded-staleness reads in-zone
  # Cross-zone coupling (the governance layer, §3)
  publishes:
    - name: orders_pub
      tables: [orders, order_lines]          # the subset THIS zone exports
  dataDependencies:
    - fromZone: zone-us
      tables: [customers]                    # tables THIS zone CONSUMES from a peer
      mode: replicate                        # replicate (copy) | federate (FDW live read)
status:
  phase: Ready
  database: { appDatabase: zone-eu, timelineId: "…", computeReady: true }
  subscriptions:
    - fromZone: zone-us, slot: sub_zone_us_customers, state: streaming, lagBytes: 0
```

The `Zone` operator: (a) creates/owns an `AppDatabase` named `<zone>` (delegation,
finalizer-driven teardown exactly like ADR-0006 §3c), (b) reconciles the
publications it declares onto its own DB, (c) for each `dataDependency` with
`mode: replicate`, creates the subscription on itself against the peer's
publication (§2), (d) for `mode: federate`, provisions `postgres_fdw` foreign
tables instead (§2). Alternative (Open decision 3): a `zone` sub-block on
`AppDatabase` — simpler (no new CRD) but couples the public API to cross-zone
concerns; rejected as the recommendation for the reasons above.

### 2. Cross-zone fabric — eventual consistency (logical replication) + live federation (FDW)

**Two mechanisms, chosen per declared dependency:**

**(a) `mode: replicate` — logical replication (the default, the eventual-consistency
path).** The consuming zone keeps a **local, eventually-consistent copy** of the
declared table subset. This is what spike #133 proved. Sequence, and **who does
what** (all driven by the `Zone` operator, no human steps):

```
producer zone (zone-us)                     consumer zone (zone-eu)
  │ operator reconciles spec.publishes:        │
  │   CREATE PUBLICATION orders_pub             │
  │     FOR TABLE customers;                    │
  │                                             │ operator reconciles a
  │                                             │ dataDependency {fromZone: zone-us,
  │                                             │   tables:[customers], replicate}:
  │             <── CREATE SUBSCRIPTION ────────│  CREATE SUBSCRIPTION sub_zone_us_customers
  │  slot sub_zone_us_… auto-created on         │    CONNECTION '<direct to compute-zone-us.svc:55433>'
  │  the PUBLISHER; initial COPY streams;       │    PUBLICATION orders_pub;
  │  live inserts decode + stream (sub-second)  │
```

- **The operator is the sole author of pub/sub/slot.** No app or human runs SQL.
  Publications live on the producer; subscriptions + their slots on the peer.
- **Consistency is eventual**: initial `COPY` then continuous WAL-decoded streaming.
  Measured lag (spike): sub-second live (~1.4 s poll-bound upper bound); 1000-row
  backlog after a subscriber sleep caught up ~1.5 s after boot; 500-row worst-case
  (both slept) ~4.4–4.9 s from subscriber wake. **No ordering guarantee across
  zones; each zone is internally consistent at its own apply point.**
- **The connection is direct compute→compute** (`compute-<zone>.svc:55433`),
  **bypassing the apps-gateway** — this is the wake-path problem (§4c).

**(b) `mode: federate` — `postgres_fdw` foreign tables (live cross-zone read, no
copy).** When a zone needs a *fresh, on-demand* read of a peer's data (not a
maintained local copy), provision a `postgres_fdw` foreign table pointing at the
peer's compute. The read is served live from the peer at query time.

**When to replicate vs federate (the design rule):**

| Choose **replicate** (logical repl) | Choose **federate** (FDW) |
|---|---|
| The consumer reads the data often / joins it locally / must survive the peer being asleep or unreachable | The consumer reads rarely and needs the *freshest* value, tolerating a live cross-zone hop |
| Read-heavy, latency-sensitive in-zone joins | Occasional lookups; staleness of a replica is unacceptable |
| Eventual consistency acceptable (it is the model) | Live consistency for that read required |
| **Cost:** storage for the copy + a slot that pins WAL on the producer (§4a) | **Cost:** every read is a cross-zone TCP round-trip; **wakes/keeps the peer up** (same wake problem, §4c, but pull-driven) — and a sleeping peer stalls the read |

**Recommendation: `replicate` is the default; `federate` is the deliberate opt-in**
for freshness-critical, low-frequency reads. Both cross the same
gateway-bypass/wake boundary (§4c) — replicate at subscribe-time + on catch-up,
federate on every read.

### 3. The declared-dependency contract — `Zone.spec.dataDependencies` (the governance layer)

Cross-zone data flow is **never implicit**. A zone consumes a peer's data **only**
by declaring it, and the declaration IS the specification that drives the fabric:

- `spec.publishes[]` — the table subset a zone **exports** (→ `CREATE PUBLICATION`).
  A zone exports **nothing** by default. Sovereignty-first: a zone's data does not
  leave it unless the zone owner declares an export.
- `spec.dataDependencies[]` — `{fromZone, tables[], mode}` — the tables a zone
  **imports** from a named peer (→ subscription or FDW). The consumer declares its
  needs; the producer declares its offers; **the operator only wires a dependency
  when BOTH sides agree** (the requested tables ∈ the peer's published set).
  A dependency on tables the peer does not publish is a `status` error, not a silent
  grant — this is the governance gate.
- **This is the audit + policy surface.** Every byte of cross-zone data flow is
  declared in a CR, reviewable, diffable, and enforceable. It is also where a future
  data-sovereignty policy (e.g. "zone-eu may never import PII from zone-us") is
  enforced — as admission on `dataDependencies`, not buried in SQL.

### 4. The five spike musts — designed

Each is a hard requirement from spike #133 §"WAL-retention" and §"Other findings".

**(a) Bounded WAL retention + a SLOT-AWARE janitor/monitor.**
The risk: on this build `max_slot_wal_keep_size = -1` (unbounded) and
`idle_replication_slot_timeout` **does not exist** (PG17.5/neon —
`unrecognized configuration parameter`). So an **inactive** logical slot (subscriber
asleep or gone) pins WAL on the **publisher forever**, never auto-invalidated. The
#19 `wal-janitor` (CronJob `30 2 * * *`) prunes **safekeeper WAL in object storage
per timeline against the pageserver `remote_consistent_lsn`** and is **slot-unaware**;
`apps-wal-monitor` watches orphan timelines / PV pressure and is likewise blind to a
compute-side slot's `restart_lsn`. Two failure classes result (spike §risk):
*runaway pin* (a long-asleep subscriber fills the plane) and *pruned-out-from-under*
(a future guard prunes past a slot's `restart_lsn` → `wal_status=lost` → the
subscription breaks permanently, recoverable only by drop+recreate with `copy_data`).

**Design:**
1. **Set a bounded `max_slot_wal_keep_size`** (a per-zone cap, e.g. sized to the
   plane's headroom / expected max subscriber-sleep backlog). This makes the
   failure mode a **graceful degrade to re-sync** (slot goes `lost` → operator
   detects → drop+recreate subscription with `copy_data`) instead of a **plane-fill
   (ENOSPC on the safekeeper PV / object store)**. Bounded-and-recoverable beats
   unbounded-and-catastrophic. The cap value is an operator knob; a runaway
   subscriber costs *its own* re-sync, never the plane.
2. **Teach `apps-wal-monitor`/`wal-janitor` to enumerate logical slots** — read
   `pg_replication_slots` on each awake publisher compute, treat each slot's
   `restart_lsn` as a **prune floor**, and **alert on slot lag** (`SlotWALGrowth`,
   modeled on the existing `SafekeeperWALGrowth`). The janitor's existing
   fail-closed discipline (never over-prune an unresolvable timeline) extends to:
   **never prune below any live slot's `restart_lsn`.**
3. The cap + the slot-aware monitor together close both risk classes: runaway is
   bounded (cap → re-sync) and *observable* (lag alert) before it bounds; the
   janitor won't prune a slot's backlog out from under it (floor).

**(b) A per-zone REPLICATION role, applied every boot.**
Neither `cloud_admin` (loopback-only over TCP since #112: `pg_hba` `host all
cloud_admin all reject` before the network catch-all) nor the per-app role
`app_<app>` (no `REPLICATION` attribute) can drive a subscription. The spike minted
a `spike_repl` role (`LOGIN REPLICATION`) admitted by the `host all all all md5`
catch-all. **Design:** a per-zone `repl_<zone>` role (`LOGIN REPLICATION`, random
md5), minted into the zone's Secret and **injected on every boot by the exact same
mechanism as `APP_ROLE`** — `entrypoint.sh` already appends the per-app login role
to the compute spec's `roles[]` array on every wake (`compute_ctl` re-applies spec
roles each boot). Add a second injected role when `REPL_ROLE`/`REPL_ROLE_MD5` are
set (from `compute-config-<zone>` + the zone Secret, exactly as `APP_ROLE`/
`APP_ROLE_MD5` flow today via `render.go` `RenderConfigMap` + the Secret
`SecretKeyRef`). Zero blast radius on non-zone computes (vars unset → block skipped).
**TLS note:** spike traffic was plaintext over the pod network; cross-zone
replication should move to `sslmode=require` on the publisher front (the `pggw-tls`
material already exists, #113) — mandatory for any cross-cluster reach (§4e).

**(c) THE PUBLISHER WAKE PATH — the key open decision.**
The subscriber's walreceiver connects **directly** to `compute-<zone>.svc:55433`,
**bypassing the apps-gateway**. `publishNotReadyAddresses: true` (confirmed in
`render.go` `RenderService`) means the Service DNS resolves even at 0 replicas — but
**nothing scales the publisher up**. In the spike the publisher was woken manually.
So: *a subscriber cannot, on its own, wake a sleeping publisher to drain a backlog.*
This interacts with the entire scale-to-zero premise of the axis. Three options:

| Option | How | Trade-off |
|---|---|---|
| **(i) Warm-publisher-while-subscribed** *(recommend, phase 1)* | Any zone with ≥1 live subscriber gets `tier: warm` (min replicas 1, never sleeps). The Zone operator sets it when a dependency is wired, clears it when the last subscriber drops. | **Simple + correct + shippable today** (the `warm` tier exists, ADR-0003). **Cost:** a *publishing* zone never fully scales to zero. But a zone others depend on for data is **by definition not idle-irrelevant** — the cost is bounded to zones that actually export, and *leaf* zones (no subscribers) still sleep at zero. Reintroduces a standing compute cost the axis otherwise avoids. |
| **(ii) Gateway-mediated replication-wake** *(recommend, phase-2 target)* | Add a replication listener/port to the apps-gateway; the subscriber connects *through* it; on the replication startup packet the gateway wakes `compute-<zone>` (as it does for normal connects), then pipes. The walreceiver retries on failure (`wal_retrieve_retry_interval`) so it tolerates the ~3.6 s wake. | **Preserves scale-to-zero for publishers** — the axis's whole premise. **Cost:** the gateway must parse enough of the replication startup to route+wake; a dedicated replication path; the first post-sleep apply eats one wake latency (acceptable — replication is async). More build. This is the *right* long-term answer. |
| **(iii) Replication-aware sidecar/poker** | A small controller watches subscriber slot lag (or a schedule) and wakes the publisher periodically to drain. | **Another component**; replication becomes **batchy** (drain every N min → higher, lumpier lag). Fine for a low-freshness zone, worst of both otherwise. Not recommended as the default. |

**Recommendation (Open decision 2): ship phase 1 on (i) warm-publisher-while-
subscribed** — zero new machinery, provably correct (it is what the spike did),
honest about the cost. **Design (ii) gateway-mediated replication-wake as the
phase-2 path** to restore scale-to-zero for publishers, since it is the only option
that preserves the axis's core premise. (iii) stays a documented fallback for
low-freshness zones. **This is an OWNER DECISION** — it trades cost vs build vs the
scale-to-zero promise.

**(d) Deprovision hygiene — drop sub/pub/slot on the peer before reclaim.**
ADR-0003's `destroy` reclaims a timeline two-sided (pageserver `DELETE` + safekeeper
`DELETE` on all three, port 7676) but is **slot-unaware** — it would strand a
logical slot on the *peer* zone. **Design:** the `Zone` operator's finalizer, before
delegating the `AppDatabase` teardown, runs cross-zone cleanup **on the peers**:
`DROP SUBSCRIPTION` on this zone (releases the local apply worker), and — critically
— `DROP PUBLICATION` + `pg_drop_replication_slot` **on each peer** that this zone was
subscribed to or publishing for. Order: drop the *subscriber* side first (stops the
slot from being re-pinned), then the *publisher* side slot, then reclaim the
timeline. A peer that is **asleep at deprovision time** must be woken (or the drop
recorded to a pending-reclaim ConfigMap and reconciled, mirroring ADR-0003's
`apps-wal-reclaim-pending` pattern for a down safekeeper). **Leaving a slot on a
live peer re-creates the unbounded-pin risk of §4a** — so this step is mandatory,
not best-effort.

**(e) Cross-cluster is a FOLLOW-UP spike — not claimed here.**
Spike #133 was **two branches on ONE storage plane** (intra-cluster). True SCS
multi-**system** replication crosses clusters/regions, where the connection model is
materially harder: network path + NAT/ingress, mutual TLS, auth across trust
domains, latency, WAL volume over a WAN, and slot durability across a partition.
**Design:** phase 1 of the zone axis is **intra-cluster only** (Open decision 4).
Cross-cluster requires its own spike (a `#133`-style live drill across two planes)
**before this ADR's claims extend to multi-system**. Do not market cross-region
zones until that spike is green. The intra-cluster design here is forward-compatible
(the fabric is the same pub/sub; only the transport hardens), but the ADR does not
assert cross-cluster reach.

### 5. Consistency model — stated plainly (and the SCS trade-off, owned)

- **STRONG within a zone.** One timeline, one writer, one WAL stream. In-zone reads
  are strongly consistent (or bounded-staleness against the zone's RO pool, axis 2).
- **EVENTUAL across zones.** Logical replication is asynchronous: a consumer sees a
  producer's writes after decode+stream+apply (sub-second live; seconds after a
  sleep/catch-up). FDW federation is live-but-per-read (no cross-read snapshot).
- **NO cross-zone ACID.** There is **no distributed transaction** spanning zones —
  the foundation cannot provide one (single-node WAL per timeline). A workflow that
  must mutate two zones atomically **must use sagas / compensation**: each zone
  commits locally, and cross-zone invariants are maintained by compensating actions
  on failure, not by a 2PC the platform does not have. **This is an application
  responsibility the platform surfaces, never hides.**
- **The SCS coupling trade-off (owned explicitly).** ADR-0003 parked SCS
  multi-system precisely because coupling databases reintroduces the hard problems
  distributed data has: eventual consistency, conflict handling, partial failure,
  and the loss of a single transactional truth. **This ADR un-parks that
  deliberately.** The mitigations: coupling is (a) *declared* (§3, never implicit),
  (b) *directional and subset-scoped* (a zone exports only what it publishes), (c)
  *eventual by contract* (stated, not silent), and (d) *bounded in blast radius* (a
  broken slot degrades one dependency to a re-sync, §4a — it does not corrupt the
  producer, whose WAL is the source of truth). What the platform does **not** solve
  and must document: **write-write conflicts** (if two zones can write the *same*
  logical row and both publish it, logical replication has no conflict resolution —
  last-apply-wins, silent divergence). **Design rule:** a table may be **published
  by at most one zone** (single-writer-per-replicated-table); consumers get a
  read-only copy. Bidirectional replication of the same table is **out of scope**
  (it needs conflict resolution the foundation lacks). This keeps "eventual" from
  becoming "eventually wrong."

---

## Evidence (spike #133, live on OKE `neon:8464`)

| Claim | Evidence |
|---|---|
| `wal_level=logical` boots as-shipped | `deploy/compute-files/config.json` (`logical`, `max_wal_senders=10`, `max_replication_slots=10`) — no change |
| Cross-branch `CREATE PUBLICATION`/`SUBSCRIPTION` works | spike steps 2–3 GREEN; `neon` ext does not block decoding |
| Live incremental lag | sub-second (~1.4 s poll-bound upper bound) |
| Subscriber cold boot (0→1) | ~3.6 s |
| 1000-row backlog, subscriber-asleep, catch-up | ~1.5 s after boot (~5.0 s wall from scale-up) |
| **Slot survives publisher scale-to-zero** (worst case: sub behind + pub bounced) | `restart_lsn` intact; 500 rows caught up ~4.4–4.9 s; **ordered md5 matched, zero divergence** |
| WAL pinned by an inactive slot | ~156–290 kB per 500–1000 rows — **grows unbounded with backlog** (→ §4a) |
| `max_slot_wal_keep_size` / `idle_replication_slot_timeout` | `-1` (unbounded) / **absent** on this build (→ §4a) |

---

## Alternatives considered

- **Pure-SCS (API-only federation, no data coupling).** Zones share nothing at the
  database layer; all cross-zone data flows through **application APIs** (a zone
  calls a peer's HTTP/gRPC service for its data). **Pro:** no logical-replication
  machinery, no slot/WAL-pin risk, no shared-plane coupling, cleanest sovereignty
  boundary. **Con:** every cross-zone read is a live synchronous API call (latency,
  the peer must be up, no local joins), and the consistency/caching burden lands
  entirely in each application. **Rejected as the *whole* answer** because it forfeits
  the platform's value proposition — the DB layer *can* maintain an
  eventually-consistent local copy far more cheaply and correctly than N app teams
  reinventing caches. **But it is the correct model when data must NOT be copied at
  all** (hard sovereignty) — so `mode: federate` (§2b) preserves the API-shaped,
  no-copy option *within* this ADR for dependencies that demand it.
- **Status-quo — branch-per-app, no cross-zone (ADR-0003 as-is).** Every database is
  an island; no data crosses. **Pro:** zero coupling, the simplest correct thing,
  already shipped. **Con:** cannot express a multi-zone system that shares any data —
  the exact SCS use case. **Rejected** as the ceiling: it is the right default (and
  a single-zone deployment of this ADR *is* the status quo), but it cannot answer the
  zone question. This ADR is strictly additive on top of it.
- **Distributed SQL (Spanner/CockroachDB/Citus).** A genuinely cross-node-consistent
  store. **Rejected** — it is a different foundation (CLAUDE.md rule: reuse Neon,
  don't rebuild). It would discard the whole scale-to-zero / WAL-quorum architecture.
  Out of scope by first principles.

**Why logical-replication-eventual is the chosen middle:** it sits between
pure-SCS (too little — no platform-maintained shared state, all burden on apps) and
distributed SQL (too much — wrong foundation, no scale-to-zero). It gives each zone
**strong local consistency + scale-to-zero** (the platform's core value) *and* a
**declared, bounded, eventual** window into peers' data — proven viable on the
shipped image, with the failure modes designed to degrade to re-sync, never to
corruption or a plane-fill.

---

## Consequences & follow-ups

- **New controller surface:** a `Zone` CRD + operator (composing `AppDatabase`).
  Additive; the appdb operator and apps-gateway are unchanged except the phase-2
  gateway replication-wake path (Open decision 2, if chosen).
- **The wal-janitor / apps-wal-monitor become slot-aware** (§4a) — a real change to
  #19 machinery, gated on this ADR shipping. Until then, no logical slots exist and
  the collision is inert (spike §risk).
- **A publishing zone carries a standing compute cost** under the recommended
  phase-1 wake path (§4c option i) — bounded to zones that export, but real.
- **Cross-cluster reach is unproven** — a follow-up spike (§4e) gates any
  multi-system / multi-region claim. This ADR is intra-cluster.
- **`docs/SCALING.md` §4** moves from "🔬 spike + ADR-0007" to "designed, pending
  owner go" on ratification; the consistency model + wake-path decision are
  documented there per the standing "never a silent default" rule.
- **Kill-criterion honesty:** if the owner declines the coupling trade-off (§5), the
  axis stays parked and the status-quo alternative stands — no code is lost, because
  nothing is built until ratification.
