# Independent System-Design Review — scale-to-zero Postgres (KS-PG)

**Reviewer:** independent senior system-design reviewer (did not build this system).
**Date:** 2026-07-02. **Scope:** `gateway/`, `deploy/`, verify scripts, docs, and the
live `scale-zero-pg` namespace (context `orbstack`, inspected read-only; `_verify-wake.sh`
run once — observed **2546 ms** gateway wake, ~6 s client-observed first-query, clean
0→1→0→1 loop).

---

## Executive verdict

The gateway is a genuinely good piece of engineering — small, single-purpose, well-commented,
and honestly documented — and the scale-to-zero loop demonstrably works (2.5 s wake, quorum
drill and HA drill pass). But the system that a small team would actually *operate for years* is
the **Neon storage plane**, and that is where the risk lives: a single pageserver and single
MinIO are platform-wide single points of failure, all state sits on node-local `local-path`
volumes with `Delete` reclaim and no backups, and the compute image floats on `:latest` while the
storage it must stay binary-compatible with is pinned. The deepest hazard is not any one bug but
the amount of Neon-specific operational knowledge (image-compat contract, generation numbers,
`fsync=off`, emergency mode) that is trapped in the builders' heads rather than written down.

| Dimension | Score | One-line justification |
|---|---|---|
| **Maintainability** | **5 / 10** | Clean, small, honestly-documented gateway; but a floating compute tag, one shared superuser rotated by hand-editing an md5 hash, unbuilt multi-tenancy, and Neon storage internals undocumented make the *whole system* hard for a non-author team to own. |
| **Production-readiness** | **3 / 10** | Solid MVP that works; but single pageserver + single MinIO SPOFs, local-path/Delete storage with no backups, trivial superuser over cleartext with no NetworkPolicy, no server-side pooling, and one hardcoded tenant put it firmly at proof-of-concept, not production. |

---

## Findings

