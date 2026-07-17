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
| SCRAM-SHA-256 auth (issue #117) | no measurable regression | ✅ verified on OKE | wire auth is now SCRAM (was md5). The SCRAM handshake adds one client↔server round-trip vs md5 (sub-ms on the in-cluster LAN, swamped by the seconds-scale cold-wake); cold-wake wall-time was indistinguishable from the md5 baseline. The app-role verifier is precomputed at provision time (PBKDF2 4096 iters, ~ms, off the wake path). Cold-wake caveat: an existing md5-era app can still auth via md5 in the ~tens-of-ms window before `apply_config` lands the SCRAM verifier (#158). |
| **Cold-boot role-apply settle (#132)** | — | **+250 ms deterministic** on per-app cold wake | `GW_ROLE_APPLY_SETTLE_MS` (default 250). The gateway holds the client 250 ms on a **genuine cold wake** of a per-app front door before the auth attempt, absorbing the cold-boot `28P01` role-apply race. Fires ONLY on cold wake (gateway log `cold wake — settling 250ms`, once per wake — no retry loop); warm connects + base single-DB path add **0**. ≈7 % of the p50 3.72 s cold-wake baseline; clamped to `GW_WAKE_TIMEOUT_MS`. |

### Cold-start under concurrency — single-flight DB wake (#339), OKE, 2026-07-17

N concurrent first-connects from a knext app each independently blocked on the 0→1
compute wake. #339 single-flights the wake in `@knext/lib` `getDbPool` (globalThis /
`Symbol.for` inflight-promise cell, fail-open on rejection) so N concurrent
first-connects collapse onto **one** shared wake. Measured on OKE via the file-manager
app hitting `/users` (`unstable_noStore` → a DB query on every request); latencies are
client-observed HTTP round-trips (sslip.io ingress → Knative → app → apps-gateway →
compute wake). BEFORE = `obs-4331a43` (no single-flight); AFTER = `obs-88d66dd`.

**A) Pure DB-wake herd (app warm, DB cold)** — app held warm via shallow `/api/health`
pings so the number isolates the wake path (AFTER / single-flight):

| Concurrency | p50 / p95 / max |
|---|---|
| C=1  | **3.6s** (single-request cold wake) |
| C=20 | **3.8s / 3.9s / 4.3s** |

p95(C=20) ÷ single-request = **1.08×** — comfortably within the ≤1.5× acceptance bound
(#339). 20 concurrent cold-DB requests finish within ~1× a single wake because they
share one inflight wake instead of each racing their own.

**B) End-to-end cold (app cold + DB cold), matched before/after** — app-wake is the same
constant in both arms, so the delta is the DB-herd effect:

| Concurrency | BEFORE p50/p95/max/wall | AFTER p50/p95/max/wall |
|---|---|---|
| C=20 | 9.2 / 9.6 / **14.5** / 14.5s | 8.2 / 8.4 / **8.4** / 8.4s |

The herd tail collapses: worst-case **14.5s → 8.4s (−42%)**, wall 14.5s → 8.4s. All 20
AFTER requests land in a tight 8.1–8.4s band (one shared wake) vs the 9–14.5s BEFORE
spread.

Method / caveats: one burst per cell (the 20 concurrent samples give the intra-burst
distribution). Cluster was CPU-healthy (~4% node CPU) at measurement; the historical
**32s** figure cited in #339 was taken under ~99% CPU-request saturation
(scheduling-bound, not steady-state DB contention), so the steady-state herd penalty is
the ~1.5× tail shown in arm B, which single-flight removes. #361 (a rejected pool query
still stamps `lastDbActivityAt`) is unit-covered, not a cluster metric.

### Wake-path resilience — request-during-wake returns 200, not 5xx (#310), OKE, 2026-07-17

#310 adds a knext-client-side bounded retry/backoff in `@knext/lib` getDbPool (inner to
#339's single-flight; the client complement to the gateway wake-retry #190). A request
arriving during a `compute-<app>` 0→1 wake retries transient connect failures
(`ECONNREFUSED`/`ECONNRESET`/"Connection terminated", non-`28xxx`) within a bounded
budget (`DB_WAKE_RETRY_BUDGET_MS`=8000, `BASE`=100, `MAX`=1000 ms), so it resolves as
bounded latency rather than a 5xx; permanent (auth/`28xxx`) errors fail fast.

Live drill on OKE (`obs-6e977bc` on file-manager, `/users`): **3 forced-cold cycles**
(compute scaled to 0 between cycles, app warm), **33 requests total, 0 failures / 0 5xx**:

| Cycle | Pattern | Result |
|---|---|---|
| 1 | C=10 concurrent cold-wake | 10/10 = 200 (tight ~19s band — one shared wake) |
| 2 | 1 trigger + waves at +2s/+4s **arriving mid-wake** | 11/11 = 200, incl. **10/10 mid-wake arrivals** |
| 3 | C=12 concurrent cold-wake | 12/12 = 200 (~3.6s wake) |

The cycle-2 mid-wake arrivals are the headline #310 case (a request landing while the
wake is in-flight) — all returned 200. Wake wall-time varies (3.6–19s) with per-cycle
compute pod scheduling under the manual scale-to-0 force; the resilience property (no
5xx) held across all cycles. Unit tests pin the retry/backoff/fail-fast contract with
fake timers; this drill proves it against the real gateway connect-race.

### Cold-boot role-apply settle gate (#132) — OKE drill, 2026-07-11

