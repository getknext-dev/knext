# Ops-toil ledger — ADR-0002 kill-criterion 1

KC1: **if operating the storage plane costs more than ~1 engineer-day/month,
escalate to managed Postgres.** This ledger is the measurement. Every human (or
agent-hours-at-human-request) intervention on the storage plane gets a row —
same-batch with the intervention, like BENCHMARKS.

Counts as toil: unplanned safekeeper/pageserver/MinIO surgery, WAL/bucket
cleanup beyond the janitor, version-pair upgrades, restore executions (real,
not drills), auth/session babysitting for the plane.

Counts as toil (v0.6.0 multi-tenant surface, ADR-0003):
- Per-app **provision/deprovision** runs beyond CI automation — especially the
  deprovision sharp edge: it must `DELETE` the timeline on **all three
  safekeepers**, plus the tombstone / random-timeline-id footgun (a mis-run leaks
  safekeeper WAL or hangs a compute in the walproposer handshake).
- Per-app **compute / ConfigMap / Service drift or cleanup** — orphaned
  `compute-<app>` / `compute-config-<app>` / `svc/compute-<app>`, and orphaned
  safekeeper WAL prefixes left by deprovisioned apps.
- **Read-pool / warm-tier babysitting** — `compute-ro` / `compute-warm` sizing,
  HPA tuning, RO staleness handling.

Does NOT count: feature work, drills, reviews, gateway/app-tier work.

**Note (enlarged surface):** the monthly KC1 sum now spans this ENLARGED
multi-tenant surface, so the >1 eng-day/month tripwire matters MORE at N apps.

**Note (v2 zone standing surface, ADR-0007):** the zone axis adds standing storage-plane
surface — the `zone-operator` is now a **persistent** single-replica reconciler (v1.3.1,
#151; crash-only, same low-toil class as `appdb-operator`/`pswatcher`), and cross-zone
logical-replication slots pin publisher WAL (monitored by the repl-slot monitors +
`ReplicationSlot*` alerts). Net KC1 effect is **small and bounded**: the operator is
self-healing and the slot WAL is hard-capped (`max_slot_wal_keep_size`, degrade-to-
re-sync). The `JanitorConfigDisarmed` tripwire (v1.3.1, #142) *reduces* expected toil by
converting a silent multi-hour WAL-accumulation incident into a one-cycle page.

| Date | What | Time spent | Notes |
|---|---|---|---|
| 2026-07-03 | (ledger opened) | — | Baseline: zero unplanned storage-plane interventions since OKE migration 2026-07-02; DiskPressure incident (2026-07-02, ~2h) predates the ledger but is the reference example of a countable row |
| 2026-07-06 | DiskPressure — safekeeper WAL accumulation from a **disarmed** wal-janitor (`storage-objstore` ConfigMap deleted as residue by a throwaway backup-portability drill → prune pod stuck `CreateContainerConfigError` → no Failed Job → silent until a node hit DiskPressure) | ~1h (session reset) | The exact silent hole #142 closes. Now guarded by `JanitorConfigDisarmed` (pages within one cycle, not 26h). Root fix: drills must not delete main-ns shared config; detection: this new alert. |

**Monthly check (part of the on-release gate):** sum the month's rows; >1
eng-day ⇒ KC1 fires ⇒ re-convene the review trio with a managed-Postgres
comparison on the table.
