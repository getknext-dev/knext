# Benchmarks — every measured number, with provenance

Standing rule: **every drill or bake-off run that produces a number lands here**
(same batch as the change, per CLAUDE.md rule 2b). Raw data: `bakeoff/results/*.csv`;
methodology in `bakeoff/README.md`. Environments: **local** = single-node OrbStack
k8s on an M-series laptop (decommissioned 2026-07-03); **OKE** = Oracle OKE
`knext2`, 2× amd64 nodes, `oci-bv` block volumes, shared with knext's Knative stack.

## Wake latency (the product metric)

| Metric | Local | OKE | Notes |
|---|---|---|---|
| Cold wake p50 (gateway-measured) | **2.43–2.63s** | **2.15–2.82s** | steady state; OKE ≈ laptop despite real cloud scheduling |
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
| Pageserver failover (promote standby, gen+1) | **~7s** | **9s** | read-WRITE preserved; SPOF → bounded RTO |
| Backup → restore in fresh namespace | **~110s** | **304s** | rehearsed, not theoretical; OKE slower on 50GB-min block-volume provisioning; restore read-only on 8464 OSS |
| Backup job at ~18GB bucket | green (retry loop exercised live) | — | after minio 512Mi + mc 1Gi sizing fixes |
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

## Methodology notes

- Wake latency is **gateway-measured** (scale call → backend accepted) unless
  marked client-observed (adds client pod startup + poll overhead, ~1–3s).
- Aggregating per-pod gateway metrics: **sum counters, max gauges** — summing a
  "last latency" gauge across replicas fabricates numbers (learned the hard way).
- Cold means *settled zero*: no pod objects at all — a Terminating pod still
  holds the timeline and re-wake during drain costs ~2–3s extra.
