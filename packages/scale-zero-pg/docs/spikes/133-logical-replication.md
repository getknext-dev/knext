# Spike #133 — Logical replication on `neon:8464`, and its survival across scale-to-zero

**Status:** COMPLETE — **verdict: VIABLE (all steps GREEN) on `neon:8464` as-is, no newer tag needed.**
**Date:** 2026-07-06 · **Gate for:** ADR-0007 (zone-scaling axis 4, `docs/SCALING.md` §4)
**Reproduce:** `deploy/_spike-logrepl.sh run` (throwaway `spike-za`/`spike-zb` branches, self-teardown)

This spike is the make-or-break gate for the zone axis. It answers, with live evidence
against the real OKE storage plane (context `context-ckmva7v7zvq`, ns `scale-zero-pg`),
two questions: (1) does the OSS `neon:8464` compute support cross-branch logical
replication, and (2) does a subscriber — and the publisher's slot — survive
scale-to-zero? Both are **YES**. Method: two throwaway per-app branch computes
(`spike-za` = publisher/zone-a, `spike-zb` = subscriber/zone-b), provisioned by the
real `provision-app.sh`, on the shared storage plane. The live `pgdemo` app was never
touched; both spike branches + their WAL were fully reclaimed on teardown.

Environment: PostgreSQL **17.5**, `neon` extension **1.6**, compute image
`neondatabase/compute-node-v17:8464`, storage `neondatabase/neon:8464`.

---

## The 5-step verdict

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | **`wal_level=logical`** — does the compute boot with it / can it be set? | ✅ **PASS** | Boots `logical` already — set in `deploy/compute-files/config.json` (`wal_level=logical`, `max_wal_senders=10`, `max_replication_slots=10`, `max_logical_replication_workers=4`). No change needed. |
| 2 | **PUBLISHER** — `CREATE PUBLICATION` for a table subset on zone-a | ✅ **PASS** | `CREATE PUBLICATION zone_pub FOR TABLE zone_events` succeeded; the `neon` extension does **not** block logical decoding or publication creation. |
| 3 | **SUBSCRIBER** — `CREATE SUBSCRIPTION` on zone-b to zone-a's publication | ✅ **PASS** | Slot `zone_sub` auto-created on the publisher; initial `COPY` of 5 rows replicated; live inserts replicated with **~1.4 s** end-to-end lag (poll-bound; true lag sub-second). Cross-compute TCP (zone-b → `compute-spike-za.svc:55433`) is not blocked. |
| 4 | **SCALE-TO-ZERO survival** | ✅ **PASS** (both directions + worst case) | See below. |
| 5 | **Measurements** (lag, catch-up, WAL retention) | ✅ recorded | See "Numbers". |

### Step 4 in detail — three scenarios, all pass

- **4a — subscriber sleeps, publisher stays up.** Scaled `compute-spike-zb → 0`,
  inserted 1000 rows on zone-a. The now-**inactive** slot pinned WAL on the publisher
  (retained grew 0.6 kB → **261–290 kB**, `wal_status=reserved`). Woke the subscriber:
  boot **~3.6 s**, then full 1000-row catch-up **~1.5 s after boot** (~5.0 s wall from
  scale-up). Slot released WAL back to baseline once caught up.
- **4b — publisher sleeps (the critical Neon question).** Scaled `compute-spike-za → 0`
  (a stateless-compute restart: local `pg_wal` is ephemeral and rebuilt from the
  pageserver on boot). **The logical slot `zone_sub` survived the restart** — present,
  `active=t`, `wal_status=reserved` — and post-wake inserts replicated with zero gap.
  Neon persists logical-slot state across compute restarts on `8464`.
- **4b-worst — subscriber BEHIND *and* publisher scales to zero.** The dangerous
  intersection: put the subscriber 500 rows behind, *then* bounced the publisher
  through zero (dropping its local WAL). On wake the slot's `restart_lsn` was intact,
  the subscriber caught up all **500 backlog rows in ~4.4–4.9 s**, and the ordered
  **md5 checksum matched exactly** (zone-a == zone-b, 1506–1566 rows, zero
  divergence). The backlog WAL the slot needs is durable via the safekeeper quorum and
  is re-served after the publisher reconstructs — logical replication is **not** broken
  by either side sleeping.

Data integrity was asserted every run with an ordered `md5(string_agg(...))` over both
zones; it matched on every scenario (`078b1da5…`, `8b91d8f2…`, `2a28d0e2…`).

---

## Numbers (from live runs)

| Metric | Value |
|---|---|
| Live incremental lag (single row) | sub-second (~1.4 s poll-bound upper bound) |
| Subscriber cold boot (scale 0→1) | ~3.6 s |
| Catch-up, 1000-row backlog, subscriber-asleep | ~1.5 s after boot (~5.0 s from scale-up) |
| Catch-up, 500-row backlog, **both** slept (worst case) | ~4.4–4.9 s from subscriber wake |
| WAL pinned on publisher by an inactive slot | ~156–290 kB per ~500–1000 rows (grows with backlog) |
| Full repeatable spike wall-clock (provision→prove→teardown) | ~75 s |

---

## WAL-retention / #19-janitor interaction — the one real risk

Logical replication works, but it **reintroduces an unbounded WAL-pin on the
publisher** that the current janitor does not account for:

