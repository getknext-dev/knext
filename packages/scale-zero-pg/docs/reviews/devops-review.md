# Independent DevOps / SRE Review — scale-to-zero Postgres (KS-PG)

**Reviewer:** independent SRE (would carry the pager). Did not build this. Method: read
`deploy/*.yaml` + `gateway/` with an operator's eye; inspected the live cluster read-only
(`kubectl --context orbstack -n scale-zero-pg get/describe/exec`, PVC `df`, events, restarts).
Date: 2026-07-02. Scope: local single-node OrbStack cluster, all committed.

---

## Executive verdict

This is a **well-reasoned architecture and an impressive engineering demo, but it is a
single-node POC, not a production system** — it runs on one node with `local-path` RWO volumes
(`Delete` reclaim), no backups of the MinIO PVC that *is* the entire database history, no
liveness probes, no resource limits on the storage plane, plaintext credentials committed in
git, and a compute Postgres spec (`fsync=off`, `shared_buffers=1MB`, DB literally named
`docker_compose_test`) copied straight from Neon's compose *test* fixture. The wake path and
gateway are genuinely solid — HA, peer-aware idle, 57P03 handshake absorption, distroless
non-root, minimal RBAC — but everything *below the wire* is dev-grade and would page us
weekly. I would not take this pager without the "Minimum bar" list below closed first.

| Dimension | Score | One-line justification |
|---|---|---|
| **Operability** | **3 / 10** | No backups, no CI, no liveness probes, no PDBs, plaintext secrets in git, image only exists on one docker daemon; day-2 = manual `kubectl` from a runbook. |
| **Production-performance readiness** | **2 / 10** | Single shared compute at 1Gi/`shared_buffers=1MB`/`max_connections=100`, single pageserver SPOF, storage plane has no resource requests/limits — it will saturate and OOM under any real load, and capacity is unmeasurable (no metrics-server). |

---

## Findings

Severity: **CRITICAL** = data-loss / prod-blocking, **HIGH** = will page you, **MEDIUM** =
operational debt, **LOW** = polish.

