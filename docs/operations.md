# Operations guide

Day-2 reference for running the platform: configuration, monitoring, failure
behavior, and troubleshooting.

## Gateway configuration (env on `deploy/pggw`)

| Variable | Default | Meaning |
|---|---|---|
| `GW_PORT` | 55432 | Postgres wire listener |
| `GW_METRICS_PORT` | 9090 | `/metrics` (Prometheus), `/metrics.json`, `/healthz` |
| `GW_COMPUTE_MODE` | static | `static` \| `exec` \| `kubectl` \| `template` \| `warmpool` |
| `GW_TARGET` | 127.0.0.1:55432 | compute address (static/exec/kubectl; warmpool: compute-warm svc:55433) |
| `GW_K8S_NAMESPACE` / `GW_K8S_DEPLOYMENT` | scale-zero-pg / compute | what `kubectl` mode scales 0↔1 |
| `GW_TARGET_TEMPLATE` / `GW_K8S_DEPLOYMENT_TEMPLATE` | — | `template` mode: `{system}` = database name (multi-DB, parked) |
| `GW_GATE_PORT` | 9091 | `warmpool` mode: TCP port the parked warm pod polls; the gateway opens it (accept) only after the single-writer check passes |
| `GW_WARM_DEPLOYMENT` / `GW_WARM_COLD_DEPLOYMENT` | compute-warm / compute | `warmpool` mode: the gated warm deployment, and the cold deployment that must be fully drained before the gate opens |
| `GW_IDLE_MS` | 300000 | idle window before scale-to-zero (deployed: 60000) |
| `GW_WAKE_TIMEOUT_MS` | 60000 | give up waking after this (deployed: 120000) |
| `GW_CONNECT_TIMEOUT_MS` / `GW_RETRY_MS` | 1000 / 250 | per-attempt connect timeout / poll interval (deployed retry: 100) |
| `GW_MAX_CONNS` | 0 (unlimited) | connection cap; excess gets a clean `53300`. Deployed: 90 — MUST stay under compute `max_connections=100` |
| `GW_PEER_SELECTOR` | — | label selector for sibling gateways (peer-aware idle); empty disables |
| `GW_POD_NAMESPACE` / `GW_POD_IP` | — | downward API; self-exclusion for the peer check |
| `GW_TLS_CERT_FILE` / `GW_TLS_KEY_FILE` | — | front-door TLS keypair (PEM paths). Both set + loadable → gateway answers `SSLRequest` with `S` and wraps the wire (TLS 1.2+). Set-but-unloadable or half-set → gateway **fails fast at startup**. Unset → `SSLRequest` gets `N` (plaintext only). Deployed: mounted from Secret `pggw-tls` at `/etc/pggw-tls/`. |

Every `GW_*` var passes through verbatim — there is deliberately no whitelist.

## Monitoring

Scrape each gateway pod's `:9090/metrics` (Prometheus text) or read `/metrics.json`:

| Metric | Meaning |
|---|---|
| `pggw_wakes_total` / `pggw_wake_failures_total` | cold starts triggered / failed |
| `pggw_wake_latency_ms_last` | last wake duration (per pod — take max across pods, don't sum) |
| `pggw_active_connections` | live client connections (per pod — sum across pods) |
| `pggw_sleeps_total` | scale-to-zero events |
| `pggw_system_*{system=...}` | the same, per database key |

**Alerting is deployed and drilled**, not aspirational. Prometheus
(`deploy/60-prometheus.yaml`, PVC-backed, 15d retention) scrapes three producers
— the gateway fleet (`:9090`), **kube-state-metrics** (`deploy/59`, the CronJob /
Deployment / StatefulSet / Job health producer), and **pswatcher** (`deploy/58`,
the failover controller `:9091`) — evaluates the rules below, and routes via
Alertmanager (`61-alertmanager.yaml`) to a receiver.

### Alert rules — what each means, and the 3am action

| Alert | Fires when | 3am action |
|---|---|---|
| `GatewayWakeFailures` (crit) | `pggw_wake_failures_total` rose in 5m | Cold starts are erroring — check compute events / storage plane reachability. |
| `GatewayWakeLatencyHigh` (warn) | last wake >5s | Node image-pull or resource pressure — check compute scheduling. |
| `ComputePhantomKeepalive` (warn) | connections never idle for 30m (state-based) | An app pool holds connections open — see [connecting](connecting.md#connection-pooling-rules) sizing rule. Blocks scale-to-zero. |
| `BackupJobFailed` (crit) | a Job owned by the **backup** CronJob failed | The daily off-cluster mirror did not complete — check `kubectl -n scale-zero-pg logs job/<backup-job>`; a restore would be stale. |
| `WalJanitorJobFailed` (crit) | a Job owned by the **wal-janitor** CronJob failed | The WAL trimmer stalled — `/safekeeper` WAL will regrow and slow restores past 60min (#19/#41). Check pageserver reachability at 02:30. |
| `WalJanitorStale` (crit) | last successful janitor run >26h old | The janitor **silently stopped** producing runs (no Failed Job) — schedule misses / backlog. `/safekeeper` is regrowing; restore RTO is slipping. Check `kubectl -n scale-zero-pg get cronjob wal-janitor` (suspend? schedule?) and the last `wal-janitor-*` Job. (#49) |
| `BackupStale` (crit) | last successful backup >26h old | >1 missed daily run — the off-cluster copy is stale. Investigate the CronJob before it becomes a data-loss window. |
| `BackupStaleAbsent` (crit) | backup **never** succeeded / suspended **and the CronJob is >26h old**, OR the CronJob object is gone | The last-success metric is absent — `BackupStale` is blind here. Treat as **no off-cluster backup at all**: un-suspend / redeploy the CronJob and force a run. **Age-gated so a fresh / DR-restored plane is not paged for the first 26h** (#62); the deleted/renamed case fires immediately (#51). |
| `WalJanitorStaleAbsent` (crit) | janitor **never** succeeded / suspended **and the CronJob is >26h old**, OR the CronJob object is gone | The last-success metric is absent — `WalJanitorStale` is blind here. `/safekeeper` WAL is unbounded: un-suspend / redeploy the CronJob and force a run. **Age-gated for 26h on a fresh/DR plane** (#62); deleted/renamed fires immediately (#49/#51). |
| `Watchdog` (none) | **always firing by design** | The alerting stack's **dead-man's-switch** (#60). You should **never** be paged by this rule directly — it is routed to an *external* heartbeat monitor. If that **external** monitor pages you, Prometheus or Alertmanager itself is down. See [dead-man's-switch](#dead-mans-switch-external-heartbeat-60). |
| `KubeStateMetricsDown` (crit) | `up{job=kube-state-metrics}==0` or absent for 2m | **Sev-1.** KSM (`deploy/59`) is the sole producer for `BackupJobFailed`, `WalJanitorJobFailed`, `BackupStale`, `WalJanitorStale`, `SafekeeperWALGrowth`, `PageserverStandbyNotReady`, `ComputeWakeStuck`, `ComputeWakeStuckApps`, `ComputeRoPoolStuck`, `ComputeStuckNotReady` — while it is down **all of them are blind**. Restore KSM before trusting any platform alert. (#48) |
| `PswatcherDown` (crit) | `up{job="pswatcher"}==0` for 2m | The failover authority is down — a primary pageserver death now degrades to the manual runbook (below). Restart pswatcher. |
| `PswatcherPromotionFired` (crit) | `pswatcher_promotions_total` rose in 10m | A **failover happened** — the promoted standby is now the sole read authority with NO standby behind it. Rebuild a standby. |
| `PswatcherPrimaryDown` (warn) | `pswatcher_primary_up==0` for 1m | The watcher can't reach the **current read authority**. Pre-failover that's the primary (a promotion may be ~6s away); **post-failover the watcher re-anchors this metric onto the promoted standby** (#25), so it now also covers "the promoted node is the unguarded SPOF and just died." Check the current authority / watcher↔pageserver network. |
| `PageserverStandbyNotReady` (crit) | `pageserver-standby` <1 ready for 5m | The warm standby that failover promotes into is gone — automated failover has nothing to promote. Rebuild it. |
| `ComputeWakeStuck` (crit) | **single-DB plane**: `pggw` (gateway=pggw) connections held but 0 `compute`/`compute-warm` ready for 2m | A single-DB client is connected but the DB never woke — attach error / image pull / storage stall. Clients are hanging. (Connection sum scoped to `gateway="pggw"` so apps traffic can't mask/trip it — #80.) |
| `ComputeWakeStuckApps` (crit) | **apps plane**: `pggw-apps` connections held but 0 `compute-<app>` ready anywhere for 2m | The whole branch-per-app wake path is down — apps clients are hanging. Aggregate (fires when 0 per-app computes are ready); a single stuck app among healthy peers is caught by `ComputeStuckNotReady`. Check the apps-gateway, the per-app compute events, and the shared storage plane. (#80) |
| `ComputeRoPoolStuck` (crit) | read-replica pool `compute-ro` desired ≥1 but 0 ready for 2m | The RO pool was woken under read traffic but no replica became ready (crashloop / attach stall / image pull) — `DATABASE_URL_RO` reads are hanging. Check `kubectl -n scale-zero-pg describe deploy compute-ro` + its pod events. Silent when the pool is at rest (spec 0). (#80/#66) |
| `ComputeStuckNotReady` (crit) | any `compute*` pod (compute / compute-ro / compute-warm / compute-`<app>`) has Ready=false for 5m | A compute-family pod is crash-looping / attach-stalled — **pages even with NO client waiting** (catches a sleeping app's compute crash-looping that the connection-gated rules miss). `kubectl -n scale-zero-pg get pod {{pod}}` + describe/logs. Healthy cold starts (~5s) never trip the 5m window. (#80) |
| `DemoCanaryFailed` (warn) | a Job owned by the **demo-canary** CronJob failed (dormant unless the demo canary is deployed) | The full **visitor→app→gateway→compute** cold path is broken or regressed past budget — the only synthetic that sees app-side / DNS / ingress-class regressions, not just the DB half. **3am:** if the demo is meant to be up, run `demo/_verify.sh` to reproduce; check `kubectl -n knext-demo get ksvc pg-demo` (Ready? ingress-class?), the operator, and the gateway. If the demo is intentionally torn down, delete the `demo-canary` CronJob to silence it. See [demo-canary](#demo-canary). |
| `SafekeeperWALGrowth` (**warn**) | a Job owned by the **apps-wal-monitor** CronJob failed: orphaned apps-tenant WAL (a deprovisioned app's safekeeper WAL dir, pageserver-404) is accumulating on the fixed **2Gi** safekeeper PVs, **and/or** a safekeeper `/data` is over its utilization threshold (75%) | **Not the primary pager** (expected branch-per-app churn) but must not be ignored — an unbounded leak ends in ENOSPC that wedges the *whole* storage plane. Read the Job log (`kubectl -n scale-zero-pg logs job/<apps-wal-monitor-…>`) for the orphan count vs PV%. Reclaim with `deploy/provision-app.sh reclaim-orphans`. Distinct from `WalJanitorJobFailed` — the janitor is *correct* to skip (never over-prune) an orphan; this is the missing **bound + signal** (#90/#87). Dormant when the monitor isn't deployed. See [Reclaiming orphaned apps-tenant WAL](#reclaiming-orphaned-apps-tenant-wal-9087). |

CronJob rules match by **exact owner name** (`kube_job_owner{owner_name="backup"}` /
`"wal-janitor"`), not a loose `backup.*` regex — so a failing `wal-janitor` is
never missed (the gap that re-opened the #19 DR blocker).

**Every silent failure mode is now covered, not just "a Job ran and Failed":**
- **silent-stop** — a CronJob that stops *scheduling* (suspend, backlog, missed
  deadlines) creates no Job, so `*JobFailed` never trips. The `*Stale` rules catch it
  via the CronJob's own last-success timestamp (#49).
- **never-succeeded / suspended** — `kube_cronjob_status_last_successful_time` does
  not exist until the first success and is gone when suspended/deleted, so `*Stale`
  itself goes blind. The `*StaleAbsent` companions page on `absent(...)` **or**
  `kube_cronjob_spec_suspend==1` (#51).
- **dead producer** — every rule above reads kube-state-metrics series; if KSM dies
  they all go silent. `KubeStateMetricsDown` guards the producer itself, symmetric to
  `PswatcherDown` (#48).
- **dead evaluator/router** — every rule above (including the producer guards) is
  *evaluated by Prometheus and routed by Alertmanager*. If either is down/OOM/evicted,
  nothing fires and nothing on-cluster notices. The `Watchdog` dead-man's-switch closes
  this last hole from **outside** the cluster (#60, below).
- **Day-0 / post-DR false page** — the `*StaleAbsent` guards would themselves over-fire
  on a freshly built plane (no first success yet). They are age-gated to stay quiet for
  26h so an incident rebuild doesn't hand you two crit pages you can't clear (#62).

### Wake-path & multi-tenant compute alerts

v0.6.0 enlarged the wake surface from one DB to a **branch-per-app** plane plus a
**read-replica pool** — so the pager was widened to see all of it (#80). Prometheus
now scrapes the **gateway family** (`pggw` *and* `pggw-apps`, keyed on a `gateway`
label), not just the single-DB `pggw`, so the apps-gateway's `pggw_*` metrics and
every per-app compute finally reach a rule:

- **`ComputeWakeStuck`** — single-DB plane, connection sum scoped to `gateway="pggw"`
  so apps traffic can neither mask nor spuriously trip it.
- **`ComputeWakeStuckApps`** — apps plane; `gateway="pggw-apps"` connections held but
  0 ready `compute-<app>`. Aggregate (whole-plane-down); a single stuck app is caught
  by `ComputeStuckNotReady`.
- **`ComputeRoPoolStuck`** — `compute-ro` desired ≥1 but 0 ready under read traffic
  (the read pool couldn't serve). KSM-only; silent when the pool rests at 0.
- **`ComputeStuckNotReady`** — any `compute*` pod Ready=false >5m, **no client needed**
  — the catch-all for a sleeping app's compute crash-looping that the connection-gated
  rules would miss.

All four evaluate kube-state-metrics series, so they are covered by
`KubeStateMetricsDown` (they go blind if KSM dies). The apps-gateway being an **UP**
scrape target is asserted by `deploy/_validate.sh` (manifest contract) and
`deploy/_verify-alerting.sh` (live target-UP + rules-loaded) so the "pager-blind
apps plane" of #80 stays closed.

### demo-canary

The alert set above scrapes the gateway, KSM and pswatcher — it sees a DB-side
regression but is **blind to the app half** of the wake path (an app-side crash,
a DNS failure, a Knative ingress-class mismatch — the iteration-5 review found
exactly that class of bug by hand, not by alert). The `pg-demo` NextApp is the
one workload that exercises the *whole* path, so it doubles as a synthetic
canary (issue #39).

`demo/manifests/30-demo-canary.yaml` is a `CronJob` that every 15 min hits the
app cold through the internal Kourier gateway (using the app's cluster-local
Host header — no LB IP, no RBAC) and asserts a **DB-backed HTTP 200** within a
per-attempt wake budget (45s, 3 attempts — a real visitor reloads through the
cold-start race). A run that can't is a **Failed Job**.

The mechanism is deliberately **zero-new-infra**: the CronJob lives in the
`scale-zero-pg` namespace (not `knext-demo`) precisely because kube-state-metrics
only watches this namespace, so its Job is visible to the existing alert plane.
A failure surfaces as `kube_job_status_failed{owner_name="demo-canary"}`, which
`DemoCanaryFailed` (deploy/60) joins on — the same Failed-Job pattern as backup
and wal-janitor, no new exporter, pushgateway, or blackbox target. Latency drift
is covered by the same mechanism: a wake that regresses past the budget fails the
attempt, so a slow-enough regression trips the alert too.

The rule ships in the always-on Prometheus but is **dormant** — with no canary
deployed there is no `demo-canary` Job series, so it never fires. Enable the
canary only when the demo is deployed:

```sh
kubectl apply -f demo/manifests/30-demo-canary.yaml   # deploy WITH the demo
kubectl -n scale-zero-pg get cronjob demo-canary
kubectl delete -f demo/manifests/30-demo-canary.yaml  # remove WITH the demo
```

Leaving it running after the demo is torn down will (correctly) page that the
canary path is broken — delete the CronJob when you delete the app.

### Receiver — testable sink by default, real pager one flip away

The default route is an in-cluster logging sink (`alert-sink`) so the pager path
is provable end-to-end with no external credentials. **To page a human:**

```sh
# 1. mint a Slack (or compat) incoming webhook, then scaffold the Secret:
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX sh deploy/gen-secrets.sh
# 2. flip the default receiver in the alertmanager-config ConfigMap:
#      route.receiver: webhook-sink  ->  route.receiver: slack
kubectl -n scale-zero-pg rollout restart deploy/alertmanager
```

The webhook URL is read at send time from the mounted Secret (`api_url_file`) —
it never lands in the ConfigMap or in git.

Prove the whole pager path any time:
- `sh deploy/_verify-alerting.sh` — synthetic always-firing rule reaches the sink.
- `sh deploy/_verify-cronjob-alerting.sh` — a **real failing CronJob** pages via
  kube-state-metrics → the exact owner-name rule → Alertmanager → sink, and
  asserts the KSM + pswatcher scrape targets are UP.
- `sh deploy/_verify-ksm-down.sh` — scales kube-state-metrics to 0 and asserts
  `KubeStateMetricsDown` reaches the sink, then restores it (the producer self-guard,
  #48).

### Dead-man's-switch — external heartbeat (#60)

Every alert above is **evaluated by Prometheus and routed by Alertmanager**. If either
process is down, crash-looping, OOM-killed or evicted, **no rule fires and no page is
sent** — including `KubeStateMetricsDown` and `PswatcherDown`, the guards meant to catch
silent machinery. Those close the *producer*-death holes but are all blind to
*evaluator/router* death. "All 15 rules green" cannot, on its own, tell a healthy
alerting stack from a dead one.

The fix is the standard **dead-man's-switch**: an always-firing `Watchdog` alert
(`expr: vector(1)`, `deploy/60`) routed to a **dedicated external receiver** (`watchdog`
in `deploy/61`) that POSTs a heartbeat to an **off-cluster** monitor on a short
(~1 min) repeat. The external monitor is configured to **alarm when the heartbeat
STOPS** — which is exactly what happens if Prometheus/Alertmanager die. The pattern is
inverted on purpose: on-cluster silence is the failure signal, and only something
**outside** the cluster can observe it.

**Arm it (operator, once):**

```sh
# 1. create a check on any heartbeat service and copy its ping URL, e.g.:
#      healthchecks.io   -> https://hc-ping.com/<uuid>
#      Dead Man's Snitch -> https://nosnch.in/<token>
#      cronitor          -> https://cronitor.link/p/<id>/<name>
#    Set its EXPECTED PERIOD to ~5 min and its grace to a few minutes.
# 2. scaffold the Secret (same optional alertmanager-receiver Secret as Slack):
WATCHDOG_HEARTBEAT_URL=https://hc-ping.com/<uuid> sh deploy/gen-secrets.sh
# 3. reload Alertmanager so it mounts the new key:
kubectl -n scale-zero-pg rollout restart deploy/alertmanager
```

The URL is read at send time from the mounted Secret (`url_file`) — never in the
ConfigMap or in git. Until armed, the in-cluster alert path is unaffected and the
Watchdog simply has nowhere external to go.

**What silence means.** If the **external** monitor pages you ("heartbeat missed"),
the alerting stack itself is down: `kubectl -n scale-zero-pg get pods -l plane=observability`,
check Prometheus/Alertmanager restarts/OOMs, and treat every other alert as **untrustworthy
until the heartbeat resumes** — during the gap, real incidents were not paging either.

Verify the heartbeat exists any time: `sh deploy/_verify-alerting.sh` asserts the
`Watchdog` alert is **active in Alertmanager's API** (the pre-condition for the external
ping) in addition to drilling the normal pager path.

Quick look without Prometheus: `sh deploy/_metrics.sh`.

**Drift drill — "exists" vs "healthy" (issues #27/#51).** `sh deploy/_verify-drift.sh`
asserts every Deployment/StatefulSet/CronJob declared in `deploy/NN-*.yaml` is not just
**present** on the cluster (closing merged≠deployed) but **healthy**: for
Deployments/StatefulSets `readyReplicas == spec.replicas` (which correctly accepts the
scale-to-zero compute — `0 ready == 0 desired`), and CronJobs are **not suspended**.
Existence-only was blind to a deployed-yet-CrashLoopBackOff workload — e.g. a
crash-looping kube-state-metrics would have passed "exists" while blinding five platform
alerts. Now a 0-ready or suspended load-bearing workload fails the drill.

## Durability model (what you can lose, and when)

- A **committed write is durable once 2/3 safekeepers ack** its WAL. Losing any one
  safekeeper pod/PVC loses nothing and doesn't block writes (drill-verified).
- The **compute is disposable** — kill it any time; no volume, no restore. Data is
  never in the pod.
- **Pageserver loss** (single, MVP): reads stop until it restarts, OR until the warm
  standby is **automatically** promoted — the drill-measured failover is **~8 s, hands
  off** (see "Pageserver failover"). PVC-backed; history also lives in MinIO.
- **MinIO loss**: running computes keep serving from safekeepers+pageserver; new
  timeline creation and long-term history offload pause. PVC-backed.
- **Both gateways down**: new connections fail (existing pipes drop); data unaffected.
- **Node loss / both storage PVCs gone**: recoverable **only** from the off-cluster
  backup (below). Everything durable lives in the MinIO `neon` bucket; the backup is
  the copy that survives losing the cluster. See "Backup & disaster recovery".

## Backup & disaster recovery

Closes the standing CRITICAL finding ("no backups anywhere"). Manifests:
`deploy/62-backup.yaml`; rehearsed drill: `deploy/_verify-restore.sh`.

> **Restoring for real?** The drill above is a *self-cleaning rehearsal* in a
> throwaway namespace — it proves the mechanism, it is **not** the production
> procedure. To restore **service into a fresh cluster** during an actual outage,
> follow **[`runbook-dr.md`](runbook-dr.md)** (copy-paste, operator-facing).

### What is the backup

The durable truth is the MinIO `neon` bucket — **pageserver layer uploads**
(`/pageserver`) + **safekeeper WAL offload** (`/safekeeper`) — plus the config the
bucket alone cannot rebuild: the `compute-config` / `compute-files` /
`pageserver-config` ConfigMaps (fixed tenant/timeline IDs, compute spec) and the
`storage-s3-creds` Secret. The pageserver PVC is a rebuildable cache; safekeeper
PVCs hold only recent WAL. So **a faithful backup = a copy of the bucket + the
config**, and **a faithful restore = a fresh storage plane attached to a restored
bucket copy**.

### How it runs

- **`CronJob/backup`** (daily 03:00) mirrors the `neon` bucket **off-cluster to OCI
  Object Storage** over its native S3-compatible endpoint (pinned `minio/mc`,
  signature v4, path-style), and dumps the ConfigMaps + Secret alongside it under
  the destination bucket's `neon/` and `neon-config/` prefixes. The config dump
  runs in an initContainer on a pinned kubectl image under a **scoped
  ServiceAccount** (`backup-operator`: `get`/`list` on **configmaps only** in
  `scale-zero-pg` — **not secrets**, issue #28). `src` (in-cluster MinIO)
  authenticates with `storage-s3-creds`; `dst` (OCI OS) uses a **separate
  least-privilege** `backup-s3-target` Secret.
- **No secret material leaves the cluster (issue #28).** The dump carries only
  ConfigMaps (tenant/timeline IDs, compute/pageserver spec). It used to also
  `mc cp` the `storage-s3-creds` Secret into the bucket, leaving the storage-plane
  credentials (base64, not encrypted) at rest **off-cluster** — the exact blast
  radius the separate `backup-s3-target` credential exists to avoid. That is gone.
  `storage-s3-creds` is the **MinIO root credential** (a knob, not data): on
  restore into a fresh cluster you mint a **new** one with `deploy/gen-secrets.sh`,
  so nothing in the backup depends on the old value. **Rotation:** rotate
  `storage-s3-creds` by re-running `gen-secrets.sh` with new values and restarting
  the storage plane; no backup re-dump is needed (the bucket never held it).
- **On demand (issue #31):** `kubectl create job --from=cronjob/backup` stamps a
  **controller ownerReference** to the CronJob (verified on k8s 1.34), so a naive
  manual run **counts against `successfulJobsHistoryLimit` and trips
  `UnexpectedJob`**. Create the manual run **standalone** — strip the
  ownerReferences so it is *not* owned by the CronJob:

  ```sh
  kubectl -n scale-zero-pg create job backup-now-$(date +%s) --from=cronjob/backup \
    --dry-run=client -o json | jq 'del(.metadata.ownerReferences)' \
    | kubectl -n scale-zero-pg apply -f -
  ```

  The `backup-now-` prefix keeps it visually distinct from the controller-created
  scheduled Jobs (`backup-<unix-ts>`); being unowned, it never evicts the scheduled
  03:00 history (see "Confirming the scheduled 3am backup" below). The
  `successfulJobsHistoryLimit: 6` headroom absorbs the occasional *naive* `--from`
  run that skipped the strip.
- **The `backup-s3-target` Secret** (endpoint / access / secret / bucket) is
  created by `deploy/gen-secrets.sh` from an **OCI Customer Secret Key** — the
  S3 access/secret pair, minted **once per tenancy** for the API-key user and
  shown only at creation. Provision (owner, once):

  ```sh
  NS=axfqznklsd2t                # OCI Object Storage namespace (oci os ns get)
  REGION=me-abudhabi-1
  # 1. bucket with versioning + a 30-day lifecycle on non-current versions:
  oci --profile DEFAULT os bucket create -ns $NS --name ks-pg-backup \
      --compartment-id <compartment-ocid> --versioning Enabled
  oci --profile DEFAULT os object-lifecycle-policy put -ns $NS \
      --bucket-name ks-pg-backup --from-json file://lifecycle.json --force
  # (lifecycle.json: DELETE previous-object-versions after 30 DAYS. Requires an
  #  IAM policy: "Allow service objectstorage-$REGION to manage object-family in
  #  tenancy" — otherwise the put returns InsufficientServicePermissions.)
  # 2. the S3 access/secret pair (Customer Secret Key):
  oci --profile DEFAULT iam customer-secret-key create --user-id <user-ocid> \
      --display-name ks-pg-backup-s3 --query 'data.{access:id,secret:key}'
  # 3. the cluster Secret:
  BACKUP_S3_ENDPOINT=https://$NS.compat.objectstorage.$REGION.oraclecloud.com \
  BACKUP_S3_ACCESS=<access> BACKUP_S3_SECRET=<secret> BACKUP_S3_BUCKET=ks-pg-backup \
    sh deploy/gen-secrets.sh
  ```

  `gen-secrets.sh` is idempotent (won't rotate an existing Secret) and, if the
  Secret is missing **and** no credentials are supplied, prints these steps and
  fails loudly rather than creating a half-empty Secret.
- **Retention/pruning + deletion-propagation risk (issue #28).** The mirror runs
  `mc mirror --remove`, so deleting an object in the live `neon` bucket removes it
  from the OCI copy too. This keeps the copy lean (the janitor's intentional WAL
  trims + pageserver GC propagate) and closed the incident where un-pruned mirror
  copies accumulated to ~60 GB — **but it is also the risk**: a bug or a bad actor
  that empties/corrupts the live `neon` bucket would, on the next scheduled mirror,
  propagate those deletions into the backup.
  - **Why it is survivable — versioning.** The destination bucket has **versioning**
    enabled, so a `--remove`-propagated deletion is **not** an immediate loss: the
    object becomes a **non-current version** recoverable for the lifecycle window.
    Recover a propagated deletion by listing and restoring prior versions, e.g.
    `oci --profile DEFAULT os object list-object-versions -ns <ns> -bn ks-pg-backup --prefix neon/...`
    then `os object restore`/re-copy the wanted version before the lifecycle ages
    it out. The backup CronJob is now **versioning-aware**: it passes `--remove`
    **only when the destination bucket reports versioning enabled**, and otherwise
    mirrors additively (no destructive propagation) and warns.
  - **Limitation (known MVP gap).** Retention is a **mutable 30-day** window (the
    lifecycle policy on non-current versions) with **no object-lock / WORM** — a
    bucket admin can still shorten the window or purge versions, and a deletion older
    than 30 days is unrecoverable. Enabling OCI **Retention Rules / object
    immutability** on `ks-pg-backup` would make the backup tamper-proof; until then
    this is an accepted MVP gap, tracked here.
  - If the lifecycle API is ever unavailable on the compat endpoint, fall back to
    `mc rm --recursive --force --older-than 30d dst/ks-pg-backup/neon` as a
    scheduled prune.
- **Proven envelope:** the earlier in-cluster path was verified green at **~18 GB**
  bucket size with the shipped mc-client sizing (1Gi); the OCI OS path uses the
  same client and retry loop. The retry loop has live evidence (a mid-run mirror
  read race converged on retry).

### Confirming the scheduled 3am backup (issue #31)

Two independent checks — mechanism vs the specific scheduled run:

- **The mechanism is green (any run):** `BackupStale` alerts if
  `kube_cronjob_status_last_successful_time{cronjob="backup"}` is older than 26h,
  and `BackupJobFailed` fires on a failed run. This confirms *a* backup succeeded,
  not *which*.
- **The specific 03:00 scheduled run:** when manual runs are created **standalone**
  (ownerReferences stripped, as above), they are **not owned by the CronJob**, so
  the only owned Jobs are the controller's own scheduled runs. Distinguish by **name
  prefix** too — scheduled Jobs are named `backup-<unix-ts>`, manual ones
  `backup-now-*`. List the scheduled successes, newest last:

  ```sh
  NS=scale-zero-pg
  # scheduled runs = owned by cronjob/backup AND name is NOT backup-now-*:
  kubectl -n $NS get jobs -l app=backup \
    -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].name=="backup")]}{.metadata.name}{"\t"}{.status.succeeded}{"\t"}{.status.completionTime}{"\n"}{end}' \
    | grep -v 'backup-now-' | sort -k3
  # the CronJob's own last-success timestamp:
  kubectl -n $NS get cronjob backup -o jsonpath='{.status.lastSuccessfulTime}{"\n"}'
  ```

  With 6 kept scheduled successes an operator can always point at a recent 03:00 run.
  (A *naive* `--from` manual run IS owned and would appear here as a `backup-now-*`
  entry — filtered out by the `grep -v` above — and counts against the limit; that's
  what the 6-deep headroom and the strip recipe protect against.)

### The honesty rule (critical)

A backup is only trustworthy for data the **pageserver has already uploaded to the
bucket** — i.e. `remote_consistent_lsn ≥ the write's LSN`. A restore stands up
**fresh, empty safekeepers**, so anything still only in safekeeper WAL (not yet in
a pageserver layer) is **not** restorable. The pageserver flushes+uploads a layer
after ~`checkpoint_distance` (256 MB) of WAL or on its checkpoint timer. The drill
forces this and asserts `remote_consistent_lsn` passed the marker LSN before taking
the backup. Operationally: **do not treat a just-written row as backed up until the
pageserver has uploaded it** (watch `remote_consistent_lsn` on
`GET :9898/v1/tenant/<t>/timeline/<tl>`).

### Rehearsed restore drill — `deploy/_verify-restore.sh`

Writes a tagged marker through the live compute, forces it into the bucket, takes a
backup **to OCI Object Storage**, then in a **throwaway `restore-drill` namespace**
stands up minio (seeded from the OCI OS backup) + broker + 1 safekeeper +
pageserver + compute, **reconstructed from the backed-up config**, and reads the
marker back. It then **promotes the restore to a read-WRITE primary** (STEP 5,
`deploy/_restore-writable.sh`) and asserts an INSERT **survives a compute kill +
fresh re-basebackup** — proving the restore comes back as a *service*, not just
readable data. Self-cleaning; leaves the live compute as found (scaled to 0).
**Measured RTO** on OKE (context-ckmva7v7zvq, 2026-07-03, **after the issue #19
WAL prune**): **read-only 1045 s** (backup start → first drill read) and
**writable 1226 s** (backup start → durable INSERT). The bulk — and the run-to-run
spread — is the two cross-internet bucket copies to/from OCI OS (upload the neon
bucket, then re-download it into the drill minio), which scale with bucket size.
The **read→write promotion delta is only ~181 s** (safekeeper WAL re-seed × 2
phases + one pageserver catch-up + the PRIMARY boot) and is independent of bucket
size. Pruning stale safekeeper WAL (below) took this drill from **>60 min
(unbounded, at a 13 GiB bucket)** to a **bounded ~20 min**; the remaining RTO is
now dominated by the **~11 GiB of pageserver layer files** (real data + the 7-day
PITR history), not safekeeper WAL. Still not bounded by Postgres. See
docs/BENCHMARKS.md.

### What we learned (tribal knowledge, now written down)

- **Re-attach at a HIGHER generation.** The live tenant/index are at generation 1;
  the drill re-attaches at **generation 2** (`location_config` `AttachedSingle`,
  `generation:2`). The pageserver picks the newest `index_part.json-<gen>` with
  generation ≤ its own, so gen 2 reads the gen-1 index and writes forward at gen 2 —
  a clean control-plane-style re-attach. Attaching at the **same** generation risks
  overwriting the index; attaching **lower** would not see the latest index.
- **Read-only is the first, always-safe proof.** The faithful *readability* check is
  a **STATIC read-only compute** pinned to the restored pageserver LSN
  (`spec.mode = {"Static":"<lsn>"}`), which reads pages directly from the pageserver
  and needs **no safekeepers**. This proves durability + readability of the backup
  independently of the writable-promotion machinery, and is the fallback if
  promotion ever fails.
- **A restore can now be promoted to READ-WRITE on 8464 OSS** (issue #2,
  `deploy/_restore-writable.sh`). The blocker was that a read-write compute needs a
  safekeeper that confirms WAL continuity from the basebackup LSN, and a fresh drill
  safekeeper reports `flush_lsn 0/0`, so Postgres aborts with *"cannot start in
  read-write mode from this base backup"*. On 8464 there is **no safekeeper HTTP API
  to create a timeline at an existing LSN** (`GET`/`DELETE` exist; `POST` timeline
  and `PUT .../control_file` → 404) and **no storage controller**, so the fix is
  **on-disk reconstruction**:
  1. The backup's `/safekeeper` prefix holds the **real offloaded WAL segments**.
     Seed the fresh safekeeper PVC with those segments plus a **crafted
     `safekeeper.control`** — a small binary struct (magic `0xcafeceef`, format v9,
     **CRC32C** trailer) written by `deploy/skctl.py` (format reverse-engineered from
     a live safekeeper; the serializer round-trips a real control file
     byte-identically). The safekeeper then reports the correct `flush_lsn`.
  2. First read-write attempt *still* failed — root cause was the **basebackup
     emitting `prev LSN 0/0`**: the pageserver loses `prev_record_lsn` on a cold load
     from remote storage. Fix: seed the safekeeper a couple of segments **past** the
     pageserver's `last_record_lsn` (Y); the pageserver streams the real WAL delta
     `Y→Z` and **re-derives `prev_record_lsn`**.
  3. Re-seed the safekeeper **truncated at exactly Z** (`flush == commit == Z ==`
     pageserver `last_record`), keep the pageserver up so the re-derived prev
     persists, then boot the compute as a **plain PRIMARY** (no `Static` mode). It
     basebackups at Z with a valid prev and comes up **read-write**.
  The drill asserts an INSERT then **survives a compute kill + fresh re-basebackup**.
  All inputs are **disaster-available** (bucket WAL + pageserver
  `initdb_lsn`/`last_record_lsn` + `system_id`/`pg_version`/`wal_seg_size` read from
  the read-only compute) — **no surviving safekeeper is required**.
- **Upgrade carrot.** A newer neon release ships a first-class **safekeeper timeline
  import / HTTP timeline-create** (the `POST /v1/tenant/<t>/timeline/<tl>` this 8464
  build 404s) and a **storage controller** to drive promotion — adopting it would
  replace the on-disk `skctl.py` craft with an API call. Until then, the on-disk
  re-seed above is the working, automated path on 8464 OSS.

### Production hardening

- **Off-cluster target — DONE (issue #4).** The mirror writes to **OCI Object
  Storage** with **bucket versioning + a 30-day lifecycle policy** on non-current
  versions and a **separate least-privilege credential** (`backup-s3-target`). The
  retired in-cluster `backup-store` MinIO PVC survived losing a storage PVC but
  **not** node loss; the off-cluster copy is what closes the node-loss /
  `kubectl delete pvc` incident. On a cluster still running the old workload,
  after the first OCI backup is green:
  `kubectl -n scale-zero-pg delete deploy/backup-store svc/backup-store pvc/backup-store-data`.
- **Remaining:** longer-horizon retention tiers (e.g. monthly beyond 30 days) if
  policy demands; a second region copy for regional durability.
- **Backup failure + staleness alerting — DONE (issues #29/#41).** kube-state-metrics
  (`deploy/59`) produces the Job/CronJob metrics; Prometheus ships `BackupJobFailed`,
  `WalJanitorJobFailed` (both matched by **exact** `owner_name`, not `backup.*`),
  and `BackupStale` (>26h via `kube_cronjob_status_last_successful_time`). See the
  [alert table](#alert-rules--what-each-means-and-the-3am-action) above and the
  drill `deploy/_verify-cronjob-alerting.sh`.

### Bounding safekeeper WAL growth — `wal-janitor` (issue #19)

**The problem.** Every restore/failover drill fills ~360 MB of WAL through the
live compute. The safekeepers offload that WAL to the bucket's `/safekeeper`
prefix as their durability backup, and **nothing trimmed it**: the bucket
lifecycle policy ages out only non-current *versions* (not current
accumulation), and neon's pageserver **GC does not touch safekeeper WAL at all**
— `gc_horizon` / `pitr_interval` govern only pageserver *layer* reclamation. So
`/safekeeper` grew unbounded (measured **~5.6 GB / ~360 × 16 MiB segments** on the
live bucket), and since a restore re-downloads the whole `neon` bucket twice
across the internet, that bloat directly inflated restore RTO.

**What GC actually reclaims (and does not).** Neon 8464 `PUT
:9898/v1/tenant/<t>/timeline/<tl>/do_gc` returns `200` but reclaims only
pageserver layer files older than `max(gc_horizon, pitr_interval)`. With a 7-day
PITR window and data younger than 7 days it reclaims **nothing**, and it never
has any notion of the `/safekeeper` prefix. GC is therefore **not** a tool for
this problem — an explicit janitor is required.

**What is safe to prune.** A safekeeper WAL segment is dead weight once it is
**both**:
1. **below the pageserver's `remote_consistent_lsn`** — the honesty-rule LSN,
   meaning the WAL is already ingested *and* uploaded into pageserver layers, so
   no pageserver will ever re-stream it; **and**
2. **outside the window the writable restore re-seeds.** `deploy/_restore-writable.sh`
   reads only a handful of segments around `last_record_lsn`
   (`[last_record − 2 seg .. + ~1 seg]`) to reconstruct the safekeeper. We keep a
   **`KEEP_SEGMENTS` safety horizon (default 32 = 512 MiB) below
   `remote_consistent_lsn`** — 8× the ~4 segments the restore actually needs and
   2× the 256 MB `checkpoint_distance`.

Everything **at or above** the horizon, and **every `.partial` segment** (the
live tail the safekeepers are still writing), is **never** touched. Pruning is
purely LSN/segment based — it does **not** key off the PITR *time* window,
because point-in-time reads are served from retained **pageserver layers**, not
from raw safekeeper WAL.

**The janitor.** A sibling `wal-janitor` CronJob in `deploy/62-backup.yaml` runs
daily at **02:30** (30 min before the 03:00 backup, so the next `mc mirror
--remove` propagates the trim to the OCI copy the same night):
1. an initContainer resolves a **per-timeline horizon** (#59): it reads
   `remote_consistent_lsn` for the configured timeline (**fail-closed** — a missing/zero
   rcl aborts the whole job and prunes nothing) **and** walks the pageserver's timeline
   list, writing each timeline's OWN `segno(rcl) − KEEP_SEGMENTS` suffix to
   `/state/horizons/<timeline_id>`. A timeline whose rcl can't be resolved gets **no**
   horizon file;
2. the `mc` container iterates **every timeline prefix** present under
   `/safekeeper/<tenant>/` and, for each, deletes only complete 16 MiB segments whose
   24-hex name sorts *strictly before* **that timeline's own** threshold — with the
   per-8-hex-TLI derivation (#42) applied within each timeline. A timeline with no
   resolved horizon is **fail-safe-skipped** (never judged against another timeline's
   horizon — that would over-prune a lagging sibling below its own rcl) and the run
   **fails loud** (exits non-zero → `WalJanitorJobFailed`). It also fails loud if the
   bucket listing errors — never exit-0-having-pruned-nothing.

> **Why the TLI is derived, not `1` (issue #42).** WAL segment object names are
> `<TLI><LOGID><SEG>` (24 hex). The janitor used to hardcode `TLI=1`. A neon timeline
> **promotion** bumps the TLI (`00000002…`); those segments sort *above* a `TLI=1`
> threshold and would **never** be pruned — the janitor would keep exiting `0` while
> `/safekeeper` regrew unbounded (silent success, invisible to the Failed-Job alert).
> Deriving the TLI from the segment set and pruning per-timeline closes that. Today's
> single-timeline compute has one TLI (`00000001`); the logic now generalises without
> a code change. The safety direction is unchanged — a wrong/extra TLI only ever keeps
> **more** WAL, never deletes needed WAL. The runtime drill `deploy/_verify-wal-janitor.sh`
> proves the invariants against the live plane.

Run it on demand (and preview first with `DRY_RUN`):

```
# supervised preview — list what WOULD be pruned, delete nothing. Patch the
# CronJob env first (patching a running Job's pod template has no effect), then
# create a Job from it.
kubectl -n scale-zero-pg set env cronjob/wal-janitor --containers=prune DRY_RUN=true
kubectl -n scale-zero-pg create job wal-janitor-preview --from=cronjob/wal-janitor
kubectl -n scale-zero-pg logs job/wal-janitor-preview --all-containers   # inspect the range + count
kubectl -n scale-zero-pg set env cronjob/wal-janitor --containers=prune DRY_RUN=false  # restore default

# real prune (the shipped default, DRY_RUN=false)
kubectl -n scale-zero-pg create job wal-janitor-now --from=cronjob/wal-janitor
kubectl -n scale-zero-pg logs job/wal-janitor-now --all-containers
```

A supervised live prune on 2026-07-03 reclaimed **325 of 357 segments (~5.2 GB;
`/safekeeper` 5.6 GB → 534 MB)**, keeping 32 segments + 3 partials, with live
reads/writes verified healthy immediately after. Tune the horizon by editing
`KEEP_SEGMENTS` on the `resolve-horizon` initContainer.

**How to tell the janitor has stalled (issues #41/#49).** Three alerts, one per
failure mode — see the [alert table](#alert-rules--what-each-means-and-the-3am-action):
- a scheduled run that **Fails** (pageserver unreachable at 02:30, listing error, etc.)
  fires `WalJanitorJobFailed` within one missed schedule (the janitor is fail-closed
  *and* fail-loud, so a persistent failure never regrows `/safekeeper` silently);
- a janitor that **silently stops scheduling** (suspend, controller backlog, missed
  deadlines) produces no Job at all — caught by `WalJanitorStale` (last success >26h);
- a janitor that has **never once succeeded, or is suspended/deleted** (no last-success
  metric) — caught by `WalJanitorStaleAbsent`.

Manual check: `kubectl -n scale-zero-pg get jobs -l app` and look at the last
`wal-janitor-*` Job's status, or query
`kube_job_status_failed * on(namespace,job_name) group_left(owner_name) kube_job_owner{owner_name="wal-janitor"}`
in Prometheus. Trend the prefix size from the janitor's own logs (it prints the
segment count each run).

**Prove the prune logic is safe before a DR event.** `deploy/_verify-wal-janitor.sh`
runs the *real* janitor against the live plane and asserts: (A) fail-closed — with the
pageserver unreachable the Job exits non-zero and deletes nothing; (B) it prunes
**only** complete segments strictly below `segno(rcl) − KEEP_SEGMENTS`, deletes every
seeded below-horizon segment, and preserves every `.partial` and every at/above-horizon
segment; (C) it is idempotent (a second run reports "nothing to prune"). This is the
gate that catches a prune-set off-by-one (hex width, TLI, sort boundary) before it can
destroy WAL the writable restore needs.

## Pageserver failover

The single pageserver is the MVP's read authority — lose it and reads stall (writes
still reach the safekeeper quorum). The reviews flagged this as an *unbounded* read
outage. It is now **automatic**: a standing warm-Secondary standby plus the
`pswatcher` controller promote-and-flip on primary-down, no human step. Manifests:
`deploy/57-pageserver-standby.yaml` (standby + generation ledger),
`deploy/58-pswatcher.yaml` (watcher). Rehearsal: `deploy/_verify-pageserver-failover.sh`.

### The components

- **Standby pageserver (`pageserver-standby`, 57).** A second StatefulSet, distinct
  node identity (`id=1235` vs the primary's `1234`), **same bucket + broker**. Its
  init Job registers a **warm Secondary** location for the live tenant
  (`location_config` `mode:"Secondary"`, `secondary_conf.warm:true`) so it
  pre-downloads layers from MinIO without serving — a promotion is a fast re-attach,
  not a cold restore.
- **Generation ledger (`pageserver-generation` ConfigMap).** Holds the last generation
  the tenant was attached at (seed `1`, matching `storage-init`). Each failover reads
  it, promotes at **value+1**, and writes the new value back — so repeated failovers
  stay monotonic and a restarted watcher never re-uses a stale generation.
- **Stable liveness handle (`pageserver-primary` Service).** Always selects the primary
  STS, so the watcher probes the *primary's* health even after it flips the
  client-facing `pageserver` Service.
- **The watcher (`pswatcher`, 58).** Polls `pageserver-primary:9898/v1/status`
  (`PSW_POLL_MS`, default 2 s). After `PSW_FAIL_THRESHOLD` consecutive misses
  (default 3 ≈ 6 s — long enough not to split-brain a slow primary) **and** a
  second-vantage confirmation (see the decision table below) it runs the same
  runbook the restore drill proved, in order:
  1. **Promote** the standby to `AttachedSingle` at **generation+1** — the higher
     generation fences the dead primary (single-writer is intrinsic to Neon; the
     pageserver picks the newest `index_part.json-<gen>` ≤ its own).
  2. **Persist** the advanced generation in the ledger ConfigMap.
  3. **Flip** the `pageserver` Service selector to the standby, so the compute's
     unchanged `neon.pageserver_connstring host=pageserver` now resolves to it.
  4. **Bounce** the compute (delete its pod) so a cold wake basebackups from the
     promoted standby.
  The surviving safekeeper carries the WAL, so the standby streams forward and the DB
  stays **read-WRITE** across the failover. The watcher is single-shot per failover
  and idempotent on restart (if the `pageserver` selector already points at the
  standby it adopts that state rather than re-promoting).
  **After it fails over it does not go blind (#25):** every tick it re-derives the
  current read authority from the `pageserver` Service selector, so once flipped it
  **probes the promoted standby** and `pswatcher_primary_up` reports *that* node's
  real health — the metric can no longer read a false "healthy" for a node the watcher
  stopped watching. The returned old primary is never re-adopted (the selector never
  flips back). It exposes `/healthz` and
  `pswatcher_promotions_total` / `pswatcher_primary_up` / `pswatcher_failed_over` /
  `pswatcher_suspected_partitions_total` on `:9091`; RBAC is minimal
  (services get/patch, configmaps get/update/patch, pods list/delete).

#### Partition tolerance — the promote decision (#26)

An automatic promotion is **irreversible and standby-consuming**: it fences the old
primary and leaves the platform on a pageserver with no standby behind it. A failed
HTTP probe reflects only the watcher pod's own network path, so a ~6 s watcher↔primary
blip (DNS/kube-proxy hiccup) must **not** burn the only standby. Before promoting, the
watcher corroborates death from a **second vantage** — it asks the API server (the
kubelet's independent view) about the primary pod (`PSW_PRIMARY_SELECTOR`, default
`app=pageserver`):

| Our HTTP probe | API server (kubelet) says | Decision |
| --- | --- | --- |
| fails ≥ threshold | pod **Running & Ready** | **HOLD** — this is a watcher-side partition, not primary death. No promotion; `pswatcher_suspected_partitions_total` increments; the standby is preserved. |
| fails ≥ threshold | pod **NotReady** | **PROMOTE** — the primary is genuinely unhealthy. |
| fails ≥ threshold | pod **absent**, primary **was** seen present before | **PROMOTE** — a pod we were demonstrably watching has vanished. |
| fails ≥ threshold | pod **absent**, primary was **never** seen present | **HOLD** — `present=false` here is more likely a mis-typed/drifted `PSW_PRIMARY_SELECTOR` (or an RBAC empty list) than a death. `pswatcher_primary_never_seen_total` increments; the standby is preserved (#58). *Exception:* if the generation ledger already shows a prior promotion (`gen > base`), a restarted watcher **resumes** and promotes — an advanced ledger is independent evidence a failover was warranted. |
| fails ≥ threshold | **API unreachable** | **HOLD** — can't corroborate; refuse to promote on a single vantage (a `tick error` is logged and retried). |

**Seen-present anchor (#58).** `present=false` from the API server means only "zero pods
match `PSW_PRIMARY_SELECTOR`" — indistinguishable between a genuinely-gone primary and a
selector that never matched anything. The watcher therefore **anchors**: it must have
observed the primary pod *present* at least once (on a healthy tick, or as
NotReady/Ready during an investigation) before it will read a later absence as death.
Until anchored, an absence **holds** and surfaces `pswatcher_primary_never_seen_total`, so
a selector misconfiguration fails **safe** (no promotion) and **observable** instead of
silently degrading the #26 second-vantage back to single-vantage.

> **Node-death RTO regime.** The `~8 s` RTO holds for a **pod-process** death (kubelet
> marks NotReady fast). A whole-**node** failure is different: the API-server vantage
> serves the last-known `Ready` status until the node lease expires
> (`node-monitor-grace-period`, ~40 s default), so `{probe fails, kubelet still Ready}`
> ⇒ HOLD until the lease lapses. Node-level failover RTO is bounded by that grace period,
> not `FailThreshold × interval` — shorten the grace on the pageserver pods if you need
> it tighter (#58).

**Tuning knobs & their partition tolerance.** `PSW_POLL_MS` (2 s) × `PSW_FAIL_THRESHOLD`
(3) ⇒ the HTTP path must be down ~6 s before the gate is even consulted; the
second-vantage check then absorbs any watcher-only partition of arbitrary duration
(the standby is never consumed while the kubelet still sees the primary Ready). Raise
the threshold to trade failover RTO for more blip tolerance on the *primary's own*
readiness flaps; the second vantage already covers the watcher-side ones.

#### Availability posture of the authority itself (#23)

The watcher is a deliberate **single replica** — promotion is the single-writer of a
one-way action, and two watchers could double-flip. We do **not** add a replica or
leader-election. Instead the authority is **crash-only**: its entire state lives in the
cluster (the `pageserver` Service selector + the generation ledger ConfigMap), not in
memory. A watcher that dies mid-failover **resumes idempotently** on restart —
- selector already flipped ⇒ it adopts the promoted standby and never re-promotes —
  **and bounces the compute exactly once on adoption** (#57), so a compute still pinned
  to the dead primary from a crash in the flip→delete window is re-attached (deleting an
  already-gone pod is a no-op; retried until it lands);
- ledger advanced but selector not yet flipped ⇒ it drives the failover to completion
  with a **monotonic** generation (still fences the dead primary).
`strategy: Recreate` guarantees a rollout never runs two watchers at once; a
`PodDisruptionBudget` (`maxUnavailable: 1`) makes the single-replica intent explicit
and lets node drains proceed — we accept the brief gap because recovery is idempotent.
The gap itself is covered by `PswatcherDown` (below), which degrades to the manual
runbook until the watcher is back.
- **Measured automated RTO: 8 s on OKE** (kill → reads restored on the promoted
  standby, **no human step**) in the self-contained drill (see `docs/BENCHMARKS.md`).
  This converts the SPOF from an *unbounded* outage into a *known, small, hands-off*
  RTO — on par with the manual mechanism (~9 s) but with zero operator involvement.

### Operating it

- **Deploy:** `kubectl apply -f deploy/57-pageserver-standby.yaml -f deploy/58-pswatcher.yaml`
  (the watcher is the `/pswatcher` binary in the same gateway image). Confirm the
  standby is a warm Secondary: `kubectl -n scale-zero-pg logs job/pageserver-standby-init`.
- **Verify hands-off:** `sh deploy/_verify-pageserver-failover.sh` — stands up a
  throwaway 2-pageserver plane + the watcher, kills the primary, and asserts reads
  recover with the `pageserver` Service selector flipped **by the watcher** (proof no
  human acted), the generation ledger advanced 1→2, and the watcher's **post-failover
  truthfulness** (`pswatcher_failed_over=1` and `pswatcher_primary_up` re-anchored onto
  the promoted standby, not a blind latched 1 — #25).
- **After a failover:** the standby is now the primary and the ledger holds the new
  generation. To restore redundancy, bring up a fresh warm Secondary (re-seed
  `pageserver-standby` against the now-primary); the watcher adopts the flipped
  selector and will not re-promote.
- **Manual fallback** (watcher down): the identical steps run by hand —
  `sh deploy/_verify-pageserver-failover.sh --manual` documents the exact commands
  (kill → `PUT location_config AttachedSingle generation+1` → flip the `pageserver`
  selector → `rollout restart deploy/compute`). Failover keeps the same safekeeper,
  so WAL continuity holds and the DB stays read-write. (The sibling **writable-restore**
  safekeeper re-seed — needed only for a full-plane rebuild from backup, where the
  safekeepers are fresh — is now also automated; see "Backup & disaster recovery".)

## Password rotation

`ALTER USER ... PASSWORD` does **not** stick — `compute_ctl` re-applies the spec's
roles on every boot. To rotate:

1. Compute the hash: `md5` of `password + username`, e.g.
   `printf 'NEWPASScloud_admin' | md5`.
2. Put it in `roles[].encrypted_password` inside `deploy/54-compute-files.yaml`
   (the `config.json` key) and `kubectl apply -f deploy/54-compute-files.yaml`.
3. Update the app Secrets (`30-knext-secret.yaml`) and restart the compute:
   `kubectl -n scale-zero-pg rollout restart deploy/compute`.

## TLS certificate rotation

The gateway terminates TLS on the Postgres wire when `GW_TLS_CERT_FILE` +
`GW_TLS_KEY_FILE` are set (see the config table). The keypair lives in the Secret
`pggw-tls`, mounted at `/etc/pggw-tls/`. This closes the "plaintext Postgres on an
external LoadBalancer" review finding — clients connect with `sslmode=require`.

**Generate it (once):** `sh deploy/gen-tls.sh`. Idempotent — it self-signs a cert
(CN `pggw.scale-zero-pg.svc`; SANs cover `pggw`, `pggw-lb`, `localhost`, `127.0.0.1`)
into Secret `pggw-tls` **only if absent**, so it never rotates silently. The pods
require the Secret to start, so run this **before** `kubectl apply -f deploy/10-gateway.yaml`.

**Self-signed, on purpose.** This is cluster-local infra. Clients use
`sslmode=require` (encrypt without CA verification) — **not** `verify-full`. Moving
to `verify-full` needs a cert from a CA the clients trust (cert-manager + an issuer,
or your org CA); swap the Secret contents and clients can then verify.

**To rotate (deliberate):**

1. Regenerate the keypair (self-signed example):
   ```
   kubectl -n scale-zero-pg delete secret pggw-tls
   sh deploy/gen-tls.sh
   ```
   Or `kubectl -n scale-zero-pg create secret tls pggw-tls --cert=… --key=… \
   --dry-run=client -o yaml | kubectl apply -f -` for a CA-issued pair.
2. Roll the gateway so it reloads the mount: `kubectl -n scale-zero-pg rollout
   restart deploy/pggw`. A mounted Secret update also propagates to the file on
   its own, but the gateway loads the cert once at startup — the restart is what
   picks it up.
3. Verify: `sh deploy/_verify-tls.sh` (proves `sslmode=require` is encrypted,
   `sslmode=disable` still works, and the wake path works over TLS).

**Disabling TLS** (revert to plaintext): unset the two env vars in
`deploy/10-gateway.yaml` and restart. `SSLRequest` then gets `N` again and only
`sslmode=disable` clients connect.

## Network isolation caveat

`deploy/70-networkpolicy.yaml` (default-deny + per-flow allows; compute reachable
only from the gateway) is declaratively correct but **only enforced if your CNI
enforces NetworkPolicy**.

**Empirically verified on the OKE cluster (`context-ckmva7v7zvq`, issue #5):
NetworkPolicy is NOT enforced here.** The cluster's pod network is
**kube-flannel** (overlay) — flannel ships no NetworkPolicy controller, so the
seven policy objects are *admitted and inert*: nothing evaluates them. The proof
is behavioural, not by inspection: `deploy/_verify-netpol.sh` runs a pod in a
throwaway namespace and connects to the gateway pod's `:9090` — a path the
`gateway-ingress` policy restricts to in-namespace pods only. Under an enforcing
CNI that cross-namespace connection is refused; here it succeeds, which is only
possible if the policy is not being enforced. (`kubectl get ds -n kube-system`
confirms flannel with no Calico/Cilium/kube-router alongside it.)

**What the policies WOULD enforce, given a capable CNI:** a default-deny-ingress
baseline plus per-flow allows, the load-bearing one being `compute-ingress` —
the sensitive data path `compute:55433` reachable **only** from the gateway pods
(`app=pggw`), with everything else in the namespace denied. Metrics `:9090` would
be in-namespace-only; the storage plane's ports scoped to their real callers.

**To actually enforce isolation on OKE**, pick one before relying on it in
production:
- **Calico policy-only add-on** — install Calico in policy-enforcement mode
  alongside flannel (the "Canal" arrangement: flannel for the data plane, Calico
  for policy). Calico then evaluates the existing `networking.k8s.io/v1` objects
  unchanged.
- **OCI VCN-native pod networking with network policy** — provision the node pool
  with the OCI VCN-Native Pod Networking CNI and enable its NetworkPolicy support,
  instead of the flannel overlay.

After enabling either, re-run `deploy/_verify-netpol.sh`. Its enforcement-detection
probe will now report `enforcement DETECTED`, at which point the drill **hard-asserts**
that `compute:55433` is unreachable from a non-gateway pod and **fails** (not warns)
if it is not — so a regression in the policies, or a CNI that only partially enforces,
is caught instead of passing silently.

## Common operations

```sh
# force the DB awake / asleep manually
kubectl -n scale-zero-pg scale deploy/compute --replicas=1   # or 0

# change the idle window (e.g. 5 min)
kubectl -n scale-zero-pg set env deploy/pggw GW_IDLE_MS=300000

# scale gateways (peer-aware idle keeps sleep decisions safe at any count)
kubectl -n scale-zero-pg scale deploy/pggw --replicas=3

# watch the wake loop live
kubectl -n scale-zero-pg get pods -l app=compute -w
kubectl -n scale-zero-pg logs -l app=pggw -f --prefix | grep 'gw]'
```

## Multi-tenant apps — branch-per-app (ADR-0003)

The apps-gateway (`deploy/81-apps-gateway.yaml`, `pggw-apps`) fronts one
scale-to-zero compute per app, each on its own Neon branch. Full design:
[ADR-0003](adr-0003-multi-tenancy.md); connect contract:
[connecting.md](connecting.md#multi-app--branch-per-app).

```sh
cd deploy
./provision-app.sh init-plane --schema testdata/app-base-schema.sql  # one-time
./provision-app.sh create  orders        # branch + compute + per-app credential
./provision-app.sh list                  # apps-tenant timelines
./provision-app.sh fsck                  # reconcile branches<->intents (exit≠0 if any); add --converge to auto-repair
./provision-app.sh rotate-cred orders --bounce   # rotate the app's password + apply now
./provision-app.sh destroy orders        # reclaims the timeline BY DEFAULT — no orphan (#91)
./provision-app.sh reclaim-orphans       # sweep any orphan branches + drain pending SK-deletes (#87/#90)
# read an app's DSN (per-app credential):
kubectl -n scale-zero-pg get secret app-db-orders -o jsonpath='{.data.DATABASE_URL}' | base64 -d
```

**Tenant access control (issue #74).** Each app authenticates as its own role
`app_<app>` (minted into `app-db-<app>`; applied to the compute spec every boot by
`compute_ctl`). The apps-gateway **refuses**, with a clean `28P01` and **no wake**,
any startup whose `(user, database)` is not `app_<db>/<db>`, whose database is not
a lowercase RFC1123 label, or whose database is a reserved system name
(`GW_RESERVED_SYSTEMS=tmpl,warm,ro`). Consequences: `cloud_admin` does **not** work
through `pggw-apps` (admin is direct-to-`compute-<app>` only); one app's DSN cannot
reach another; the shared template/warm/RO computes are unreachable via the
apps-gateway. Keep `GW_APP_ROLE_PREFIX`/`GW_RESERVED_SYSTEMS` (gateway) in
lock-step with `APP_ROLE_PREFIX`/`RESERVED_NAMES` (`provision-app.sh`). Drill:
`deploy/_verify-multitenant.sh` (section 6 denies cross-app + cloud_admin).

**Per-app idle (issue #75).** Sleep is decided **per app**: the peer-aware idle
check (2-replica apps-gateway) reads each app's own connection count from the
peers' `per_system` metrics, so one busy app never keeps other idle apps awake.
Drill section 7 proves an idle app scales to zero while a neighbour holds a
connection open.

**Cross-replica idle thrash — assessment (issue #93c).** *Can two apps-gateway
replicas oscillate an app `0↔1` when a client's connections are SPLIT across
them?* **No — not in steady state.** Before any replica scales an app to zero,
`scheduleSleep` (`gateway/internal/gateway/gateway.go`) requires **both** its own
local count == 0 **and** the peer fleet's `per_system.active` for *that app* == 0;
a peer that still holds a connection (or any peer-scrape error) **postpones** the
sleep and re-arms the timer. So as long as *either* replica holds a live
connection for app X, X is never scaled down — split long-lived connections keep
X up. The only residual is a **narrow, self-healing** window: if a fresh
connection lands on peer B in the sub-second gap between A's peer-check (saw B=0)
and A's scale-to-zero call, B's own wake-on-connect immediately re-wakes the
compute and B's client is held by its wake-retry loop until ready — bounded to **at
most one** scale cycle, never a sustained flap. Evidence (gateway unit tests, run
in CI): `TestIdleSleepDefersToPeers` (no sleep while a peer is busy; sleeps once
the fleet is quiet), `TestSplitConnectionsDoNotThrashAcrossWindows` (no `1→0` flap
across ~12 idle windows while a peer holds the app, then **exactly one** clean
scale-to-zero when the peer drops), and `TestSleepRaceWakesBackWhenConnectionArrivesMidSleep`
(the same-replica TOCTOU heal). **No code fix required** — the peer-aware idle
already closes the window; this behaviour is regression-locked by the tests above.

### Deprovision is safe by default (issue #91)

`destroy <app>` — the obvious command, **no flag** — now DELETEs the app's Neon
timeline (pageserver **and** all three safekeepers) as well as its k8s objects, so a
routine teardown leaves **no orphan branch and no unbounded safekeeper WAL**. This
was the #91 defect: the old default *kept* the timeline (only `--delete-timeline`
reclaimed it), and since it deleted the owning ConfigMap first, every default
`destroy` manufactured an orphan.

- `destroy <app>` → reclaims the timeline (safe default). Legacy `--delete-timeline`
  is still accepted as a no-op.
- `destroy <app> --keep-timeline` → **explicit** opt-out for PITR/forensics. It
  retains the branch and prints the now-orphaned id **plus** the reclamation command,
  so retention is a tracked decision, never a silent leak.
- A safekeeper **down/unreachable** at destroy time no longer drops its WAL dir on
  the floor (`|| true`): the failed `(timeline → safekeeper ordinals)` is recorded to
  the durable ConfigMap `apps-wal-reclaim-pending`, and `reclaim-orphans` drains it.

### fsck: orphans & dangling intents (issues #76, #93a)

`create` is **intent-first**: the per-app ConfigMap (which records the branch's
`TIMELINE_ID`) and the credential Secret are applied **before** the pageserver
branch call, so an interrupted `create` never leaves a branch with no owner — a
re-run reads the id back and converges. `fsck` reconciles the plane in **both
directions** and exits non-zero if anything is off:

```sh
./provision-app.sh fsck            # report every mismatch (exit 1 if any)
./provision-app.sh fsck --converge # ALSO auto-repair dangling intents (re-branch)
```

1. **Orphan timeline** — a branch on the pageserver with **no owning ConfigMap**
   (a `--keep-timeline` teardown, an old pre-fix interrupted `create`, or a
   hand-deleted ConfigMap). **`fsck` is report-only** — deleting WAL is high
   blast-radius, so it never auto-deletes a branch. Reclaim every orphan (pageserver
   **and** all safekeepers, plus any safekeeper-only WAL dir whose branch is already
   404) with the dedicated tool, then re-run `fsck`:

   ```sh
   ./provision-app.sh reclaim-orphans   # two-sided delete of every orphan; exit≠0 if a SK is still down
   ./provision-app.sh fsck              # confirm clean (exit 0)
   ```

   Leaving an orphan pins the template's ancestor WAL/pages (`pitr_history_size`
   grows) and leaks safekeeper WAL dirs — the same cost as a forgotten `destroy`.
   Full reclamation runbook (+ the `SafekeeperWALGrowth` signal) below.

2. **Dangling intent** — the intent-first *failure mode* (issue #93a): a ConfigMap
   (and/or credential Secret) exists but its recorded timeline **has no branch**,
   because a crash landed **after** the ConfigMap/Secret apply and **before** the
   pageserver branch call. The compute can never boot (its `wait-timeline`
   initContainer blocks forever on the missing branch). `fsck` detects it; with
   `--converge` it **re-branches the recorded id** via an idempotent `create`,
   finishing the interrupted provision:

   ```sh
   ./provision-app.sh fsck --converge   # re-branches each ConfigMap's recorded timeline
   # equivalently, for one app:  ./provision-app.sh create <app>
   ```

   A **stray Secret** with no ConfigMap (crash between the Secret and ConfigMap
   applies) is also reported; resolve with `create <app>` (completes the provision)
   or `destroy <app>` (removes it).

### Rotating an app credential (issue #93b)

Each app authenticates as `app_<app>` with a per-app password stored in Secret
`app-db-<app>` (`PGPASSWORD` + `APP_ROLE_MD5` + `DATABASE_URL`). `compute_ctl`
re-applies the role's md5 **from spec on every boot**, so rotation is: write a new
md5 into the Secret, then bounce (or wait for the next wake of) the compute.

```sh
cd deploy
./provision-app.sh rotate-cred orders            # new password into the Secret only
./provision-app.sh rotate-cred orders --bounce   # + bounce compute-orders NOW to apply it
```

- The **DSN contract is unchanged** — same role, host, and database; only the
  password **value** rotates (see [connecting.md](connecting.md#rotating-an-app-credential-issue-93b)).
- **Timing / who breaks:** a **running** compute keeps the OLD password valid until
  it is bounced — `rotate-cred` without `--bounce` only updates the Secret, so live
  sessions are undisturbed and you apply the change on your own schedule.
  `--bounce` does a `Recreate` rollout (single-writer-safe) so the new md5 takes
  effect immediately and the old password stops authenticating. A compute **at 0**
  (scaled to zero) picks up the new md5 automatically on its next wake — no bounce
  needed.
- **Consumers must re-read the Secret.** knext injects `DATABASE_URL` into the app
  pod's env at pod-start, so a rotated password only reaches the app when its pods
  restart. Recommended zero-fuss order: `rotate-cred <app>` → roll the consumer
  Deployment (picks up the new `DATABASE_URL`) → the first new connection wakes/uses
  the compute with the new md5. If you `--bounce` before rolling consumers, in-flight
  sessions on the old password get a clean reconnect and re-auth once the consumer
  pods carry the new Secret.

<a id="reclaiming-orphaned-apps-tenant-wal-9087"></a>
### Reclaiming orphaned apps-tenant WAL (#90/#87)

Reclamation is the **deprovision path's** job — this closes the circular
responsibility the reviewer flagged (`destroy` said "the janitor will reclaim"; the
janitor said "deprovision reclaims"; nobody did). One command reclaims **every**
orphan — a branch with no owning ConfigMap **and** a safekeeper-only WAL dir whose
branch is already pageserver-404 — on the pageserver **and** all safekeepers, and
drains any recorded pending SK-deletes. Safe + idempotent (an orphan has no live app
and, its branch deleted, no PITR hold):

```sh
./provision-app.sh reclaim-orphans   # reclaim all orphan branches + SK WAL dirs; exit≠0 if a SK is still down
./provision-app.sh fsck              # confirm clean (exit 0)
```

**Run it as a scheduled reclamation drill** (e.g. weekly, or after any batch of
`--keep-timeline` teardowns / a safekeeper outage). The `apps-wal-monitor` CronJob
(`deploy/62-backup.yaml`, every 3h) is the **signal** that tells you when to: it
measures orphan WAL dirs on the safekeeper PVs and each safekeeper's `/data`
utilization, and fires **`SafekeeperWALGrowth`** (warning) when residue accumulates
or a PV approaches ENOSPC. The wal-janitor itself never reclaims an orphan — it is
*correct* to fail-safe-skip (never over-prune) an unresolvable timeline; the missing
half was this bound + signal + reclaim, not a change to the janitor's prune logic.

Leaving an orphan pins the template's ancestor WAL/pages (`pitr_history_size` grows)
and leaks safekeeper WAL dirs on the fixed **2Gi** safekeeper PVs — unbounded, it
ends in ENOSPC that wedges the *whole* storage plane. Proven end-to-end by
`deploy/_verify-wal-janitor.sh` section F (create → default `destroy` → assert the
branch is gone from the pageserver, the SK WAL dir is gone on all three safekeepers,
`fsck` is clean, and re-provisioning the same name mints a fresh timeline id).

## Read-only pool (issue #66)

The read-only pool (`deploy/26-compute-ro.yaml`) is a set of read-only computes
on the primary's timeline, fronted by the gateway's second listener
(`GW_RO_PORT`, default `55434`). Apps reach it via `DATABASE_URL_RO`
([connecting](connecting.md#scaling-reads-database_url_ro-opt-in-read-only-pool)).
It is **off by default** (`replicas: 0`) and needs no single-writer ceremony —
read-only computes coordinate nothing.

**Lifecycle:** a read connection on `GW_RO_PORT` scales `compute-ro`
`0 → GW_RO_WAKE_REPLICAS`; `GW_RO_IDLE_MS` with no RO connections scales it back
to `0`. The gateway RO lane is a copy of the writer lane (same wake/idle/peer/TLS
code) built from `GW_RO_*` env — remove `GW_RO_PORT` to disable it entirely.

```sh
# enable the pool (bring it online once so it's schedulable), then let idle sleep it
kubectl -n scale-zero-pg apply -f deploy/26-compute-ro.yaml
# choose tip-following (default) or the fixed-LSN fallback
kubectl -n scale-zero-pg set env deploy/compute-ro RO_MODE=Replica   # or Static
# drill it: RO wakes only the pool, reflects committed data, rejects writes, staleness
RO_MODE=Replica sh deploy/_verify-readpool.sh
```

**`RO_MODE`:** `Replica` = tip-following hot standby (goal; reads track the writer
with replication lag). `Static` = pinned at the LSN the `resolve-lsn` initContainer
captured at attach (frozen; advances only on pod re-roll). The drill prints
`READPOOL_STALENESS mode=… tip_following=yes|no lag_s=…` — that line records which
you actually got.

**Scaling N>1 — the HPA vs scale-to-zero tension.** The gateway RO driver and an
HPA both want to own `compute-ro`'s replica count, so pick ONE posture
(`deploy/27-compute-ro-hpa.yaml.optional` documents all three):

- **A — gateway-managed 0↔N (default):** no HPA. Full scale-to-zero; wakes to a
  fixed `GW_RO_WAKE_REPLICAS`. Simplest.
- **B — HPA-managed 1↔N:** apply `deploy/27`, and set `GW_RO_IDLE_MS=0` so the
  gateway never sleeps the pool (the HPA's `minReplicas: 1` floor means **no**
  scale-to-zero — one replica costs RAM 24/7). Load drives N.
- **C — zero-cost AND elastic:** KEDA (`deploy/40` pattern) with a connections
  trigger and `minReplicaCount: 0`. Documented upgrade path.

> Note: the RO gateway lane serves the Postgres wire but does **not** yet export
> its own Prometheus metrics port (the writer lane owns `:9090`). RO wake/latency
> metrics are a follow-up; the drill is the current source of truth.

## Vertical resize of the writer — in-place pod resize (issue #67)

Neon-cloud parity: grow/shrink the **running** writer's CPU/RAM without a
restart, using Kubernetes **in-place pod resize** (`--subresource resize`).
**Verdict: FEASIBLE on OKE — verified live on v1.33.10, 2026-07-04.** A CPU and a
memory resize both actuated on a running Postgres pod with `restartCount: 0` and
an unchanged `pg_postmaster_start_time()` (Postgres never bounced); the container
cgroup (`cpu.max`, `memory.max`) reflected the new values.

**Recipe (patch cpu and memory SEPARATELY):**

```sh
# the compute container declares resizePolicy (add to 20-compute.yaml to adopt):
#   resizePolicy:
#     - { resourceName: cpu,    restartPolicy: NotRequired }
#     - { resourceName: memory, restartPolicy: NotRequired }

# CPU up, live, no restart:
kubectl -n scale-zero-pg patch pod <compute-pod> --subresource resize \
  --patch '{"spec":{"containers":[{"name":"compute","resources":{"requests":{"cpu":"500m"},"limits":{"cpu":"1"}}}]}}'
# memory up, live, no restart:
kubectl -n scale-zero-pg patch pod <compute-pod> --subresource resize \
  --patch '{"spec":{"containers":[{"name":"compute","resources":{"requests":{"memory":"512Mi"},"limits":{"memory":"1Gi"}}}]}}'
# confirm actuation (NOT just the spec) + no restart:
kubectl -n scale-zero-pg get pod <compute-pod> \
  -o jsonpath='{.status.containerStatuses[0].resources} restarts={.status.containerStatuses[0].restartCount}{"\n"}'
```

**What resize CAN and CANNOT change without a restart:**

| Knob | Live-resizable? | Notes |
|---|---|---|
| CPU request/limit | **yes** | cgroup `cpu.max` updates; Postgres uses more cores immediately |
| Memory request/limit | **yes** | cgroup `memory.max` updates immediately |
| `shared_buffers` | **no** | fixed at boot — confirmed `show shared_buffers` unchanged after a memory resize. Growing it needs a compute restart (edit the spec in `54-compute-files.yaml`). |
| `work_mem`, `effective_cache_size`, etc. | yes (SQL) | runtime GUCs — `ALTER SYSTEM … ; SELECT pg_reload_conf();`, independent of the pod resize |

**Gotchas:**
- Combining cpu+memory+limits in a **single** `--type merge` patch returned
  `Forbidden: only cpu and memory resources are mutable` — patch **per resource**
  (default strategic merge) instead. That is the working recipe above.
- A resize the node can't fit is **deferred**, not failed:
  `PodResizePending: Deferred — Node didn't have enough resource: cpu`. The
  kubelet actuates it when capacity frees up. Check the `PodResizePending`
  condition before assuming success; size the request to node headroom.
- A metric-driven auto-resizer (the NeonVM analogue) is a future build — the
  mechanism above is the manual/scriptable primitive it would use.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Client: `compute unavailable` after ~2 min | Wake timed out. `kubectl -n scale-zero-pg describe pod -l app=compute` — image pull? Pending (resources)? `wait-timeline` init stuck (pageserver down or storage-init never ran)? |
| Compute crashloops with `TENANT_ID ... must set` | `compute-config` ConfigMap missing/edited — re-apply `54-compute-files.yaml`, re-run `55-storage-init.yaml`. |
| Compute Running but clients hang | Check pageserver/safekeeper pods; `kubectl logs deploy/compute -c compute` (look at `total_startup_ms` line — healthy is ~150ms). |
| DB never scales to zero | An app pool is holding idle connections (`pggw_active_connections` > 0), or a peer gateway is unreachable (peer check fails ⇒ sleep is postponed by design — see gateway logs "postponing sleep"). |
| First query after idle is slow | That's the wake (~2.5s). Only sub-second option today: keep it awake (`replicas: 1` + `GW_IDLE_MS=0`) or wait for the warm-standby pool (TASKS.md phase 3). |
| `password authentication failed` after redeploy | The spec reset the role password (by design). See rotation above. |
| Verify scripts fail on a fresh cluster | Order matters only the first time: storage pods Ready → `storage-init` Complete → everything else is self-healing. |

## Upgrades

- **Gateway**: build a new image, `rollout restart deploy/pggw` — zero client impact
  beyond dropped in-flight pipes (clients reconnect).

### Releasing an OCIR image — digest pinning (issue #56)

Our own images (`gateway`, and the `pswatcher`/`alertsink` binaries baked into the
same `ks-pg/gateway` repo) are **pinned by digest** in the manifests
(`tag@sha256:...`, `deploy/10-gateway.yaml`, `58-pswatcher.yaml`,
`61-alertmanager.yaml`). The tag is human provenance; the `@sha256` is what
Kubernetes actually pulls. This is enforced by `deploy/_validate.sh` (contract 22:
every `ks-pg/*` image must carry `@sha256`) and `deploy/_verify-drift.sh` (asserts
the **live** running `imageID` digest equals the manifest digest — so a
rebuilt-but-not-rolled or stale-tag binary can no longer pass drift-green).

**Release procedure — build → push → record digest → bump manifest → roll:**

```sh
REPO=me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway
TAG=v0.6.0                                   # bump per change
# 1. build + push by tag
docker build -t $REPO:$TAG gateway/ && docker push $REPO:$TAG
# 2. RECORD the digest OCIR assigned (do NOT trust the local build digest):
oci --profile DEFAULT artifacts container image list \
    --compartment-id <tenancy-ocid> --repository-name ks-pg/gateway \
    --query "data.items[?version=='$TAG'].digest" --raw-output
#    -> sha256:....  (or: docker inspect --format='{{index .RepoDigests 0}}' $REPO:$TAG)
# 3. bump the manifest image ref to  $REPO:$TAG@sha256:<that-digest>
#    (edit 10-gateway.yaml / 58-pswatcher.yaml / 61-alertmanager.yaml)
# 4. validate + apply + roll to the pinned digest:
sh deploy/_validate.sh                       # contract 22 must pass
kubectl -n scale-zero-pg apply -f deploy/10-gateway.yaml   # (and 58/61 as changed)
kubectl -n scale-zero-pg rollout status deploy/pggw
sh deploy/_verify-drift.sh                   # live imageID digest == manifest digest
```

Never ship a bare tag: it reopens the `merged ≠ deployed` class the digest pin
closes. If you rebuild the same tag, you **must** re-record and re-bump the digest.

### Kill-criteria tripwires — where each one lives (issue #14)

ADR-0002's six standing kill criteria are operationalized; none rely on a human
remembering to check:

| KC | Criterion | Tripwire (mechanical home) |
|---|---|---|
| 1 | Ops toil > ~1 eng-day/month | `docs/OPS-TOIL.md` running ledger; monthly sum is an on-release-gate checklist item |
| 2 | Wake edge regresses | `GatewayWakeLatencyHigh` alert (p50 gauge > 5s, live) + BENCHMARKS baselines re-measured by `_verify-wake.sh` each battery run. *Caveat:* a hard CI p99 gate needs the formal OKE cold/warm baseline (#9) — until then this criterion detects via alert + drill, not CI-fail |
| 3 | Version-pair treadmill | `_validate.sh` contract 12 (compute↔storage pair) + contract 22 (skctl `SK_COMPAT_NEON_TAG`) — both run in CI on every PR; `_rehearse-upgrade.sh` exit≠0 re-convenes the review trio |
| 4 | knext posture shifts | Trigger-gated review: any knext-side ADR/CRD change touching the DATABASE_URL contract re-convenes the trio (see the loop section in CLAUDE.md) |
| 5 | Justifying capability unused for a quarter | Dated tracked item: issue #65 (due 2026-10-03) |
| 6 | Reliability floor (read SPOF reached users) | Ruled CLEARED at iteration 4; guarded live by `PswatcherPrimaryDown` / `PswatcherPromotionFired` / `PswatcherDown` + the `Watchdog` dead-man's-switch behind them |

### Upgrading the storage plane — posture, triggers, and the rehearsal

**Posture (ADR-0002 amendment, issue #50): KS-PG owns `neon:8464`. Moving off it
is a deliberate PIVOT-CLASS event, not routine maintenance.** The plane is welded
to 8464 by a **triple pin**, every leg a fail-loud CI gate: the compute↔storage
**version pair**, the skctl **`safekeeper.control` v9 format weld**, and the
**`SK_COMPAT_NEON_TAG` compat constant** (see "skctl format coupling" below and
`deploy/_validate.sh`). A tag bump is not a chore because, *if* the on-disk
control format has bumped from v9, the upgrade requires re-reverse-engineering the
struct and rewriting `skctl.py` — exactly the Neon-internals work ADR-0002 **KC1**
says triggers pivot-to-managed. So an upgrade is a **decision to spend
pivot-class effort**, gated on KC1/KC3.

**Triggers that would force the decision open** (do not upgrade absent one):
- a **CVE / security fix** in `neon` or `compute-node-v17` with no 8464 backport
  — the one routine reason to accept the cost;
- a **needed capability** only a newer release ships. The one most worth taking:
  neon's first-class **safekeeper timeline-import / HTTP timeline-create API**
  (the `POST …/timeline/…` that 8464 404s) + a storage controller — adopting it
  **retires `skctl.py` entirely** and makes future upgrades routine again;
- **KC1/KC3/KC4** firing for their own reasons (ops toil, version-treadmill,
  knext posture change).

**Rehearse before deciding — `deploy/_rehearse-upgrade.sh`.** The drill boots the
newest pullable neon/compute pair in a throwaway `upgrade-drill` namespace from
the **real** `deploy/` manifests (only the image tag + namespace are rewritten),
runs storage-init, serves a read-write workload, then dumps the new safekeeper's
`safekeeper.control` and runs `skctl checkver` against it. It answers the only
question that decides pivot-vs-bump: **does the newer image still write a v9
control file?** It is fully isolated (touches nothing outside `upgrade-drill`) and
self-cleaning (deletes the namespace + PVCs on exit).

```
# rehearse the newest pair (default), or pin a tag:
KSPG_CONTEXT=context-ckmva7v7zvq deploy/_rehearse-upgrade.sh
KSPG_CONTEXT=context-ckmva7v7zvq deploy/_rehearse-upgrade.sh 8465
KEEP_DRILL=1 deploy/_rehearse-upgrade.sh   # leave the ns up to inspect
# exit 0 = control still v9 (upgrade = manifest bump); exit 3 = format diverged
# (upgrade = skctl rewrite / KC1 pivot); exit 1 = infra failure (inconclusive).
```

**What the first run found (2026-07-03).** Rehearsed tag **`17411840350`** — the
newest coherent `neondatabase/neon` + `compute-node-v17` pair on Docker Hub (a CI
build dated 2025-09-02, **newer than the pinned 8464**; the `8xxx` release series
tops out at 8464 for both repos, so the only images newer than 8464 today are the
run-ID-tagged CI builds). Findings, recorded honestly:
- **Storage plane booted clean** under the new tag — broker, pageserver, and
  safekeeper all reached Ready from the unmodified manifests. **No manifest/config
  breakage.** (One benign, pre-existing `kubectl` warning — "spec.SessionAffinity
  is ignored for headless services" on the safekeeper Service — is emitted under
  8464 too; not a regression.)
- **storage-init passed** — the pageserver's HTTP tenant/timeline-create contract
  is unchanged; our bootstrap Job still works.
- **Read-write workload served** — compute booted, a marker row was written and
  read back through the full walproposer→safekeeper→pageserver path.
- **THE PROBE: `safekeeper.control` is still `magic=0xcafeceef`, `format_version=9`.**
  `skctl checkver` accepted it. **⇒ An upgrade to `17411840350` would be a MANIFEST
  BUMP, not a re-RE project** — skctl's format weld survives, writable restore
  stays intact. The pivot-vs-bump cost is now a *known number* for the nearest
  newer image: **bump** (cheap), not **rewrite** (pivot-class).
- **Cost caveat:** the bleeding-edge image is multi-GB and the first pull onto each
  node took several minutes — a real (if one-time) upgrade cost. Cached runs are fast.

If a future run exits 3 (version ≠ 9), do **not** bump the tag: skctl must be
re-reverse-engineered against the new struct first, or better, adopt the
timeline-import API (see the trigger list above and "Upgrade carrot").

- **Compute ↔ storage are a version PAIR.** The compute (`compute-node-v17:8464`)
  and storage plane (`neon:8464`) are built from the same Neon release and must be
  upgraded together — the pageserver wire protocol and layer formats are internal
  interfaces with no cross-version guarantee. Supported pair today: **8464 + 8464**.
- **Upgrade procedure** (both images): bump both tags in `deploy/` on a throwaway
  cluster, run the full verify battery, then promote. Never `:latest` anywhere.
  The compute is stateless so its rollback is trivial; storage rollback is NOT
  (layer formats may migrate forward) — take an on-demand backup before a storage
  bump (`kubectl -n scale-zero-pg create job backup-now --from=cronjob/backup`; see
  "Backup & disaster recovery").
- **skctl format coupling — a THIRD version-coupled artifact.** `deploy/skctl.py`
  hand-writes the safekeeper's on-disk `safekeeper.control` struct (magic
  `0xcafeceef`, **format version 9**, CRC32C trailer) reverse-engineered from
  `neon:8464`. Writable restore (`deploy/_restore-writable.sh`) depends on it. The
  compute↔storage version-pair check cannot see this coupling, so it is guarded
  separately: `skctl.py` pins `SK_CONTROL_VERSION = 9` and `SK_COMPAT_NEON_TAG =
  "8464"`, `deploy/_validate.sh` fails CI if that tag ever drifts from the pinned
  `neon:` tag, and `deploy/test_skctl.py` (CI job `skctl`) proves the serializer
  round-trips a **real** neon:8464 control file byte-identically.
  **On any `neon:` tag bump you MUST re-validate this format** as part of the
  upgrade procedure, or writable restore will silently craft a structurally-wrong
  control file (a "successful" restore that is subtly corrupt):
  1. Dump a control file from a safekeeper running the **new** image:
     `kubectl exec safekeeper-0 -- cat /data/<tenant>/<timeline>/safekeeper.control > new.control`
     and confirm the version byte still reads 9 — quick check:
     `python3 deploy/skctl.py checkver --file new.control` (aborts loudly if not v9).
  2. Refresh the test fixture (`deploy/testdata/safekeeper.control.real`) with the
     new dump and run `python3 -m unittest discover -s deploy -p 'test_skctl.py'`.
     If the round-trip still passes, bump `SK_COMPAT_NEON_TAG` to the new tag.
  3. If the version is **not** 9 (or the round-trip fails), the on-disk struct
     changed: skctl must be re-reverse-engineered against the new format before the
     upgrade ships. Prefer adopting neon's first-class safekeeper timeline-import
     HTTP API (see "Upgrade carrot" above), which retires the hand-rolled serializer
     entirely.