- **The slot pins WAL with no ceiling.** `max_slot_wal_keep_size = -1` (unbounded) and
  `idle_replication_slot_timeout` **does not exist** on this build (PG17.5/neon —
  `unrecognized configuration parameter`). So an inactive logical slot (subscriber
  asleep or gone) holds WAL on the publisher **forever**, and it is never
  auto-invalidated or auto-reaped. A zone-b that sleeps for a long time while zone-a
  takes heavy writes ⇒ monotonically growing pinned WAL on zone-a.
- **The #19 wal-janitor is slot-unaware.** `wal-janitor` (CronJob, `30 2 * * *`) prunes
  **safekeeper WAL in object storage per-timeline against the pageserver horizon**
  (`remote_consistent_lsn`), and `apps-wal-monitor` watches for orphan timelines / PV
  pressure. Neither knows about a compute-side logical slot's `restart_lsn`. On today's
  branch-per-app plane these two facts don't collide (there are no logical slots). The
  moment the zone axis creates them, the risk classes are:
  1. **Runaway pin (durability leak):** a long-asleep subscriber pins ever-growing WAL
     on the publisher's timeline — the safekeeper PV / object store fills. This is the
     `apps-wal-monitor` ENOSPC risk, now driven by a *slot* the monitor can't see.
  2. **Pruned-out-from-under (broken replication):** if a future guard (a
     `max_slot_wal_keep_size`, or the janitor) prunes WAL past a slot's `restart_lsn`,
     the slot goes `wal_status=lost` and the subscription breaks permanently — a full
     re-sync (drop + recreate subscription with `copy_data`) is the only recovery.

  Note: this spike never *observed* an invalidation (retention stayed `reserved`
  throughout, and the janitor prunes by pageserver horizon which trails the slot), but
  the config leaves the door open in both directions.

**ADR-0007 must own this.** Concretely: (a) set a bounded `max_slot_wal_keep_size` (or a
zone-level cap) so a runaway subscriber degrades to a re-sync rather than filling the
plane; (b) teach `apps-wal-monitor`/`wal-janitor` to enumerate logical slots and
alert/prune with slot `restart_lsn` as a floor; (c) on deprovision, **drop the
subscription/publication and the slot** before reclaiming the timeline (the existing
reclaim path deletes the timeline but would strand a slot on the *peer* zone).

---

## Other architectural findings for ADR-0007

- **Replication needs a dedicated REPLICATION role + a wake path that bypasses the
  gateway.** `cloud_admin` is loopback-only (#112 pg_hba `reject` over TCP) and the
  per-app role `app_<app>` has no `REPLICATION` attribute, so neither can drive a
  subscription. The spike minted a `spike_repl` role (`LOGIN REPLICATION`) on the
  publisher; it was admitted over TCP by the `host all all all md5` catch-all. ADR-0007
  needs a **per-zone replication role applied every boot** (same mechanism as the
  `APP_ROLE` injection in `entrypoint.sh`), minted into a Secret.
- **The subscriber connects DIRECTLY to the peer compute Service
  (`compute-<zone>.svc:55433`), bypassing the apps-gateway.** That means **nothing wakes
  a sleeping publisher for a subscriber** — the raw TCP reconnect hits the Service
  (`publishNotReadyAddresses: true` resolves DNS at 0 replicas) but no controller scales
  the publisher up. In this spike the publisher was woken manually. Production options
  for ADR-0007: (i) keep the publisher zone warm (min replicas 1) while any subscriber
  exists, (ii) route replication through a gateway listener that wakes on connect, or
  (iii) a replication-aware sidecar. **This is a first-class design decision, not a
  detail** — it interacts with the whole scale-to-zero premise of the zone axis.
- **Traffic was plaintext** over the pod network (`sslmode` unset). Cross-zone (and
  certainly cross-cluster/SCS) replication must consider TLS on the publisher front.
- **Cross-cluster is untested.** This spike is two branches on **one** storage plane
  (intra-cluster). True SCS multi-system replication crosses clusters/regions; the
  connection model (network path, auth, TLS, latency, WAL volume) is materially harder
  and must be a follow-up spike before ADR-0007 claims cross-*system*.

---

## Recommendation for ADR-0007

**PROCEED. Logical replication is viable on `neon:8464` exactly as shipped** — no image
bump, no config change beyond what's already in `deploy/compute-files/config.json`. The
consistency mechanism for axis 4 (publish a table subset → subscribe → eventual
cross-zone consistency, strong-in-zone) is **empirically sound and survives
scale-to-zero in every direction**, including the worst case where both sides sleep and
the subscriber is behind.

ADR-0007 must, before any implementation, specify:
1. **Bounded WAL retention** (`max_slot_wal_keep_size` / zone cap) + **slot-aware
   janitor/monitor** — degrade a runaway subscriber to a re-sync, never to a plane-fill.
2. **A per-zone REPLICATION role** applied every boot (Secret-backed, like `APP_ROLE`).
3. **A wake path for a sleeping publisher** — decide warm-publisher vs
   gateway-mediated-replication-wake vs sidecar. This is the load-bearing design choice.
4. **Deprovision hygiene** — drop subscription/publication/slot on the peer before
   timeline reclaim.
5. A **follow-up cross-cluster spike** before claiming SCS multi-system reach.

State the consistency model plainly (strong in-zone, eventual across-zone; no cross-zone
transactions — sagas/compensation) and ship it behind the ADR, never as a silent
default (per `docs/SCALING.md` standing decision points).
