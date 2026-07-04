# Benchmarks — every measured number, with provenance

Standing rule: **every drill or bake-off run that produces a number lands here**
(same batch as the change, per CLAUDE.md rule 2b). Raw data: `bakeoff/results/*.csv`;
methodology in `bakeoff/README.md`. Environments: **local** = single-node OrbStack
k8s on an M-series laptop (decommissioned 2026-07-03); **OKE** = Oracle OKE
`knext2`, 2× amd64 nodes, `oci-bv` block volumes, shared with knext's Knative stack.

## Wake latency (the product metric)

| Metric | Local | OKE | Notes |
|---|---|---|---|
| Cold wake (gateway-measured) | **2.43–2.63s** | **p50 3.72s / p95 4.14s** (n=20, issue #9) | formal OKE baseline landed 2026-07-04 (see "Cold + warm OKE baseline, n=20"); earlier 5-run range was 2.0–2.95s |
| Cold wake, first-ever boot on node | — | 38s | one-time: 1.3GB compute image pull + cold volume; not steady state |
| Cold wake before CoreDNS fix | 5.19s | — | headless-Service NXDOMAIN negative-cache masked all pod-side gains |
| Warm connect (compute already up) | 120–134ms | — | native Postgres latency through the pipe |
| **Warm-tier wake (gated pod)** | **413ms p50 / 558ms p95 / 206ms best** | ✅ drill green (<1.5s bound) | n=20 local; costs 256Mi reservation while parked |
| compute_ctl attach alone | **123–160ms** | — | Neon's true share; everything else is k8s mechanics |
| Compose-era cold start (no k8s) | 772ms | — | the floor without pod machinery (historical) |

## Combined wake (knext demo, issue #8)

The north star, measured end-to-end: a real knext `NextApp` (Knative
scale-to-zero) bound to scale-zero-pg via a `DATABASE_URL` Secret. Both asleep
at rest; **one cold HTTP request wakes both** and returns Postgres data; both
idle back to zero. Drill: `demo/_verify.sh` (TTFB via `curl` from an in-cluster
pod; DB pre-wake via `psql` through the gateway). OKE `knext2`, 2 nodes,
2026-07-03, n=5.

| Request class | OKE (mean) | Range (n=5) | What it is |
|---|---|---|---|
| **`T_both`** — app + DB both cold | **13.0s** | 7.4 – 16.1s | the headline: one request wakes app **and** DB |
| `T_appcold` — app cold, DB pre-warmed | **3.9s** | 3.5 – 4.7s | app's Knative cold start alone |
| `T_warm` — both awake | **23ms** | 19 – 28ms | steady state (Next.js + warm pool) |
| bare DB cold-connect (no app) | 2.6s | 2 – 3s | DB wake as a bare `psql` client sees it |

Per-iteration `T_both`: 13.2 / 15.2 / 13.1 / 7.4 / 16.1 s. North star proven 5/5
(HTTP 200 + live visit-counter row every time).

**Honest reading — the DB wake did *not* simply "hide" inside the app cold
start; the both-cold path costs *more* than the parts summed.** App-only cold
start is a stable ~3.9s and the DB's bare wake is ~2.6s, yet waking both on one
request lands at ~13s (range 7–16s), not ~6.5s. So `T_both − T_appcold` (~9s) is
**not** a clean DB-wake isolate — `_verify.sh` now prints it as *"combined-cold
overhead … NOT DB wake"* (issue #45) — it's dominated by both-cold cold-start
mechanics: the app pod schedules + starts (image-cache locality across 2 nodes
drives the 7→16s spread) *and* its first request blocks on a cold-DB connection
inside the Knative activation window, while the compute pod schedules in
parallel. Net: the combined cold hit is a cold-start problem, not a DB-wake
problem. Mitigations that move it toward `T_warm`: the **warm tier** (~0.4s DB
wake, `deploy/25-compute-warm.yaml`) and/or `NextApp` `minScale: 1` /
bytecode-cache for latency-sensitive apps. Steady-state (warm) is 23ms — the DB
is a transparent pipe once up. Filed back to the platform as a wake-UX finding.

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

## Branch-per-app provisioning (ADR-0003)

Multi-tenancy = one Neon **branch** (timeline) per app off a shared template, on
one storage plane (#6 / KC5 #65). Measured on OKE (`context-ckmva7v7zvq`, ns
`scale-zero-pg`, `neon:8464`), via `deploy/provision-app.sh` + the spike.

| Step | OKE | What it is |
|---|---|---|
| **App provision (branch + ConfigMap + Deployment + Service)** | **~4.0s** (3.94 / 4.15s, 2 apps) | `provision-app.sh create <app>`; no initdb, no migration replay |
| Branch create alone (pageserver ancestor API) | **~1.0s** | `POST /v1/tenant/<t>/timeline/` with `ancestor_timeline_id` + `ancestor_start_lsn` |
| Branch → **writable** compute Ready (cold, image cached) | **~3.5s** | child compute boots read-write on the branch |
| Safekeeper craft for a branched timeline | **none** | walproposer auto-inits the branch on a live pageserver (unlike cold restore, which needs `skctl craft`) |

Isolation + independent 0↔1 proven by `deploy/_verify-multitenant.sh` (two apps,
one plane, all connects through the apps-gateway): each app sees only its own
writes; scaling one app to zero leaves the other serving; the slept app wakes with
data intact. Method: branch two throwaway apps, write an app-private row into the
shared `app_items`, cross-check visibility, force-sleep one, re-wake it. Full
finding + caveats: [ADR-0003](adr-0003-multi-tenancy.md).

### v0.6.1 tenant security (issues #74/#75/#76) — live-verified 2026-07-04

`deploy/_verify-multitenant.sh` (apps-gateway image `v0.6.1-tenantsec`) now also
proves, on the OKE plane:

| Property | Result | How |
|---|---|---|
| **Tenant access control (#74)** | app A's DSN **denied** against app B; `cloud_admin` **denied** through the apps-gateway; reserved `tmpl` **denied** — the app's own per-app credential to its own db **succeeds** | gateway `(user,database)` authz refuses with `28P01` before any wake; per-app role `app_<app>` + md5 password applied by `compute_ctl` each boot |
| **Per-app idle (#75)** | idle app A **scales to zero on schedule** while busy app B holds an open connection (apps-gateway `GW_IDLE_MS` lowered to 8s for the assertion) | peer-aware idle now reads each app's own `per_system` active count, not the fleet-global scalar |
| **Crash-safe provisioning (#76)** | a create interrupted after the intent ConfigMap but before the branch **re-converges on the same timeline** (no orphan); `fsck` reports a clean plane | `create` writes the ConfigMap (branch owner) + Secret before the branch call |

Per-app credential + role injection add **no measurable** provision-time cost (the
Secret + one spec role are applied in the same window; provision stays ~4s).

### Branch-per-app scale ceiling (#86) — live-measured 2026-07-04

`deploy/_verify-scale-ceiling.sh` provisioned N apps on **one** shared plane and
measured what ADR-0003's "tens/low-hundreds" claim rested on but had only asserted
(prior proof was 2 apps). Two runs on OKE (`context-ckmva7v7zvq`), `neon:8464`:

| Measure | N=30 run | N=20 run | Reading |
|---|---|---|---|
| **Apps provisioned on one plane** | **30** ✅ | **20** ✅ | demonstrated ceiling: **tens of apps** |
| Provision latency (create, replicas 0) | p50 **10.28s** / p95 10.82s | p50 **10.07s** / p95 10.53s | **RTT-bound** from an out-of-region workstation (~8–10 `kubectl`+pageserver round-trips to me-abudhabi-1 per create); the plane-side branch create is still ~1s. In-cluster/CI provisioning is far faster |
| Template `pitr_history_size` | 2 092 952 → **2 092 952 B** (Δ0) | flat | **FLAT in branch count** — all branches pin the *same* template LSN, so the feared unbounded WAL pin does **not** materialise |
| Safekeeper apps WAL dirs | 3 → **2** (no growth) | flat | sleeping apps (replicas 0) run no walproposer ⇒ **zero** per-branch safekeeper WAL |
| Control-plane objects | **30/30/30/30** (Deploy/Svc/CM/Secret) | 20/20/20/20 | **linear** — 1 of each per app |
| Cold-wake a sampled subset through the gateway | routed to the right branch ✅ | routed ✅ | each app wakes to **its own** branch; a **pooled/retrying** client (like knext) rides through the first-connect role-apply window (bare one-shot `psql` can see a transient `28P01` — see below) |

**Honest ceiling:** **tens of apps on one plane is demonstrated** (30 provisioned,
footprint flat/linear). Low-hundreds is plausible on plane resources but **not yet
drilled**; thousands / high-churn per-PR-preview is **out of scope** for the imperative
path (that regime is what the deferred CRD operator, ADR-0004, is for). The drill is
self-cleaning (destroys every app + sweeps orphans on exit).

**Cold-wake role-apply race (found by this drill):** a freshly-woken compute opens its
Postgres port a beat before `compute_ctl` finishes applying the per-app login role, so
a one-shot first connect can race and see `28P01`. A connection **pool** (knext) or a
retrying client connects; not a data/availability defect. The drill's wake client
retries for exactly this reason.

### Per-app tenant quotas (#89) — live-verified 2026-07-04

`deploy/_verify-tenant-quotas.sh`, two apps on one plane, one hostile:

| Property | Result | How |
|---|---|---|
| **Per-app `max_connections` enforced + independent** | hostile app capped at **12**, victim unchanged at **100** | `--max-conns` → `PG_MAX_CONNECTIONS` in the app ConfigMap → the compute entrypoint sets it in *that app's* Postgres only |
| **CPU limit rendered** | hostile compute has a CPU limit (**250m**) | template now renders a CPU *limit* (was absent — the noisy-neighbour hole); a CPU burn is throttled to its allotment |
| **Noisy-neighbour contained** | victim **wakes + serves** `select 1`/`select 42` through the shared apps-gateway **while** the hostile app floods **20** gateway connections + burns CPU | each app is its own Postgres; the hostile flood is bounded by its own cap (**≤12** backends observed), so the plane is not exhausted |

**Caveat:** the apps-gateway `GW_MAX_CONNS=90` is a **process-wide** goroutine ceiling
(OOM guard), **not** per-app; a true per-`{system}` gateway slot cap is a fast-follow.
Per-app Postgres `max_connections` is the enforced per-tenant bound today.

## Reliability drills (RTO)

| Drill | Local | OKE | What it proves |
|---|---|---|---|
| Compute pod kill → data served | 1–6s | 38s first-boot; 2.2–3.0s steady | stateless compute; no volume, no restore (*first-boot pull) |
| Safekeeper quorum (kill 1 of 3) | writes continue | ✅ passes | 2/3 WAL quorum; member rejoins |
| Pageserver failover — MANUAL (promote standby, gen+1) | **~7s** | **9s** | read-WRITE preserved; hand-run mechanism (`--manual`) |
| Pageserver failover — AUTOMATED (pswatcher, no human step) | — | **~8s** (unchanged post-#25/#26/#23) | watcher promotes gen+1 + flips Service selector + bounces compute; RTO = kill→cold read on standby (incl. ~3s×1s-poll detection). Proof = selector flipped by watcher + gen ledger 1→2 + read served by the fresh cold compute (not old-pod cache) + **post-failover truthfulness** (`pswatcher_failed_over=1`, `pswatcher_primary_up` re-anchored onto the promoted standby — #25). A **second-vantage gate** (API-server pod-readiness) now precedes any promotion (#26) to reject watcher-side partitions; it adds a single sub-second API call only on the promotion tick, so RTO is unchanged. Authority is crash-only single-replica (#23). |
| Backup → restore (READ-ONLY) from OCI Object Storage (fresh ns) | **~110s** (in-cluster, pre-#4) | **417–942s** (OCI OS, 2026-07-03) | issue #4: backup mirrors OFF-CLUSTER to OCI OS, restore sources from it; RTO scales with bucket size (cross-internet copy dominates); STATIC read-only proof (reads pages from pageserver, no safekeepers) |
| Backup → restore promoted to **WRITABLE** primary (fresh ns) | — | **1226s (writable) / 1045s (read-only)** post-WAL-prune, 2026-07-03; was **>60min @13GiB — unbounded-in-practice** (devops-r4) | issue #2: on-disk safekeeper WAL re-seed from the `/safekeeper` backup + crafted `safekeeper.control` (`deploy/skctl.py`); pageserver re-derives `prev_record_lsn`; INSERT survives a compute kill + fresh re-basebackup. **Promotion delta over read-only ≈ 181s** (bucket-size-independent). Issue #19 pruned 5.2 GB of stale safekeeper WAL, taking the restore from **unbounded (>60min)** to a **bounded ~20min**. No storage controller / no HTTP timeline-create on 8464 |
| Backup job at ~18GB bucket | green (retry loop exercised live) | — | in-cluster path (pre-#4); OCI OS path uses same mc client 1Gi + retry loop |
| CNPG pod-kill recovery | ~16s | — | comparison point (hibernate resume: ~3.3s) |
| Alert path (rule → Alertmanager → receiver) | delivered | **delivered** | idempotent drill; unique per-run identity |
| Gateway HA (held conn across idle window, pod kill) | ✅ | ✅ | no split-brain sleep; no SPOF |
| TLS (sslmode=require, incl. cold wake over TLS) | TLS 1.3 | **TLS 1.3** | plaintext preserved as opt-in |

## Object-storage backend: OCI vs MinIO (issue #105)

`deploy/_verify-objstore.sh` — a throwaway-namespace drill that stands up a
storage plane whose pageserver + safekeeper offload to a **configured** S3
endpoint, writes 5000 rows, forces a layer upload (`remote_consistent_lsn`
advances past the marker), **wipes the pageserver PVC** (empties its layer
cache), re-attaches, and reads every row back through a STATIC compute — so the
read is necessarily served from object-store-fetched layers. Same drill, two
backends:

| Backend | In-cluster MinIO? | Offload latency (checkpoint → rcl past marker) | Read-back RTO (empty-cache re-attach → first read) | Rows |
|---|---|---|---|---|
| **In-cluster MinIO** (baseline, digest-pinned) | yes (local default) | **35s** | **25s** | 5000 ✅ |
| **OCI Object Storage** (S3-compat, path-style, no MinIO) | **none** | **20s** | **16s** | 5000 ✅ |

Method: OKE (context `context-ckmva7v7zvq`, 2026-07-04), neon `8464`, single
safekeeper + single pageserver, 5000 proof rows + a 300k-row WAL fill over the
256MB `checkpoint_distance`; OCI endpoint
`axfqznklsd2t.compat.objectstorage.me-abudhabi-1.oraclecloud.com` (SigV4,
path-style, reusing the #4 Customer Secret Key), dedicated throwaway bucket.

Reading the numbers honestly: **offload latency is bounded by the pageserver's
freeze/compaction cadence (~20s), not by network** at this small layer size — so
OCI came out at/under MinIO here (both are compaction-cadence-bound, and run-to-run
scheduling variance exceeds the backend delta). A large cross-internet layer upload
*would* favour in-cluster MinIO; the point of this row is the **verdict**, not a
network micro-benchmark: **the pageserver offloads pages to, and serves reads back
from (after a full layer-cache wipe), OCI Object Storage's S3 Compatibility API
with NO in-cluster MinIO** (ADR-0005). Reproduce: `deploy/_verify-objstore.sh`
(baseline) and the same with `OBJSTORE_ENDPOINT=…` set (OCI).

## Upgrade rehearsal (issue #50 — pivot-vs-bump cost is now a known number)

`deploy/_rehearse-upgrade.sh` boots the newest pullable neon/compute pair in a
throwaway `upgrade-drill` ns from the real manifests, runs storage-init, serves a
read-write workload, and dumps the new `safekeeper.control` to check its format
version. Answers: is an upgrade a **manifest bump** (control still v9, skctl
survives) or a **skctl rewrite** (format diverged, KC1 pivot-class)?

| Rehearsed tag | Booted? | storage-init | R/W served | `safekeeper.control` | Verdict |
|---|---|---|---|---|---|
| **`17411840350`** (newest Docker Hub pair, 2025-09-02, > pinned 8464) | ✅ clean, no manifest breakage | ✅ | ✅ marker row | `magic=0xcafeceef` **version=9** | **MANIFEST BUMP** — skctl weld survives; upgrade is cheap, not pivot-class |

Method/caveats: OKE, 2026-07-03; the `8xxx` stable release series tops out at 8464
for both repos, so the only images newer than 8464 today are run-ID-tagged CI
builds — `17411840350` is the newest coherent pair. First pull of the multi-GB
bleeding-edge image took several minutes/node (one-time upgrade cost). Full
narrative: `docs/operations.md` §"Upgrading the storage plane".

## Vertical in-place resize (issue #67 — Neon-cloud parity spike)

Live-verified on **OKE v1.33.10, 2026-07-04**, using a throwaway `postgres:17-alpine`
pod (no shared infra touched). In-place pod resize (`kubectl patch --subresource
resize`) grows/shrinks a **running** container's CPU/RAM without a restart.

| Resize | Actuated live? | Restart? | Postgres bounced? | Evidence |
|---|---|---|---|---|
| CPU 100m→120m req / 250m→300m lim | **yes** | no (`restartCount=0`) | no | cgroup `cpu.max` = `30000 100000` (0.3 CPU) |
| Memory 128Mi→200Mi req / 256Mi→320Mi lim | **yes** | no (`restartCount=0`) | no | cgroup `memory.max` = `335544320` (320Mi) |
| `shared_buffers` after memory resize | **no** (by design) | — | — | `show shared_buffers` still `128MB` — fixed at boot |
| CPU 100m→500m (node too full) | **deferred** | no | no | `PodResizePending: Deferred — Node didn't have enough resource: cpu` — kubelet queues it, not a failure |

`pg_postmaster_start_time()` was **identical before and after** every resize —
Postgres never restarted. **Verdict: FEASIBLE.** Recipe + caveats (patch cpu and
memory separately; `shared_buffers` needs a restart; runtime GUCs tune via
`ALTER SYSTEM`): `docs/operations.md` §"Vertical resize of the writer".

## Read-only pool (issue #66)

The read-only pool (`DATABASE_URL_RO` → `compute-ro`, `RO_MODE=Replica` default)
scales reads 0→N→0 on the primary's timeline. Gateway routing is covered by Go
table tests (`gateway/internal/wake/ro_test.go`); manifest contracts by
`deploy/_validate.sh`; end-to-end behaviour by `deploy/_verify-readpool.sh`
(RO wakes only the pool, reflects committed data, rejects writes, measures
staleness).

Verified **pre-merge on OKE, 2026-07-04** (`_verify-readpool.sh`, on the live cluster
running the **v0.6.0 release gateway** `v0.6.0@sha256:9ee6497826…`, `KSPG_SKIP_BUILD=1`,
`RO_MODE=Replica` — issues #78/#82/#83; the RO lane is now deployed live on `pggw`
(GW_RO_* env) with `compute-ro` at its 0-replica rest posture):

| Metric | Result | Evidence |
|---|---|---|
| **RO mode achieved** | **Replica — TIP-FOLLOWING** (goal, not the static fallback) | `compute-ro` logs `mode=Replica`; `READPOOL_STALENESS mode=Replica tip_following=yes` |
| RO read wakes only the pool | ✅ primary stayed at **0 pods** through the RO read | drill asserts `compute` pods == 0 during the RO query; pool scaled `0→1` |
| RO reflects committed data | ✅ 3 seeded rows returned via `DATABASE_URL_RO` | while primary asleep |
| Write on RO DSN rejected | ✅ `read-only transaction` error; no row leaked | negative assertion |
| **Staleness (Replica lag)** | **~9 s** writer-commit → RO-visible | a row committed on the writer became visible on the pool within ~9 s (`READPOOL_STALENESS mode=Replica tip_following=yes lag_s=9`; poll granularity + per-poll client-pod spawn inflate this; true replication lag is at/under this bound) |

The pool boots the **tip-following `Replica`** compute mode — compute_ctl 8464
supports a read-only endpoint that streams WAL from the safekeepers and tracks
the timeline tip (not merely a static-at-attach LSN). The `Static` fixed-LSN path
remains the honest fallback (`RO_MODE=Static`).

## Read-only pool under load (HPA n>1, issue #99)

The GA gate for read-scaling: with the read-scaling HPA
(`deploy/optional/27-compute-ro-hpa.yaml`, posture B, `minReplicas: 1`) applied,
**real concurrent read load drives `compute-ro` past one replica and it drains
back down** when the load stops. Verified **live on OKE, 2026-07-04** by
`deploy/_verify-readpool.sh` (its `RO_HPA` section, auto-on when a metrics-server
is present), on the **v0.6.1 release gateway**
(`v0.6.1@sha256:12a73533…`, `KSPG_SKIP_BUILD=1`, `RO_MODE=Replica`). Load = 4
concurrent in-cluster loaders each looping a CPU-heavy streaming aggregate
(`select sum(i) from generate_series(1,30000000) i`) against the `compute-ro`
Service; `maxReplicas` capped to 3 for the 2-node test cluster (the shipped
manifest ships `maxReplicas: 5`).

| Metric | Result | Evidence |
|---|---|---|
| **HPA scale-up under load** | **`compute-ro` 1 → 3** (n>1) | CPU hit **276%** of the 250m request (target 70%); `READPOOL_HPA scaled_up=yes base=1 peak=3 loaders=4` |
| **Writes rejected while at n>1** | ✅ `read-only transaction` at **n=3** | a write on the RO path is refused even under load + at multiple replicas (retried through not-ready-pod routing) |
| **HPA scale-down after drain** | **`compute-ro` 3 → 1** | load removed → CPU→4% → HPA drained to the `minReplicas: 1` floor over its 120s stabilization; `READPOOL_HPA scaled_down=yes final=1` |
| Staleness **under load** | not measured this run (honest) | on the 2-node test cluster the cold writer could not wake within the bounded window while N RO pods + N loaders occupied it; the **pre-load contract (~9 s, above) stands** as the guarantee. `READPOOL_HPA_STALENESS … tip_following=unmeasured note=writer-wake-headroom` |

Operational notes surfaced by the drill (all handled in `_verify-readpool.sh`, and
they are real properties operators must know — see operations.md posture B):
- A stock **CPU Resource HPA cannot scale up from 0** (no pod → no metric); posture
  B's `minReplicas: 1` floor is load-bearing, and the drill seeds 1 replica first.
- `compute-ro` is a **shared singleton** Deployment that the **live gateway** also
  idle-scales; posture B therefore requires `GW_RO_IDLE_MS` disabled on the managing
  gateway (the drill disables it for the section and restores it after) — otherwise
  the gateway and the HPA fight over the replica count.
- The `compute-ro` Service sets `publishNotReadyAddresses`, so a freshly-scaled-up,
  not-yet-ready RO pod is in the Service rotation — clients (and the write-reject
  check) must tolerate transient `connection refused` during scale-up.

## Combined wake — demo on a per-app database (branch-per-app, KC5 / #99)

The **"capability in real use"** evidence for ADR-0002 kill-criterion 5 (#65/#73):
the real **pg-demo `NextApp`** was moved OFF the shared primary onto its OWN
provisioned per-app database — a Neon **branch** (`timeline 73eeba98…`) under the
apps tenant, its own role `app_pgdemo`, its own `0↔1 compute-pgdemo`, routed by the
**apps-gateway** (`pggw-apps`) — via `demo/migrate-to-perapp.sh` (which invokes
`deploy/provision-app.sh` read-only). Then the standard demo drill
(`DB_DEPLOY=compute-pgdemo DB_PREWAKE=0 ITERS=3 bash demo/_verify.sh`) proved the
north star end-to-end on that per-app DB. Measured **live on OKE, 2026-07-04**:

| Class | i1 | i2 | i3 | What it shows |
|---|---|---|---|---|
| **`T_both`** (app + per-app DB both asleep → one cold request wakes both) | 25.6 s | 14.8 s | 15.4 s | **all three `db-backed=yes`, HTTP 200** — a real knext app on its own branch-per-app DB, both scaled to zero, woken by a single cold HTTP request, returning rows from Postgres |
| `T_warm` (both awake) | 0.022 s | 0.025 s | 0.023 s | steady state |

Every iteration started from a **verified resting state** (`app_pods=0 compute-pgdemo=0`,
both asleep) and returned to it before the next. The combined-cold `T_both` (~15–26 s,
higher than the shared-primary demo's ~5–9 s) is dominated by the app's Knative cold
start + the first visitor's `CREATE TABLE IF NOT EXISTS` on a fresh branch + a busy
2-node cluster — **not** the bare DB wake (branch-per-app provisioning itself is ~6 s,
[above](#branch-per-app-provisioning-adr-0003)); `DB_PREWAKE=0` skips the shared-gateway
`T_appcold` isolation because a per-app DB authenticates as `app_<app>`, not `cloud_admin`.
This is DB-per-app serving a real knext app, sleeping and waking, end-to-end — the KC5
Neon-capability-in-real-use demonstration.

## Cold + warm OKE baseline, n=20 (issue #9)

Measured **2026-07-04 on OKE** with `bakeoff/_run-battery.sh`
(`FOUNDATIONS=neon DIMS="cold warm"`, N=20) — the same client-side methodology as
the bake-off (one in-cluster psql client, connect + `SELECT count(*)` through the
live `pggw` gateway; cold is deterministic scale-to-zero, confirmed by
`spec.replicas==0` AND zero pods). This is the formal OKE reference the KC2
`GatewayWakeLatencyHigh` alert lacked a documented baseline for. Raw CSVs:
`bakeoff/results/neon-{cold,warm}-oke-rs-n20.csv`.

| Metric | p50 | p95 | p99 | min | max | n |
|---|---|---|---|---|---|---|
| **Cold wake** (cold-zero tier: scale-to-zero → connect + query) | **3719 ms** | 4138 ms | 4316 ms | 2747 | 4361 | 20 |
| **Warm connect** (compute already up: client connect + query) | **818 ms** | 1027 ms | 1217 ms | 721 | 1265 | 20 |

Notes:
- **Cold p50 3719 ms** corroborates the bake-off's Neon cold cell (3717 ms) —
  the two independent runs agree. Use **~3.7 s p50 / ~4.1 s p95** as the OKE
  cold-wake reference for the `GatewayWakeLatencyHigh` threshold.
- The **warm connect** row is *compute-already-up* end-to-end client latency
  (psql process start + connect + query from the in-cluster pod), **not** the
  gated **warm-TIER** pod. The warm-tier gated-pod wake is **413 ms p50 local**
  and `deploy/_verify-warmtier.sh` proves it stays **< 1.5 s on OKE** (5-sample
  bounded drill, green); a dedicated gated-pod n=20 on OKE is the one open
  follow-up on this issue.

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
- **WAL-janitor safety drill (issue #37/#42, `deploy/_verify-wal-janitor.sh`,
  2026-07-03).** The 5.2 GB reclaim above was a one-off manual measurement; it is
  now a **repeatable gate**. The drill runs the *real* janitor against the live
  plane and asserts the safety invariants: fail-closed (pageserver unreachable →
  Job exits non-zero, deletes nothing), below-horizon-only pruning, tail +
  `.partial` preservation, and idempotence. A representative run derived a single
  timeline (`00000001`, published `threshold_suffix=000000010000006D` from
  `remote_consistent_lsn=1/8DF36A00`, `segno=397`, `KEEP_SEGMENTS=32`) and pruned
  **42 of 74** complete segments (**~672 MiB**, `/safekeeper` → 558 MiB / 35
  objects), keeping every at/above-horizon segment and all 3 `.partial`s; the
  second run reported "nothing to prune". **TLI is now derived from the segment
  names, not hardcoded `1` (issue #42)** — a timeline promotion (`00000002…`) would
  otherwise sort above a `TLI=1` threshold and silently stop the janitor while it
  kept exiting `0`. Live check confirmed the plane is single-timeline today, so the
  fix is a correctness/forward-compat guard, not a behavior change.
- **Iteration-8 pager-trust drill battery (2026-07-03, OKE, all green).** Re-ran the
  affected drills against the live plane after the #57/#58/#59/#60/#61/#62 changes:
  - **`_verify-wal-janitor.sh` (per-timeline horizon, #59):** derived
    `threshold_suffix=0000000100000095` for the single live timeline
    (`f0…f002`) and pruned **34 of 75** complete segments (**~544 MiB**,
    `/safekeeper` → 702 MiB / 44 objects), keeping every at/above-horizon segment +
    all 3 `.partial`s; idempotent second run. **New section D:** seeded a segment
    under an *unresolvable sibling timeline* (`ffff…ffff`) — the janitor **failed
    loud** (exit non-zero → `WalJanitorJobFailed`) and the sibling segment
    **survived** (per-timeline horizon is fail-safe: a lagging sibling is never
    pruned against another timeline's horizon).
  - **`_verify-pageserver-failover.sh` (new `#57/#58` image):** automatic promotion
    of pageserver-b @ gen 2, selector flip, compute bounce, metric re-anchor — reads
    read-write again in **7 s**, no regression from the adopt-bounce / seen-present
    anchor changes.
  - **`_verify-alerting.sh` (#60):** the always-firing `Watchdog` dead-man's-switch
    is **ACTIVE in Alertmanager's API** (the external heartbeat pre-condition) and
    the normal pager path (Prometheus → Alertmanager → sink) still delivers.
  - **`_verify-wake.sh` (#61):** full 0→1→0→1 loop green — cold wake **8 s wall /
    2131 ms gateway latency** — with the new stderr-diagnostic + bounded first-connect
    retry.
  - **`BackupStaleAbsent` companion (#52/#62), verified live by decomposing the rule:**
    suspending the real backup CronJob drives `kube_cronjob_spec_suspend==1` (arm
    fires); the full age-gated rule is **empty** at a 21 h-old CronJob (Day-0/post-DR
    suppression, #62) and evaluates to **1** with the gate lowered to >1 h — proving
    the suspend arm + age gate fire together once a CronJob has genuinely existed past
    the horizon. Un-suspended immediately (no scheduled run skipped).