| # | Sev | Finding | Evidence | Consequence | Remedy |
|---|-----|---------|----------|-------------|--------|
| 1 | **CRITICAL** | Compute runs a **floating `:latest`** tag while the storage plane it must stay format-compatible with is pinned to `neon:8464`. Live compute deployment confirmed on `neondatabase/compute-node-v17:latest`. | `deploy/20-compute.yaml:54` (`:latest`) vs pinned `neondatabase/neon:8464` at `52-safekeeper.yaml:23`, `53-pageserver.yaml:50`, `55-storage-init.yaml:21`; live `kubectl get deploy compute` → `...compute-node-v17:latest`. Directly violates the project's own rule `docs/operations.md:100-104` ("Never `:latest` for storage… Compute: same procedure"). | A silent `docker pull` on any node reschedule can fetch a compute build that no longer attaches to 8464 storage → **platform-wide data-serving outage with zero code/manifest change**, and non-reproducible ("worked yesterday"). | Pin the compute to a specific digest/tag matched to the storage release; document the compute↔storage compatibility matrix; `imagePullPolicy: IfNotPresent` only hides this locally. |
| 2 | **CRITICAL** | **Single pageserver** is an availability SPOF for *every* database. `replicas: 1`, no secondary. | `deploy/53-pageserver.yaml:31`; live `statefulset/pageserver 1/1`; admitted in `docs/operations.md:50`, `README.md:107`. | Any pageserver restart (upgrade, node drain, OOM, crash) stalls **all** computes on `GetPage@LSN` — the platform is down for reads and page faults even though computes show "up". Recovery = pod restart + layer-cache warm. | Run ≥2 pageservers with a storage controller, or at minimum a documented fast-restart runbook + PDB + tested RTO. Today there is no controller (`control_plane_emergency_mode=true`, `53:17-18`). |
| 3 | **HIGH** | **Split-brain sleep race (TOCTOU).** The peer-active check and the `Sleep()`/scale-to-0 are not atomic across replicas. Between pod A reading `peers==0` and issuing the scale-down, a fresh connection can land on pod B and wake/use the compute; A then scales it to 0 under B's live connection. | `gateway/internal/gateway/gateway.go:333-352` — peer check at :335, `driver.Sleep` at :352, no fleet-wide lock. Peer scrape is best-effort HTTP w/ 2 s timeout (`peers.go:48,72`); a blip returning `0` (not an error) also mis-sleeps. | Rare but real: a `Recreate` scale-to-0 terminates the compute mid-query, aborting an in-flight transaction; client sees a reset. Self-heals on reconnect but is a correctness hole in the core sleep decision. | Gate sleep on a short re-confirm (re-check local + peer immediately before scale, and after scale verify no connection arrived), or move the idle decision to a single leader/lease, or have the compute itself refuse-idle-shutdown while sessions are live. |
| 4 | **HIGH** | **Trivial superuser over cleartext, cluster-wide reachable.** `cloud_admin` (superuser), password = md5 of `cloud_admin`, `sslmode=disable`, `password_encryption=md5`, and **no NetworkPolicy** (confirmed none in namespace). Metrics `:9090` is also published on the gateway `LoadBalancer`. | `deploy/54-compute-files.yaml:22-25,94-95`; `30-knext-secret.yaml:27` (`sslmode=disable`); `10-gateway.yaml:104-106` (LB exposes 9090); live `kubectl get netpol` → none. | Anything in the cluster can reach `compute:55433` / `pggw:55432` and obtain superuser; unauthenticated metrics leak connection topology. Trivial lateral-movement DB compromise. | NetworkPolicy restricting compute to the gateway; real per-app credentials (not one shared superuser); TLS or a mesh; scram not md5; don't expose 9090 via the external LB. |
| 5 | **HIGH** | **One shared superuser for all apps, rotated by hand-editing an md5 hash in a ConfigMap.** `ALTER USER` doesn't stick (spec re-applied every boot), so rotation = compute the hash, edit `54-compute-files.yaml`, apply, rollout. | `docs/operations.md:56-65`; `deploy/54-compute-files.yaml:22-27`; `30-knext-secret.yaml:24-26`. | No credential isolation between apps; rotation is a manual, error-prone, whole-fleet reboot; the "secret" is derivable from the username. Scales terribly with tenant count. | Per-tenant roles created out-of-band (not baked into the boot spec); store real secrets in `Secret`s; a rotation job, not a manual md5 recipe. |
| 6 | **HIGH** | **All persistence is node-local `local-path`, RWO, reclaim `Delete`, tiny, no backups.** safekeeper (3×2Gi), pageserver (5Gi), MinIO (5Gi) all on `local-path`; PVs `RECLAIM=Delete`. | Live `kubectl get pvc/pv`: all `local-path`, all `Delete`; sizes in `52:53`, `53:70`, `50:43`. | Node loss strands/destroys the pageserver-0 and MinIO copies (single-node, single-copy); `kubectl delete pvc` = data gone; 2Gi WAL PVCs can fill under load. Undermines "reliable enough". No MinIO/S3 backup means no true bottomless durability. | Real StorageClass with replication/snapshots; `Retain` reclaim for stateful data; off-cluster S3 with lifecycle + backup; right-size PVCs and alert on WAL fill. |
| 7 | **HIGH** | **Single MinIO with plaintext dev creds in three manifests.** The bottomless/PITR/branching floor is one replica; `minio/password` hardcoded. | `deploy/50-minio.yaml:22-23`; same creds copied into `52-safekeeper.yaml:39-40` and `53-pageserver.yaml:53-54`. | MinIO loss pauses WAL offload / history / new-timeline creation and removes the PITR basis; creds in cleartext across manifests. | Real S3 or distributed MinIO; creds in a `Secret` referenced by all three consumers; verify offload survival, not just compute survival. |
| 8 | **MEDIUM** | **No anti-affinity / no PodDisruptionBudget on the storage plane.** safekeepers use `podManagementPolicy: Parallel` with no `topologySpreadConstraints`/anti-affinity and no PDB. | `deploy/52-safekeeper.yaml:15` (Parallel), no affinity/PDB anywhere in `deploy/`. | On a real multi-node cluster all 3 safekeepers can co-schedule on one node; a single node drain can take ≥2 → **quorum loss and write stall**, defeating the whole point of 3 safekeepers. | Pod anti-affinity across nodes/zones + a PDB (`minAvailable: 2`) for safekeeper; PDB for pageserver. |
| 9 | **MEDIUM** | **Config sprawl with no validation and silent fallback.** Every `GW_*` var is read verbatim with no whitelist; a typo silently reverts to the compiled default, and only `mode`+`idle_ms` are logged at boot. | `gateway/internal/wake/wake.go:38-50` (deliberate no-whitelist), `envInt` fallbacks `gateway.go:70-74`; boot log `cmd/gateway/main.go:57`. | Misconfiguration is invisible — e.g. a mistyped `GW_IDLE_MS` yields the default with no warning; effective config is never dumped. Hard to diagnose. | Log the full effective config at startup; validate/parse-fail loudly on unknown or unparseable `GW_*`. |
| 10 | **MEDIUM** | **Multi-tenancy is unbuilt; one hardcoded tenant/timeline.** `template` mode exists in code but nothing generates per-tenant compute Deployments or storage-init; IDs are hand-picked hex. | `deploy/54-compute-files.yaml:213-214` (fixed `f000…f001/f002`); `template` driver `wake.go:147-167`; `55-storage-init.yaml` creates exactly one; ADR admits it (`adr-0001…:118-121`). | The advertised knext model ("one DB per app") cannot actually run N apps today; adding a second tenant is undocumented and unautomated. | Build+test the `template` path end-to-end, or document clearly that this is single-DB-only until then (the CLAUDE brief does; the manifests/README should too). |
| 11 | **MEDIUM** | **`fsync=off` in the compute spec with no in-file rationale.** Safe under Neon (durability is on the safekeeper quorum), but nothing at the setting says so. | `deploy/54-compute-files.yaml:33-35`. | A future engineer reads `fsync=off` as a data-loss bug and either panics or "fixes" it, changing behavior; or trusts it without understanding the safekeeper dependency. Classic knowledge trap. | One-line comment at the setting explaining Neon's durability model + link to the durability section of operations.md. |
| 12 | **MEDIUM** | **Verify client image ≠ deployed compute image.** Verify scripts run `psql` from `ks-pg-compute:8464`; the actual compute Deployment is `compute-node-v17:latest`. Live confirmed a stale RS `compute-6bddd4dfd` on `ks-pg-compute:8464` alongside `:latest` RSs. | `deploy/_verify-wake.sh:25`, `_verify-ha.sh:27,45` (`ks-pg-compute:8464`) vs `20-compute.yaml:54` (`:latest`); live `kubectl get rs -l app=compute`. | The thing being tested is not exactly the thing deployed; image drift is already present in the cluster. Erodes trust in the "verified" claim. | Single source of truth for the compute image; have verify pull it from the Deployment spec. |
| 13 | **LOW** | **Demo-grade Postgres tuning shipped as the spec.** `shared_buffers=1MB`, `max_connections=100`, no server-side pooler in front of the single primary. | `deploy/54-compute-files.yaml:59-65`; no PgBouncer in `deploy/`. | Production performance will be poor (every read misses cache → pageserver round-trip); 100-conn ceiling per DB with no pooling. | Right-size `shared_buffers`; add a pooler (PgBouncer) or document the pool-sizing contract harder than the one note in `30-knext-secret.yaml:13-15`. |
| 14 | **LOW** | **`publishNotReadyAddresses: true` lets the gateway TCP-dial a *Terminating* compute.** Handshake absorbs `57P03` (starting-up) but not a backend shutting down mid-stream. | `deploy/20-compute.yaml:89`; handshake loop `gateway.go:257-289` only special-cases 57P03. | During a scale-down/rollout overlap a new connection can attach to a dying pod and get an ungraceful drop rather than a clean retry. | Also treat connection-refused/EOF during handshake as "retry the wake", not just 57P03. |

