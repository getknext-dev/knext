# Ops-toil ledger — ADR-0002 kill-criterion 1

KC1: **if operating the storage plane costs more than ~1 engineer-day/month,
escalate to managed Postgres.** This ledger is the measurement. Every human (or
agent-hours-at-human-request) intervention on the storage plane gets a row —
same-batch with the intervention, like BENCHMARKS.

Counts as toil: unplanned safekeeper/pageserver/MinIO surgery, WAL/bucket
cleanup beyond the janitor, version-pair upgrades, restore executions (real,
not drills), auth/session babysitting for the plane.
Does NOT count: feature work, drills, reviews, gateway/app-tier work.

| Date | What | Time spent | Notes |
|---|---|---|---|
| 2026-07-03 | (ledger opened) | — | Baseline: zero unplanned storage-plane interventions since OKE migration 2026-07-02; DiskPressure incident (2026-07-02, ~2h) predates the ledger but is the reference example of a countable row |

**Monthly check (part of the on-release gate):** sum the month's rows; >1
eng-day ⇒ KC1 fires ⇒ re-convene the review trio with a managed-Postgres
comparison on the table.