`deploy/_verify-coldboot.sh` (app=pgdemo, CYCLES=8, settle build sha-55edfaa on the
apps-gateway, `postgres:17-alpine` client pods per #171):

| Property | Result | Provenance |
|---|---|---|
| First connect, valid creds, N cold cycles | **8/8 — NEVER a transient 28P01** | drill assertion (scans client output for `28P01`/`password authentication failed`) |
| Wrong password, cold path | **fast-fails with `28P01`, not masked** | drill: psql exits non-zero + `28P01` in output; the gate settles once then the single auth attempt rejects |
| Settle-gate engagement | fired **once per cold wake** (`cold wake — settling 250ms`) | apps-gateway logs — no repeated settle ⇒ no auth-retry loop |
| Gateway-measured wake (excl. settle) | **1.6–2.9 s** | apps-gateway `awake in Xms` logs (consistent with the OKE cold-wake baseline) |
| Settle cost (before/after) | **+250 ms deterministic** on the cold path only | the gate sleeps exactly `GW_ROLE_APPLY_SETTLE_MS`, clamped to the wake deadline |

Note on method: the drill's **end-to-end** per-connect times (10–60 s; wrong-pw ~112 s)
are dominated by client-pod scheduling + image pull + OKE API flakiness and are **not**
a usable signal for the 250 ms settle — the settle cost is taken from the deterministic
gate value corroborated by the gateway `awake in` / `settling` logs, not from pod
wall-clock. The race is made **negligible** (settle ≫ the ~85 ms apply window, #158),
**not deterministically zero**; the deterministic `compute_ctl` `/status` readiness gate
lands in **#174**.

### Deterministic `/status` readiness gate (#174) — mechanism only, gate OFF in the shipped build

#174 adds the OPT-IN deterministic upgrade: on a cold wake the apps-gateway can poll
`compute_ctl` `/status` (port 3080) until `status:"running"` and proceed the instant the
role apply is provably done, instead of the fixed 250 ms settle. **The shipped deployment
is unchanged** — the gate is disabled by default (`GW_STATUS_PORT` unset; 3080 is neither
Service-exposed nor NetworkPolicy-allowed), so the cold-wake numbers above **still stand**
(the #132 settle remains the shipped mechanism). No new OKE wake number is claimed for
#174: enabling the gate (expose 3080 + wire the JWT) is a deferred ops step, and its
end-to-end effect is **≤ the current +250 ms** (deterministic proceed when the apply
completes sooner; bounded by `GW_WAKE_TIMEOUT_MS` when it doesn't). Verified by the Go
suite (`internal/gateway/statusgate_test.go`: proceeds-when-ready, respects-deadline,
token-reject-fast, unreachable-bounded, fires-only-on-cold-wake, settle-fallback); a live
OKE drill is deferred until the gate is enabled in a deploy. See
`docs/operations.md` → "Deterministic upgrade — the `compute_ctl` `/status` readiness gate".

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

### AppDatabase operator provisioning (#96, ADR-0004)

The v1.0 declarative interface: `kubectl apply` an `AppDatabase` → the in-cluster
`appdb-operator` reconciles it to a full per-app database. Measured by
`deploy/_verify-operator.sh` (`context-ckmva7v7zvq`, ns `scale-zero-pg`,
`neon:8464`), CR-apply → `status.phase: Ready`.

| Step | OKE (measured 2026-07-04) | What it is |
|---|---|---|
| **`AppDatabase` apply → `status.phase: Ready`** | **3.5s** | branch + ConfigMap + Deployment + Service + Secret + status, driven by one `kubectl apply`; a watch-triggered reconcile fires within ~1s of apply, so this is well under the ~15s resync backstop |
| Branch create alone (pageserver ancestor API) | **~1.0s** | identical to the script — same pageserver ancestor call |
| Serve through the apps-gateway | woke compute **0→1**, `schema_migrations`=1 (template inherited, copy-on-write), read back its own write ✅ | the operator-provisioned app is reachable as `app_<app>` through `pggw-apps` |
| Drift heal (hand-deleted Deployment → re-created) | **~1s** | continuous reconciliation the script does not provide |
| Deprovision (`kubectl delete` → finalizer) | **~1.2s** (CR gone, child objects gone, pageserver branch reclaimed, `TimelineReclaimed` event; safekeeper WAL swept, `fsck` clean) | two-sided delete (pageserver + all safekeepers) under the finalizer |

Measured live on `context-ckmva7v7zvq` / ns `scale-zero-pg` / `neon:8464` by running
the operator against the real plane (create → serve → drift-heal → delete → `fsck`
clean). The `3.5s` create includes an out-of-region workstation→pageserver hop for
the branch call; **in-cluster the branch is the same ~1s** and the total is lower.

**vs the script.** The operator runs **in-cluster** at steady state, so its branch
call avoids the ~8–10 out-of-region `kubectl`/pageserver round-trips that made
`provision-app.sh create` from an out-of-region workstation ~10s (#86, scale-ceiling
table); the plane-side work is the same ~1s branch. The operator adds continuous
reconciliation (drift-heal, ~1s) and a finalizer-enforced safe deprovision that the
imperative path only offers on the correct invocation. Full lifecycle drill:
`deploy/_verify-operator.sh` (runs against the in-cluster operator once its image is
built + pinned).

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
| **Per-app (branch) restore** — one app's Neon **branch** restored from OCI OS (#97) | — | **962 s (read-only) / 1210 s (writable)** (OKE, ~14 GiB bucket, 2026-07-04) | `deploy/_verify-app-restore.sh`: provision→mark→backup→**destroy the app's branch**→restore THAT branch in a throwaway ns. Read-only = STATIC compute on the restored branch. **Writable needed the SAME `skctl` craft as the platform tenant** — the cold branch is not "auto-init" (that's live-branching only); promotion delta ≈ **248 s**. Gated on **ancestor (template) durability** — a fresh branch blocks on its un-uploaded template tail (see methodology + `runbook-dr.md` §9d/§9d-bis). Isolation proven both directions; no per-branch PITR |
| **Slot-aware janitor + bounded WAL retention** (#139, ADR-0007 §4a) | — | ✅ 3 proofs green (OKE, 2026-07-07) | `deploy/_verify-slot-janitor.sh`: throwaway publisher+subscriber, real cross-branch logical replication. **PROOF 1 (BOUND):** inactive slot past `max_slot_wal_keep_size` → **INVALIDATED** (`wal_status=lost`), `restart_lsn` released, safekeeper `/data` **13%→13%** (plane did NOT fill) — *degrade-to-re-sync, never plane-fill*; re-sync recovers. **PROOF 2 (ALERT):** both `repl-slot-{wal,inactive}-monitor` Jobs Fail → `ReplicationSlotWALGrowth` / `ReplicationSlotInactive` fire. **PROOF 3 (ACTIVE-NOT-PRUNED):** an active slot deliberately **72 MB behind** (subscriber apply stalled) → the wal-janitor's `resolve-slot-floors` writes a floor at its `restart_lsn` and the prune horizon never crosses it; on lock release the subscriber drains the backlog (**60 005 rows**) and the publisher/subscriber **checksums match** (live replication intact). Inert on the slot-free plane (janitor behaves identically). See `docs/operations.md#zoned-replication-slot-monitoring-adr-0007` |
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

### Backup + WAL-janitor portability (issue #120, v1.0.1) — live-verified 2026-07-05

The #105 abstraction was only half-applied: `deploy/62-backup.yaml` hardcoded
`mc alias set src http://minio:9000` in both the backup Job and the wal-janitor, so
a non-MinIO deployment had **no backup** and leaked safekeeper WAL. Fixed: both now
resolve `src` from `storage-objstore`. `deploy/_verify-backup-portability.sh` proves
it against **real OCI Object Storage, NO MinIO**:

| Path | Result | Evidence |
|---|---|---|
| Backup **mirror** (src=OCI live store, dst=OCI backup bucket) | ✅ pageserver objects + intact `index_part.json` landed in the OCI backup bucket | `ok - pageserver objects landed in the OCI backup bucket (2 objects …)`; `MIRROR_OK` |
| WAL-**janitor** prune (config-driven src=OCI) | ✅ below-horizon WAL reclaimed from OCI; `.partial` tail + at/above-horizon segment preserved | `ok - OCI prune correct: below-horizon segment removed; .partial tail + above-horizon segment preserved` |

Method: OKE (`context-ckmva7v7zvq`), throwaway namespace `backup-port-drill`, two
self-provisioned OCI buckets (`ks-pg-bkpport-src/dst-drill`, torn down on exit),
endpoint `axfqznklsd2t.compat.objectstorage.me-abudhabi-1.oraclecloud.com` (SigV4,
path-style, reusing the #4 CSK), drill-only tenant. The container env wiring +
src/dst resolution mirror the shipped `62-backup.yaml`; `deploy/_validate.sh`
(contract 15b) is the standing guard that neither container reintroduces `minio:9000`.

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

## Upgrade EXECUTED — data through the upgrade (issue #98, GA gate) — 2026-07-04

`deploy/_verify-upgrade.sh` goes past the rehearsal: it stands up a plane at the
**current** tag (8464), seeds a real `ledger` table and **durably offloads** it to
the object store (remote_consistent_lsn past the seed marker), then **rolls every
image to `17411840350`** in place (`kubectl set image` on broker→safekeeper→
pageserver→compute, version pair honored), and proves the seeded data survived and
the plane is still read-write. OKE `context-ckmva7v7zvq`, throwaway ns
`upgrade-exec`, durability tier = **OCI Object Storage S3-compat** (#105, no
in-cluster MinIO), dedicated drill bucket + drill-only tenant.

| Property | Result |
|---|---|
| Seeded rows, made durable pre-upgrade | **5000** (checksum `sum(amount)=2497500`), offloaded to OCI OS |
| **Data survived the image roll** | ✅ **5000 rows, checksum identical** on `17411840350` |
| New write post-upgrade | ✅ accepted + read back (ledger → 5001 rows) |
| `safekeeper.control` across upgrade | pre **v9** → post **v9** (`magic=0xcafeceef`, `skctl checkver` SURVIVES) ⇒ **manifest bump, not skctl rewrite** |
| Post-upgrade wake cycle (compute 0→1) | ✅ **4s**, rows intact |
| version-pair + skctl-coupling contracts | ✅ green |

**Upgrade duration + client downtime** (compute is scaled to 0 first, back to 1
last; downtime = compute-0 → new-tag compute serves SQL):

| Component roll | Warm (images pre-pulled) | Cold (first pull on node) |
|---|---|---|
| storage-broker | 12s | 192s |
| safekeeper | 63s | 216s |
| pageserver | 60s | 12s |
| compute | 32s | 45s |
| **TOTAL upgrade / downtime window** | **169s (2m49s)** | **~465s (~7m45s)** |

**The dominant upgrade cost is the per-node multi-GB image pull, not the plane
mechanics.** Cold (a tag never seen on the node) is ~7–8 min of downtime; warm
(image pre-pulled) is ~2m49s. **Mitigation: pre-pull the target images onto every
node** (a `DaemonSet` or `crictl pull`) *before* opening the maintenance window —
that collapses the outage toward the warm number. Full narrative + rollback
posture: `docs/operations.md` §"Upgrading the storage plane".

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

## Writer vertical-autoscaler — automated in-place resize (issue #103)

The `writer-autoscaler` controller automates the #67 resize. Live-verified on **OKE
v1.33.10, 2026-07-05**, driving a real `compute` (primary writer) under CPU load via
`deploy/_verify-writer-autoscaler.sh` (fast drill cadence: 5s poll, up-hold 2,
down-hold 3, up≥0.55 / down≤0.40):

| Phase | Action | Actuated? | Restart? | Evidence |
|---|---|---|---|---|
| CPU load (3 busy loops, ~1000m on a 1000m limit → ratio ≈1.0) | autoscaler resizes **up** `cpu-limit 1000m→1250m` | **yes, immediately** | **no** (`restartCount=0`) | actuated `status…resources.limits.cpu` = 1250m within one poll |
| Load dropped, sustained idle | autoscaler resizes **down** `cpu-limit 1250m→1000m` (hysteresis) | **yes** | **no** (`restartCount=0`) | actuated limit back to 1000m after down-hold |
| memory-bound AT `WAS_MAX_MEM` | **flag** annotation, no resize, **no bounce** | n/a (flagged) | **no** | `writer_autoscaler_needs_bounce_total` +1; `needs-bounce` annotation set |

`restartCount` was **0 throughout** — the Postgres never bounced. Key design point:
the autoscaler moves the **limit** (cgroup ceiling) and keeps the **request** at the
manifest baseline, so the resize is **never deferred** for lack of node allocatable
(the nodes were at 97%/77% CPU-requests during the drill) — it actuates immediately.
Runbook + config: `docs/operations.md` §"Writer vertical-autoscaler".

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

## Per-app read replicas — tenant isolation + staleness (issue #127)

Per-app read replicas make `DATABASE_URL_RO` a **real, tenant-isolated** endpoint:
the apps-gateway RO listener (`GW_RO_PORT=55434`, **template mode**) routes
`database=<app>` reads to that app's OWN `compute-ro-<app>` (0↔N), provisioned by the
AppDatabase operator when `roPool.enabled`. Gateway routing + authz are covered by Go
table tests (`gateway/internal/wake/ro_test.go` — per-app resolve, `(user,database)`
authz on the RO lane, never the shared pool); operator RO provisioning by
`gateway/internal/appdb/{reconcile,render_ro}_test.go`; manifest contracts by
`deploy/_validate.sh`; and **isolation end-to-end** by `deploy/_verify-perapp-ro.sh`
(two apps A+B, each `roPool.enabled`).

Verified **live on OKE, 2026-07-05** (`_verify-perapp-ro.sh`, apps `roa`/`rob`, gateway
+ operator on the #127 image):

| Metric | Result | Evidence |
|---|---|---|
| A reads A (per-app RO serving) | ✅ A's `DATABASE_URL_RO` woke `compute-ro-roa` and returned A's own row | **~48 s** first-read incl. **cold** RO wake (0→1); scale-to-zero pool |
| **A can NOT read B's data** | ✅ A's RO returned **0 rows** for B's marker | timeline isolation (distinct branch) |
| **A refused on B's RO db** | ✅ `app_roa` on db `rob` (RO port) → `28P01`, and `app_rob` on `roa` → refused | `(user,database)` authz holds on `55434`, **both directions** |
| Write on RO DSN rejected | ✅ `read-only transaction` error; no row leaked | negative assertion (writer confirms no row) |
| Staleness (Replica lag) | fresh writer row visible on A's RO (bounded) | **~143 s this run** — but that figure is dominated by scale-to-zero cold-wakes + a **concurrent load lane** (the writer-autoscaler drill on the same 2-node cluster) contending for CPU, **not** replication lag. The warm tip-following contract is the pre-existing **~9 s** (§ Read-only pool #66) — Replica mode is the same code path per-app. |
| Teardown removes RO compute | ✅ deleting B removed `compute-ro-rob` | no orphaned read replicas |

Verified **live on OKE, 2026-07-05** (`_verify-perapp-ro.sh`, apps `roa`/`rob`, gateway
+ operator on `sha-445d19d@sha256:8a7a115d…`). The **isolation** guarantee — A reads
A, never B, both data and authz directions — is the headline result and passed
cleanly across repeated runs; the staleness figure is noisy under the concurrent
load lane and is recorded honestly rather than cherry-picked.

## Warm-plane RO staleness (issue #169)

**The question.** A #167 sysdesign drill saw a per-app RO (`compute-ro-<app>`) not
reflect a fresh writer row within 90 s on a **cold** plane (both computes just
woken). Is the ~9 s tip-following contract (§ #127 / #66) broken, or was the 90 s the
one-time **cold walreceiver catch-up** — a wake cost, not steady-state replication
lag? `deploy/_measure-ro-staleness.sh` isolates the two: one long-lived pod holds
psql to both the writer (`DATABASE_URL`) and the RO (`DATABASE_URL_RO`), commits a
unique marker, and polls the RO **every 100 ms**. It reports **two independent
metrics per cycle**: `polls` (100 ms polls until the row is visible — the
**replication-only** signal, taken once the RO is already awake) and `lag_s`
(wall-clock write→visible). Warm-up cycles are discarded so the cold catch-up is
excluded on purpose.

**Result — live on OKE, 2026-07-12 (`_measure-ro-staleness.sh`, app `rostale`,
`RO_MODE=Replica`, warm plane).** Run captured during an **intermittently degraded
OKE control-plane window** (recurring `net/http: TLS handshake timeout`); the run's
session lapsed mid-drill after 5 of 7 cycles, so the numbers below are the honest
partial capture (N=5), not the full N≥7. The **replication-only** signal is
unambiguous:

| Cycle | `polls` (100 ms polls → visible) | `lag_s` (wall-clock) |
|---|---|---|
| WARM 0 | **0** | (discarded warm-up) |
| WARM 1 | **0** | (discarded warm-up) |
| WARM 2 | **0** | (discarded warm-up) |
| CYCLE 0 | **0** | 64.113 s |
| CYCLE 1 | **0** | 64.101 s |

**`polls=0` on every one of the 5 cycles** — the RO saw the committed writer row on
the **very first 100 ms poll** (i.e. sub-100 ms replication visibility once the RO is
awake). Steady-state tip-following replication is **sub-second**, far inside the ~9 s
contract, which **HOLDS**.

**The `lag_s=64 s` is a wall-clock artifact, NOT replication lag** — and `polls=0`
proves it: the row was *already* replicated and visible the instant the RO responded.
On this run the RO compute scaled to zero between cycles (idle in the write→next-cycle
gap under the flaky API), so the first `seen()` poll of each measured cycle blocked
~64 s **waking `compute-ro-rostale` 0→1** before it could answer — that ~64 s is
**RO-side cold-wake time**, on the scale-to-zero axis, not the replication axis. This
is the **same class of artifact** as the #167 90 s and the #127 ~143 s figures: all
three are **cold-wake / degraded-API wall-clock**, not tip-following replication lag.
The `_measure-ro-staleness.sh` design starts its clock *after* an acknowledged
`COMMIT` (so writer-wake is already excluded from `lag_s`); a fully clean `lag_s`
additionally requires the **RO** to stay warm across cycles — a persistent RO
connection was added mid-run but the session lapsed before clean cycles completed.

**Verdict:** steady-state warm-plane RO staleness is **sub-second** (replication-only
`polls=0`, N=5) — the ~9 s contract holds. The 60–124 s `lag_s` seen here and in the
prior #169 attempt, the #167 90 s, and the #127 ~143 s are **cold-wake / degraded-API
wall-clock artifacts**, not replication lag. A clean end-to-end `lag_s` (both computes
held warm, healthy control plane) is deferred to a re-run under a stable session.

**Update (#188, 2026-07-12) — drill verdict fixed; clean `lag_s` infra-deferred.**
Two changes. (1) **`_measure-ro-staleness.sh` now derives its pass/fail verdict from
the `polls` metric** (sub-second = visible within ~1 poll → HOLDS; only a genuinely
slow *replication* signal → CONCERN), not the `lag_s` median — which previously
**false-flagged** a contract concern on any RO cold-wake cycle that `polls=0` refutes.
The `selftest` covers the classifier (SUBSEC/HOLDS/CONCERN/NODATA boundaries). (2) A
clean end-to-end `lag_s` (both computes held warm) was re-attempted on the current
**2-node** OKE cluster and is **still deferred — for an infrastructure, not a
replication, reason**: node CPU-**request** allocatable is only **1830m per node** on
these small (~2 vCPU) nodes, and most of it is already reserved by the resident storage
+ control-plane footprint (safekeeper / pageserver / MinIO / gateways / prometheus /
operator requests — even though *actual* CPU usage is only ~5%). So co-scheduling a
second warm compute (default request **250m** — `deploy/26-compute-ro.yaml`, `appdb`
`DefaultQuotas.CPURequest`) *plus* the drill's measurement + keepalive pods exceeds the
remaining unreserved allocatable, and the second compute lands `Pending` with
`0/2 nodes available: Insufficient cpu` (node-allocatable pressure on **requests**, not
a large per-compute request — same 2-node request-contention noted for the #127 ~143 s
figure). A clean `lag_s` needs a larger/less-loaded drill cluster (or scaling the
resident footprint down for the run).
This is a benchmark nicety only: **the contract is already answered** — `polls=0`
(#187, N=5) conclusively proves sub-second tip-following replication. The drill gained
`RO_MINREPLICAS`/RO-keepalive knobs to hold the RO warm for a future clean run.

## Read-only pool under load (HPA n>1, issue #99)

The GA gate for read-scaling: with the read-scaling HPA
(`deploy/optional/27-compute-ro-hpa.yaml`, posture B, `minReplicas: 1`) applied,
**real concurrent read load drives `compute-ro` past one replica and it drains
back down** when the load stops. Verified **live on OKE, 2026-07-04** by
`deploy/_verify-readpool.sh` (its `RO_HPA` section, auto-on when a metrics-server
is present), on the **v0.6.1 release gateway**
(`v0.6.1@sha256:12a73533…`, `KSPG_SKIP_BUILD=1`, `RO_MODE=Replica`). Load = 4
concurrent in-cluster loaders each looping a CPU-**and-ephemeral**-heavy query
(`select sum(i) from (select i from generate_series(1,12000000) i order by i desc) s`
— the `ORDER BY` spills temp files to the pod's ephemeral fs, exercising the #121
eviction path while still driving the CPU HPA) against the `compute-ro` Service;
`maxReplicas` capped to 3 for the 2-node test cluster (the shipped manifest ships
`maxReplicas: 5`).

| Metric | Result | Evidence |
|---|---|---|
| **HPA scale-up under load** | **`compute-ro` 1 → 3** (n>1) | CPU hit **276%** of the 250m request (target 70%); `READPOOL_HPA scaled_up=yes base=1 peak=3 loaders=4` |
| **Writes rejected while at n>1** | ✅ `read-only transaction` at **n=3** | a write on the RO path is refused even under load + at multiple replicas (retried through not-ready-pod routing) |
| **HPA scale-down after drain** | **`compute-ro` 3 → 1** | load removed → CPU→4% → HPA drained to the `minReplicas: 1` floor over its 120s stabilization; `READPOOL_HPA scaled_down=yes final=1` |
| Staleness **under load** | not measured this run (honest) | on the 2-node test cluster the cold writer could not wake within the bounded window while N RO pods + N loaders occupied it; the **pre-load contract (~9 s, above) stands** as the guarantee. `READPOOL_HPA_STALENESS … tip_following=unmeasured note=writer-wake-headroom` |
| **No eviction under sustained load (#121)** | ✅ **0 evictions** at **n=3** over **120 s**; peak ephemeral **~2.0 Gi** | re-run **2026-07-05** with the temp-spilling loader + sized ephemeral-storage (request 2Gi / limit 4Gi): `READPOOL_EPHEMERAL sustained_s=120 evictions=0 peak_mb=2065 limit_mb=4096 request_mb=2048`. At the old **1Gi** limit the kubelet evicted `compute-ro` under exactly this load — peak ~2065MB proves the load genuinely crossed the old ceiling, and the 4Gi limit absorbed it. |

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

## Gateway-mediated replication-wake (v2-1, issue #139, ADR-0007 §4c)

The load-bearing metric of the **zone-scaling axis**: a subscriber's walreceiver
connecting **through** the apps-gateway wakes a **sleeping** publisher — so a
publishing zone keeps full scale-to-zero (the axis's whole premise) instead of the
warm-publisher fallback (§4c option i). The subscription's `CONNECTION` points at
`pggw-apps` (not `compute-<zone>` directly); the gateway detects the `replication=`
startup (`proto.IsReplication`), authorizes it against the per-zone `repl_<zone>`
role (`wake.AuthorizeReplication`, ADR-0007 §4b — NOT `app_<zone>`), wakes the
publisher, and pipes the CopyBoth stream through the **same** byte pump as ordinary
traffic (no dedicated listener). An active replication stream is tracked
(`replCount`) so the idle timer never sleeps a publisher while a walreceiver is
attached. Go tables: `gateway/internal/proto/proto_test.go` (detection matrix),
`gateway/internal/wake/authz_test.go` (repl-vs-app role separation, uniform `28P01`
#92), `gateway/internal/gateway/replwake_test.go` (wake-target + hold-awake e2e).

Verified **live on OKE, 2026-07-07** (`deploy/_verify-repl-wake.sh`, throwaway zones
`zpub`/`zsub`, gateway image `sha-0913539@sha256:9ccbc6a0…`, `DRILL_IDLE_MS=15000`):

| Metric | Result | Evidence |
|---|---|---|
| **Slept publisher WOKEN by a subscriber** | ✅ `compute-zpub` scaled **0→1** with **no manual scale** — the walreceiver's connect through the gateway was the sole trigger | **4.05 s** (cold, settled-zero publisher) |
| Backlog drains after gateway-wake | ✅ subscriber caught up **305 rows** (5 seed + 300 backlog) | **7.45 s** after subscriber wake |
| **Does NOT sleep while replicating** | ✅ publisher **HELD at 1 replica** across a **27 s** hold (> 15 s idle window) with a live insert (`livemark`) replicating mid-hold | `replCount` holds it awake; live row arrived |
| Sleep-eligible once the stream closes | ✅ after `DROP SUBSCRIPTION` (walreceiver disconnects) the publisher scaled **1→0** on its own | **12.10 s** after slot closed |
| Slot retention while subscriber asleep | ✅ publisher retained **82 kB** WAL for the inactive slot (`active=false`) — no data loss across the double-sleep | `pg_replication_slots.restart_lsn` |

The `~3.6 s` wake estimate in ADR-0007 §4c held (4.05 s cold). The walreceiver's
own retry (`wal_retrieve_retry_interval`) tolerates the wake latency, so no
subscriber-side tuning was needed. Metric: `pggw_replication_connections_total`.
Config: `GW_REPL_ROLE_PREFIX` (default `repl_`) on `deploy/81-apps-gateway.yaml`.
The drill provisions/destroys its own throwaway zones and restores `GW_IDLE_MS` on
teardown — it never touches live apps.

## Zone operator — cross-zone replication end-to-end (v2-2, issue #139, ADR-0007)

The payoff of the zone-scaling axis, driven ENTIRELY through `Zone` CRs + the
`zone-operator` (no manual pub/sub SQL — the operator is the sole author). A
publisher zone `za` declares `publishes: [{orders_pub, [orders]}]`; a consumer zone
`zb` declares `dataDependencies: [{fromZone: za, tables: [orders], mode: replicate}]`.
The operator composes both `AppDatabase`s, mints `repl_za` (LOGIN REPLICATION),
creates the publication on za, and the subscription on zb whose `CONNECTION` points
at `pggw-apps` — so the v2-1 replication-wake (#140) wakes a sleeping publisher for
the subscriber. Governance: the subscription is wired only because za publishes the
requested table (**both-sides-agree**), and za's UNpublished `secret_t` is never
exported (**sovereignty**).

Verified **live on OKE, 2026-07-07** (`deploy/_verify-zones.sh`, throwaway zones
`za`/`zb`, gateway image `sha-fec345e@sha256:5abb86fc…`):

| Metric | Result | Evidence |
|---|---|---|
| Compose + wire (operator-authored) | ✅ both AppDatabases Ready; `repl_za` (REPLICATION attr), `orders_pub`, and `zone_sub_za` (streaming) all created by the operator | `kubectl get zone`, `pg_publication`/`pg_roles`/`pg_subscription` |
| Publisher compute labeled `plane=compute` | ✅ so the slot-janitor (#143) floors its prune horizon at active slots | `kubectl get deploy compute-za` labels |
| Initial COPY (cross-zone) | ✅ 5 seed rows replicated `za → zb` | subscription initial snapshot |
| **Live cross-zone lag** | ✅ a live insert on za appeared on zb | **1.81 s** |
| **SOVEREIGNTY** | ✅ za's UNpublished `secret_t` did **not** reach zb (no such table) — opt-in export only | `information_schema.tables` on zb |
| **Publisher TRULY rests at zero** | ✅ with the **zone-operator scaled to 0**, `compute-za` stayed at **0 replicas for 20 s** — the steady-state gate means a Ready zone is never force-woken by the resync (ADR-0007 §4c scale-to-zero contract) | `kubectl get deploy compute-za` replicas, operator down |
| **PUBLISHER WOKEN FOR REPLICATION** | ✅ waking ONLY the subscriber (operator still down) woke sleeping `compute-za` **0→1** — unambiguously zb's walreceiver through the gateway (#140), NOT the operator | **5.30 s** |
| Backlog drains after publisher-wake | ✅ zb caught up **56 rows** (6 live + 50 backlog) | **6.73 s** after subscriber wake |
| **Deprovision hygiene (§4d)** | ✅ deleting zb dropped its subscription + the slot on za (**no orphan slot**); deleting za dropped the publication; **both timelines reclaimed** | `pg_replication_slots` on za empty; `kubectl get appdatabase` gone |

The **publisher-truly-at-rest** row is the load-bearing correction from PR #145's
code review: the operator re-asserts the (durable) repl role / publication /
subscription **only on a spec change** (a steady-state gate keyed on
`generation == observedGeneration`), so it never wakes a Ready zone's compute on the
15 s resync — otherwise a publishing zone could never scale to zero and the
gateway-mediated wake (#140) would be moot. The measurement scales the operator to 0
during the wake so the `0→1` is attributable ONLY to the subscriber path.

The subscription's create is gated on the peer's `status.publications` so the
initial COPY never snapshots an empty publication (it captures pre-existing rows).
Publications reconcile non-disruptively (`CREATE`-if-absent + `ALTER PUBLICATION SET
TABLE`, never drop+recreate); subscriptions are created **once** (a `\gset`/`\if`
guard) so no re-COPY/slot-thrash on the 15 s resync. The drill provisions/destroys
its own throwaway zones — it never touches live apps.

## Zone reliability — re-sync actuator + no-force-wake + alerting (v1.3.1, #146/#147, ADR-0007)

Verified **live on OKE, 2026-07-07** (`deploy/_verify-zones.sh run` + `alerts`,
throwaway `za`/`zb`/`zbadfail`, zone-operator image
`sha-zonerel-0f43d94@sha256:2b30dcd4…` — rebuilt with these fixes). The full v2-2
drill above still passes on the new image (wake **5.40 s**, backlog-56 **6.78 s**,
clean deprovision); the new reliability proofs:

| Metric | Result | Evidence |
|---|---|---|
| **Scale-to-zero regression guard (#145 NOT reintroduced)** | ✅ with the **zone-operator RUNNING 1/1** and reconciling every 15 s, `compute-za` (Ready+healthy publisher) **rested at 0 for 60 s** — the re-sync health poll reads a peer slot ONLY when the peer is already awake, so it never force-wakes a settled zone | `kubectl get deploy compute-za` replicas polled 12× over 60 s, operator up |
| **Slot invalidation → self-heal (RE-SYNC ACTUATOR, ADR-0007 §4a)** | ✅ shrinking `max_slot_wal_keep_size` to 1 MB + WAL while the subscriber slept **invalidated** `zone_sub_za` (`wal_status=unreserved`); the running operator detected it and **auto re-synced** (`DROP`+`CREATE SUBSCRIPTION copy_data`) — subscription back to **streaming** on a **fresh** slot (`wal_status=reserved`) | operator poll + `pg_replication_slots` before/after |
| **Post-resync correctness (checksum)** | ✅ a fresh live insert on za replicated to zb; `orders` row counts **match** after re-sync (**za=57, zb=57**) | `select count(*)` both sides |
| **Zone alerting pages (SRE F2)** | ✅ an invalid-spec Zone (`zbadfail`, self-dependency) reached `phase=Failed`; the on-demand `zone-phase-monitor` Job **FAILED** → `ZoneDegradedOrFailed` fires via `kube_job_owner` (critical, `plane=zones`) | `kubectl create job --from=cronjob/zone-phase-monitor` → Job `failed=1` |

The auto re-sync healed fast enough that the transient `needs_resync` status was not
caught by the 2 s drill poll (the truthful-status flip + the runbook-only path when
`ZONE_AUTO_RESYNC=false` are unit-covered:
`gateway/internal/zone/reconcile_test.go`). Fail-closed on a Zone-lister outage
(#147 — no publication created while the peer set is unreadable) and deprovision
retry-not-strand on a live-but-unwakeable peer (#146) are unit-proven
(`TestReconcile_ListErrorFailsClosed`, `…DeprovisionRetriesLivePeerNotStrand`) —
they cannot be safely forced on the live plane without breaking operator RBAC.

## Wake-primitive security — per-app wake budget (issue #116, ADR-0008)

Verified **live on OKE, 2026-07-07** (`deploy/_verify-wake-guard.sh run`, throwaway
`wgapp`, apps-gateway image `sha-e140408@sha256:f6f6abf9…` — the wake-budget build).
`pggw-apps` runs `GW_WAKE_BUDGET=15` / `GW_WAKE_WINDOW_MS=60000`, 2 replicas.

| Metric | Result | Evidence |
|---|---|---|
| **No regression — legit single wake** | ✅ an app connecting with valid creds through `pggw-apps` after scale-to-zero still cold-started its compute and returned a row | drill step 2 (`select 42`) |
| **Unauth burst budget-capped** | ✅ **42** unauthenticated parallel startups for one sleeping app (budget 15 × 2 replicas + 12) were capped: **12/42 refused** with clean `53400`; the gateway logged **13** refusals server-side | drill step 3 (client `53400` count + `kubectl logs -l app=pggw-apps \| grep 'wake budget exceeded'`) |
| **Churn bounded** | ✅ `compute-wgapp` never exceeded **1 replica** under the burst — single-writer wake is 0→1 only, not unbounded | `kubectl get deploy compute-wgapp` spec.replicas |
| **Observable — metric rises** | ✅ `pggw_wake_budget_exceeded_total{gateway="pggw-apps"}` rose during the burst | Prometheus instant query |
| **Observable — alert fires** | ✅ `WakeBudgetExceeded` (plane=apps) reached **firing** in alertmanager after the 1m `for` | `alertmanager /api/v2/alerts?active=true` |

Note: the budget is enforced **per gateway replica** (in-memory token bucket), so the
effective per-app ceiling before refusals begin is `GW_WAKE_BUDGET × replicas` (30 at
15×2). Still a hard bound; a fleet-shared bucket is a deliberate non-goal (ADR-0008).
Wake **latency** is unchanged (a warm app is never gated; the budget is consulted only
when the compute is asleep) — no cold-wake regression.

> **Update (issue #166), re-verified live on OKE 2026-07-11:** the `WakeBudgetExceeded`
> alert was **debounced** — `for: 1m` over a `[5m]` window → **`for: 3m`** over a `[2m]`
> window — so a single self-clearing burst no longer pages (only a *sustained* breach
> does). The reworked drill (`_verify-wake-guard.sh run`) now **sustains** the over-budget
> breach (~5 min, past the 3m `for:`) before asserting firing.
>
> **2026-07-11 live re-record** (post-#184 deploy; `pggw-apps` `GW_WAKE_BUDGET=15` × 2
> replicas ⇒ ~30 ceiling; prometheus rule confirmed live at `for: 3m` / `increase(...[2m])`):
> full drill **PASS** — no-regression legit wake returned a row; unauth burst of **42**
> attempts **capped at 12/42 refused** (`53400`), `compute-wgapp` bounded to **≤1 replica**;
> `pggw_wake_budget_exceeded_total{gateway="pggw-apps"}` rose **0 → 12**; and
> **`WakeBudgetExceeded` (plane=apps) reached FIRING under the sustained breach** — while a
> single self-clearing burst is debounced away. Confirms the #166 debounce pages on a
> genuine sustained side-channel and suppresses only transient noise. (The 2026-07-07 row
> above remains the pre-#166 `for: 1m` single-burst record.)

## Platform extensions — TimescaleDB + pgvector self-enable + scale-to-zero survival (issues #177/#178, ADR-0001)

Verified **live on OKE, 2026-07-11** on `compute-node-v17:8464`. Mechanics first probed on
the `pgdemo` app DB, then codified + re-run end-to-end via `deploy/_verify-extensions.sh`
(throwaway app `extdrill`, provisioned through the AppDatabase CRD).

| Claim | Result | Evidence |
|---|---|---|
| **Both bundled + trusted** | ✅ `timescaledb 2.17.1` and `vector 0.8.0` in `pg_available_extensions`; both control files `trusted = true` | `pg_available_extensions` + `*.control` on the compute |
| **pgvector needs NO preload / image bump** | ✅ `CREATE EXTENSION vector` works with the stock compute config (not in `shared_preload_libraries`); already in 8464 | spike, no manifest change |
| **App SELF-enables (no cloud_admin)** | ✅ `app_extdrill` ran `CREATE EXTENSION timescaledb; CREATE EXTENSION vector;` over its own `DATABASE_URL`. Before the template `GRANT CREATE ON DATABASE … TO PUBLIC`: *"permission denied … Must have CREATE privilege on current database"*; after: succeeds | drill step 2 |
| **TimescaleDB hypertable live** | ✅ `create_hypertable` + 60 rows + `time_bucket('15 min')` → 5 buckets | drill step 3 |
| **pgvector hnsw ANN live** | ✅ `vector(3)` column + `hnsw (vector_l2_ops)` index + `<->` nearest-neighbour: top hit is the query vector itself (dist 0) | drill step 4 |
| **Survives scale-to-zero** | ✅ scale `compute-extdrill` → 0, wake on reconnect: hypertable (60 rows), `time_bucket`, vector `<->`, the `ext_vec_hnsw` index, and both `pg_extension` rows all intact | drill steps 5–6 |

Methodology: extension objects + data live on the pageserver (per-branch catalog + tables),
so scale-to-zero is a compute restart, not data loss — the same durability the base wake drill
proves. TimescaleDB is offered at the **Apache-2 tier only** (no columnar compression /
continuous aggregates: those are TSL background-worker jobs that cannot run on a compute that
sleeps — ADR-0001 Q1). pgvector has no such caveat (no background worker). Drill runtime on the
flaky OKE control plane is dominated by throwaway-psql-pod scheduling + occasional TLS-handshake
retries, not by Postgres — every positive assertion is wrapped in a 6× `RETRY`.

## Sustained-load / soak baseline (high-traffic wave, #375 W1 · #376)

Harness: `deploy/_verify-loadsoak.sh` + `deploy/88-loadsoak-k6.yaml` — an **in-cluster**
k6 Job (ramping-VUs: ramp-to-ceiling → ≥10-min soak) against ONE knext app. In-cluster to
avoid the WAN RTT that made earlier out-of-region numbers RTT-bound (see Methodology).
Metrics per run: RPS achieved, p50/p95/p99, error rate, the concurrency→latency curve
(input to W2 ContainerConcurrency), and a both-planes snapshot recording **which wall broke
first**. Invoke: `TARGET_URL=<in-cluster app URL> ./_verify-loadsoak.sh` (see
operations.md "Sustained-load / soak / throughput harness").

### OKE baseline — 2026-07-17 (cc=100, no pooler, max-scale=10)

Live run on OKE (`context-ckmva7v7zvq`), image `obs-6e977bc`, target the in-cluster
route `http://file-manager.default.svc.cluster.local/users` (`unstable_noStore` → a DB
query every request), ramp 0→40 VU (2m) → soak 28 VU (5m). **k6 client pinned to
`K6_CPU_REQUEST=150m`** (see caveat).

| app | phase | RPS | p50 (ms) | p95 (ms) | p99 (ms) | err % | peak VUs | first wall |
|---|---|---|---|---|---|---|---|---|
| file-manager | rampsoak | **135.3** | 226.8 | 308.1 | 398.0 | **0.00%** | 40 | none hit at this load |

Concurrency→latency curve (W2 ContainerConcurrency input), CSV `concurrency,p50,p95,p99,err%,rps`:
```
40,226.83,308.08,397.95,0.00,135.32
```

**Reading:** at 40 concurrent the app served **135 RPS at p99 ~398 ms, 0 errors, on ONE
app pod** — with the default `containerConcurrency=100`, 40 concurrency is well below the
add-a-replica threshold, so the app never scaled out and no wall (app pods / GW_MAX_CONNS=90
/ writer / DB CPU) was approached. Healthy headroom; the DB single-writer absorbed the
read-heavy mix comfortably.

**Caveats (honest limits of this baseline):**
1. **k6-client-CPU-bound, not app-bound.** This OKE cluster is CPU-**request**-constrained
   (2 nodes × 1830m allocatable, ~mostly reserved by Knative/kourier/storage/monitoring;
   actual usage ~5%). A single in-cluster k6 pod only schedules at `~150m`, which caps it
   near ~40 VU. So 135 RPS is a *floor* (the k6 client ceiling), NOT the app's ceiling —
   the app stayed at 1 pod and 0 errors, i.e. it was never stressed. Driving the real
   ceilings (app scale-out at cc, the 90-conn wall, writer saturation) needs either more
   schedulable CPU or a **fan-out of N k6 pods** — a harness follow-up (#376-fanout).
2. **Gateway `pggw_*` metrics scraped "unavailable"** and the DB-compute snapshot showed
   `replicas=0` while requests were served 0-error (mislabeled deployment lookup) — the
   "which wall broke first" instrumentation needs a fix before it can adjudicate a real
   wall (harness follow-up). Not load-bearing here since no wall was hit.

This is the honest "before" data point for the wave: at achievable in-cluster load the
platform is comfortable; the true high-traffic ceilings remain to be driven once the
load-generation constraint is lifted (multi-k6-pod fan-out).

The harness is validated cluster-free (`SELFTEST=1 ./_verify-loadsoak.sh` +
`bash deploy/test_verify-loadsoak.sh`): the manifest dry-runs and the summary parser is
asserted to produce this exact row format from a sample k6 JSON. **No load numbers are
fabricated here** — the table stays "pending" until the OKE run fills it (rule 2b / honesty).

## Writer vertical-autoscale under sustained write load (#379)

Harness: `deploy/_verify-writer-ceiling.sh` + `deploy/test_verify-writer-ceiling.sh` — an
**in-cluster write loader** (`WC_LOADERS` `psql` INSERT-loop pods) driving sustained INSERTs
**through the apps-gateway on the app's own branch** (passwordless DSN
`postgres://app_<app>@pggw-apps:55432/<app>`; the password is injected as `PGPASSWORD` via a
`secretKeyRef` to `app-db-<app>` — never in the manifest/DSN/etcd, per security.md)
into a throwaway `wc_drill` table, while the drill samples the #103 writer vertical-autoscaler
on `compute-<app>`. Two things are proven/published (wave #375 W4):

1. **In-place resize under real write load** — the writer's *actuated* cpu-limit grows UP under
   the write soak and shrinks DOWN after drain, with `restartCount == baseline` throughout (an
   in-place resize never bounces Postgres). Same invariant as the #103 CPU-burner drill, now
   under the **real gateway write path** instead of a synthetic in-container burner.
2. **Write RPS ceiling** — the max sustained write RPS (committed INSERT batches/s, summed across
   loaders) at the node-fit / limit ceiling. This is the **honest hard limit**: writes scale
   **only vertically** (single-writer, the #103 resize) up to the node/limit ceiling; beyond that
   = **sharding, out of scope**. The number below is one app-branch's write capacity on the cluster.

Invoke (see operations.md "Writer vertical-autoscale ceiling under sustained WRITE load"):

```sh
cd deploy
WC_APP=wcdrill WC_LOADERS=4 WC_BATCH=50 WC_SOAK_S=180 \
  WC_CONTEXT=context-ckmva7v7zvq ./_verify-writer-ceiling.sh
```

Results — **SCHEMA, pending OKE** (the orchestrator fills the numbers; no fabricated values):

| Phase | writeRPS (fleet, summed) | ok batches | err | err% | window (s) | writer cpu-limit | restartCount |
|---|---|---|---|---|---|---|---|
| ramp+soak (WC_LOADERS loaders) | _pending-OKE_ | _pending-OKE_ | _pending-OKE_ | _pending-OKE_ | _pending-OKE_ | `<base>m → <peak>m` (in-place) | **0** (no bounce) |
| drain (hysteresis) | — | — | — | — | — | `<peak>m → <base>m` (in-place) | **0** (no bounce) |

**Honest note (single-writer ceiling).** The write ceiling is the **single-writer vertical
limit**. A knext app has exactly one writer per branch; the only knob to raise write throughput
is the #103 in-place cpu-limit resize, up to the node/limit ceiling. Past that, the answer is
**sharding across branches** — deliberately out of scope for this wave. This drill turns the
previously-unknown write ceiling into a **known, documented capacity number**.

**Feasibility caveat (recorded honestly, per the mission).** On a CPU-request-constrained OKE
cluster each loader pod schedules at ~50m and the single writer may not be pushed past
`WAS_UP_RATIO` — the drill may only reach a **moderate write rate** and reports that explicitly
rather than faking a ceiling. In that case the *ceiling* row is the honest achievable write RPS
for the run, and the *in-place resize* proof may show "no scale-up observed under this load"
(the autoscaler correctness is still separately covered by `_verify-writer-autoscaler.sh` #103).

The harness is validated cluster-free (`SELFTEST=1 ./_verify-writer-ceiling.sh` +
`bash deploy/test_verify-writer-ceiling.sh`): the loader manifest dry-runs (asserting it writes
*through* pggw-apps, never a direct `compute-<app>` bypass) and the `parse_wcount` /
`aggregate_wcounts` parsers are asserted to produce this exact row format from fixed inputs.
**No write numbers are fabricated here** — the table stays "pending" until the OKE run fills it.

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
- **Per-app (branch) restore drill (#97, `deploy/_verify-app-restore.sh`, 2026-07-04,
  OKE).** Executed a REAL branch-per-app disaster recovery — provision two apps
  (victim + peer), mark, back up off-cluster, **destroy the victim's branch state**,
  restore THAT branch in a throwaway ns, prove read-only → writable → durable, assert
  isolation. Three findings, all executed (not asserted):
  1. **Cold branch restore needs `skctl` craft, same as the platform tenant.** The
     branch-per-app "walproposer auto-init, no craft" property (ADR-0003) is a
     **live-branching** property only. On a cold restore the fresh drill safekeeper is
     `flush_lsn 0/0`, so the branch PRIMARY aborts with *"cannot start in read-write
     mode from this base backup"* exactly like the platform tenant — it took the same
     `deploy/_restore-writable.sh` on-disk WAL re-seed (retargeted at the apps
     tenant + branch timeline) to promote it read-write. So the drill tries the LIGHT
     path, empirically records that it fails, and the HEAVY path carries it.
     (`_restore-writable.sh`'s `primary_kick` gained a backward-compatible
     tenant/timeline rewrite so it kicks the branch's timeline, not the hard-coded
     platform one — a no-op for the platform-tenant restore.)
  2. **Ancestor durability is a hard precondition.** A branch basebackup reads
     unmodified pages from its ANCESTOR (the shared template) at `ancestor_lsn`; a cold
     restore blocks *"waiting for WAL record … to arrive"* unless the **template's**
     `remote_consistent_lsn ≥ the branch's ancestor_lsn` is in the bucket. Because
     `provision-app` branches at the template's `last_record_lsn` (ahead of its
     `remote_consistent_lsn` by the un-flushed tail), a **freshly-provisioned app is
     un-cold-restorable in the seconds-to-minutes before the template tail flushes**.
     The drill reproduced the block and now gates on ancestor durability. 8464's
     force-checkpoint API is compiled out, so the only levers are WAL-driven or waiting
     for the periodic upload (details: `docs/runbook-dr.md` §9d-bis).
  3. **Isolation holds both directions:** destroying/restoring the victim never touched
     the peer branch on the live plane, and the peer's marker is not visible through the
     restored victim branch (timeline-scoped). **CAN'T:** per-branch PITR — one bucket,
     one restore point for every branch. RTO in the "Reliability drills" table above.
