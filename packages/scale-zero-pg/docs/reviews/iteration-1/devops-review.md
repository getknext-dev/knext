# Iteration-1 DevOps/SRE re-review — the 3am pager perspective

**Reviewer:** independent SRE (did not build this). Judgment formed from primary
sources only (code, manifests, scripts, and the live `scale-zero-pg` namespace on
`orbstack`). I did not read prior reviews or the phase-3 plan.

**Method:** read every manifest + gateway package; ran against the live cluster —
inspected pods/PVs/PDBs/Secrets, scraped the gateway metrics endpoint, evaluated the
Prometheus alert state, and measured a real cold-start wake.

---

## Executive verdict

The engineering hygiene is genuinely good for an MVP — least-privilege RBAC, a real
gateway CI, `Retain` PVs, quorum safekeepers with a sane PDB, a documented runbook —
and the wake loop works (I measured a **3.5 s** cold start live). But this is a
**single-compute, single-pageserver, single-node, connection-capped-at-100** system
whose headline safety features (NetworkPolicy isolation, the alert rules) are either
**inert on the target cluster or route nowhere**, and it has **no backup/restore drill
beyond killing a pod**. It will demo beautifully and page you hard the first time 50
real apps open more than 100 connections or one node reboots.

| Dimension | Score | One-line justification |
|---|---|---|
| **Operability (day-2)** | **4/10** | Clean manifests + runbook, but alerts route nowhere (no Alertmanager), metrics are ephemeral (emptyDir/6h), backups/restore are undrilled, and storage is single-node local-path. |
| **Production-performance readiness** | **3/10** | Hard 100-connection ceiling behind a misleading 500 gateway cap with no pooler; one shared compute; scale-to-zero defeated by any persistent app pool; 3.5 s wake cliff. |

---

## Findings

| Sev | Finding | Evidence | Consequence | Remedy |
|---|---|---|---|---|
| **Critical** | **Alerts route nowhere.** Prometheus evaluates 3 rules but there is no Alertmanager and no receiver. | `kubectl get deploy,svc \| grep alert` → *NO alertmanager*. `60-prometheus.yaml` has no `alerting:` block. | On-call is never paged. Every "incident forecast" below fires silently. | Deploy Alertmanager (or route to an existing one) with a PagerDuty/Slack receiver; wire `alerting:` in the Prometheus config. |
| **Critical** | **Connection ceiling mismatch.** Gateway admits `GW_MAX_CONNS=500`; compute is `max_connections=100`; no pooler. | `10-gateway.yaml` L79; `compute-files/config.json` L51–54. No pgbouncer anywhere. | Connections 101–500 pass the gateway and get `FATAL: too many clients` from Postgres — a cascading app-fleet outage that the gateway cap does nothing to prevent. | Put pgbouncer (transaction pooling) in front of the compute; set `GW_MAX_CONNS` to the *pooler's* real ceiling, not 5× the DB's. |
| **Critical** | **Single compute shared by all apps; scale-to-zero is defeated by any persistent pool.** `replicas: 0↔1`, `Recreate`, one instance. | `20-compute.yaml` L17,21. knext default pool = 5; 50 apps × 5 = 250 potential conns, and any one idle-but-open pool blocks sleep forever (phantom keepalive). | Either the DB never sleeps (value prop gone, compute burns 24/7) or it saturates at 100 conns. You cannot have both scale-to-zero *and* 50 always-connected apps on one 100-conn Postgres. | Pooler with short idle-timeout < `GW_IDLE_MS`; document a hard "max apps per compute" number; for real multi-tenancy revive the `template` multi-DB seam. |
| **High** | **No enforced network isolation on the target cluster.** NetworkPolicies are declaratively correct but inert. | `kube-system` has no Calico/Cilium/netpol controller (grep empty); `70-networkpolicy.yaml` header + `operations.md` admit OrbStack/flannel doesn't enforce. Confirmed live. | The "compute reachable only from gateway" guarantee is fiction here; any pod in-namespace can reach compute:55433 and the storage plane. | Run on an enforcing CNI in prod and gate `_verify-netpol.sh` in CI; until then, treat isolation as *unenforced* in all risk docs. |
| **High** | **No backup/restore drill; single-node local-path storage.** Only "drill" is killing one safekeeper + the compute pod. | `_verify-storage.sh` steps 4b/5; all PVs are `local-path` on one `orbstack` node (`kubectl get pv`). No MinIO backup, no PITR restore, no `pg_dump`, no snapshot mechanism. | Node loss = total data loss. RPO/RTO undefined. "Retain" protects against `kubectl delete` fat-fingers, not against the disk. | Move storage to real PVs (replicated/EBS-class); back up MinIO offsite; **actually perform** a pageserver-PVC-loss and a MinIO-restore drill and record RPO/RTO. |
| **High** | **Metrics are ephemeral and there are no dashboards.** Prometheus is `emptyDir`, 6 h retention, 1 replica, no `remote_write`. | `60-prometheus.yaml` L133,162. No Grafana in the repo. | A Prometheus restart erases all history; post-incident you have no timeline. Blind troubleshooting. | `remote_write` to a durable backend; add Grafana or point at an existing stack. |
| **High** | **Pageserver is a SPOF whose PDB blocks node drains.** 1 replica, `minAvailable: 1`. | `56-pdb.yaml` L24–33; live `pageserver` PDB shows **ALLOWED DISRUPTIONS 0**. MinIO + storage-broker also single-replica, no PDB. | Any node maintenance requires a manual cordon/scale dance or accepts a read outage; pageserver crash = read-serving stops for all apps. | Add a second pageserver and raise `minAvailable`; the manifest header already flags this as required for prod. |
| **Medium** | **Phantom-keepalive alert is a false-positive generator.** It's `sum(wakes)-sum(sleeps) > 0 and active==0`, counter-based, not reconciled with actual replica count. | Live: alert `ComputePhantomKeepalive` was **pending with value 2 while `compute` was 0/0 replicas** — a demonstrable false positive (counters don't survive gateway pod restarts). | Alert fatigue; on-call learns to ignore the one alert that also catches the real money-burning case. | Base the alert on actual Deployment replica gauge (`kube-state-metrics`) × active connections, not on unreconciled gateway counters. |
| **Medium** | **Plaintext/weak auth on the DB path.** `cloud_admin:cloud_admin` DATABASE_URL committed; `password_encryption=md5`; `sslmode=disable` end-to-end; compute default hash is the "publicly known" dev fallback. | `30-knext-secret.yaml` L27; `config.json` L83 (md5); `54-compute-files.yaml` L203 `b093c0d3...`. | Anyone on the pod network reads/writes the DB in cleartext with a known password. | scram-sha-256; real per-app credentials from a Secret manager; TLS termination in front of the gateway (it declines SSL today). |
| **Medium** | **Gateway has no PDB, no anti-affinity/topology spread.** It's the only always-on connection path. | `10-gateway.yaml` — 2 replicas, no PDB, no `topologySpreadConstraints`. Both pods can co-locate. | On a multi-node cluster a single drain/node loss can take out both gateway replicas → total connection outage. | Add a PDB (`minAvailable: 1`) and topology spread across nodes. |
| **Medium** | **End-to-end path is never gated in CI.** Gateway unit CI is real; the e2e job is opt-in (`[e2e]` in commit msg) **and** `continue-on-error: true`. | `.github/workflows/ci.yml` L34–38. | The wake loop + storage integration can regress silently; green CI ≠ working platform. No image scan/SBOM either. | Make a lightweight wake e2e blocking on PRs; add image scanning. |
| **Low** | **Manual, fragile PV hardening + no-rollback upgrades.** `harden-pvs.sh` must be re-run after every new PVC; storage rollback is explicitly unsupported without a snapshot that local-path can't take. | `harden-pvs.sh` header; `operations.md` "Upgrades". | Easy to forget; a scaled-up safekeeper's PV silently reverts to `Delete`. Upgrades are one-way. | Dedicated `Retain` StorageClass; a tested backup before any storage bump. |
| **Low** | **Tiny storage, no capacity alerts.** safekeeper 2Gi, pageserver 5Gi, MinIO 5Gi; no disk-usage alert. | `52-safekeeper.yaml` L80; live PVCs. | Silent fill under real write volume → write stalls. | Size for real workload; add PVC-usage alerts. |

