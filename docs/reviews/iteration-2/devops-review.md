# Iteration-2 — Independent DevOps/SRE Review (3am-pager lens)

**Reviewer posture:** independent SRE, did not build this. Blinded to `docs/reviews/*`
and `docs/plan-*.md`. Evidence is from primary sources only: manifests under `deploy/`,
`gateway/` + CI, `warmstandby/`, `bakeoff/`, the ADRs, git log, and **hands-on against
the live `orbstack` cluster** (`scale-zero-pg`, `bakeoff-cnpg`).
**Date:** 2026-07-02. **Foundation of record:** ADR-0002 ACCEPTED — Neon, two-tier
(cold default + opt-in warm). This review scores that ratified path against a *production*
bar, not a demo bar.

---

## Scorecard (1–10)

| Axis | Score | One-line justification |
|---|---:|---|
| **Maturity** | **4** | Real evidence, ADRs, CI, pinned images, and a genuine 0→1→0 loop — but backups don't exist, TLS doesn't exist, NetworkPolicy is inert on the live CNI, and the warm tier is a shell-harness prototype, not a product. |
| **Ease of maintenance** | **5** | Excellent docs + `_validate.sh`/`_verify-*.sh` harness and pinned images pull this up; 6 data-path workloads, a **human-enforced** compute↔storage version-pair, and manual `harden-pvs.sh`/`gen-secrets.sh` pull it back down. |
| **Production reliability** | **3** | No backups + single-pageserver read SPOF = unbounded data-loss/outage exposure; alert delivery is not reliably verifiable and is already emitting a **false page**; plaintext wire. Fine for a POC, not for a pager rotation. |

---