---

## What breaks at 10×

**10× connections.** The gateway is not the bottleneck — it is stateless, goroutine-per-connection,
2 replicas, 32Mi requests (`10-gateway.yaml:47,91-93`), and pipes bytes after handshake. The wall is
the **single compute**: `max_connections=100` (`54:63-65`) with **no server-side pooler**, and
`shared_buffers=1MB` means 100 concurrent sessions thrash straight through to the pageserver. knext's
per-app pool (`DB_POOL_MAX=5`) keeps a handful of apps under 100, but 10× connections on one hot DB is
simply refused. There is also no backpressure from gateway to client beyond TCP. **Verdict: needs a
pooler and real `shared_buffers` before 10× connections.**

**10× databases (tenants).** **Not supported today.** One tenant/timeline is hardcoded
(`54:213-214`); `template` wake mode exists in code (`wake.go:147-167`) but nothing provisions per-tenant
compute Deployments, Services, or storage-init Jobs, and the **single pageserver** would host every
tenant with **no shard-split wired** (ADR-0001 Q2 marks it "not yet built / unexercised",
`:118-121`). The peer-scrape idle check also becomes O(pods) per idle window, and each tenant adds a
Deployment the gateway must be told about. **Verdict: 10× tenants is a build project, not a config
change.**

**10× write volume.** Single-writer per tenant is intrinsic to Neon — there is **no write scale-out**.
All WAL funnels through the **one pageserver** (ingest CPU/IO ceiling) and lands on **2Gi safekeeper
PVCs** (`52:53`) that retain until pageserver+S3 ack; `max_replication_write_lag=500MB` (`54:132-134`)
backpressures and stalls the primary when the pageserver/MinIO can't keep up. 10× writes ⇒ pageserver
saturation, replication-lag backpressure stalls, and possible 2Gi WAL-PVC fill. **Verdict: write path is
the least horizontally-scalable part; partitioning bounds one node, real scale-out defers to the unbuilt
`template` sharding.**

