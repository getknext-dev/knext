# Benchmarks — every measured number, with provenance

Standing rule: **every drill or bake-off run that produces a number lands here**
(same batch as the change, per CLAUDE.md rule 2b). Raw data: `bakeoff/results/*.csv`;
methodology in `bakeoff/README.md`. Environments: **local** = single-node OrbStack
k8s on an M-series laptop (decommissioned 2026-07-03); **OKE** = Oracle OKE
`knext2`, 2× amd64 nodes, `oci-bv` block volumes, shared with knext's Knative stack.

## Wake latency (the product metric)

| Metric | Local | OKE | Notes |
|---|---|---|---|
| Cold wake (gateway-measured) | **2.43–2.63s** | **2.0–2.95s** (range, 5 runs) | steady state; real p50/p95 lands with issue #9 (n=20). OKE ≈ laptop |
| Cold wake, first-ever boot on node | — | 38s | one-time: 1.3GB compute image pull + cold volume; not steady state |
| Cold wake before CoreDNS fix | 5.19s | — | headless-Service NXDOMAIN negative-cache masked all pod-side gains |
| Warm connect (compute already up) | 120–134ms | — | native Postgres latency through the pipe |
| **Warm-tier wake (gated pod)** | **413ms p50 / 558ms p95 / 206ms best** | ✅ drill green (<1.5s bound) | n=20 local; costs 256Mi reservation while parked |
| compute_ctl attach alone | **123–160ms** | — | Neon's true share; everything else is k8s mechanics |
| Compose-era cold start (no k8s) | 772ms | — | the floor without pod machinery (historical) |

## Foundation bake-off (ADR-0002 evidence; n=20/cell, same gateway)

| Cell | Neon | CNPG baseline | CNPG tuned (1s probes) |
|---|---|---|---|
| Cold p50 / p95 / p99 | 3717 / 4956 / 5067 ms | 14413 / 14848 / 14917 ms | 6331 / 8167 / 8465 ms |
| Reconnect-after-drain p50 | 3692 ms | 14446 ms | — |
| Warm p50 | 121 ms | 115 ms | — |
| CNPG irreducible floor | — | — | ~4–5s (pod-recreate path) |

Root causes worth remembering: CNPG's 14.4s was **kubelet probe cadence** (10s
polls), not the database; Neon's 5.2s was **CoreDNS negative caching**, not Neon.
The engines were never the bottleneck — Kubernetes mechanics were, twice.

## Reliability drills (RTO)