## Findings (blunt, evidence-cited)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | **CRITICAL** | **No backups exist. Anywhere.** No `Backup`/`ScheduledBackup`, and Neon PITR is unexposed. MinIO and pageserver are each a **single PVC with no off-cluster copy** — lose both PVCs (node loss) and history is gone. | `kubectl get scheduledbackup,backup -A` → *No resources found*. ADR-0002 §3: backup story "**not yet built**". `docs/operations.md` durability model has no backup row. |
| F2 | **CRITICAL** | **Alert delivery is not reliably verifiable, and is already false-paging.** (a) `_verify-alerting.sh` **hung >10 min** on step 4 (delivery) and I had to kill it. The `alert-sink` (busybox `nc -l -w 5` single-shot loop) returns a canned `200` but discards/rarely logs the request body — 238× `nc: timeout`, **0 payloads** in 20 min. (b) Alertmanager itself reports the transport healthy (`alertmanager_notifications_total{webhook}=8`, `..._failed_total=0`), so the *sink* is the broken observability point the drill depends on. (c) `ComputePhantomKeepalive` is **firing live with value 41 while `compute` is genuinely at `replicas: 0`** — a false page ("scale-to-zero is blocked / burning compute") caused by cumulative gateway counters (`wakes−sleeps`) drifting across pod restarts/experiments. | Live `kubectl exec` against prometheus `/api/v1/alerts` + alertmanager `/api/v2/alerts` + `/metrics`; `alert-sink` logs; `deploy/compute` = `0/0`. |
| F3 | **HIGH** | **Isolation & wire security are absent on the live cluster.** NetworkPolicy is **inert** — `_verify-netpol.sh` confirms `compute:55433` is REACHABLE from a non-gateway pod (OrbStack/flannel doesn't enforce). Postgres wire is **plaintext**: the gateway *declines* SSL (`proto.go`), `pggw-lb` LoadBalancer exposes `55432` with no TLS termination built. | `_verify-netpol.sh` WARN block; `10-gateway.yaml` (LB, no TLS); `docs/operations.md` "Network isolation caveat". |
| F4 | **HIGH** | **The compute↔storage version-pair (`8464`/`8464`) is human-enforced.** ADR-0002 kill-criterion #3 explicitly says trusting this to human discipline in production is a **release blocker** — yet there is no CI/manifest assertion that fails on tag divergence today. | `docs/operations.md` "Upgrades"; ADR-0002 kill-criterion #3; no such check in `.github/workflows` or `_validate.sh`. |
| F5 | **MEDIUM** | **Warm tier is unsafe to productize as-is (single-writer gate is a shell script).** Two deployments (`compute`, `compute-warm`) target one timeline; the *only* thing preventing two-writers-on-one-timeline corruption is the harness's `assert_single_writer` bash check before each gate release. No in-cluster admission/lease/fencing. | `warmstandby/README.md` "Single-writer risk = elevated"; `warmstandby/20-compute-warm.yaml`. |
| F6 | **MEDIUM** | **Gateway (the one always-on, externally-exposed component) is under-hardened vs the rest.** No container `securityContext` (no `runAsNonRoot`, no `drop: [ALL]`), no CPU limit, and **no livenessProbe** (readiness only) — a wedged gateway won't self-heal. Prometheus/Alertmanager/compute all have the hardening the front door lacks. | `10-gateway.yaml` container spec. |
| F7 | **MEDIUM** | **"50 apps" does not fit the current shape.** This is a **single** database (one compute, one timeline, one storage plane; SCS multi-tenancy parked). 50 apps means either 50 full stacks (≈6 workloads + 6 PVCs each = ~300 pods/PVCs), or 50 apps contending for one compute where `GW_MAX_CONNS=90` < `max_connections=100` — pool-holding apps hit clean `53300` rejections fast and also **defeat scale-to-zero** (idle pools = phantom keepalive). | `10-gateway.yaml` (`GW_MAX_CONNS=90`); `docs/operations.md`; ADR-0002 §ops-mass. |
| F8 | **LOW** | **Prometheus data PVC reclaim is `Delete`** while all storage PVCs are correctly `Retain`. Metrics survive a pod restart (PVC bound) but a namespace delete wipes trend history. Also `harden-pvs.sh` is a **manual** step, not a `Retain` StorageClass — a new safekeeper PVC starts `Delete` until someone re-runs it. | `kubectl get pv` reclaim policies; `harden-pvs.sh` header. |
| F9 | **LOW** | **Alertmanager notification-log is `emptyDir`.** A silence/dedup state is lost on AM restart, so a just-silenced alert can immediately re-page. Acceptable for MVP, flag for prod. | `61-alertmanager.yaml` volumes. |

**What is genuinely good (credit where due):** pinned images everywhere (no `:latest`);
storage PVs are `Retain` (verified); safekeeper PDB `minAvailable: 2` correctly preserves
2/3 write quorum on drains; peer-aware idle prevents a split-fleet premature sleep; metrics
are ClusterIP-only (not leaked via the LB — verified); `_validate.sh` (27 checks) and the
`_verify-*` battery are a real, honest test surface; docs (`operations.md`) are unusually
candid about the SPOFs and caveats. The Neon warm-standby p50 **413 ms** result is real
(every sample returned `count(*)=3`).

---

## "First 90 days in production" incident forecast

1. **Day-of-outage data loss (F1).** First node failure or accidental `kubectl delete pvc`
   on `data-pageserver-0` / `minio-data`, and there is **no restore path** — history is on
   two un-backed-up local PVCs. This is the incident that ends the project. **P0.**
2. **Pageserver read outage (SPOF).** Single pageserver pod/PVC/node event → *all reads
   stop* until it restarts. `minAvailable:1` PDB turns any node drain of that node into a
   manual, blocking operation nobody documented a runbook for. ADR-0002 kill-criterion #6
   flags this as a "reliable-enough is falsified" trigger.
3. **The pager cries wolf, then goes silent (F2).** On-call gets `ComputePhantomKeepalive`
   pages for a DB that is *correctly* asleep (counter drift), learns to ignore the channel,
   and then a *real* wake-failure storm arrives through a delivery path whose only proof-of-
   life (`_verify-alerting.sh`) hasn't passed cleanly since the sink got racy. Classic
   alert-fatigue-into-miss.
4. **Silent version-pair drift (F4).** Someone bumps only `compute-node-v17` (or only
   `neon`) during a routine patch; wake starts failing with opaque protocol errors and no
   CI caught the divergence. Multi-hour head-scratch with no Rust/Neon on-call staffed.
5. **"Why is the DB always on / rejecting connections?" (F7).** A knext app ships a pool
   with `min_idle>0`; scale-to-zero never triggers (compute burns 24/7) and/or a second app
   crosses `GW_MAX_CONNS=90` and users see `53300`. Both are config-in-the-consumer problems
   with no admission guardrail on our side.
6. **Warm-tier corruption near-miss (F5).** The day someone runs the warm experiment (or a
   productized v1) against a cluster where `compute` didn't fully drain, the shell gate is
   the only thing between them and two writers on one timeline.

## Minimum bar for production (checklist)

- [ ] **Backups exist and a restore has been rehearsed.** Off-cluster: MinIO bucket
      replication/versioning + a scheduled `pg_dump`/base-backup, or expose Neon PITR — and
      run one full restore drill. *(Closes F1; this is the single gate that matters most.)*
- [ ] **Second pageserver deployed; PDB raised.** Remove the whole-data-plane read SPOF
      (ADR-0002 kill-criterion #6). Until then, ship a documented node-drain runbook.
- [ ] **Prove alert delivery to a real receiver (Slack/PagerDuty), not the busybox sink,**
      and make `_verify-alerting.sh` pass in CI without hanging. Fix `ComputePhantomKeepalive`
      to key off actual compute replica state (or reset counters on scale), not cumulative
      `wakes−sleeps`. *(Closes F2.)*
- [ ] **TLS on the front door** (terminate at `pggw-lb`/ingress; `sslmode=require` in
      `DATABASE_URL`) and **run on an enforcing CNI** with `_verify-netpol.sh` hard-asserting.
      *(Closes F3.)*
- [ ] **CI gate that fails on compute↔storage tag divergence.** *(Closes F4, kill-criterion #3.)*
- [ ] **Harden the gateway** (`runAsNonRoot`, `drop:[ALL]`, CPU limit, livenessProbe).
      *(Closes F6.)*
- [ ] **Decide the multi-tenancy story before onboarding app #2** (F7): one-DB-per-app
      economics (300 pods at 50 apps) vs. shared-DB connection governance. Warm tier stays
      **experiment-only** until the single-writer gate lives in the gateway, not a shell script
      (F5).
- [ ] **`Retain` StorageClass (not manual `harden-pvs.sh`)**; put Prometheus on `Retain` too
      if trends matter. *(Closes F8.)*

---

## Verdict

Solid, honest **engineering POC** with a real measured foundation decision and a test
harness most MVPs never build. It is **not yet productionizable** for an on-call rotation:
the two blockers are **F1 (no backups + read SPOF = unbounded data-loss/outage)** and
**F2 (alert path unproven + already false-paging)**. Both are addressable inside iteration-3's
4C scope. Fix those two and TLS (F3), and this crosses from "impressive demo" to "callable at
3am." Scores reflect that gap deliberately.