---

## The 3-years-later test

**Written down well (credit where due):** `docs/operations.md` is unusually honest — durability model,
a real failure-mode table, the password-rotation reality, monitoring/alerting guidance, and an explicit
"never `:latest` for storage" rule. `README.md:107` is candid about 1 pageserver. `ADR-0001` is frank
about TSL-vs-scale-to-zero mismatch and that shard-split is unbuilt/unexercised. The verify scripts are
**real** (they actually kill a safekeeper and a compute and time the recovery) — not mocked theater.
`TASKS.md:34-35` names warm-standby as the sub-second path. This is above-average documentation for an MVP.

**Trapped in heads (the risk):**
- **The compute↔storage image-compatibility contract** — *why* `:latest` compute against pinned `8464`
  storage is a loaded gun (finding #1). The docs preach pinning; the manifest contradicts them and no
  compatibility matrix exists.
- **Neon generation numbers** — `storage-init` hardcodes `"generation":1` (`55-storage-init.yaml:33`) and
  the pageserver runs `control_plane_emergency_mode=true` with a junk `control_plane_api` and `id=1234`
  (`53:17-21`). The split-brain-protection semantics of generations, and what happens if you re-init with
  the wrong one, are undocumented — this is how you silently corrupt an attach.
- **Why `fsync=off` is safe** (finding #11) — depends entirely on the safekeeper-quorum durability model,
  stated nowhere near the setting.
- **How to actually upgrade `neon:8464`** — operations.md gives a "bump the tag and run verify" procedure
  but no storage-format compatibility matrix, no safekeeper-vs-pageserver ordering, and no storage
  rollback story. For a small team this is the scariest recurring task and it's underspecified.
- **How to create a second tenant safely** — the hand-picked hex IDs, and the relationship to Neon's normal
  control-plane-issued IDs, are implicit.
- **Peer-aware idle failure semantics** — that a wedged peer metrics endpoint postpones sleep *forever* by
  design (`gateway.go:337-349`) is in code comments but not in the ops runbook as an expected "DB won't sleep"
  cause (operations.md:91 mentions it briefly — good, but the "forever" bias isn't spelled out).

**Bottom line for the 3-years-later engineer:** the *gateway* is learnable from the code in an afternoon.
The *storage plane* is a specialized Neon deployment whose correctness depends on tribal Neon knowledge that
is not in the repo. That gap, more than any single bug, is the maintainability risk.