| Sev | Finding | Evidence | Consequence | Remedy |
|---|---|---|---|---|
| CRITICAL | **No backup of the storage plane.** MinIO holds the whole DB history; its PVC is `local-path`, RWO, reclaim `Delete`, single replica, one node. | `50-minio.yaml:9` replicas 1; `kubectl get pv` → `RECLAIM POLICY: Delete`, `STORAGECLASS local-path`; `df` shows all 5 PVCs on `/dev/vdb1` one node. | Node dies / PVC deleted / `kubectl delete ns` → **total, unrecoverable data loss.** No restore drill exists. | Real S3 (or replicated MinIO) off-node; scheduled `mc mirror`/`pgBackRest`-style export; documented + rehearsed restore. Change reclaim to `Retain`. |
| CRITICAL | **Single-node, single points of failure everywhere.** One node, one pageserver, one MinIO, one storage-broker; RWO volumes forbid rescheduling; no anti-affinity, no failure domains. | `kubectl get nodes` → 1 node `orbstack`; `53-pageserver.yaml:31` replicas 1; `50/51` replicas 1; all PVCs `RWO`. | Node loss or pageserver crash = full read/serving outage for **all** apps. Safekeeper quorum is the only redundant tier. | Multi-node cluster; secondary pageserver; distributed object store; `RWX`/networked storage or per-AZ topology; pod anti-affinity. |
| CRITICAL | **Test Postgres spec shipped as prod.** Compute config is Neon's compose *test* fixture: `fsync=off`, `shared_buffers=1MB`, `restart_after_crash=off`, DB name `docker_compose_test`. | `deploy/compute-files/config.json` (`fsync=off`, `shared_buffers":"1MB"`, `"name":"docker_compose_test"`). | `shared_buffers=1MB` → every read hits the pageserver, crippling latency under load. `fsync=off` relies entirely on the safekeeper-quorum durability assumption being airtight — unverified for crash-during-WAL-ship edge cases. | Build a real compute spec: size `shared_buffers`/`work_mem` to the 1Gi limit, confirm the Neon durability model makes `fsync=off` truly safe, rename the DB. |
| CRITICAL | **Plaintext credentials committed in git.** Object-store and DB creds are hard-coded, not real Secrets. | `50-minio.yaml:22-23` `minio/password`; `52-safekeeper.yaml:39-40` and `53-pageserver.yaml:53-54` same in env; `30-knext-secret.yaml:27` `cloud_admin:cloud_admin` in a plaintext `stringData` Secret; MinIO buckets job reuses them. | Anyone with repo read = full data-plane access. Rotation means editing YAML + rebooting compute (`operations.md:56`). | SealedSecrets / External Secrets / SOPS; unique generated creds per tier; remove all plaintext from git history. |
| HIGH | **No liveness probes anywhere; storage has no resource requests/limits.** Only readiness probes exist; storage pods (safekeeper, pageserver, minio, broker) declare no `resources`. | `52/53/50/51` — no `livenessProbe`, no `resources`; only `10-gateway.yaml:91` and `20-compute.yaml:70` set limits. | A hung (not crashed) pageserver/safekeeper never restarts → silent stall. No limits = BestEffort QoS: one memory-hungry pageserver evicts the whole plane under pressure. | Add liveness probes + `requests/limits` (pageserver is memory-hungry — size it) to every storage pod. |
| HIGH | **Gateway image is not deployable off this machine.** `scale-zero-pg/gateway:dev`, `IfNotPresent`, no registry — exists only on OrbStack's shared docker daemon. | `10-gateway.yaml:57-58`; comment "built locally; OrbStack k8s shares the docker daemon". | On any real/multi-node cluster pods `ImagePullBackOff`. No provenance, no rollback-by-tag, no scanning. | Push versioned tags to a registry; pin by digest; add build+push to CI. |
| HIGH | **`compute-node-v17:latest` is unpinned — on the wake path.** Their own rule ("never `:latest` for storage", `operations.md:100`) is violated for compute. | `20-compute.yaml:54` `image: ...compute-node-v17:latest`. | A silent upstream retag changes DB behavior on the next cold start; non-reproducible; rollback impossible. | Pin compute to a digest, same discipline as `neon:8464`. |
| HIGH | **No CI.** Tests exist (`go test ./...`) but nothing runs them; image built by hand. | No `.github/`, no CI YAML in repo; Dockerfile built locally. | Regressions ship silently; the red/green TDD discipline isn't enforced; no gate before deploy. | CI: `go test`, `go vet`, build+push image, `deploy/_validate.sh`, run verify battery on a throwaway cluster. |
| HIGH | **No observability stack, alerting is aspirational.** `/metrics` is per-pod in-memory (resets on restart, must sum/max by hand across replicas); no Prometheus, ServiceMonitor, alert rules, or `metrics-server` deployed. | `operations.md:24-41` describes scraping but nothing scrapes; `kubectl top` → "Metrics API not available"; `metrics.go` counters in-process. | The alerts the docs promise (`wake_failures`, phantom keepalive, latency drift) are not wired — you find out from users. No CPU/mem visibility, so no HPA/VPA and no capacity signal. | Deploy metrics-server + Prometheus + Alertmanager; ship alert rules as code; persist/aggregate gateway metrics; no traces (add for wake-path latency breakdown). |
| MEDIUM | **No PodDisruptionBudgets + no securityContext.** Nothing guards the safekeeper 2/3 quorum during a drain; every pod runs with default (root) securityContext. | `kubectl get pdb` → none; `get networkpolicy` → none; `securityContext` empty on all 10 pods. Gateway is the lone exception (distroless `nonroot`, `Dockerfile`). | A node drain can take 2 safekeepers down → write outage. Containers run as root, no seccomp/`readOnlyRootFS`/dropped caps. | PDB `minAvailable: 2` on safekeeper; `runAsNonRoot`, drop caps, seccomp `RuntimeDefault` on the storage plane. |
| MEDIUM | **No NetworkPolicy — flat namespace.** Postgres wire (55432/55433), pageserver HTTP, MinIO console all reachable by any pod in the cluster. | `get networkpolicy` → none; `pggw` Service is `LoadBalancer` (`10-gateway.yaml:102`, external IP `192.168.139.2`). | Lateral movement; unauthenticated MinIO console/API exposure; DB reachable cluster-wide. | Default-deny + explicit allows; keep `pggw` ClusterIP in prod (docs already note this). |
| MEDIUM | **Undersized PVCs with no autoscaling/monitoring.** safekeeper 2Gi, pageserver 5Gi, minio 5Gi; no alerting on fill. | `get pvc`; live usage tiny (17M/61M/94M) because idle — but WAL + history grow with write volume. | For 50 active apps, safekeeper WAL and MinIO history outgrow 2–5Gi; a full WAL volume **stops writes**. `local-path` can't easily expand. | Size to real write volume; alert at 70/85%; use an expandable StorageClass. |
| MEDIUM | **Gateway has no connection cap.** Goroutine-per-connection, no ceiling; 128Mi limit. | `gateway.go:102` `go g.handle(client)`; no limiter; `10-gateway.yaml:93` `limits.memory 128Mi`. | A connection storm (misbehaving pool) can OOM-kill the gateway, taking down the *only* wire path. | Max-conns semaphore + reject-with-backpressure; raise/justify the memory limit. |
| LOW | **ReplicaSet churn / stale artifacts.** 6 `pggw` + 4 `compute` old ReplicaSets linger; one references a never-cleaned `ks-pg-compute:8464` image. | `get rs` output. | Cosmetic; mild confusion during incidents. | `revisionHistoryLimit: 2`. |
| LOW | **Password rotation requires a compute reboot.** `compute_ctl` re-applies the spec roles every boot; `ALTER USER` doesn't stick. | `operations.md:56-65`. | Rotation = brief outage + multi-file edit; easy to fumble at 3am. | Document as a runbook with a single scripted path; consider externalizing roles. |

