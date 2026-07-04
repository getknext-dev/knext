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

| Date | What | Time spent | Notes |
|---|---|---|---|
| 2026-07-03 | (ledger opened) | — | Baseline: zero unplanned storage-plane interventions since OKE migration 2026-07-02; DiskPressure incident (2026-07-02, ~2h) predates the ledger but is the reference example of a countable row |

**Monthly check (part of the on-release gate):** sum the month's rows; >1
eng-day ⇒ KC1 fires ⇒ re-convene the review trio with a managed-Postgres
comparison on the table.