| Drill | Local | OKE | What it proves |
|---|---|---|---|
| Compute pod kill → data served | 1–6s | 38s first-boot; 2.2–3.0s steady | stateless compute; no volume, no restore (*first-boot pull) |
| Safekeeper quorum (kill 1 of 3) | writes continue | ✅ passes | 2/3 WAL quorum; member rejoins |
| Pageserver failover — MANUAL (promote standby, gen+1) | **~7s** | **9s** | read-WRITE preserved; hand-run mechanism (`--manual`) |
| Pageserver failover — AUTOMATED (pswatcher, no human step) | — | **8s** | watcher promotes gen+1 + flips Service selector + bounces compute; RTO = kill→cold read on standby (incl. ~3s×1s-poll detection); proof = selector flipped by watcher + gen ledger 1→2 + read served by the fresh cold compute (not old-pod cache) |
| Backup → restore (READ-ONLY) from OCI Object Storage (fresh ns) | **~110s** (in-cluster, pre-#4) | **417–942s** (OCI OS, 2026-07-03) | issue #4: backup mirrors OFF-CLUSTER to OCI OS, restore sources from it; RTO scales with bucket size (cross-internet copy dominates); STATIC read-only proof (reads pages from pageserver, no safekeepers) |
| Backup → restore promoted to **WRITABLE** primary (fresh ns) | — | **1226s (writable) / 1045s (read-only)** post-WAL-prune, 2026-07-03; was **>60min @13GiB — unbounded-in-practice** (devops-r4) | issue #2: on-disk safekeeper WAL re-seed from the `/safekeeper` backup + crafted `safekeeper.control` (`deploy/skctl.py`); pageserver re-derives `prev_record_lsn`; INSERT survives a compute kill + fresh re-basebackup. **Promotion delta over read-only ≈ 181s** (bucket-size-independent). Issue #19 pruned 5.2 GB of stale safekeeper WAL, taking the restore from **unbounded (>60min)** to a **bounded ~20min**. No storage controller / no HTTP timeline-create on 8464 |
| Backup job at ~18GB bucket | green (retry loop exercised live) | — | in-cluster path (pre-#4); OCI OS path uses same mc client 1Gi + retry loop |
| CNPG pod-kill recovery | ~16s | — | comparison point (hibernate resume: ~3.3s) |
| Alert path (rule → Alertmanager → receiver) | delivered | **delivered** | idempotent drill; unique per-run identity |
| Gateway HA (held conn across idle window, pod kill) | ✅ | ✅ | no split-brain sleep; no SPOF |
| TLS (sslmode=require, incl. cold wake over TLS) | TLS 1.3 | **TLS 1.3** | plaintext preserved as opt-in |

## Capacity / sizing facts

- Gateway: `GW_MAX_CONNS=90` < compute `max_connections=100`; excess → clean 53300.
- Compute: 256MB shared_buffers / 1Gi limit; spec re-applied every boot.
- MinIO 512Mi + mc client 1Gi: the durability tier and its backup client must
  survive a full-bucket mirror (both OOMed at smaller sizes — observed live).
- OCI block volumes round small PVCs up to 50GB minimum.
- Backup target = OCI Object Storage (issue #4), S3-compat endpoint
  `https://axfqznklsd2t.compat.objectstorage.me-abudhabi-1.oraclecloud.com`,
  bucket `ks-pg-backup`, **versioning Enabled** + lifecycle **DELETE
  previous-object-versions after 30 DAYS** (+ abort incomplete multipart after
  7d). `mc mirror --remove` keeps the live set; lifecycle prunes superseded
  versions — closes the ~60GB un-pruned-mirror incident. Lifecycle needs an IAM
  policy: `Allow service objectstorage-me-abudhabi-1 to manage object-family in
  tenancy`. S3 creds = an OCI **Customer Secret Key** (one per tenancy), stored
  in the `backup-s3-target` Secret (separate from `storage-s3-creds`).
- ephemeral-storage requests default to **0** when undeclared — under DiskPressure
  the kubelet evicts such pods first (they are Burstable on cpu/mem but rank
  worst on disk). Declared everywhere since #11/#12; `_verify-drift.sh` asserts
  it stays live.

## Methodology notes

- Wake latency is **gateway-measured** (scale call → backend accepted) unless
  marked client-observed (adds client pod startup + poll overhead, ~1–3s).
- Aggregating per-pod gateway metrics: **sum counters, max gauges** — summing a
  "last latency" gauge across replicas fabricates numbers (learned the hard way).
- Cold means *settled zero*: no pod objects at all — a Terminating pod still
  holds the timeline and re-wake during drain costs ~2–3s extra.
- **Writable-restore RTO** is measured from the same backup-start clock as the
  read-only RTO to the moment the promoted primary's INSERT is confirmed **durable**
  (after a compute kill + fresh re-basebackup), so it is strictly ≥ the read-only
  number. The delta over read-only is the safekeeper WAL re-seed (two short
  `mc cp` seeds of a handful of 16 MiB segments) + one pageserver WAL catch-up +
  one PRIMARY compute boot; it is not bounded by Postgres.
- **Safekeeper WAL prune (issue #19, `wal-janitor`)** reclaimed **5.2 GB** of stale
  `/safekeeper` WAL from the live bucket (5.6 GB → 534 MB, 325 of 357 16-MiB
  segments; kept a 32-segment / 512-MiB horizon below `remote_consistent_lsn` +
  all `.partial`). This took the writable restore from **unbounded (>60 min at a
  13 GiB bucket)** to a **bounded ~1226 s** measured immediately after. **Honest
  caveat:** the restore RTO is now dominated by the **~11 GiB of pageserver layer
  files** (real page data + the 7-day PITR history) copied twice across the
  internet — *not* safekeeper WAL. Pruning removed the unbounded safekeeper
  growth; the remaining floor tracks the pageserver bucket and would only move
  with PITR/layer-retention tuning (separate, riskier concern). Each drill run
  re-adds ~360 MB of safekeeper WAL (the marker-forcing fill); the daily janitor
  re-trims it, so accumulation stays bounded over time rather than growing every
  drill.