---

## First 90 days in production (incidents, in likely order)

1. **Week 1–2 — "the DB is slow."** `shared_buffers=1MB` + single shared 1Gi compute + every
   read round-tripping the single pageserver. First real query load exposes it. Pages tied to
   latency SLOs. (No metrics-server → you're debugging blind.)
2. **Week 2–4 — connection exhaustion.** 50 apps × pool 5 = 250 target connections vs
   `max_connections=100` on one shared compute. `FATAL: too many clients`. The gateway happily
   forwards past the ceiling; no pooler in front.
3. **Week 3–6 — compute OOMKill under load.** 1Gi limit on the single Postgres serving
   everyone; a few heavy queries (sorts/joins, `work_mem`) tip it over. `Recreate` + single-writer
   means the restart stalls *all* new connections through a cold wake.
4. **Month 2 — pageserver / node incident = full outage.** Single pageserver or the one node
   hiccups; no HA, no liveness restart if it hangs. Everything is down until a human intervenes.
5. **Month 2–3 — storage volume fills.** safekeeper 2Gi or MinIO 5Gi hits full with no alert;
   writes block. Emergency PVC surgery on `local-path`.
6. **The one that ends the project — data loss.** An `kubectl delete pvc`, node rebuild, or
   `Delete`-reclaim event wipes MinIO with **no backup to restore from.** This is the finding I
   care about most: everything else is recoverable; this is not.

---

## Minimum bar for prod (shortest list before I take the pager)

- [ ] **Backups + a rehearsed restore drill** for MinIO/pageserver history; reclaim policy `Retain`. *(no data loss without a way back)*
- [ ] **Multi-node cluster**, secondary pageserver, distributed/real S3, networked storage — remove the single-node & single-pageserver SPOFs.
- [ ] **Real compute Postgres spec**: size `shared_buffers`/`work_mem`, right-size `max_connections` + put a pooler in front, verify `fsync=off` is truly safe under the Neon durability model, drop the `docker_compose_test` name.
- [ ] **Secrets out of git** (SealedSecrets/ESO/SOPS), unique generated creds, scrub history.
- [ ] **Resource requests/limits + liveness probes on every storage pod**; PDB `minAvailable:2` on safekeeper.
- [ ] **Registry-hosted, digest-pinned images** for gateway *and* compute; **CI** that tests, builds, pushes, and runs the verify battery.
- [ ] **Observability that works**: metrics-server + Prometheus + Alertmanager, alert rules as code for wake-failures / latency / volume-fill / quorum-loss.
- [ ] **Capacity model** for the target app count: connections, memory, WAL/history growth vs PVC sizing — written down and load-tested.

**Estimated steady-state operational load for ~50 apps as-is:** high and reactive —
realistically **8–15 hrs/week** (manual deploys/rotations, no-alerting firefighting, capacity
babysitting, DR anxiety). With the Minimum bar closed it drops toward **2–4 hrs/week**.

**Top 3 pages I'd expect:** (1) DB-slow / latency-SLO breach; (2) connection exhaustion
(`too many clients`); (3) pageserver-or-node down = full outage.

---

*What's genuinely good (credit where due):* the gateway design — HA with peer-aware idle
(fail-safe: any peer error postpones sleep), tight minimal RBAC (`deployments/scale` only),
57P03 starting-up handshake absorption, `publishNotReadyAddresses` to dodge CoreDNS
negative-cache, distroless non-root image, `Recreate`+single-writer correctness, and a real
safekeeper 2/3 quorum with a drill-verified durability claim. The wake path is production-grade.
Everything below the wire is not — yet.