---

## First 90 days in production — incident forecast

1. **Week 2–4 — "Database refusing connections" (the certain one).** An app-fleet
   event (deploy, traffic spike, pool leak) pushes past `max_connections=100`. The
   gateway happily admits up to 500, there's no pooler, and Postgres starts
   `FATAL: too many clients`. Multiple knext apps error simultaneously. Because
   **alerts route nowhere**, the first signal is user complaints, not a page.

2. **Week 3–6 — "The DB is burning compute 24/7" / alert-fatigue whiplash.** With 50
   apps, at least one always holds an idle pooled connection, so scale-to-zero never
   fires — the entire value prop is silently off. Meanwhile the *counter-based*
   phantom-keepalive alert also fires spuriously after gateway restarts (observed live
   at compute 0/0), so on-call learns to ignore it. You lose money and trust at once.

3. **Week 6–10 — "Everything is down and I can't drain the node."** A node reboot or
   the single pageserver crashes. Compute can't serve; the pageserver PDB
   (`ALLOWED DISRUPTIONS 0`) blocks the drain; storage is local-path so if the node's
   disk is gone there is **no restore path** — no drill, no offsite backup. This is the
   career-defining page.

**Estimated ops load for 50 apps:** ~**8–12 hrs/week** steady-state (more up front),
dominated by connection/pool firefighting, manually eyeballing metrics that route
nowhere, PV-hardening re-runs, and paired manual upgrades with no rollback. This is not
"set and forget."

---

## Minimum bar for production

- [ ] **Connection pooler** (pgbouncer, transaction mode) in front of compute;
      `GW_MAX_CONNS` set to the pooler's real ceiling, not 5× the DB.
- [ ] **Alertmanager wired to a real receiver** (PagerDuty/Slack); prove a test alert
      pages a human.
- [ ] **Backups + a performed restore drill**: MinIO offsite backup, pageserver-PVC-loss
      recovery, and a PITR/`pg_dump` restore — with recorded RPO/RTO.
- [ ] **Replicated, non-local-path storage**; second pageserver; MinIO redundancy.
- [ ] **Enforcing CNI** with `_verify-netpol.sh` passing (isolation actually on).
- [ ] **TLS on the wire** + scram-sha-256 + per-app credentials from a Secret manager
      (no committed `cloud_admin:cloud_admin`).
- [ ] **Durable metrics** (`remote_write`) + a dashboard; fix the phantom-keepalive
      alert to key off actual replica state.
- [ ] **Gateway PDB + topology spread**; **blocking** wake e2e in CI.
- [ ] A documented, tested answer to: *what is the max number of apps per compute, and
      what happens at app N+1?*

**Bottom line:** a strong, honest MVP and a legitimately clever wake loop — but as
configured it is a **single-tenant demo with production-shaped manifests**, not a
platform 50 apps can lean on. The gap is not polish; it's pooling, HA, backups, and an
alert that reaches a human.
