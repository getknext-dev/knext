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
| `GW_WAKE_BUDGET` | 0 (off) | per-app **wake** budget: burst 0→1 wakes an app may trigger, refilling over `GW_WAKE_WINDOW_MS`. `0`/unset = no budget (wake path unchanged). Excess wakes are refused `53400` **without scaling**. Deployed on `pggw-apps`: 15. See [Wake budget & wake side-channel (#116)](#wake-budget--wake-side-channel-issue-116). |
| `GW_WAKE_WINDOW_MS` | 60000 | refill window for `GW_WAKE_BUDGET` (a full budget refills over this window). |
| `GW_WAKE_RETRY_BASE_MS` | 200 | base exponential-backoff step (with jitter) for the **bounded idempotent retry** around the 0→1 scale call (issue #190). A **transient** apiserver blip (TLS handshake timeout, 5xx, throttle, `Conflict`, context deadline) is retried instead of failing the client's cold wake. `GetScale`→`UpdateScale` is idempotent so retry is safe. Total retry time is clamped to `GW_WAKE_TIMEOUT_MS` — a genuinely-down apiserver still fails **bounded** (no hang). A **terminal** error (`NotFound`/`Forbidden`/`Unauthorized`/…) fails loud immediately, no retry. Healthy wake is unchanged (retry fires only on error). See [Transient apiserver blips on the wake scale call (#190)](#transient-apiserver-blips-on-the-wake-scale-call-issue-190). |
| `GW_WAKE_MAX_ATTEMPTS` | 8 | belt-and-braces cap on total scale attempts (first try + retries) for the `#190` retry; the wake deadline (`GW_WAKE_TIMEOUT_MS`) is the real ceiling. |
| `GW_PEER_SELECTOR` | — | label selector for sibling gateways (peer-aware idle); empty disables |
| `GW_AUTH_FAIL_FLOOR_MS` | 250 | apps-gateway only: constant-floor delay on refusals so unknown-app and wrong-pair are timing-comparable (issue #92); `0` disables |
| `GW_ROLE_APPLY_SETTLE_MS` | 250 | apps-gateway (per-app) only: on a **genuine cold wake** hold the client this long before the auth attempt so `compute_ctl` applies the per-app role first, absorbing the cold-boot `28P01` role-apply race (issue #132). NOT an auth retry — a wrong password still fast-fails; warm connects + base single-DB path are never delayed; clamped to `GW_WAKE_TIMEOUT_MS`. `0` disables. **When the deterministic `/status` gate (below) is configured this is the bounded fallback**, used only if `/status` is unreachable/rejected. |
| `GW_STATUS_PORT` | 0 (off) | **opt-in DETERMINISTIC cold-boot gate (issue #174).** `compute_ctl` HTTP port (3080). When set (and a token is provided) the apps-gateway, on a genuine cold wake of a per-app front door, **polls `http://<compute>:<port>/status` until `compute_ctl` reports `running` (spec/role apply DONE)** instead of blindly sleeping `GW_ROLE_APPLY_SETTLE_MS` — race-free, and proceeds the instant the apply is provably complete. Bounded by `GW_WAKE_TIMEOUT_MS`. `0`/unset = gate disabled → the `#132` settle is used (default). **Enabling requires also exposing 3080 on the compute Service + NetworkPolicy — see [Cold-wake role-apply reliability](#cold-wake-role-apply-reliability).** |
| `GW_STATUS_TOKEN` / `GW_STATUS_TOKEN_FILE` | — | the `compute_ctl` JWT for `/status` (Bearer). `/status` is JWT-gated. `_FILE` (a mounted Secret path) is preferred so the JWT never lands in the pod env. **Required** for the gate — `GW_STATUS_PORT` without a token leaves the gate disabled. |
| `GW_STATUS_READY` | `running` | the `compute_ctl` `/status` value that means "spec applied / ready" |
| `GW_STATUS_POLL_MS` | 50 | poll interval between `/status` reads |
| `GW_STATUS_REQ_TIMEOUT_MS` | 1000 | per-request timeout for a single `/status` read (bounds a hung endpoint) |
| `GW_STATUS_TIMEOUT_MS` | 0 (full wake budget) | cap on the deterministic poll before falling back to the bounded settle; `0` = use the whole `GW_WAKE_TIMEOUT_MS`. Set smaller (e.g. `2000`) so a misconfigured/unreachable `/status` degrades to the settle quickly. Never extends past `GW_WAKE_TIMEOUT_MS`. |
| `GW_POD_NAMESPACE` / `GW_POD_IP` | — | downward API; self-exclusion for the peer check |
| `GW_TLS_CERT_FILE` / `GW_TLS_KEY_FILE` | — | front-door TLS keypair (PEM paths). Both set + loadable → gateway answers `SSLRequest` with `S` and wraps the wire (TLS 1.2+). Set-but-unloadable or half-set → gateway **fails fast at startup**. Unset → `SSLRequest` gets `N` (plaintext only). Deployed: mounted from Secret `pggw-tls` at `/etc/pggw-tls/`. |
| `GW_APP_ROLE_PREFIX` / `GW_REPL_ROLE_PREFIX` | `app_` / `repl_` | `template` mode: the per-app auth role (`app_<db>`, ordinary tenant traffic) and per-zone REPLICATION role (`repl_<db>`, walreceiver) prefixes. **They MUST differ** — equal prefixes merge the two roles into one name so a replication credential could satisfy an ordinary connection (and vice versa), collapsing app/repl separation. An equal-prefix misconfig **fails fast at startup** (mirrors the TLS half-config guard). Defaults are safe. |

Every `GW_*` var passes through verbatim — there is deliberately no whitelist.

## Monitoring

Scrape each gateway pod's `:9090/metrics` (Prometheus text) or read `/metrics.json`:

| Metric | Meaning |
|---|---|
| `pggw_wakes_total` / `pggw_wake_failures_total` | cold starts triggered / failed |
| `pggw_wake_retries_total` | transient scale-call blips **retried** and absorbed (issue #190). Rising while `pggw_wake_failures_total` stays flat = retries are silently rescuing wakes the old path would have failed (*retried-then-succeeded*). Rising **together with** `pggw_wake_failures_total` = a sustained apiserver outage — retries are exhausting (*failed-after-retries*). Each retry also logs `transient wake scale error (attempt N), retrying within wake budget`. |
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
| `JanitorConfigDisarmed` (crit) | a **wal-janitor / repl-slot-monitor / apps-wal-monitor / backup** pod is stuck in `CreateContainerConfigError` (or an image-pull fault) for 2m | The **janitor is DISARMED**: a janitor-critical ConfigMap/Secret is missing (e.g. `storage-objstore` deleted as drill residue), so the pod's container **never starts** → no Failed Job → `WalJanitorJobFailed`/`ReplicationSlot*`/`SafekeeperWALGrowth` all stay silent and `/safekeeper` WAL accumulates toward node **DiskPressure** (the 2026-07-06 incident). This pages the **same cycle**, not 26h later via `WalJanitorStale`. `kubectl -n scale-zero-pg describe pod {{pod}}` names the missing config; re-derive `storage-objstore` via `deploy/gen-secrets.sh`. Covers the nightly janitor **and** the zone repl-slot monitors (#142). |
| `Watchdog` (none) | **always firing by design** | The alerting stack's **dead-man's-switch** (#60). You should **never** be paged by this rule directly — it is routed to an *external* heartbeat monitor. If that **external** monitor pages you, Prometheus or Alertmanager itself is down. See [dead-man's-switch](#dead-mans-switch-external-heartbeat-60). |
| `KubeStateMetricsDown` (crit) | `up{job=kube-state-metrics}==0` or absent for 2m | **Sev-1.** KSM (`deploy/59`) is the sole producer for `BackupJobFailed`, `WalJanitorJobFailed`, `BackupStale`, `WalJanitorStale`, `SafekeeperWALGrowth`, `ReplicationSlotWALGrowth`, `ReplicationSlotInactive`, `PageserverStandbyNotReady`, `ComputeWakeStuck`, `ComputeWakeStuckApps`, `ComputeRoPoolStuck`, `ComputeStuckNotReady` — while it is down **all of them are blind**. Restore KSM before trusting any platform alert. (#48) |
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
| `ReplicationSlotWALGrowth` (**warn**) | a Job owned by the **repl-slot-wal-monitor** CronJob failed: a cross-zone logical replication slot on an awake publisher is retaining WAL past **75%** of the `max_slot_wal_keep_size` bound (512MB), or was already **invalidated** by it (`wal_status=lost`) | **Not the primary pager** — the bound is the hard backstop. A subscriber is falling behind or a slot is leaking; past the bound Postgres invalidates the slot and the subscriber must **re-sync** (drop+recreate subscription with `copy_data`) — the designed **degrade-to-re-sync, never plane-fill**. Read the Job log for the offending slot; if it is a live subscriber, wake/heal it; if leaked, drop the slot. Dormant until the monitors are deployed and a slot exists (#139). See [Zoned-replication slot monitoring](#zoned-replication-slot-monitoring-adr-0007). |
| `ReplicationSlotInactive` (**warn**) | a Job owned by the **repl-slot-inactive-monitor** CronJob failed: a replication slot has been **inactive >24h** | Very likely a **leaked** slot from a dead/deprovisioned cross-zone subscriber, still pinning publisher WAL toward the bound. Drop it (`SELECT pg_drop_replication_slot('<slot>')` on the publisher) or run the Zone deprovision hygiene (ADR-0007 §4d). A briefly-sleeping subscriber is short and expected — 24h means abandoned. Dormant until deployed + a slot exists (#139). See [Zoned-replication slot monitoring](#zoned-replication-slot-monitoring-adr-0007). |
| `ZoneDegradedOrFailed` (**crit**) | a Job owned by the **zone-phase-monitor** CronJob failed: a Zone CR is `phase=Failed` (invalid spec) or `phase=Degraded` (a dependency the operator could not wire, or a slot invalidated → awaiting re-sync) | **Pages** — a cross-zone data dependency is not delivering. `kubectl -n scale-zero-pg get zone -o wide` finds the phase; `kubectl get zone <z> -o yaml` → `.status.message` + `.status.conditions` say why. Failed = fix the spec (terminal until corrected); Degraded = see the subscription state below. Dormant until the monitor is deployed and a Zone breaks (ADR-0007). See [Zone alerts & re-sync runbook](#zone-alerts--re-sync-runbook). |
| `ZoneSubscriptionBroken` (**crit**) | a Job owned by the **zone-subscription-monitor** CronJob failed: a `dataDependency` subscription is `state=error` / `denied` / `needs_resync` | **Pages.** `error` = a wiring failure (read the Job log + `.status.subscriptions[].message`). `denied` = **governance** — the peer does not `publish` a requested table; declare it in the peer's `spec.publishes` to grant. `needs_resync` = the peer slot was **invalidated** (`wal_status=lost`); the local copy is stale — the operator **auto re-syncs** (DROP+CREATE SUBSCRIPTION `copy_data`) unless `ZONE_AUTO_RESYNC=false`, in which case run the manual re-sync below. Dormant until deployed + a Zone breaks. See [Zone alerts & re-sync runbook](#zone-alerts--re-sync-runbook). |

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

**Target-cluster identity guard — no false-green (issue #157).** Before *any* check,
`_verify-drift.sh` now asserts it is pointed at the **OKE plane** and `exit 1`s loudly
otherwise. This closes a *meta* merged≠deployed: the gate ran against kubectl's
**current-context** with no identity check, and an operator-machine kubectl wrapper
**self-resets current-context to local orbstack** — so the whole drill could run fully
GREEN against the WRONG cluster (orbstack/kind) while the real OKE plane drifted. The
guard (a) fast-rejects well-known local contexts (`orbstack`, `kind-*`, `docker-desktop`,
`minikube`, …); (b) asserts a **positive OKE fingerprint** — the OCI CRD
`nodeoperationrules.oci.oraclecloud.com` or a known OKE node (`10.0.1.253`/`10.0.1.78`) —
which survives a *renamed* / self-reset context that a name check alone would miss; and
(c) accepts an explicit **`--context <ctx>`** (or `DRIFT_CONTEXT`) for CI vs interactive,
plus an optional **`EXPECTED_CLUSTER`** hard-pin (current-context must equal it). If none
of the OKE signals resolve, the gate refuses to run rather than false-green.

**Drift drill — "exists" vs "healthy" (issues #27/#51).** `sh deploy/_verify-drift.sh`
asserts every Deployment/StatefulSet/CronJob declared in `deploy/NN-*.yaml` is not just
**present** on the cluster (closing merged≠deployed) but **healthy**: for
Deployments/StatefulSets `readyReplicas == spec.replicas` (which correctly accepts the
scale-to-zero compute — `0 ready == 0 desired`), and CronJobs are **not suspended**.
Existence-only was blind to a deployed-yet-CrashLoopBackOff workload — e.g. a
crash-looping kube-state-metrics would have passed "exists" while blinding five platform
alerts. Now a 0-ready or suspended load-bearing workload fails the drill.

The same gate also checks two subtler flavors of merged≠deployed:

- **Image-digest provenance (issues #56/#153).** Every running `ks-pg/*` container must
  be executing a digest the manifests pin (`tag@sha256:…`) — not just a matching *tag*.
  The check matches the pinned digest against **either** the reference the kubelet
  actually pulled (`.status.image`) **or** the recorded `imageID`. Both are checked
  because an image pushed as an **OCI image index** (docker buildx attestations/provenance
  — the `appdb-operator` build is one) reports its `imageID` as the *selected child's
  config digest*, a different `sha256` than the index/manifest digest the manifest pins.
  An `imageID`-only comparison false-fired `DIGESTDRIFT` on such a pod even though it was
  running exactly the pinned reference (verified 2026-07-07 with a forced `Always` pull).
  A genuinely drifted pod — a bare tag, or unpinned content — still matches neither and
  trips. **Do not "reconcile" that by pinning the `imageID`:** a config digest is not a
  pullable manifest reference.

- **Prometheus rules LOADED, not merely applied (issue #155).** A rule can be merged into
  `deploy/60-prometheus.yaml`, applied to the `prometheus-config` ConfigMap, and even
  present on the pod's mounted `rules.yml`, yet **never loaded** by the running Prometheus
  — ConfigMap volume updates do **not** trigger a reload, so the rule stays *dark* until a
  pod roll or a manual `POST /-/reload` (this bit the 2026-07-06 zone alerts). The gate
  now queries the live Prometheus (`/api/v1/rules`) and fails if **any** alert rule shipped
  in `deploy/60` is not loaded. It is backed by an **auto-reload** mechanism: the
  Prometheus Deployment pod template carries a `ks-pg.dev/prometheus-config-sha256`
  annotation whose value is the sha256 of the ConfigMap data. Editing a rule changes the
  hash, which changes the pod template, so `kubectl apply` **rolls the (Recreate) pod** and
  the new pod loads the fresh rules at boot — no manual `/-/reload` needed. **After any
  edit to the ConfigMap rules/scrape config, regenerate the annotation:**
  `./deploy/_validate.sh prom-config-hash` (prints the value to paste). `_validate.sh`
  contract 27 fails CI if the annotation drifts from the ConfigMap, guaranteeing the roll
  is never forgotten.

- **compute-files SCRAM content, LIVE (issues #160/#162).** §F asserts the shared
  `compute-files` ConfigMap on the cluster carries the md5→SCRAM migration verbatim:
  `config.json`'s `password_encryption=scram-sha-256`, the pg_hba catch-all rewrite to
  `scram-sha-256`, and the `APP_ROLE_VERIFIER` spec-role injection. *Note:* the pg_hba
  rewrite (`harden_pg_hba`) was factored out of `entrypoint.sh` into the sourced
  **`lib-harden.sh`** by the #164/#167 RO/warm-parity refactor, so §F now reads
  `lib-harden.sh` too — before this it false-fired `pg_hba-catch-all-not-scram` on a live
  cluster that was actually correct (the rewrite had simply moved keys).

- **Per-app DURABLE SCRAM verifiers — opt-in `--deep` (issue #162).** §F proves the shared
  ConfigMap is SCRAM, but it **cannot** prove a given app's *durable catalog* verifier
  (`pg_authid.rolpassword`) is SCRAM — a SCRAM verifier can't be re-derived from a manifest
  without the app's plaintext, so it must be **read off a live compute**. A half-migrated
  app (SCRAM pg_hba live, but its own verifier still md5) **cold-wake-rejects on the wire**
  (the #160 atomic-rollout hazard). Because this needs a compute **wake**, it is opt-in:
  `sh deploy/_verify-drift.sh --deep` (or `DRIFT_DEEP=1`) wakes a **bounded sample** of
  per-app computes (default 2, `DRIFT_SAMPLE` overrides; the reserved `tmpl` template is
  excluded) and asserts each app role's `pg_authid.rolpassword` begins `SCRAM-SHA-256`,
  restoring each compute to its prior replica count afterward. A verifier beginning `md5`
  fails as `PERAPPSCRAMDRIFT` — catching the half-migrated app **before** a visitor's cold
  wake does. Run it after any SCRAM rollout / new-app onboarding batch.

## Object-storage backend (#105)

The storage plane's durable truth is an **S3 object store** (pageserver layer
uploads under `/pageserver`, safekeeper WAL offload under `/safekeeper`). That
store is **configurable** — it is NOT hardcoded to bundled MinIO. See
[ADR-0005](adr-0005-object-storage-backend.md) for the posture.

**How it is wired.** The pageserver (53), standby pageserver (57), and
safekeepers (52) read `{endpoint, bucket, region}` from the `storage-objstore`
ConfigMap and their S3 access/secret from the `storage-s3-creds` Secret. Both are
created by `deploy/gen-secrets.sh` (which must run before `kubectl apply`, same as
today). The pageserver's `remote_storage` TOML line is appended by its seed-config
init container from those env vars; the safekeeper builds `--remote-storage`
inline the same way. **Path-style + SigV4 are automatic** — neon forces path-style
addressing whenever a custom `endpoint` is set, which is what makes both MinIO and
OCI's S3 Compatibility API work with no extra flag.

**Default (local/dev): in-cluster MinIO.** `gen-secrets.sh` with no override
points `storage-objstore` at `http://minio:9000` / bucket `neon`. `50-minio.yaml`
is the optional local default — **digest-pinned** to the archived last-good build
(MinIO archived its community repos), and it no longer creates the bucket
(`55-storage-init`'s `ensure-bucket` initContainer does, against whatever endpoint
is configured).

**External backend (managed cloud S3, or on-prem SeaweedFS / Ceph RADOS Gateway /
Garage).** Point `storage-objstore` at it and **do not apply `50-minio.yaml`**:

```sh
# example: OCI Object Storage S3 Compatibility API. Mint a Customer Secret Key
# (SigV4 access/secret) for the api-key user (same kind of credential as #4's
# backup target), then:
STORAGE_OBJSTORE_ENDPOINT=https://<ns>.compat.objectstorage.<region>.oraclecloud.com \
STORAGE_OBJSTORE_BUCKET=ks-pg-pages STORAGE_OBJSTORE_REGION=me-abudhabi-1 \
STORAGE_S3_USER=<access-key> STORAGE_S3_PASSWORD=<secret-key> \
  sh deploy/gen-secrets.sh
# apply everything EXCEPT the in-cluster MinIO (documented apply-set):
ls deploy/[0-9][0-9]-*.yaml | grep -v '50-minio.yaml' | xargs -I{} kubectl apply -f {}
```

`.oci.customer-oci.com` and `.oraclecloud.com` endpoint variants both work; the
region is the OCI region. The bucket must be reachable — `ensure-bucket` creates
it with `mc mb --ignore-existing`, but a managed S3 that denies `CreateBucket`
requires you to pre-create it (`oci os bucket create ...`).

**Re-pointing an existing plane** is deliberate (no silent rotation): delete the
ConfigMap and re-run gen-secrets — `kubectl -n scale-zero-pg delete configmap
storage-objstore`, then `STORAGE_OBJSTORE_* … sh deploy/gen-secrets.sh`. Do this
only during a planned migration; the pageserver/safekeepers must be restarted to
pick up a new target, and moving object stores under a live plane means copying
the `/pageserver` + `/safekeeper` data across first.

**Verify it** — `deploy/_verify-objstore.sh` stands up a throwaway plane against a
configured endpoint (external OCI OS with no MinIO, or the MinIO baseline), proves
pages offload and are read back after a full pageserver cache wipe, and prints the
offload + read-back timings. Numbers: [BENCHMARKS.md](BENCHMARKS.md).

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

The durable truth is the **live object-store bucket** — the configured
`storage-objstore` backend (MinIO by default, any external S3 when re-pointed; see
"Object-storage backend" above): **pageserver layer uploads** (`/pageserver`) +
**safekeeper WAL offload** (`/safekeeper`) — plus the config the bucket alone
cannot rebuild: the `compute-config` / `compute-files` / `pageserver-config`
ConfigMaps (fixed tenant/timeline IDs, compute spec) and the `storage-s3-creds`
Secret. The pageserver PVC is a rebuildable cache; safekeeper PVCs hold only recent
WAL. So **a faithful backup = a copy of the bucket + the config**, and **a faithful
restore = a fresh storage plane attached to a restored bucket copy**.

### How it runs

- **`CronJob/backup`** (daily 03:00) mirrors the live object-store bucket
  **off-cluster to OCI Object Storage** over its native S3-compatible endpoint
  (pinned `minio/mc`, signature v4, path-style), and dumps the ConfigMaps + Secret
  alongside it under the destination bucket's `neon/` and `neon-config/` prefixes.
  The config dump runs in an initContainer on a pinned kubectl image under a
  **scoped ServiceAccount** (`backup-operator`: `get`/`list` on **configmaps only**
  in `scale-zero-pg` — **not secrets**, issue #28).
- **Portable source, off-cluster destination (issue #120).** The mirror's `src` is
  the **live object store** — its endpoint/bucket come from the `storage-objstore`
  ConfigMap (the same backend the pageserver + safekeepers offload to, #105/ADR-0005),
  authenticated with `storage-s3-creds`; the `dst` is the OFF-CLUSTER backup target,
  a **separate least-privilege** `backup-s3-target` Secret. Before v1.0.1 `src` was
  **hardcoded** to `http://minio:9000`, so a deployment running the live store on an
  external S3 (OCI/Ceph/SeaweedFS/Garage) had **no backup** and its safekeeper WAL
  leaked (the wal-janitor pruned a store that wasn't there). Both the backup Job and
  the wal-janitor now resolve `src` from `storage-objstore` — so **the ConfigMap is a
  prerequisite for the backup path** (created by `gen-secrets.sh`, MinIO-valued by
  default). Proof on a real non-MinIO endpoint: `deploy/_verify-backup-portability.sh`.
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

### Zoned-replication slot monitoring (ADR-0007)

**Only relevant once the zone axis (ADR-0007) is in use.** Cross-zone logical
replication grows a **replication slot per subscriber** on the publisher's compute.
A slot pins the publisher's WAL from its `restart_lsn` forward — and on this
`neon:8464` build the two guards you'd reach for are missing: `max_slot_wal_keep_size`
defaulted to **-1 (unbounded)** and `idle_replication_slot_timeout` **does not exist**
(spike #133). So an **inactive** slot (a sleeping or dead subscriber) would pin
publisher WAL **forever** — a slow ENOSPC that wedges the shared **2Gi** safekeeper PVs,
invisible to the (slot-unaware) `wal-janitor`. Three mechanisms close this (#139):

**1. The hard backstop — bounded WAL retention.** `deploy/compute-files/config.json`
sets `max_slot_wal_keep_size = 512MB`. Past that cap Postgres **invalidates** the slot
(`wal_status=lost`) and the subscriber must **re-sync** from a fresh snapshot
(`DROP SUBSCRIPTION` + recreate `WITH (copy_data = true)`). This turns the failure mode
from an **unbounded pin → plane-fill** into a **bounded degrade → re-sync**:
bounded-and-recoverable, never catastrophic — *"degrade to re-sync, never plane-fill."*

> **The 512MB trade-off.** Larger = more tolerance for a lagging/sleeping subscriber
> before a forced re-sync; smaller = tighter safety for the shared plane. 512MB is
> ~1.7M spike-rows of backlog headroom yet only 25% of a 2Gi safekeeper PV, so even
> several leaked slots degrade to re-sync well before ENOSPC. It is a single operator
> knob — lower it on a constrained plane. The alert warns at **75%** of it.

**2. The early warning — slot-aware monitors.** `deploy/63-repl-slot-monitor.yaml` ships
two CronJobs (the same *fail-the-Job → Prometheus alert via `kube_job_owner`* pattern as
`apps-wal-monitor`, #90). They `kubectl exec` psql into every **awake writer** compute
(a slot only accrues WAL while its publisher is awake) and read `pg_replication_slots`:

- **`repl-slot-wal-monitor`** (hourly) fails → **`ReplicationSlotWALGrowth`** when a slot
  is retaining WAL past **75%** of the bound, or was already invalidated by it.
- **`repl-slot-inactive-monitor`** (every 3h) fails → **`ReplicationSlotInactive`** when a
  slot has been inactive **>24h** — a **leaked** slot from a dead/deprovisioned subscriber.

Both are **warning** (the bound is the hard backstop) and **dormant** until deployed *and*
a slot exists, so shipping them always-on is free.

**3. Janitor awareness — never break live replication.** The `wal-janitor` (`deploy/62`)
gains a `resolve-slot-floors` initContainer (under a scoped `wal-janitor` ServiceAccount
that can `exec` computes). It reads `pg_replication_slots` on every awake writer and:

- **ACTIVE slot** → writes a **floor** at its `restart_lsn`. The prune step takes the
  **older** of the rcl horizon and the slot floor, so it **never** prunes WAL a live
  subscriber still needs. An active slot means a live walsender, which means the
  publisher is awake and readable — so this floor is always determinable.
- **INACTIVE slot** → **surfaced (WARN) only**, no floor: its far-behind WAL is
  reclaimable (the janitor's normal `rcl − KEEP_SEGMENTS` prune degrades it to a re-sync),
  bounded by `max_slot_wal_keep_size`. This is the *"surface + optionally reclaim inactive"*
  half of the requirement.
- **awake compute, Postgres unreadable** → the timeline is **PROTECT-skipped** that run
  (fail-safe: never risk a live slot's WAL). Transient and safe (the WAL bound still backs
  it); the next run reclaims once the compute is readable.
- **awake compute, ConfigMap unreadable** (can't even map `TENANT_ID`/`TIMELINE_ID` — the
  #142 CM-deletion hazard, #144) → **fail-safe on an unreadable compute config.** We cannot
  scope a per-timeline PROTECT because we don't know *which* timeline's active-slot WAL is at
  risk, so `resolve-slot-floors` writes a **global** marker (`/state/protect/.unmapped-compute`,
  recording the offending pod/cm) and the prune step **skips ALL pruning that pass** (prunes
  nothing) and **fails loud** → the existing **`WalJanitorJobFailed`** page fires. Restore the
  missing/corrupt compute ConfigMap (`kubectl -n scale-zero-pg get cm`; re-provision via
  `provision-app.sh` / the AppDatabase operator), then the next run resumes normal pruning.
  The marker is **per-pass** (it lives in the janitor Job's `emptyDir` `/state`, so it
  self-clears every run) — a one-time unreadable blip never sticks: once the CM is readable
  again the next Job writes no marker and pruning resumes automatically. This composes with
  **#142**, which detects the missing CM and pages on the *disarm*; #144 guarantees no WAL is
  mis-pruned while it is missing.
  This is deliberately **fail-CLOSED**: a persistently-unmappable awake writer halts WAL
  reclamation (WAL accrues until fixed) rather than risk pruning around a live writer we
  can't see. Before #144 this case silently pruned around the unmappable compute — a narrow
  fail-open backstopped only by the `KEEP_SEGMENTS=32=512MiB == max_slot_wal_keep_size=512MB`
  numeric alignment.

On today's **slot-free** plane the pass finds nothing and the janitor behaves **identically**
— zero regression to the load-bearing prune; the slot-awareness only activates when zones
create slots.

**Prove it before relying on it.** `deploy/_verify-slot-janitor.sh` stands up a throwaway
publisher+subscriber, wires real logical replication, and proves on the live plane:
(1) **BOUND** — WAL past the cap **invalidates** the slot (`wal_status=lost`), retention is
**bounded** and the safekeeper PV does not fill, then a re-sync recovers; (2) **ALERT** —
the monitors **fail their Job** on the growing/leaked slot (the alerts fire); (3)
**ACTIVE-NOT-PRUNED** — with an active slot deliberately behind, the janitor **floors** at
its `restart_lsn` and the subscriber then catches up with a **matching checksum** (live
replication intact); (4) **UNMAPPABLE-FAILS-SAFE** (#144) — with an awake compute's
ConfigMap made unreadable, `resolve-slot-floors` writes the global `.unmapped-compute` marker
and the prune Job **fails loud without pruning** (fail-closed), and the healthy readable
case in the same run still floors correctly. It only touches its own `slotpub`/`slotsub`
branches and tears them down. `deploy/_verify-janitor-protect.sh` is a fast **offline**
(no-cluster) contract test of the same fail-safe wiring for CI.

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

## Password authentication: SCRAM-SHA-256 (issue #117)

Per-app roles (`app_<app>`) and cross-zone replication roles (`repl_<zone>`)
authenticate over the wire with **SCRAM-SHA-256**, not md5. The migration is
deliberately built so **no tenant plaintext ever lands on the compute**:

- **App roles** — `provision-app.sh` (and the AppDatabase operator) precompute a
  **SCRAM-SHA-256 verifier** from the app password (PBKDF2-HMAC-SHA256, 4096 iters,
  random per-role salt — Python `hashlib.pbkdf2_hmac` / Go stdlib `crypto/pbkdf2`)
  and store it in the app Secret as `APP_ROLE_VERIFIER`. The compute spec injects it
  verbatim as the role's `encrypted_password` (`compute_ctl` stores a recognised
  `SCRAM-SHA-256$…` verifier as-is; only a bare md5-hex value gets the `md5` prefix),
  so the role is SCRAM **from boot** and the compute only ever sees the
  non-reversible verifier — never the password.
- **Repl roles** — the zone operator sets them via loopback SQL under
  `password_encryption=scram-sha-256` (they need the `REPLICATION` attribute the
  spec-role format lacks); the plaintext reaches `psql` only over the pod-local
  `exec` stdin, never argv/env.
- **Wire enforcement** — the entrypoint rewrites the pg_hba network catch-all from
  `md5` to `scram-sha-256` (a role still carrying an md5 verifier, or an md5-only
  client, is refused), while preserving the #112 `cloud_admin` loopback-only reject.
- **`DATABASE_URL` is unchanged** — libpq negotiates SCRAM transparently from the
  same plaintext password in the DSN; apps need no change.

> **All three compute tiers enforce the same pg_hba harden (issue #164).** The
> harden (cloud_admin loopback-only reject #112 + md5→scram-sha-256 catch-all rewrite
> #117) is a **single shared snippet**, `deploy/compute-files/lib-harden.sh`, sourced by
> **all three** entrypoints — `entrypoint.sh` (primary / per-app writer),
> `entrypoint-ro.sh` (read-replica pool), and `entrypoint-warm.sh` (warm tier) — so it
> can never drift between tiers. Each entrypoint calls it **gated on `APP_ROLE`**,
> identically: a **per-app** compute (writer, RO replica, or warm — `APP_ROLE` set via
> `compute-config-<app>`) hardens, so `cloud_admin` is rejected over TCP and only
> SCRAM app roles authenticate on the wire. On a **per-app RO replica** this Just Works
> because the app role's SCRAM verifier is **replicated from the primary catalog**
> (same timeline, streamed via WAL) — the durable verifier is already SCRAM, so
> `DATABASE_URL_RO` reads negotiate SCRAM with no regression. The **base single-DB
> tiers** (`compute` / `compute-ro` / `compute-warm`, no `APP_ROLE`) deliberately skip
> the harden: there `cloud_admin` **is** the documented TCP credential the client
> presents through the gateway (`DATABASE_URL` / `DATABASE_URL_RO`), so it must stay
> TCP-reachable — but it now carries a **strong generated md5** (Secret `pg-base-admin`,
> injected as a **required** env into `deploy/20/25/26`), so the **public default**
> `cloud_admin:cloud_admin` is **rejected over TCP** on the base tier too (issue #168 —
> see "Base-tier cloud_admin" below). Additional defense: NetworkPolicy + operator
> posture (see "Network isolation caveat").
> Before #164 the RO/warm entrypoints lacked the harden entirely (a p2 defense-in-depth
> + consistency gap — the strong `cloud_admin` Secret password from #115 still held the
> line, so the trivial #112 bypass did not reproduce). Drilled by
> `_verify-perapp-ro.sh` (compute-ro-`<app>` pg_hba carries the cloud_admin reject +
> scram catch-all; cloud_admin rejected over TCP; app role authenticates SCRAM) and
> `_verify-warmtier.sh` (shared harden mounted + sourced by the live warm entrypoint;
> base warm correctly un-hardened so the `cloud_admin` `WARM_DSN` path is preserved).

#### Base-tier `cloud_admin` — strong credential, never the public default (issue #168)

The base single-DB tiers (`compute` / `compute-ro` / `compute-warm`, fronted by
`pggw`) run `cloud_admin` as the **documented `DATABASE_URL[_RO]` credential over
TCP**. They set no `APP_ROLE`, so the pg_hba harden is deliberately skipped
(`cloud_admin` MUST stay TCP-reachable — it *is* the app credential) and they cannot
use the per-app loopback-only reject. In a **pure** single-DB cluster that is fine
(one tenant; `cloud_admin` is not a cross-tenant boundary). But when the base tier is
**co-resident with the multi-tenant plane** on a CNI without NetworkPolicy (flannel),
shipping the literal public default `cloud_admin:cloud_admin` would let any in-cluster
pod wake `pggw → compute` (or direct-dial `compute:55433` after a wake) and become
**superuser on the base DB** (the #112 vector on the base tier; blast radius = the base
DB's own data, not the multi-tenant apps).

**Fix.** `deploy/gen-secrets.sh` mints Secret **`pg-base-admin`** carrying a strong
random `cloud_admin` credential — `password` (a strong plaintext) and
`CLOUD_ADMIN_MD5` = `md5(password‖"cloud_admin")`. The base compute manifests
(`deploy/20/25/26`) mount `CLOUD_ADMIN_MD5` as a **required** env (no `optional: true`),
so a base compute **fails closed** — it cannot boot on the public default. The same
run derives the base **`DATABASE_URL[_RO]`** Secret (`myapp-database`) from
`pg-base-admin.password`, so the app credential and the compute's stored md5 always
match. Result: `cloud_admin:cloud_admin` is **rejected over TCP** on every base tier;
the strong `DATABASE_URL[_RO]` path wakes and serves unchanged. `deploy/30` is now
doc-only (it no longer ships the literal default). Proven live by
`_verify-base-admin.sh`. This is defense-in-depth and does **not** depend on #118
(NetworkPolicy would also block the direct dial).

> **Drill client image + password-override notes (issues #171/#172).** The
> `_verify-*.sh` suite's throwaway psql **client** pods now run a small,
> always-pullable psql image (`postgres:17-alpine`, override with
> `PSQL_IMG=...`) under a normal pull policy, so they schedule on **any** node —
> the neon compute image is pre-pulled on only some nodes, so the old
> `imagePullPolicy=Never` client pods intermittently hit `ErrImageNeverPull`
> (a stray failure that could masquerade as a wake failure or, on a reject
> probe, silently pass). The real compute/storage **server** pods some drills
> stand up still use the pinned neon image (they must). Auth/reject probes
> pre-warm the target compute (via a real strong-credential connection) **before**
> the reject, **sequentially** — the base plane has room for one compute tier at a
> time. If you override `PG_BASE_ADMIN_PASSWORD` (base `cloud_admin`), keep it
> URL-safe or **URL-encode any `@`** in the resulting `DATABASE_URL`: the drills
> now parse the DSN credential robustly (greedy to the last `@`), but an
> unencoded `@` still makes the DSN itself ambiguous for libpq. The generated
> hex/alnum default needs no encoding.

> **Rotating base `cloud_admin` (a COORDINATED change for a CONSUMED single-DB app).**
> `pg-base-admin` is **no-silent-rotation** (re-running `gen-secrets.sh` reuses the
> existing password and reconciles `myapp-database` to match — idempotent). To
> deliberately rotate, ORDER MATTERS because the app's `DATABASE_URL` copy and the
> compute's stored md5 must move in lock-step:
>
> 1. `kubectl -n scale-zero-pg delete secret pg-base-admin` then re-run
>    `sh deploy/gen-secrets.sh` (mints a fresh password + md5, reconciles
>    `myapp-database`).
> 2. `kubectl apply -f deploy/20-compute.yaml -f deploy/25-compute-warm.yaml -f
>    deploy/26-compute-ro.yaml` (Secret-first is already done; the computes pick up the
>    new md5 on their **next wake** — a compute at 0/0 changes nothing until then).
> 3. Copy the new `DATABASE_URL[_RO]` from `myapp-database` into **every consuming
>    app's namespace** (the `NextApp.spec.secrets.envMap` target) and roll the apps.
> 4. Force a fresh wake and run `sh deploy/_verify-base-admin.sh`.
>
> If you rotate the compute md5 (steps 1–2) **before** updating the app's
> `DATABASE_URL` copy (step 3), that app authenticates with the OLD password against
> the NEW md5 → auth failure on its next cold connect. On **this** cluster the base
> tier is unconsumed, so the rollout has no app-facing outage; on a **consumed**
> single-DB deployment, do steps 3–4 in the same change window.

> **Known limitation — cold-wake md5 window (compute_ctl, issue #158).** `compute_ctl`
> opens the Postgres network socket (~T=.90) **before** it applies the spec roles
> (~T=.99) — a ~tens-of-ms window on a **cold wake only**. During it the socket
> serves the **boot-time durable** verifier under the still-`md5` pg_hba. For a
> **newly provisioned** app the durable verifier is SCRAM, so the window serves SCRAM
> (md5 is never offered). For an **existing app migrated from the md5 era**, whose
> durable verifier is still md5, that first post-cold-wake connection can authenticate
> via **md5** until `apply_config` lands the SCRAM verifier a few ms later; every warm
> / steady-state connection is SCRAM. This is a `compute_ctl` architectural property
> (the OSS `ComputeSpec` exposes no boot-time pg_hba field, and we do not patch the
> reused Neon binary — hard rule 5). It is a hash **downgrade**, not an auth bypass
> (the md5 verifier is for the *same* password; the attacker still needs it), bounded
> like the #112 window. Tracked in #158.

#### Accepted residual: md5 cold-wake downgrade window (#158)

**Decision: ACCEPT & document (2026-07-12).** This is an OWNED accepted risk, not a
future "discovery." Both advisors (architect + system-designer, forward assessment)
ruled the severity genuinely **LOW** and recommended accept-and-document over a patch:
we do **not** patch `compute_ctl` (hard rule 5 — don't modify the reused Neon binary)
and we do **not** build gateway-side pre-authentication (rejected in ADR-0008, Option A).

**Mechanism (the detail above, restated for the register).** On a **genuine cold
wake** of a per-app compute, `compute_ctl` opens the Postgres socket (~T=.90s) a few
ms **before** `apply_config` lands the per-app SCRAM verifier (~T=.99s) — a **~85 ms
window** measured live on OKE (`compute-node-v17:8464`). During it the pg_hba
catch-all is still `compute_ctl`'s hardcoded `host all all all md5`, and the role
carries its **boot-time durable verifier**. For an **md5-era** app (durable verifier
still md5), the **first** post-cold-wake handshake landing in that window can negotiate
**md5** (`method=md5` observed). This is rooted in a `compute_ctl` boot property we do
not patch (hard rule 5): the OSS `ComputeSpec` exposes **no** boot-time pg_hba-method
field, so there is no in-spec way to make the socket serve `scram-sha-256` at open.

**Why the severity is LOW.**
- It is a hash **DOWNGRADE** (md5 vs SCRAM) for the **same** password — **not** an
  auth bypass. The attacker still needs the correct secret; a wake alone grants no
  access.
- **Cold-wake-only.** Every warm / steady-state connection negotiates SCRAM.
- **md5-era-apps only.** **NEW** apps are provisioned SCRAM-durable (SCRAM verifier
  from creation) and are **never** affected — a SCRAM durable verifier auto-negotiates
  SCRAM even against the md5 pg_hba catch-all, so md5 is never offered.
- The **cross-tenant direct-dial** step that would make a downgrade reachable off-path
  is already closed: **#112**'s `cloud_admin` loopback-reject means a foreign pod
  cannot dial `compute:55433` as superuser after a wake.
- It is therefore the **same accepted class** as the documented #112 window — bounded,
  observable, single-password, no new confidentiality break.

**Forward path (track, don't gold-plate).**
- **Very likely closed incidentally by the opt-in deterministic `/status` gate
  (#174 design / #181 shipped / #182 live-enable, OPEN).** Once **LIVE-ENABLED**, the
  gateway waits for `compute_ctl` `/status` = `"running"` (which is **post-`apply_config`**)
  before replaying the client startup — so the first handshake no longer lands on the
  pre-apply socket and should negotiate **SCRAM**. This is **to be VALIDATED in the
  #182 enablement drill**: assert the first post-cold-wake connection is
  `method=scram-sha-256`, **never** md5. Until #182 lands and that assertion is green,
  the window stands as an accepted residual (the shipped default is the #132 bounded
  settle, which does not itself close the downgrade).
- **Belt-and-suspenders source fix (unsolved, tracked):** an operator-driven **durable
  SCRAM-verifier re-mint** for md5-era apps — make each app's SCRAM verifier the
  durable boot-time catalog state so the socket serves SCRAM even in the pre-apply
  window. This is blocked on an **unsolved persistence problem**: the reporter's
  `CHECKPOINT` + WAL-switch attempt did **not** survive `compute_ctl`'s per-boot
  re-apply of the spec role.
- **True fix is upstream:** a `compute_ctl` boot-time **pg_hba-method spec field**
  (set `scram-sha-256` at socket-open). Out of scope here (hard rule 5).

Cross-referenced in the accepted-risks register below (Kill-criteria tripwires §).

> **Cold-wake role-apply reliability — the gateway absorbs the race (issue #132).**
> The same `compute_ctl` property (socket open ~T=.90 **before** the spec role/password
> is (re)applied ~T=.99) means the **very first** connection during a 0→1 cold wake could
> transiently see `28P01` ("password authentication failed") and self-heal on the next
> request — a rare, self-healing wart that pooled/retrying clients rode through, but a
> single non-pooled first request could surface. The **apps-gateway now absorbs it**: on
> a **genuine cold wake** (it just triggered the 0→1 scale) of a per-app front door it
> holds the client for a bounded **role-apply settle window** (`GW_ROLE_APPLY_SETTLE_MS`,
> default **250 ms** — comfortably longer than the ~85 ms apply window observed on OKE)
> **before** replaying the startup, so `compute_ctl` has applied the role by the time the
> single auth attempt runs. This is **not** an auth retry: a genuine **wrong password
> still fails immediately** on that one attempt (never masked or slow-failed), and **warm
> / steady-state** connects and the **base single-DB** (`cloud_admin`) path are never
> delayed. The settle is clamped to the remaining `GW_WAKE_TIMEOUT_MS` budget, so it can
> never push a connection past the wake deadline. This makes the race **negligible**
> (settle ≫ the apply window), **not deterministically zero**. Drill:
> `deploy/_verify-coldboot.sh`. Set `GW_ROLE_APPLY_SETTLE_MS=0` to disable the gate
> (accepts the rare transient).
>
> **Deterministic upgrade — the `compute_ctl` `/status` readiness gate (issue #174, OPT-IN).**
> The settle above is a *heuristic* time buffer: if the apply window ever exceeds the
> settle (e.g. heavy load) the transient `28P01` could recur. `compute_ctl` exposes an
> HTTP `/status` endpoint (port **3080**) whose `status` field flips to **`running`** only
> once the compute has fully applied its spec — the exact per-app role/password the settle
> waits a fixed 250 ms for. When configured, the apps-gateway **polls `/status` until
> `running`** on a cold wake instead of sleeping — deterministic and race-free, and it
> proceeds the *instant* the apply is provably done. It obeys **every `#132` invariant**:
> it fires ONLY on `woke==true` of a per-app front door (a `systemAuthorizer`), runs
> BEFORE the single startup replay (never an auth retry — a wrong password still
> fast-fails), and its total wait is clamped to `GW_WAKE_TIMEOUT_MS` (a hung/never-ready
> `/status` falls back to the bounded settle rather than wedging the wake). It is
> **belt-and-suspenders**: deterministic when `/status` answers, the bounded settle as a
> floor when `/status` is unreachable or rejects the token.
>
> The gate is **disabled by default** and is **not enabled in the shipped deployment** —
> the compute `Service` exposes only `55433/pg` and the `compute-ingress` NetworkPolicy
> denies `3080`, so `/status` is not reachable from the gateway today (the `#132` settle
> remains the shipped mechanism). **To enable it** (do this if the settle proves
> insufficient in practice — watch for recurring cold-wake `28P01` in ops):
> 1. Mount a `compute_ctl` JWT into the apps-gateway and set `GW_STATUS_TOKEN_FILE`
>    (preferred) or `GW_STATUS_TOKEN`; `/status` is JWT-gated.
> 2. Set `GW_STATUS_PORT=3080` (and optionally `GW_STATUS_TIMEOUT_MS`, e.g. `2000`, so a
>    misconfig degrades to the settle fast).
> 3. Expose `3080` on the compute `Service` (`deploy/20-compute.yaml`, the operator-
>    rendered `deploy/compute-app.template.yaml`, and `deploy/25-compute-warm.yaml`) and
>    allow `3080` from `app: pggw` in the `compute-ingress` NetworkPolicy
>    (`deploy/70-networkpolicy.yaml`).
>
> The probe hits `compute_ctl:3080` with a dedicated `compute_ctl` JWT — it opens **no new
> surface to `cloud_admin`**, which stays loopback-only (#112/#168). Refs #132, #158.

> **Reading the logs — `method=md5` is the pg_hba KEYWORD, not md5 on the wire (N2, #160).**
> Postgres' `connection authenticated: identity="app_x" method=…` line reports the
> **pg_hba line's method keyword**, not the mechanism actually negotiated. When an HBA
> line says `md5` but the role's stored verifier is `SCRAM-SHA-256$…`, the server
> **auto-negotiates SCRAM** — it is *incapable* of md5 because there is no md5 verifier
> to check against — yet the log still prints `method=md5`. So a `method=md5` line is
> NOT evidence of md5 on the wire; only a role carrying an **md5 verifier** can ever
> authenticate via md5. On a per-app compute the entrypoint rewrites the catch-all to
> `scram-sha-256`, so post-migration you will see `method=scram-sha-256`; a lingering
> `method=md5` (e.g. the #158 cold-wake window, or the primary single-DB compute whose
> catch-all stays `md5`) does not mean the wire was md5 when the durable verifier is SCRAM.

### Rolling SCRAM out to existing (md5-era) apps — atomic, zero cold-wake outage (issue #160)

Merging #117 does **not** migrate a running cluster (the recurring merged≠deployed
gap, cf. #151). Existing apps provisioned in the md5 era carry an **md5 verifier** in
their role catalog and an `APP_ROLE_MD5` key in their Secret; the SCRAM entrypoint
(`deploy/54-compute-files.yaml`) rewrites the pg_hba catch-all to `scram-sha-256` on
the **next per-app compute boot**. Applying deploy/54 does **not** touch a compute
that is scaled to 0 — the flip happens on that app's next cold wake.

**The hazard (why order matters):** pg_hba `md5` **auto-upgrades** to SCRAM when the
stored verifier is SCRAM, but pg_hba `scram-sha-256` **requires** a SCRAM verifier — a
role still holding an md5 verifier that lands on the scram catch-all is **rejected on
the wire** (a self-inflicted outage, not a downgrade). So every existing app must be
**SCRAM-verifier-durable BEFORE** the scram pg_hba is live for it.

Run this **while the app's compute is at 0** (it is triggered by connections; a demo/
low-traffic app has no wake mid-window). Preserving the password keeps every
intermediate state non-outaging — the pre-existing md5 verifier is for the *same*
password, so the app still auths under the still-`md5` pg_hba until the scram entrypoint
lands. `NS`/`KCTX` default to `scale-zero-pg` / `context-ckmva7v7zvq`.

1. **Mint the SCRAM verifier into the app Secret, preserving the password** (so no
   `DATABASE_URL` consumer breaks). Derive it from the app's existing `PGPASSWORD`
   with the same PBKDF2 the provisioner uses, and add `APP_ROLE_VERIFIER` (leave
   `APP_ROLE_MD5` in place as a same-password belt during the transition):
   ```
   app=pgdemo
   pw=$(kubectl -n scale-zero-pg get secret app-db-$app -o jsonpath='{.data.PGPASSWORD}' | base64 -d)
   ver=$(python3 - "$pw" <<'PY'
   import hashlib,hmac,base64,os,sys
   pw=sys.argv[1].encode(); salt=os.urandom(16); it=4096
   s=hashlib.pbkdf2_hmac('sha256',pw,salt,it)
   ck=hmac.new(s,b'Client Key',hashlib.sha256).digest()
   sk=hashlib.sha256(ck).digest(); srv=hmac.new(s,b'Server Key',hashlib.sha256).digest()
   b=lambda x:base64.b64encode(x).decode()
   print(f"SCRAM-SHA-256${it}:{b(salt)}${b(sk)}:{b(srv)}")
   PY
   )
   kubectl -n scale-zero-pg patch secret app-db-$app --type merge \
     -p "{\"data\":{\"APP_ROLE_VERIFIER\":\"$(printf %s "$ver" | base64)\"}}"
   ```
   (A password *rotation* is also fine — `sh deploy/provision-app.sh rotate-cred $app`
   writes `APP_ROLE_VERIFIER` too — but it changes `PGPASSWORD`/`DATABASE_URL`, so every
   consumer must re-read the Secret. Preserve the password unless you *want* to rotate.)
2. **Re-render the per-app compute** so its Deployment env reads `APP_ROLE_VERIFIER`
   (the post-#117 template dropped `APP_ROLE_MD5`): `sh deploy/provision-app.sh create
   $app`. Idempotent — it keeps the timeline, quota, replica count (0), and Secret
   (`mint_credential` is a no-op when the Secret exists). The `APP_ROLE_VERIFIER` env is
   `optional:true`, so this step is what makes the SCRAM verifier reach the spec.
3. **Apply the SCRAM manifests** (now the Secret + Deployment + entrypoint all agree):
   `kubectl apply -f deploy/54-compute-files.yaml -f deploy/83-appdb-operator.yaml`.
4. **Verify a controlled cold wake** — connect through the apps-gateway as `app_$app`
   and confirm SCRAM with no rejection:
   ```
   sh deploy/_verify-drift.sh          # section F: live compute-files == SCRAM manifest
   sh deploy/_verify-drift.sh --deep   # section G (#162): the app's DURABLE verifier is SCRAM
   # cold-wake + auth (any per-app gateway client; e.g. the _verify-multitenant GCLIENT):
   kubectl -n scale-zero-pg logs deploy/compute-$app -c compute | grep 'connection authenticated'
   #   -> connection authenticated: identity="app_pgdemo" method=scram-sha-256
   ```
   If the app fails to authenticate at any point, **abort** — the durable verifier was
   not SCRAM before the pg_hba flipped. New apps (SCRAM from creation) need none of this.

## Password rotation

`ALTER USER ... PASSWORD` does **not** stick — `compute_ctl` re-applies the spec's
roles on every boot. Rotate by role class:

- **Per-app role** (`app_<app>`, SCRAM) — `sh deploy/provision-app.sh rotate-cred
  <app> [--bounce]`. It mints a fresh password, writes its **SCRAM verifier** into
  `APP_ROLE_VERIFIER` (Secret `app-db-<app>`), and the compute re-applies it on its
  next wake (`--bounce` applies it now via a single-writer-safe `Recreate`).
  Consumers re-read `PGPASSWORD`/`DATABASE_URL` from the Secret.
- **`cloud_admin`** (loopback-only superuser, #112) — still an md5-format
  `encrypted_password` because it authenticates only over the pod-local loopback
  (which pg_hba `trust`s) and is TCP-rejected on per-app computes, so its verifier
  format is auth-irrelevant. To rotate on the primary single-DB compute: compute
  `md5` of `password + username` (`printf 'NEWPASScloud_admin' | md5`), put it in
  `roles[].encrypted_password` in `deploy/54-compute-files.yaml`, `kubectl apply` it,
  update `30-knext-secret.yaml`, and `kubectl -n scale-zero-pg rollout restart deploy/compute`.

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

## Tenant isolation controls (issue #112 / #113 / #114)

Because NetworkPolicy is **inert on flannel** (above), the tenant boundary must not
depend on the CNI. Three controls carry it, in order of who does the enforcing:

1. **pg_hba loopback-binding of `cloud_admin` — the ENFORCING control (CNI-independent).**
   On every **per-app** compute (`compute-<app>`, i.e. any compute whose entrypoint
   sees `APP_ROLE`), `deploy/compute-files/entrypoint.sh` reconciles `pg_hba.conf`
   once Postgres is up: it inserts `host all cloud_admin all reject` just **before**
   the network `md5` catch-all. The initdb loopback lines (`127.0.0.1/32`, `::1/128`
   → `trust`) come first, so pg_hba's first-match rule keeps `cloud_admin` working
   over the pod-local loopback (compute_ctl boot + `provision-app.sh`/drills via
   `psql -h localhost`) while **rejecting it from every other address**. A co-tenant
   or compromised pod that dials `compute-<app>:55433` directly as `cloud_admin`
   (the #112 gateway-bypass) gets `FATAL: pg_hba.conf rejects connection` — no
   superuser, regardless of the CNI. App roles (`app_<app>`) are untouched: they
   fall through to the network catch-all, which the same reconcile rewrites from
   `md5` to **`scram-sha-256`** (issue #117), so the apps-gateway path keeps working
   over SCRAM (see "Password authentication: SCRAM-SHA-256"; cold-wake caveat #158).
2. **No public-default `cloud_admin` password on per-app computes.** The publicly
   documented dev md5 (`md5("cloud_admin"||"cloud_admin")`) is a skeleton key. On a
   per-app compute the entrypoint refuses it: it uses the `pg-cloud-admin` Secret's
   `CLOUD_ADMIN_MD5` if present (`deploy/gen-secrets.sh` scaffolds a strong random
   one), else mints a strong **random** md5 per boot. cloud_admin is loopback-only
   either way (control 1), so this only affects break-glass localhost access.
3. **`apps-compute-ingress` NetworkPolicy — defense-in-depth.** On a policy-capable
   CNI this restricts `compute-<app>:55433` to the `pggw-apps` pods, giving a second,
   layer-3 boundary. On flannel it is inert (hence controls 1–2 carry the weight).

The **primary single-DB** compute (no `APP_ROLE`) keeps `cloud_admin` reachable over
TCP through the primary gateway — that is a single tenant, not a cross-tenant
boundary, and is defended by the NetworkPolicy + operator posture above.

**Transport encryption (issue #113):** both gateways now serve front-door TLS from
the shared `pggw-tls` Secret — `pggw` (`deploy/10-gateway.yaml`) **and** `pggw-apps`
(`deploy/81-apps-gateway.yaml`). Per-tenant traffic (the md5 auth exchange and every
query/result row) is encrypted under `sslmode=require`; `sslmode=disable` still works
(TLS optional, no regression). Regenerate the cert with `deploy/gen-tls.sh` (its SANs
now cover `pggw-apps`) and restart both gateways to rotate.

**Drills:** `deploy/_verify-multitenant.sh` proves the attack closed **live** (an
off-localhost `cloud_admin` dial to a real per-app compute is `pg_hba`-rejected, no
superuser) plus the legit loopback + gateway + `sslmode=require` paths still work;
`deploy/_verify-netpol.sh` asserts the pg_hba control exists regardless of CNI;
`deploy/_verify-tls.sh` asserts both gateways are TLS-configured.

### Wake budget & wake side-channel (issue #116)

**What it defends.** The apps-gateway holds **no tenant credentials by design** (it
is a byte pipe after the handshake; the compute verifies SCRAM — see "Password
authentication"). So a **syntactically-valid** startup — `user=app_<app>`,
`database=<app>` — passes the `(user,database)` pre-wake authz (#74) **before any
password is checked**, and that alone is enough to scale `compute-<app>` 0→1. An
unauthenticated in-cluster pod can therefore **force-wake any tenant's compute**.
Post-#112 (the `cloud_admin` pg_hba reject, control 1 above) this is a **cost/DoS
side-channel, not a data breach** — the woken compute still enforces auth — but "any
pod can wake any tenant" must be bounded and observable. Full detail + the rejected
"pre-authenticate before wake" option: **ADR-0008**.

**The control (CNI-independent).** A **per-app token-bucket** on the wake primitive
(`GW_WAKE_BUDGET` burst wakes refilling over `GW_WAKE_WINDOW_MS`, deployed **15 /
60 s** on `pggw-apps`):

- keyed on `compute-<app>` → genuinely **per-tenant**; one hostile app cannot drain
  another's budget;
- consulted **only when the compute is asleep** — a warm app is never gated, so
  cold-wake UX and latency are unchanged for legitimate traffic;
- an app that **exceeds its budget** gets a clean, transient **`53400`** ("wake rate
  limit exceeded; retry shortly") and the compute is **not scaled** — a burst cannot
  force unbounded 0→1 churn;
- refusals are counted: `pggw_wake_budget_exceeded_total` (fleet) and
  `pggw_system_wake_budget_exceeded_total{system=<app>}` (**names the offending
  app**).

**Alert.** `WakeBudgetExceeded` (deploy/60, `plane: apps`,
`increase(pggw_wake_budget_exceeded_total{gateway="pggw-apps"}[2m]) > 0` **for 3m**) —
**pages** on a *sustained* per-app breach. The `for: 3m` over a 2 m rate window
**debounces** a single self-clearing burst (issue #166): one misconfigured client
that reconnects a few times then gives up holds the expr true for only ~2 m — under
the 3 m `for:` — so it does **not** page (the excess wakes are already refused, so it
is bounded noise, not an incident). A genuinely sustained breach keeps the counter
climbing, holds the expr true continuously, and pages after 3 m. `for:` (3 m) is
deliberately **>** the rate window (2 m) so the suppression is robust, not
boundary-dependent; the trade-off is ~2 m extra detection latency on a real
side-channel, acceptable because the wake churn is already capped.

**3am action (WakeBudgetExceeded firing):**
1. Name the source app: `sum by (system) (increase(pggw_system_wake_budget_exceeded_total[15m]))`
   in Prometheus — the `system` label is the app being force-woken.
2. Confirm whether that app has a **legitimate** cause (a pod restart / reconnect
   storm, or a client mis-sized far below `GW_IDLE_MS` — see the connecting.md sizing
   rule). If legit and recurring, **raise** `GW_WAKE_BUDGET` on `pggw-apps`
   (`kubectl -n scale-zero-pg set env deploy/pggw-apps GW_WAKE_BUDGET=…`).
3. If **not** legit, you have an in-cluster actor exercising the wake side-channel:
   identify the source pod (the burst is unauthenticated, so it will also show
   `28P01`/`53400` noise in the gateway logs — `kubectl -n scale-zero-pg logs -l
   app=pggw-apps | grep 'wake budget exceeded'`), and, on a **policy-capable CNI**,
   close reachability with the NetworkPolicy layer (**#118** — the network second
   layer of ADR-0008; inert on flannel, so the budget is the live control until #118
   lands). The budget is already **refusing** the excess wakes, so this is
   investigate-not-outage.

**Tuning.** `GW_WAKE_BUDGET` / `GW_WAKE_WINDOW_MS` are per-plane. A real app wakes
**once** then stays warm `GW_IDLE_MS`, so its sustained wake rate is far below one per
window; 15/60 s leaves headroom for a reconnect storm while capping abuse to ~1
wake/4 s. `0`/unset disables the budget (the single-DB `pggw` runs no budget — one
tenant, no cross-tenant wake concern).

> **Per-replica budget.** The bucket is **per gateway pod** (in-memory, no cross-fleet
> coordination), and connections load-balance across replicas — so the effective
> per-app ceiling before refusals begin is `GW_WAKE_BUDGET × replicas` (30 at 15×2
> today). Still a hard bound, just size it against the replica count. A fleet-shared
> bucket is a deliberate non-goal (ADR-0008 Consequences).

**Drill:** `deploy/_verify-wake-guard.sh` proves it **live** — a legitimate single
wake still works (no regression), an unauthenticated over-budget burst is capped
(`53400`, compute never exceeds one replica), and the `WakeBudgetExceeded` alert
fires. Because the alert is now debounced (3 m `for:`), the drill **sustains** the
over-budget breach for ~5 min (past the `for:`) before asserting the alert reaches
firing — a single burst is expected NOT to page.

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

**The v1.0 provisioning interface is the `AppDatabase` CRD + operator**
([ADR-0004](adr-0004-provisioning-bless-or-build.md)) — see
[AppDatabase operator runbook](#appdatabase-operator-runbook-96) below. The
imperative `provision-app.sh` remains as **break-glass / CI** (and is what bootstraps
the plane); its subcommands:

```sh
cd deploy
./provision-app.sh init-plane --schema testdata/app-base-schema.sql  # one-time plane bootstrap
./provision-app.sh create  orders        # branch + compute + per-app credential (break-glass)
./provision-app.sh list                  # apps-tenant timelines
./provision-app.sh fsck                  # reconcile branches<->intents (exit≠0 if any); add --converge to auto-repair
./provision-app.sh rotate-cred orders --bounce   # rotate the app's password + apply now
./provision-app.sh destroy orders        # reclaims the timeline BY DEFAULT — no orphan (#91)
./provision-app.sh reclaim-orphans       # sweep any orphan branches + drain pending SK-deletes (#87/#90)
# read an app's DSN (per-app credential):
kubectl -n scale-zero-pg get secret app-db-orders -o jsonpath='{.data.DATABASE_URL}' | base64 -d
```

### AppDatabase operator runbook (#96)

The `appdb-operator` (`deploy/83-appdb-operator.yaml`, a fourth binary in the
multi-binary gateway image, `/appdb-operator` entrypoint) reconciles each
`AppDatabase` (`deploy/82-appdb-crd.yaml`) into a per-app database. It reimplements
`provision-app.sh`'s proven lifecycle in Go — **it does not shell out to the script**.

**Provision / change / deprovision (declarative):**

```sh
kubectl apply -f deploy/82-appdb-crd.yaml deploy/83-appdb-operator.yaml   # install once
kubectl apply -f - <<'EOF'                     # provision (or edit spec to change quotas/tier)
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: orders, namespace: scale-zero-pg }
spec:
  appName: orders
  tier: cold                                   # cold (scale-to-zero) | warm (keep 1 hot)
  quotas: { cpu: "1000m", mem: "1Gi", maxConnections: 100 }
  keepTimelineOnDelete: false                  # false = safe two-sided reclaim on delete
EOF
kubectl -n scale-zero-pg get appdatabases      # APP PHASE TIMELINE READY TIER AGE
kubectl -n scale-zero-pg describe appdatabase orders   # status conditions + Events (Branched/…)
kubectl delete appdatabase orders              # finalizer runs safe deprovision (no orphan)
```

**What the operator owns vs the gateway.** The operator owns the per-app
`Deployment`/`Service`/`ConfigMap`/`Secret` template + quotas, and `status`. The
**apps-gateway owns `spec.replicas`** (0↔1 wake): the operator preserves the live
replica count on every reconcile and does **not** hold `deployments/scale`, so the
two never fight. Continuous reconciliation heals drift (a hand-deleted Deployment
returns on the next ~15 s resync; a missing branch is re-branched).

**Lifecycle correctness (shared with the script).** Intent-first: the finalizer and
`status.timelineId` are persisted **before** the pageserver branch, so a crash never
orphans a branch (a re-reconcile reads the id back and converges). A fresh random
timeline id is minted per lifecycle (dodges the safekeeper tombstone of a prior
delete). Deprovision is two-sided (pageserver + all safekeepers); a safekeeper down
at delete time is recorded to the **shared** `apps-wal-reclaim-pending` ledger and
the finalizer **keeps the CR** and requeues until reclaim completes (the CR
disappears only once the plane is truly clean). `provision-app.sh reclaim-orphans`
is the independent backstop for residue (e.g. a CR force-deleted while a safekeeper
was down).

**Native cascade-GC on the children (owner references, #122).** Every child the
operator creates — the per-app `Secret`, `ConfigMap`, writer `Deployment`+`Service`,
and (when `roPool.enabled`) the RO `Deployment`/`Service`/`HPA` — carries a
**controller `ownerReference` to its `AppDatabase`**. So on `kubectl delete
appdatabase <app>`, Kubernetes garbage-collects the children **natively** (background
cascade), independent of the operator's own reconcile-on-delete cleanup. This is
defense-in-depth: if the finalizer is force-removed while the operator is **down**,
the Deployment/Service/ConfigMap/Secret still reap via GC rather than orphaning (the
Neon **branch** is separate — its safe two-sided reclaim still runs through the
finalizer/`reclaim-orphans` path above). The refs are set on **both** create and
reconcile, so live apps provisioned before this change (or by `provision-app.sh`)
are **back-filled** on the next ~15 s resync — verify with `kubectl get deploy
compute-<app> -o jsonpath='{.metadata.ownerReferences}'`. `blockOwnerDeletion` is
left **false** on purpose (background delete does not need it, and it avoids an extra
`appdatabases/finalizers` RBAC dependency); a CR with no UID never stamps a ref
(an empty-UID owner would be treated as dangling and reaped). **Deploy note:** the
operator runs from the multi-binary gateway image — after this merges, **roll the
`appdb-operator` Deployment** to pick up the change; the first reconcile then
back-fills existing apps. Merged ≠ deployed.

**External-driver API (unified config, #119).** The `AppDatabase` CRD is also the
stable API the **knext operator** drives to provision + wire a per-app database
(ADR-0006). The full contract — status fields to wait on (`phase`, `Ready`,
`status.secretName`, `observedGeneration`), the output Secret keys (incl.
`DATABASE_URL_RO`, emitted only when `spec.roPool.enabled`), the scoped external
RBAC (`deploy/84-appdb-external-driver-role.yaml`), and the `v1alpha1` soft-compat
policy — is in **[docs/appdatabase-api.md](appdatabase-api.md)**.

> **`DATABASE_URL_RO` is LIVE and tenant-isolated (issue #127).** When
> `roPool.enabled`, the operator provisions the app's **own** read-only compute
> (`compute-ro-<app>`, own timeline, `0↔N`) and emits `DATABASE_URL_RO` pointing at
> the app's apps-gateway RO port (`55434`). The apps-gateway RO lane is **template
> mode** (`compute-ro-<app>`), so it enforces the same `(user,database)` authz as the
> writer and can **never** reach another tenant's RO compute or the shared primary
> `compute-ro` pool. Point per-app reads at `DATABASE_URL_RO`; use `DATABASE_URL` for
> strict read-your-writes (the RO endpoint is a hot standby). Proven by
> `deploy/_verify-perapp-ro.sh`.

**Observe / debug:**

```sh
kubectl -n scale-zero-pg logs deploy/appdb-operator        # reconcile log
kubectl -n scale-zero-pg get appdatabase orders -o jsonpath='{.status}' | jq   # phase/conditions
kubectl -n scale-zero-pg get cm apps-wal-reclaim-pending -o yaml   # pending SK-delete ledger (empty = clean)
```

- **Stuck in `Provisioning`** → check the operator log: template plane not
  initialized (`provision-app.sh init-plane`), pageserver unreachable, or (warm tier)
  the compute has no available replica yet. `Failed` phase + `InvalidAppName` message
  → the `appName` is not an RFC1123 label or is a reserved name (`tmpl/warm/ro`).
- **Delete hangs (finalizer)** → a safekeeper is down; the operator is retrying
  reclaim. Confirm the safekeeper StatefulSet is healthy; the CR clears itself once
  reclaim completes. To force-drop the CR and reconcile later:
  `kubectl patch appdatabase orders -p '{"metadata":{"finalizers":[]}}' --type=merge`
  then `provision-app.sh reclaim-orphans` once the safekeeper recovers.
- **Read-replica pool (`spec.roPool`)** — when `enabled`, the operator provisions a
  per-app read-only compute `compute-ro-<app>` (own timeline, RollingUpdate, `0↔N`
  via the apps-gateway RO lane, ephemeral 2Gi/4Gi per #121) plus an optional per-app
  HPA when `roPool.maxReplicas>0`, and the `DATABASE_URL_RO` key goes live. Toggling
  `enabled` off tears the RO compute down (writer untouched); deleting the app
  removes it too. Debug a per-app RO pool: `kubectl -n scale-zero-pg get deploy
  compute-ro-<app>` + describe its pods (attach stalls / evictions).

Drill (full lifecycle, live): `sh deploy/_verify-operator.sh`.

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

**No existence oracle (issue #92).** Every apps-gateway refusal — wrong pair,
reserved/malformed name, **or a valid pair for a non-existent app** (whose wake
would fail) — returns the byte-identical `28P01 password authentication failed for
user "<user>"`. Internal causes (`deployments.apps "compute-<x>" not found`, scale
errors) are logged **server-side only**, never on the wire, so a client on the
open front door cannot enumerate apps or harvest object names. `GW_AUTH_FAIL_FLOOR_MS`
(default 250 ms) equalises refusal latency. Drill section 6b (`_verify-multitenant.sh`)
asserts unknown-app == wrong-pair == reserved live; `TestAppsGatewayRefusalsAreByteIdentical`
+ `oracle_test.go` assert it in Go. See
[connecting.md](connecting.md#multi-app--branch-per-app) for the honest timing
limit (cold-wake latency on the wrong-password path is not masked).

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

### Per-app quotas — noisy-neighbour bound (issue #89)

Branch-per-app apps share one storage plane, so a runaway tenant must not be able to
starve its neighbours. Each app's compute now carries **per-app limits**, set on
`create` and persisted in its ConfigMap (an idempotent re-`create` / `fsck --converge`
reads them back, so a customized app is never silently reset to defaults):

```sh
cd deploy
# defaults: cpu 250m/1000m (request/limit), mem 256Mi/1Gi, max_connections 100
./provision-app.sh create orders \
  --cpu-request 250m --cpu-limit 1000m \
  --mem-request 256Mi --mem-limit 1Gi \
  --max-conns 50            # cap this tenant's Postgres backends at 50

# preview the rendered manifest without touching the cluster (also used by CI):
./provision-app.sh render orders --max-conns 50 --cpu-limit 500m
```

What each bound does, and why it contains a hostile neighbour:

- **CPU limit** (new — was **absent**; only a memory limit existed). A busy app is now
  throttled to its CPU allotment, so a CPU burn cannot starve co-scheduled apps on the
  node. The **CPU request** drives scheduling/bin-packing at scale.
- **Memory limit** is the OOM bound (unchanged default 1Gi).
- **`max_connections`** is a **per-app Postgres** cap (`PG_MAX_CONNECTIONS` in the
  app's ConfigMap; the compute entrypoint applies it to that app's `postgresql.conf`
  only). Because **each app is its own Postgres**, one app opening backends up to its
  cap cannot consume a neighbour's backends — the connection bound is per-app by
  construction. Default 100 matches the shared compute; lower it for untrusted/free
  tiers.

> **Caveat — the apps-gateway `GW_MAX_CONNS` is NOT per-app.** `GW_MAX_CONNS` (90) on
> `pggw-apps` is a **process-wide** goroutine ceiling shared across *all* apps (it
> guards the 128Mi gateway from a connection-storm OOM). One app opening many gateway
> connections can transiently consume slots shared with neighbours. The per-app
> Postgres `max_connections` bounds each app's *server-side* backends (a flood beyond
> the cap is refused fast by that app's own Postgres, freeing gateway slots quickly),
> and the drill below confirms a neighbour stays available under a 20-connection
> hostile flood. A true per-app gateway slot cap (per-`{system}` accounting on the
> gateway's `active` map) is a **fast-follow** (gateway lane) — until then, run more
> `pggw-apps` replicas if one plane hosts many high-connection apps.

**Drill:** `deploy/_verify-tenant-quotas.sh` — two apps, one hostile (connection
flood + CPU burn), asserts the victim's per-app `max_connections` is unchanged (100),
a CPU limit is rendered, and the victim still wakes/serves through the shared
apps-gateway while the hostile app floods + burns. Self-cleaning.

### Scale ceiling — branch-per-app at N apps (issue #86)

ADR-0003's "tens/low-hundreds of apps on one plane" is now **measured**, not asserted.
Run the scale-ceiling drill to reproduce (self-cleaning; destroys every drill app +
sweeps orphans on exit):

```sh
cd deploy
N=30 WAKE_SAMPLE=5 ./_verify-scale-ceiling.sh   # provision N, measure, cold-wake a subset
```

It records, at N apps on one plane: provision latency p50/p95, control-plane object
count, template `pitr_history_size` growth vs branch count, safekeeper per-timeline
WAL-dir count, and cold-wake latency for a sampled subset. The **demonstrated ceiling
+ numbers** live in `docs/BENCHMARKS.md` ("Branch-per-app scale ceiling") and
ADR-0003 ("Consequences"). Key findings baked into the claim:

- **Template WAL pin does NOT grow with branch count** — every app branches from the
  *same* template LSN, so `pitr_history_size` is flat across N branches (the feared
  unbounded-pin does not materialise in steady state).
- **Sleeping apps cost zero** compute and zero safekeeper WAL (a branch at replicas 0
  never runs walproposer, so it creates no per-timeline safekeeper WAL dir).
- **Control-plane footprint is linear** — 1 Deployment + 1 Service + 1 ConfigMap +
  1 Secret per app.
- **Cold-wake at scale has a role-apply race:** a fresh compute opens its Postgres
  port a beat before `compute_ctl` finishes applying the per-app login role, so a
  *one-shot* client can see a transient `28P01` on the very first connect. A real
  knext client (a connection **pool**) retries and connects; bare `psql` should retry
  (the drill's wake client retries for this reason). Not a data or availability
  defect — a first-connect timing window.

### Sustained-load / soak / throughput harness (issue #376, wave #375)

Finds the **real high-traffic ceilings** of ONE app under sustained load: RPS ceiling,
p50/p95/p99 under a ≥10-min soak, the error rate, the **concurrency→latency** curve (the
input to the W2 ContainerConcurrency decision), and — critically — **which wall breaks
first**: app pods, the `GW_MAX_CONNS=90` gateway cap, the single writer, or DB CPU.

The load generator is an **in-cluster k6 Job** (`deploy/88-loadsoak-k6.yaml`), not an
out-of-region driver: a remote k6 adds the cluster's WAN RTT to every request and swamps
the app+DB latency the baseline is trying to isolate (the BENCHMARKS "RTT-bound" note).
The Job targets the in-cluster app URL (Knative route / ClusterIP), never public ingress.

The k6 script runs a **ramping-VUs** scenario: a *ramp* stage (0 → `RAMP_CEIL_VU`) that
finds the knee, then a *soak* stage that holds `SOAK_VU` (~70 % of ceiling) for `SOAK_DUR`,
then drains. k6 `p(95)`/`p(99)` thresholds flag SLO breaches; `--summary-export` writes a
JSON the drill's pure parser turns into a paste-ready BENCHMARKS row + a concurrency→latency
CSV line. Alongside the run the drill snapshots the gateway `pggw_*` metrics
(`active_connections`, `rejected_connections_total`, …), the writer `compute-<app>` replica
count + restarts + CPU, app pod count, and storage-plane (pageserver/safekeeper) CPU —
sampled every 30 s so the **peak** wall pressure during the soak is captured, not just the ends.

Run (self-cleaning; the Job + ConfigMap are torn down on exit, idempotent — safe to re-run):

```sh
cd deploy
TARGET_URL='http://file-manager.knext-apps.svc.cluster.local/users' \
  RAMP_CEIL_VU=120 RAMP_UP=2m SOAK_VU=80 SOAK_DUR=10m \
  P95_MS=1500 P99_MS=3000 \
  LOADSOAK_CONTEXT=context-ckmva7v7zvq \
  ./_verify-loadsoak.sh
```

Knobs (env, all optional except `TARGET_URL` for a live run):

| Env | Default | Meaning |
|---|---|---|
| `TARGET_URL` | — (required) | in-cluster URL of the app under test |
| `APP_NAME` | derived from URL host | label for the BENCHMARKS row + `compute-<app>` instrument |
| `RAMP_CEIL_VU` | `120` | ramp target VUs — raise until p99 breaks / first error to find the knee |
| `RAMP_UP` | `2m` | time to reach the ceiling |
| `SOAK_VU` | `80` | soak VUs (~70 % of ceiling) |
| `SOAK_DUR` | `10m` | sustained soak duration (the issue's ≥10 min) |
| `RAMP_DOWN` | `30s` | drain |
| `P95_MS` / `P99_MS` | `1500` / `3000` | latency thresholds (ms) |
| `MAX_ERR_RATE` | `0.01` | error budget (fraction) |
| `K6_IMAGE` | `grafana/k6:0.49.0` | k6 image |
| `K6_CPU_REQUEST` / `K6_CPU_LIMIT` | `500m` / `2` | k6 pod CPU request / limit (see the constrained-cluster note) |
| `K6_MEM_REQUEST` / `K6_MEM_LIMIT` | `256Mi` / `512Mi` | k6 pod memory request / limit |
| `K6_FANOUT` | `1` | number of **parallel** k6 Jobs (fan-out mode — see below); `1` = single Job |
| `RUN_TIMEOUT_S` | ramp+soak+slack | Job wall budget |
| `GW_DEPLOY` | `pggw-apps` | `gateway=` series label of the apps-gateway scraped for the `pggw_*` snapshot |
| `PROM_DEPLOY` | `prometheus` | Prometheus deployment the `pggw_*` snapshot instant-queries |
| `LOADSOAK_CONTEXT` / `LOADSOAK_NS` | ambient / `scale-zero-pg` | kubectl context / namespace |

**CPU-request-constrained cluster (e.g. the live OKE plane):** OKE is 2 nodes with most
allocatable CPU *reserved* by Knative/kourier/storage/monitoring (actual usage is only
~5 %, but *requests* are saturated), so the default k6 `cpu: 500m` request fails to
schedule (`Insufficient cpu`). Set **`K6_CPU_REQUEST=150m`** (or lower) so the Job
schedules, **and reduce `RAMP_CEIL_VU`** to match — a CPU-starved k6 client measures the
*client* ceiling, not the app's. Record the k6 CPU budget (`K6_CPU_REQUEST`/`K6_CPU_LIMIT`)
alongside the numbers in BENCHMARKS.md so a client-bound run is not mistaken for an
app-bound one. Example:

```sh
TARGET_URL='http://file-manager.knext-apps.svc.cluster.local/users' \
  K6_CPU_REQUEST=150m K6_CPU_LIMIT=1 RAMP_CEIL_VU=40 SOAK_VU=28 \
  LOADSOAK_CONTEXT=context-ckmva7v7zvq ./_verify-loadsoak.sh
```

**Fan-out mode — driving real high-traffic load on a request-constrained cluster
(`K6_FANOUT`, issue #382):** because one k6 pod only schedules at ~150m (≈40 VU) on the
OKE plane, a single Job never actually stresses the app (file-manager did 135 RPS / 0 err
on one pod and was never pushed to a wall). `K6_FANOUT=N` launches **N parallel k6 Jobs**
(`loadsoak-k6-0` … `loadsoak-k6-N-1`), each at `K6_CPU_REQUEST`, **sharding** the VU
target so `ceil(RAMP_CEIL_VU/N)` × N ≥ the requested concurrency (N shards together drive
the full load, not N× it). The harness waits for **all** shards, then AGGREGATES:

- **RPS is SUMMED** across shards — valid: the shards drive disjoint request streams, so
  fleet throughput is their sum.
- **peak VUs are SUMMED** — the fleet's true peak concurrency (`40 + 40 = 80`).
- **error % is a request-weighted mean** (weighted by `http_reqs.count`).
- **p50/p95/p99 are a COUNT-WEIGHTED MEAN across shards** and are printed as **`~pooled`**.
  This is an **approximation, stated honestly**: a *true* global percentile needs the
  merged per-request latency samples, which k6 `--summary-export` does **not** emit (only
  each shard's pre-computed percentiles). For the fan-out design — identical target,
  identical CPU per shard, so near-equal latency distributions — the count-weighted pool is
  close to the true value, but it is **not** an exact global p95/p99. Treat `~pooled`
  percentiles as indicative; if you need an exact global tail, run a single larger Job (or
  merge the raw samples out-of-band). Per-shard rows are printed alongside the aggregate for
  provenance. `K6_FANOUT=1` is byte-identical to the original single-Job behavior. Teardown
  is idempotent and sweeps **all** shards (by the `drill=loadsoak` label). Example:

```sh
TARGET_URL='http://file-manager.knext-apps.svc.cluster.local/users' \
  K6_FANOUT=4 K6_CPU_REQUEST=150m K6_CPU_LIMIT=1 RAMP_CEIL_VU=160 SOAK_VU=112 \
  LOADSOAK_CONTEXT=context-ckmva7v7zvq ./_verify-loadsoak.sh
# 4 pods × 40 VU = 160 VU total; each pod requests 150m so all four schedule.
```

**Knob safety (injection guard):** the knobs are interpolated into the k6 Job's
`/bin/sh -c` argument, so the harness rejects any knob value carrying a shell
metacharacter (`'` `"` `` ` `` `$` `;` `|` `&` `\` `<` `>` `(` `)` or a control char) and
fails closed before rendering the manifest — a poisoned `TARGET_URL` cannot execute in the
Job. Practical consequence: a `TARGET_URL` whose query string needs a literal `&` is
refused; target a route/path without `&` (or add a single query param). URLs, durations
(`2m`), and integers use none of these characters, so legitimate values are unaffected.

**How the wall snapshot reads its numbers (issue #383):** the `pggw_*` gateway counters
are read from **Prometheus** (`PROM_DEPLOY`, default `prometheus`) via the instant-query
API — `sum(pggw_<metric>{gateway="$GW_DEPLOY"})` — **not** by exec-ing the gateway pod.
The apps-gateway image is distroless (`gcr.io/distroless/static:nonroot`): it has no shell,
`wget`, or `curl`, so the earlier pod-exec scrape always returned "(metrics unavailable)"
and the wall analysis had nothing to adjudicate. Prometheus already scrapes the gateway's
`:9090` and labels the series `gateway="pggw-apps"`, so the query returns real numbers.
Likewise the DB-compute line now targets the per-app deployment **`compute-$APP_NAME`**
directly (no fall-through to the base single-DB `compute`, which is always `replicas=0` in
branch-per-app mode and produced a misleading "writer compute: replicas=0" line while the
app was being served).

Reading the wall analysis: if `pggw_rejected_connections_total` climbed above 0, the
`GW_MAX_CONNS=90` cap was the wall (raise it or add app pods so the pool spreads); if
`pggw_active_connections` peaked near 90 with rejections just starting, you are at the cap;
if the DB compute `compute-<app>` CPU pinned at its limit with connections well under 90,
the single writer is the wall (the W3 write-path lever); if app pods pinned CPU first, that
is the Knative-side lever (ContainerConcurrency / min-scale, W2). Under fan-out these
counters reflect the **combined** load of all N shards (they hit the one shared gateway and
the one per-app compute), so the wall reading is fleet-wide. Every run's numbers land in
`docs/BENCHMARKS.md` under "Sustained-load / soak baseline" (rule 2b).

**Cluster-free validation** (no OKE, no k6 binary): `SELFTEST=1 ./_verify-loadsoak.sh`
dry-runs the manifest(s) and self-checks the summary parser + the fan-out aggregation math
(`SELFTEST=1 K6_FANOUT=2 ./_verify-loadsoak.sh` also proves the N-shard render);
`bash test_verify-loadsoak.sh` asserts the parser produces the exact BENCHMARKS row format
from a sample k6 JSON, the fan-out renders N distinct shard Jobs, and the aggregator sums
RPS/VUs and count-weight-pools the percentiles correctly on fixed inputs.

### Writer vertical-autoscale ceiling under sustained WRITE load (issue #379, wave #375 W4)

The soak harness above is **read-oriented** (HTTP GETs). This drill drives the other axis:
**sustained WRITE load** at ONE app's writer to (a) prove the #103 writer vertical-autoscaler
does an **in-place** cpu-limit resize (`restartCount` stays 0) *under real gateway write load*
— not the synthetic in-container CPU burner of `_verify-writer-autoscaler.sh` — then a
**hysteresis** resize-down after the load drains; and (b) publish the **write RPS ceiling**,
the honest hard limit: writes scale **only vertically** to the node/limit ceiling (single
writer; beyond that = sharding, out of scope for the wave).

The load generator is an **in-cluster loader Deployment** (`WC_LOADERS` pods, default 4), each
running a tight `psql` INSERT loop **through the apps-gateway on the app's own branch** using a
**passwordless** DSN (the password is injected out-of-band; see below):

```
postgres://app_<app>@pggw-apps:55432/<app>?sslmode=disable
```

INSERTing batches of `WC_BATCH` rows into a **throwaway `wc_drill` table** (created in setup,
dropped in teardown) on that branch. This reuses the **real** knext write path and respects
single-writer + tenant sovereignty — the loader **never** dials `compute-<app>:55433` directly.
The app-branch password is **never** placed in the DSN, the manifest, the on-disk tmp yaml, or
etcd (security.md): it is injected as `PGPASSWORD` via a **`secretKeyRef`** to the app's
credential Secret (`app-db-<app>`, `PGPASSWORD` key) — for the loader Deployment and, via
`kubectl run --overrides`, for the one-shot `wc_drill` create/drop pods (no password on any pod
command line).
Each loader counts its committed batches and prints a sentinel `WCLOAD ok=<N> err=<M> secs=<S>`
on SIGTERM; the drill's pure parser turns that into a per-loader write-RPS, and the fleet
aggregates by **summing** the disjoint per-loader streams (same reasoning as the #382 loadsoak
RPS sum). While the load ramps + soaks, the drill samples on `compute-<app>` the **actuated**
cpu-limit (from pod `.status`, not the spec), the `restartCount` (must stay at baseline), and
`kubectl top` CPU, plus the gateway `pggw_*` snapshot via Prometheus.

Run (self-cleaning; idempotent teardown drops the drill table, restores the autoscaler to its
committed cadence, rests the writer, and destroys the drill app it provisioned):

```sh
cd deploy
WC_APP=wcdrill WC_LOADERS=4 WC_BATCH=50 \
  WC_RAMP_S=60 WC_SOAK_S=180 WC_DRAIN_S=210 \
  WC_CONTEXT=context-ckmva7v7zvq \
  ./_verify-writer-ceiling.sh
```

The drill **auto-skips cleanly** (exit 0) if metrics-server, the `writer-autoscaler` Deployment
(#103), or the apps-gateway are absent — the autoscaler cannot actuate without them. Reuse an
existing app with `WC_KEEP_APP=1` (then it is not destroyed on teardown). On a
**CPU-request-constrained cluster** the loaders may not drive the single writer past
`WAS_UP_RATIO`; the drill says so honestly and still publishes the write-RPS ceiling it reached
(the writer proof and the ceiling number are reported independently). Paste the emitted
`app | phase | writeRPS | ok | err | err% | secs` fleet row into `docs/BENCHMARKS.md` under
"Writer vertical-autoscale under sustained write load (#379)" (rule 2b).

**Cluster-free validation** (no OKE, no psql binary): `SELFTEST=1 ./_verify-writer-ceiling.sh`
renders + dry-runs the loader manifest (asserting it writes *through* pggw-apps, never a bypass)
and self-checks the parsers; `bash test_verify-writer-ceiling.sh` asserts `parse_wcount` /
`aggregate_wcounts` produce the exact row format on fixed inputs and that a poisoned knob fails
`render_loader` closed.

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

   **System markers are excluded (issue #337).** Intent-reconciliation walks only
   ConfigMaps named `compute-config-<app>` — the genuine per-app intents — **not**
   every ConfigMap carrying the shared `tier=apps` label. So the wal-reclaim ledger
   `apps-wal-reclaim-pending` (a `tier=apps` system marker with **no** `TIMELINE_ID`
   by design) is **not** misclassified as a dangling intent. A real
   `compute-config-<app>` with no `TIMELINE_ID` is still flagged.

### Rotating an app credential (issue #93b)

Each app authenticates as `app_<app>` with a per-app password stored in Secret
`app-db-<app>` (`PGPASSWORD` + `APP_ROLE_VERIFIER` + `DATABASE_URL`). `compute_ctl`
re-applies the role's **SCRAM-SHA-256 verifier** (issue #117) **from spec on every
boot**, so rotation is: write a new verifier into the Secret, then bounce (or wait
for the next wake of) the compute — `rotate-cred` does exactly this.

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

## Zone replication-wake — waking a sleeping publisher (v2-1, #139, ADR-0007 §4c)

The zone-scaling axis lets one zone's database subscribe to another's via Postgres
logical replication while **both keep scale-to-zero**. The load-bearing trick: a
subscriber's walreceiver connects to the publisher **through the apps-gateway**, not
to `compute-<zone>` directly — so the connect itself wakes a sleeping publisher (as
an ordinary client connect does), and the gateway holds it awake for the life of the
replication stream. No warm-publisher tier is required.

**How the gateway treats a replication connection.** On the startup packet it detects
`replication=` (`database`=logical, `true/on/yes/1`=physical), authorizes it against
the per-zone **`repl_<zone>`** role (NOT `app_<zone>`, which has no `REPLICATION`
attribute — role separation, ADR-0007 §4b), wakes `compute-<zone>` if asleep, and
pipes the CopyBoth stream through the same byte pump as query traffic. The stream is
counted as a live connection, so **the publisher never scales to zero while a
walreceiver is attached**; it becomes sleep-eligible only after the subscriber
disconnects (unsubscribed or caught-up-then-slept) and the idle window elapses.

**Wiring a subscription (the conninfo MUST point at the apps-gateway):**

```sh
# On the PUBLISHER zone: a per-zone REPLICATION role + a publication.
# (The Zone operator mints repl_<zone> into the zone Secret and injects it every
#  boot, exactly as app_<zone> — ADR-0007 §4b. Break-glass, do it by hand:)
#   CREATE ROLE repl_<pubzone> WITH LOGIN REPLICATION PASSWORD '<pw>';
#   CREATE PUBLICATION <pub> FOR TABLE <...>;

# On the SUBSCRIBER zone: CONNECTION points at pggw-apps, user=repl_<pubzone>,
# dbname=<pubzone>. sslmode=disable -> the gateway declines SSL and pipes plaintext.
#   CREATE SUBSCRIPTION <sub> CONNECTION
#     'host=pggw-apps.scale-zero-pg.svc port=55432 user=repl_<pubzone>
#      password=<pw> dbname=<pubzone> sslmode=disable'
#     PUBLICATION <pub>;
```

The role prefix is `GW_REPL_ROLE_PREFIX` (default `repl_`) on `deploy/81-apps-gateway.yaml`
and MUST match the role the Zone operator mints. A replication startup whose user is
not `repl_<dbname>` is refused with the same uniform `28P01` as any other bad pair
(no tenant-existence oracle, #92) — and a tenant-gated gateway with no replication
authz **fails closed** rather than leaving the replication path open.

**Observability & verification.**

```sh
# replication streams the gateway has mediated (a counter)
kubectl -n scale-zero-pg logs -l app=pggw-apps --prefix | grep 'replication stream'
# curl pggw metrics -> pggw_replication_connections_total

# publisher slot health (retention while a subscriber is asleep)
#   SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
#   FROM pg_replication_slots;

# full live drill (provisions throwaway zpub/zsub, proves wake+hold+sleep, tears down)
deploy/_verify-repl-wake.sh run        # or: teardown  (restores GW_IDLE_MS, destroys zones)
```

Live-proven on OKE 2026-07-07: slept publisher woken 0→1 in **4.05 s**, 305-row
backlog drained, held awake past a 15 s idle window with a live insert replicating,
then scaled 1→0 in **12.10 s** after the subscription dropped (`docs/BENCHMARKS.md`).
The publisher retains WAL for an inactive slot while the subscriber sleeps — an
abandoned slot pins WAL unbounded, so slot hygiene on deprovision matters (ADR-0007
§4d; the slot-janitor lane owns the reaper).

## Zone operator — cross-zone fabric (v2-2, #139)

The `zone-operator` (`deploy/87-zone-operator.yaml`) reconciles `Zone` CRs
(`deploy/86-zone-crd.yaml`) into the zone-scaling axis (`docs/SCALING.md` §4,
[ADR-0007](adr-0007-zoned-consistency.md)). A Zone COMPOSES an `AppDatabase` (its
in-zone DB — the operator owns the AppDatabase via an ownerReference, ADR-0006
delegation) and the operator is the **sole author** of the cross-zone SQL. It runs
that SQL as `cloud_admin` over pod-local loopback via `pods/exec` inside the compute
pod (the distroless operator ships no psql; `cloud_admin` is rejected over TCP, #112).

**Deployment posture — STANDARD, not drill-only (issue #151).** The Zone CRD (86) and
zone-operator (87) are **standard cluster infrastructure**: they match the standard
deploy glob (`ls deploy/[0-9][0-9]-*.yaml | … | kubectl apply`), so a normal deploy
installs them alongside the apps-gateway + appdb-operator, and the operator runs **1/1,
sustained** (like `appdb-operator`/`pswatcher`). `deploy/_verify-drift.sh` (section D)
asserts their **live presence** — the `zones.zones.scale-zero-pg.dev` CRD is installed
and the `zone-operator` Deployment is ready `1/1` — so a cluster that never applied them
**fails the drift gate** instead of passing silently (the v1.3.0 convergent finding: the
flagship shipped drill-only because `_verify-zones.sh` applies 86/87 then tears them down
on exit; `_verify-zones.sh` remains the throwaway *fabric* drill, but the operator itself
is now a persistent deploy). Applying the zone manifests is **idempotent** — it does not
disturb existing `AppDatabase`s. Prove the sustained deploy live with
`deploy/_verify-zone-deploy.sh zone`.

**Scale-to-zero contract (steady-state gate):** the operator re-asserts the in-DB
fabric **only on a spec change** — a Ready zone whose `metadata.generation` equals
`status.observedGeneration` short-circuits the reconcile and runs **no** SQL, so it
never execs into (and therefore never wakes) the compute on the 15 s resync. The repl
role, publications, and subscriptions are durable on the timeline, so nothing needs
re-applying every tick; a real spec edit bumps the generation and re-opens the gate
(drift on a genuine change still heals). This is what lets a publishing/subscribing
zone actually rest at zero — the whole point of the gateway-mediated wake (#140). A
Degraded/pending zone re-evaluates its dependencies each resync but only wakes a
compute to wire a newly-grantable dependency, never to re-affirm a settled one.

What it authors, on a spec change / first reconcile (idempotent, drift-healing):
- **repl role** — `repl_<zone>` (LOGIN REPLICATION), md5 from `zone-repl-<zone>`
  Secret, re-asserted every pass (durable on the timeline). Lock-step with the
  apps-gateway `GW_REPL_ROLE_PREFIX` (#140) so replication startups authorize.
- **publications** — `spec.publishes[]` → `CREATE PUBLICATION`-if-absent + `ALTER
  PUBLICATION … SET TABLE` (never drop+recreate — that would tear down live
  streaming). A zone exports **nothing** by default (sovereignty).
- **subscriptions / FDW** — per `spec.dataDependencies[]`, gated by **both-sides-
  agree** (the peer must publish every requested table, else `state: denied` in
  status) and by the peer's `status.publications` (so the initial COPY captures
  existing rows). `mode: replicate` → `CREATE SUBSCRIPTION` (once) whose connection
  points at `pggw-apps` (the #140 wake handles a sleeping publisher); `mode:
  federate` → `postgres_fdw` foreign tables in schema `zone_<peer>`.

```sh
kubectl -n scale-zero-pg get zones                  # PHASE, DB, TIER
kubectl -n scale-zero-pg get zone zone-eu -o jsonpath='{.status.subscriptions}'
#   [] state per dependency: streaming | pending | federated | denied | error
kubectl -n scale-zero-pg logs deploy/zone-operator | grep reconcile

# full live drill (throwaway za/zb: compose + publish + subscribe + sovereignty +
# publisher-woken-for-replication + clean deprovision)
deploy/_verify-zones.sh run        # or: teardown   (KEEP_OPERATOR=1 keeps CRD+operator)
```

**Deprovision (`kubectl delete zone <name>`)** runs the finalizer's cross-zone
hygiene in the mandated order (ADR-0007 §4d): drop this zone's subscriptions
(subscriber side first), wake each replicate peer and drop the orphaned slot
(`pg_drop_replication_slot`, guarded on `NOT active`), drop this zone's publications,
then delete the composed AppDatabase (its own finalizer reclaims the timeline two-
sided). If the compute is already gone the in-DB drops are skipped so the finalizer
never wedges. **A slot left on a live peer pins WAL unbounded** (§4a) — the
slot-janitor lane monitors that as defense-in-depth, but clean deprovision is the
first line. Single replica on purpose (Recreate): the operator is the single-writer
of cross-zone fabric actions.

**Peer-gone vs transiently-unreachable (#146).** Dropping the peer slot distinguishes a
peer that is **genuinely deprovisioned** (its `compute-<peer>` Deployment is gone → the
slot went with its timeline; nothing to drop, deprovision continues) from a peer that is
**live but momentarily unwakeable** (wake/drop failed transiently). In the transient
case the operator records a **pending-reclaim** (`Fabric` condition `PendingSlotReclaim`
+ a Warning event) and **requeues without removing the finalizer** — the Zone stays and
the next resync retries the slot drop, **until the peer is reachable**. It never silently
gives up and strands a slot on a live peer; the #143 WAL bound is only the backstop,
never relied on for correctness.

Live-proven on OKE 2026-07-07 (`docs/BENCHMARKS.md`): live cross-zone lag **1.81 s**;
with the **operator scaled to 0**, `compute-za` stayed truly at rest at 0 for 20 s
(not force-woken — the steady-state gate), then the subscriber woke it **0→1 in
5.30 s** through the gateway (unambiguously the #140 path), 56-row backlog drained
**6.73 s**; sovereignty upheld (unpublished table withheld); clean deprovision (no
orphan slot, both timelines reclaimed).

### Zone alerts & re-sync runbook

**Alerts (both PAGE — severity critical, plane=zones; sourced from the
`zone-status-monitor` CronJobs, `deploy/64`):**

- **`ZoneDegradedOrFailed`** — a Zone is `phase=Failed` (invalid spec — terminal until
  corrected) or `phase=Degraded` (a dependency the operator could not wire, or a slot
  invalidated awaiting re-sync). Triage: `kubectl -n scale-zero-pg get zone -o wide`
  then `kubectl get zone <z> -o yaml` → `.status.message` + `.status.conditions`.
- **`ZoneSubscriptionBroken`** — a `dataDependency` subscription is `error` / `denied` /
  `needs_resync` (see the states below).

**Truthful subscription states (`.status.subscriptions[].state`):**

| State | Meaning | Action |
|---|---|---|
| `streaming` | logical-replication copy live | — |
| `federated` | `postgres_fdw` foreign tables live (no copy) | — |
| `pending` | peer not publishing yet / repl cred not ready | self-heals when the peer reconciles |
| `denied` | **governance**: the peer does not `publish` a requested table | declare the table in the **peer's** `spec.publishes` to grant |
| `error` | a wiring failure (bad conninfo / exec error) | read `.message` + the operator log |
| `needs_resync` | the peer slot was **invalidated** (`wal_status=lost`, the #143 degrade) — the local copy is **stale** | auto re-synced by the operator (below); manual only if `ZONE_AUTO_RESYNC=false` or auto-resync keeps failing |

**Re-sync — self-healing (default).** A settled Ready zone polls each streaming
replicate dependency for slot invalidation on **every resync**, and when it finds
`wal_status=lost` it flips the subscription to `needs_resync` and **auto-actuates** the
recovery: `DROP` + `CREATE SUBSCRIPTION … WITH (copy_data = true)` on the subscriber,
re-snapshotting the peer publication from scratch. It reads the peer slot **only when
the peer is already awake** (a non-waking read) so a settled healthy zone is **never
force-woken to poll** and still rests at zero (the scale-to-zero invariant). Watch it:

```sh
kubectl -n scale-zero-pg get zone <subscriber> -o jsonpath='{.status.subscriptions}'
kubectl -n scale-zero-pg logs deploy/zone-operator | grep -E 'Resync|NeedsResync'
```

**Re-sync — manual (only when `ZONE_AUTO_RESYNC=false`, or auto-resync cannot heal).**
On the **subscriber** compute (as `cloud_admin` over pod-local loopback), drop and
recreate the subscription with a fresh copy (the peer publisher wakes via the gateway on
the initial COPY connect):

```sh
POD=$(kubectl -n scale-zero-pg get pod -l app=compute-<subscriber> \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
kubectl -n scale-zero-pg exec -i "$POD" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_subscription WHERE subname = 'zone_sub_<peer>') THEN
    ALTER SUBSCRIPTION "zone_sub_<peer>" DISABLE;
  END IF;
END $$;
-- DROP (not detach) so the invalidated remote slot is dropped too, freeing the name;
-- the peer publisher must be reachable (it wakes via the gateway on the COPY below).
DROP SUBSCRIPTION IF EXISTS "zone_sub_<peer>";
CREATE SUBSCRIPTION "zone_sub_<peer>"
  CONNECTION 'host=pggw-apps.scale-zero-pg.svc port=55432 user=repl_<peer> password=<pw> dbname=<peer> sslmode=disable'
  PUBLICATION <peer_pub> WITH (copy_data = true, create_slot = true);
SQL
```

(`<pw>` is the peer's `zone-repl-<peer>` Secret `REPL_PASSWORD`.) This is exactly what
the operator's auto-resync emits. Verify the fresh publisher slot with
`SELECT slot_name, wal_status FROM pg_replication_slots` on the peer (a new
`zone_sub_<peer>`, `wal_status` reserved/extended — not `lost`).

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

### Per-app read replicas on the apps-gateway (issue #127)

The **apps-gateway** (`pggw-apps`) runs its OWN RO listener on `GW_RO_PORT=55434`,
but in **template mode** (not the primary's single-fixed-deployment kubectl mode):
`database=<app>` reads route to **that app's own** read-only compute
(`compute-ro-<app>`), scaled `0↔N` on connect. This is the multi-tenant read axis —
each app's reads are isolated to its own RO compute on its own timeline, enforcing
the same `(user,database)` authz as the writer lane. A naive kubectl RO lane here
would route **every** app's reads to one shared pool = cross-tenant exposure; the
template lane is the fix.

- **Provisioning is declarative:** set `AppDatabase.spec.roPool.enabled: true` (knext
  maps this from `NextApp.spec.database.readReplicas`). The operator renders
  `compute-ro-<app>` (Deployment + Service, `RO_MODE=Replica`, ephemeral 2Gi/4Gi per
  #121) and the `DATABASE_URL_RO` key on `app-db-<app>` goes live. `roPool.maxReplicas>0`
  also renders a per-app HPA (posture B; see the tension note below). Toggling
  `enabled` off tears the RO compute down; deleting the app removes it.
- **Isolation + staleness drill:** `KCTX=… sh deploy/_verify-perapp-ro.sh` — two apps
  A+B, proves A reads A (never B, data + authz both ways), RO writes rejected,
  staleness measured, teardown removes `compute-ro-<app>`.
- **Debug one app's pool:** `kubectl -n scale-zero-pg get deploy compute-ro-<app>` +
  describe its pods. Same `ComputeStuckNotReady` alert covers `compute-<app>` and its
  RO sibling (the pod-name pattern includes the app suffix).

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
(`deploy/optional/27-compute-ro-hpa.yaml` documents all three):

- **A — gateway-managed 0↔N (default):** no HPA. Full scale-to-zero; wakes to a
  fixed `GW_RO_WAKE_REPLICAS`. Simplest. This is the **default** posture — the
  HPA lives under `deploy/optional/` so `kubectl apply -f deploy/` (non-recursive)
  never applies it, keeping the pool at zero cost at rest.
- **B — HPA-managed 1↔N (GA'd in #99):** apply
  `deploy/optional/27-compute-ro-hpa.yaml`, and set `GW_RO_IDLE_MS=0` so the
  gateway never sleeps the pool (the HPA's `minReplicas: 1` floor means **no**
  scale-to-zero — one replica costs RAM 24/7). Load drives N.
  **Prerequisite: a metrics-server** (the `metrics.k8s.io` API) for the CPU metric
  to resolve — install with
  `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`.
- **C — zero-cost AND elastic:** KEDA (`deploy/40` pattern) with a connections
  trigger and `minReplicaCount: 0`. Documented upgrade path.

**GA drill — n>1 under real load.** `deploy/_verify-readpool.sh` auto-runs an HPA
section (when a metrics-server is present; force with `RO_HPA=1`): it applies the
HPA, drives real concurrent read load at the pool Service, **asserts compute-ro
scales 1→N (N≥2)**, re-checks that writes are still rejected and re-measures
staleness under load, then drains the load and **asserts it scales back N→1**.
Numbers: [BENCHMARKS](BENCHMARKS.md#read-only-pool-under-load-hpa-n1-issue-99).

> **`WAKE_BUDGET_MS` — the drill battery's ADAPTIVE wake budget (issues #198, #340).**
> The battery's timing budgets were calibrated for a fast ~2–5 s cold wake. On a
> CPU-request-tight or memory-pressured cluster (e.g. a 2-node OKE where cold wakes
> run ~14 s mean / ~19 s max, and transient scheduling stalls push a single wake past
> a minute) those fixed budgets false-FAIL even though the products are healthy.
> `deploy/_verify-readpool.sh`, `deploy/_verify-multitenant.sh` and `deploy/_verify-wake.sh`
> source `deploy/_lib-drill.sh` and size their idle/hold/ready-wait budgets off one
> knob, `WAKE_BUDGET_MS`, resolved with a strict precedence:
>
> 1. **Explicit override always wins.** Set `WAKE_BUDGET_MS=<ms>` (operators/CI pin
>    the battery), e.g. `WAKE_BUDGET_MS=45000 sh deploy/_verify-readpool.sh`.
> 2. **Adaptive measured probe (default).** When `WAKE_BUDGET_MS` is unset, the wake
>    and multitenant drills call `probe_wake_budget` at battery start: it scales the
>    default `compute` Deployment 0→1, times ONE real cold wake, scales back to 0, and
>    sizes the budget as `measured × 3 + 30 s` margin (`budget_from_measured_ms`). So
>    a slow cluster auto-tunes the whole battery from its own measured latency.
> 3. **Safe fallback = 120 s (NOT 30 s).** If no probe ran (no cluster) or the probe
>    failed/timed out, the budget falls back to a **120 s** floor — deliberately not
>    the old fixed 30 s, which false-failed `_verify-wake.sh` / `_verify-multitenant.sh`
>    on a memory-pressured OKE cluster (**#340**: 30 s failed with "compute not ready",
>    a re-run at `WAKE_BUDGET_MS=210000` passed in **12 s** — the stall was transient
>    scheduling, not a defect).
>
> The budget drives the test gateway's idle window (must outlast a wake so a just-woken
> pool isn't slept before the `replicas≥1` check), the multitenant busy-hold duration
> (must outlast the idle app's whole wake-then-idle-down sequence), and the compute
> **ready-wait** (`rollout_ready_retry` wraps `rollout status` in a **bounded retry/
> backoff**: it absorbs a transient Pending stall but a genuinely-broken wake still
> fails within the adaptive budget — never an infinite wait). A one-line
> `preflight_cluster_health` note warns (non-blocking) at battery start if any node is
> under `MemoryPressure` or an `Evicted` pod tombstone exists, so a flaky run is
> attributable. Unit tests (pure budget math + bounded-retry property):
> `sh deploy/_lib-drill.sh selftest`.
>
> The same fix corrected the HPA **load generator**, which had become a *no-op*: it
> dialed `compute-ro` as the public default `cloud_admin:cloud_admin`, which #168/#112
> reject over TCP (the base compute serves `cloud_admin` only under its strong md5),
> so the loader ran **no** query, CPU stayed ~10 %, and the CPU-target HPA never
> tripped. It now dials the strong credential from the `DATABASE_URL` Secret, so the
> N≥2 scale-up is genuinely exercised.

**Ephemeral-storage sizing — no flap under load (issue #121).** A **warm** RO
compute's local working set lives on the pod's **ephemeral (container) fs**: the
Neon Local File Cache (LFC, uncapped by default), `pg_wal` streamed from the tip
while tip-following, temp spill from big read scans, and logs. At the original
`ephemeral-storage: 1Gi` limit the kubelet **evicted** `compute-ro` pods under
exactly the sustained read load the pool exists to absorb (`Pod ephemeral local
storage usage exceeds the total limit of containers 1Gi`), so the read-scaling axis
**flapped**. `deploy/26-compute-ro.yaml` now sizes it for load — **request `2Gi`**
(kubelet ranks eviction on usage-above-*request*, so a pod under 2Gi is never a
candidate) and **limit `4Gi`** (4× the evicting ceiling). Measured live under
sustained n=3 read load: peak ephemeral **~2.0Gi** (`READPOOL_EPHEMERAL
peak_mb=2065`) — comfortably past the old 1Gi that evicted, absorbed by the 4Gi
limit with **zero evictions**. The `_verify-readpool.sh` HPA section sustains real
load and **asserts zero compute-ro evictions** (`READPOOL_EPHEMERAL evictions=0 …`). If you
run very large read scans, raise the limit further or cap `neon.max_file_cache_size`.

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
- The `writer-autoscaler` (below) automates this recipe — the manual patch above
  is the break-glass primitive.

## Writer vertical-autoscaler (issue #103, docs/SCALING.md axis 1)

The `writer-autoscaler` controller (`deploy/85-writer-autoscaler.yaml`, binary
`gateway/cmd/writer-autoscaler` baked into the multi-binary `ks-pg/gateway` image)
automates the #67 in-place resize. It watches every WRITER compute's CPU+memory
usage via **metrics-server** and, on sustained pressure, patches the `pods/resize`
subresource within configured min/max bounds — **the running Postgres never
restarts** (`restartCount` unchanged, `pg_postmaster_start_time()` unchanged).

**Per-app aware.** The `WAS_SELECTOR=plane=compute` label selector matches the
primary `compute` and every per-app `compute-<app>` writer in one loop. The
read-replica pool (`app=compute-ro`, no `plane=compute` label) is deliberately
excluded — this is a *writer* autoscaler; read scaling is the RO pool's job.

**Limits, not requests (always actuates).** The autoscaler moves the CPU/memory
**limit** (the cgroup ceiling — burst headroom) and leaves the **request** at the
manifest baseline. A limit-only in-place resize actuates *immediately* (the kubelet
writes `cpu.max`/`memory.max`); a **request** increase can be **deferred** on a node
without spare allocatable (`PodResizePending: Deferred`, see #67). Keeping requests
fixed means a resize never needs node re-admission and always actuates — even on a
busy, near-full node. Raising a guaranteed floor is a manifest change (edit the
`requests:` in `20-compute.yaml` / the per-app quota), not an autoscaler action.

**The resize tiers (what actuates live vs needs a bounce):**

| Tier | Resizable live? | How the autoscaler handles it |
|---|---|---|
| CPU limit | **yes** — cgroup `cpu.max` | grows/shrinks in place, no restart, never deferred |
| Memory limit | **yes** — cgroup `memory.max` | grows/shrinks in place, no restart, never deferred |
| CPU/memory **request** | (not touched) | stays at the manifest baseline — a manifest change, not autoscaled |
| `shared_buffers` | **no** — boot-fixed | **never bounced silently.** A writer memory-bound AT its max limit is *flagged*, not bounced (see below) |

**Never-bounce-silently (hard invariant).** Growing the buffer cache means growing
`shared_buffers`, which is fixed at Postgres boot — it only changes with a compute
restart. The autoscaler will **never** restart a live writer to grow it. Instead,
when a writer is memory-bound *and already at* `WAS_MAX_MEM`, the controller
annotates the pod:

```
writer-autoscaler.scale-zero-pg/needs-bounce: "memory at max limit under sustained
  pressure; a larger shared_buffers is boot-fixed and needs a maintenance-window bounce"
```

and increments `writer_autoscaler_needs_bounce_total`. The operator then, in a
maintenance window: raise `WAS_MAX_MEM` + the compute's `shared_buffers` (in
`54-compute-files.yaml`) and `kubectl rollout restart deploy/<compute>` (a
deliberate, scheduled bounce). Find flagged writers:

```sh
kubectl -n scale-zero-pg get pods -l plane=compute \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.writer-autoscaler\.scale-zero-pg/needs-bounce}{"\n"}{end}'
```

**Anti-flap (hysteresis + cooldown).** A resize fires only after `WAS_UP_HOLD`
(default 3 ≈ 45s at the 15s poll) consecutive over-threshold ticks — or
`WAS_DOWN_HOLD` (default 8 ≈ 2min) under-threshold ticks; the counter resets on any
direction flip, so oscillating load never resizes. After any resize, `WAS_COOLDOWN`
(default 4 ≈ 60s) ticks are suppressed. Scale-down never shrinks the memory limit
below observed working-set (no OOM). Per-pod state is GC'd on scale-to-zero, so a
re-woken writer starts fresh at the manifest baseline and re-scales under load.

**Config (env, 12-factor):**

| Env | Default | Meaning |
|---|---|---|
| `WAS_SELECTOR` | `plane=compute` | writer pods to watch (RO pool excluded) |
| `WAS_MIN_CPU` / `WAS_MAX_CPU` | `250m` / `2` | CPU resize envelope |
| `WAS_CPU_STEP` | `250m` | CPU increment per resize |
| `WAS_MIN_MEM` / `WAS_MAX_MEM` | `256Mi` / `1Gi` | memory resize envelope |
| `WAS_MEM_STEP` | `256Mi` | memory increment per resize |
| `WAS_UP_RATIO` / `WAS_DOWN_RATIO` | `0.80` / `0.30` | usage/limit scale-up / scale-down thresholds |
| `WAS_UP_HOLD` / `WAS_DOWN_HOLD` | `3` / `8` | consecutive ticks before up / down |
| `WAS_COOLDOWN` | `4` | ticks suppressed after any resize |
| `WAS_POLL_MS` | `15000` | control-loop interval |

**Prereqs.** metrics-server installed (`kubectl top pods -n scale-zero-pg`), and
each writer container declares `resizePolicy: [{cpu,NotRequired},{memory,NotRequired}]`
plus a **CPU limit** (already set in `20-compute.yaml` / `compute-app.template.yaml`).
Without a CPU limit the autoscaler treats CPU as unbounded and never resizes it.

**Metrics** (`:9092/metrics`): `writer_autoscaler_checks_total`,
`writer_autoscaler_resize_total{direction,resource}`,
`writer_autoscaler_needs_bounce_total`, `writer_autoscaler_errors_total`,
`writer_autoscaler_writers`.

**Drill:** `deploy/_verify-writer-autoscaler.sh` drives a writer's CPU up, asserts
an in-place resize with `restartCount` unchanged, then idles it and asserts the
scale-down under hysteresis.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Client: `compute unavailable` after ~2 min | Wake timed out. `kubectl -n scale-zero-pg describe pod -l app=compute` — image pull? Pending (resources)? `wait-timeline` init stuck (pageserver down or storage-init never ran)? |
| Intermittent cold-wake failures coinciding with apiserver load / `pggw_wake_retries_total` climbing | A **transient** apiserver blip on the 0→1 scale call. Since #190 these are retried within the wake budget (bounded by `GW_WAKE_TIMEOUT_MS`) instead of failing the client. If `pggw_wake_retries_total` rises but `pggw_wake_failures_total` stays flat, retries are absorbing the blips — no action. If **both** rise, the apiserver is out for longer than the budget: check control-plane health. See [Transient apiserver blips on the wake scale call (#190)](#transient-apiserver-blips-on-the-wake-scale-call-issue-190). |
| Compute crashloops with `TENANT_ID ... must set` | `compute-config` ConfigMap missing/edited — re-apply `54-compute-files.yaml`, re-run `55-storage-init.yaml`. |
| Compute Running but clients hang | Check pageserver/safekeeper pods; `kubectl logs deploy/compute -c compute` (look at `total_startup_ms` line — healthy is ~150ms). |
| DB never scales to zero | An app pool is holding idle connections (`pggw_active_connections` > 0), or a peer gateway is unreachable (peer check fails ⇒ sleep is postponed by design — see gateway logs "postponing sleep"). |
| First query after idle is slow | That's the wake (~2.5s). Only sub-second option today: keep it awake (`replicas: 1` + `GW_IDLE_MS=0`) or wait for the warm-standby pool (TASKS.md phase 3). |
| `password authentication failed` after redeploy | The spec reset the role password (by design). See rotation above. |
| Verify scripts fail on a fresh cluster | Order matters only the first time: storage pods Ready → `storage-init` Complete → everything else is self-healing. |

### Transient apiserver blips on the wake scale call (issue #190)

The gateway wakes a compute by scaling its Deployment 0→1 through the Kubernetes
API (`GetScale`→`UpdateScale`). On a flaky control plane (the recurring OKE
symptom that wedged live drills), a **single** transient error on that scale call
— a TLS handshake timeout, a 5xx, a throttle (`429`), an optimistic-concurrency
`Conflict`, a context deadline — used to surface immediately as a **client**
cold-wake failure (`pggw_wake_failures_total`).

Since #190 the scale call is wrapped in **bounded idempotent retry with
exponential backoff + jitter**:

- **Idempotent, so retry is safe.** `GetScale`→`UpdateScale` only converges the
  replica count to the wake target; re-issuing it can never over-scale (single-writer
  is intrinsic to Neon — never two writer computes on one timeline).
- **Transient → retry; terminal → fail loud.** Retryable: apiserver
  timeout/5xx/throttle/`Conflict`/`Internal`, network errors, context deadlines.
  Terminal (immediate fail, **no** retry, no budget burn): `NotFound` (the
  Deployment doesn't exist — a misconfig), `Forbidden`/`Unauthorized` (RBAC),
  `Invalid`/`BadRequest`, `Gone`, and a wake-budget refusal (#116).
- **Bounded by the wake budget.** Total retry time is clamped to
  `GW_WAKE_TIMEOUT_MS`; a genuinely-down apiserver still fails **bounded** — no
  hang past the timeout. `GW_WAKE_MAX_ATTEMPTS` is a belt-and-braces attempt cap.
  Since #192 **each individual scale attempt is also deadline-boxed** at the same
  budget (a `context.WithDeadline` threaded into the client-go call), so even a
  single `GetScale`/`UpdateScale` that *hangs* is cancelled at the deadline rather
  than consuming the client past the budget. No new knob — derived from
  `GW_WAKE_TIMEOUT_MS`.
- **Healthy path unchanged.** Retry fires only on error, so a normal wake pays
  zero added latency.
- **Observability.** Each **genuine** retried blip bumps `pggw_wake_retries_total`
  and logs `transient wake scale error (attempt N), retrying within wake budget`.
  Since #192 a client hang-up (ctx cancel) *during* backoff no longer counts as a
  retry — the metric reflects only attempts the gateway actually re-issued. A rising
  `pggw_wake_retries_total` with a flat `pggw_wake_failures_total` is
  *retried-then-succeeded*; rising alongside `pggw_wake_failures_total` is
  *failed-after-retries* (sustained outage). Tune with `GW_WAKE_RETRY_BASE_MS` /
  `GW_WAKE_MAX_ATTEMPTS`.

The same retry covers the mid-handshake re-wake path (a backend that drops the
startup during a slow cold start), since that also routes through the wrapped
scale call.

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
the **live** running digest equals a manifest-pinned digest — matched against the
pulled reference in `.status.image` **or** the `imageID`, so a rebuilt-but-not-rolled
or stale-tag binary can no longer pass drift-green). Matching either field is what
keeps **OCI-index** images (docker buildx attestations — e.g. `appdb-operator`) from
false-firing: their `imageID` is the child *config* digest, a different `sha256` than
the index/manifest digest the manifest pins (issue #153).

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
sh deploy/_verify-drift.sh                   # live digest (.status.image|imageID) == a manifest-pinned digest
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

**Janitor-disarm tripwire (issue #142).** The WAL-bound alerts above
(`WalJanitorJobFailed`, `WalJanitorStale`, `SafekeeperWALGrowth`, `ReplicationSlot*`)
all key off a **Failed Job** — but a janitor/monitor whose container **never starts**
(a janitor-critical ConfigMap like `storage-objstore` was deleted, e.g. as residue
from a throwaway drill in the main namespace → `CreateContainerConfigError`) produces
**no** Failed Job, so every one of them stays silent and the only backstop was
`WalJanitorStale` at **>26h** — long enough for `/safekeeper` WAL to accumulate toward
a node **DiskPressure** (the 2026-07-06 incident). `JanitorConfigDisarmed`
(`deploy/60`) closes that at the source: it reads the **pod's** waiting-reason from
kube-state-metrics directly and pages **within one cycle**, for the nightly wal-janitor
**and** the zone repl-slot monitors (same shared-config/exec coupling class). Proven
live by `deploy/_verify-zone-deploy.sh disarm` (a simulated missing ConfigMap makes the
alert fire in one cycle, not 26h). This is a *durability* tripwire under KC-class
"restore RTO / disk" — it does not add a new KC row; it removes a silent hole beneath
the existing WAL-bound criteria.

**Accepted security residuals (OWNED, not KC rows).** Bounded, documented risks the
owner has explicitly **accepted** (severity LOW, no in-repo fix warranted) — recorded
here so they are owned decisions, not future "discoveries":

| Residual | Class | Bound | Fix posture |
|---|---|---|---|
| **md5 cold-wake downgrade window (#158)** | hash downgrade, not bypass | ~85 ms, **cold-wake-only**, **md5-era apps only**; new apps SCRAM-durable & never affected; #112 closes the cross-tenant direct-dial step | Accept & document (2026-07-12). No `compute_ctl` patch (hard rule 5), no gateway pre-auth (ADR-0008 Option A rejected). Likely closed incidentally by the `/status` gate (#181 shipped / #182 live-enable) — **to be validated in the #182 drill**; true fix upstream. See "Accepted residual: md5 cold-wake downgrade window (#158)" above. |
| **Wake is triggerable, not pre-authenticated (#116 / ADR-0008)** | denial/cost side-channel | per-app wake budget + `53400` refusal + `WakeBudgetExceeded` alert; reachability-removal deferred to #118 (CNI) | Accept (B now + C via #118). ADR-0008 (ACCEPTED 2026-07-12). |

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

**Executed for real — `deploy/_verify-upgrade.sh` (issue #98, GA gate).** The
rehearsal only boots the new tag clean-slate; this drill proves the thing an
operator actually needs — that **real data written on the old tag survives a
rolling image upgrade** — and measures the outage. On a throwaway plane
(ns `upgrade-exec`, OCI Object Storage as the durability tier per #105, no
in-cluster MinIO), it: (1) boots the plane at **8464**, (2) seeds a `ledger` table
and **durably offloads** it (remote_consistent_lsn past the seed marker — safe
even if every PVC is lost), (3) rolls broker→safekeeper→pageserver→compute images
to **`17411840350`** together (version pair honored) via `kubectl set image`, and
(4) asserts the data survived + a new write works + the control file is still v9.

```
# execute the upgrade drill (throwaway ns; live plane untouched):
KSPG_CONTEXT=context-ckmva7v7zvq deploy/_verify-upgrade.sh
# USE_MINIO=1 …            # in-drill MinIO instead of OCI OS
# OLD_TAG=8464 NEW_TAG=…   # override the tag pair
# exit 0 = data survived + control still v9 (manifest bump); 3 = survived but format
#          diverged (skctl-rewrite / KC1 pivot); 1 = failure.
```

**Executed result (OKE, 2026-07-04):** upgrade **8464 → 17411840350** ran clean.
All **5000 seeded rows survived with an identical checksum** on the new tag, a new
write was accepted, and the upgraded safekeeper's `safekeeper.control` was still
`magic=0xcafeceef version=9` (`skctl checkver` SURVIVES) — **the executed upgrade
was a MANIFEST BUMP, not an skctl rewrite.** A post-upgrade wake cycle came back in
4s with data intact. **Client downtime = 2m49s warm / ~7m45s cold**, dominated by
the per-node multi-GB image pull, not plane mechanics (numbers + the pre-pull
mitigation are in `docs/BENCHMARKS.md` §"Upgrade EXECUTED").

**Rollback posture (mandatory before any real upgrade).** Neon has **no in-place
downgrade**: the pageserver may migrate layer/index formats forward, so you cannot
simply re-pin the old `neon:` tag on a plane that has already served writes on the
new one. The two legs:
- **Compute is stateless → its rollback is trivial and safe.** If only the compute
  misbehaves post-roll, `kubectl set image deploy/compute …=<OLD_TAG>` (matching
  the storage tag it was paired with) reverts it with no data implications. This
  leg is proven cheap by design (the compute holds no durable state).
- **Storage rollback = restore-from-backup at the old tag, NOT downgrade.** Take an
  **on-demand backup before the storage roll**
  (`kubectl -n scale-zero-pg create job backup-now --from=cronjob/backup`; see
  "Backup & disaster recovery"). If the storage plane must go back, stand up a
  **fresh** plane on the old tag and **restore that backup** into it (the writable
  restore path, `deploy/_restore-writable.sh`) — you do not roll the live
  safekeeper/pageserver images backward. Because the executed drill kept the
  control format at **v9**, the old-tag skctl craft still matches, so a restore is a
  normal restore (not a re-RE project). **Tested:** the forward upgrade + survival
  is executed and green (above); the compute-image rollback leg is trivially safe
  by construction; the **storage restore-from-backup rollback was NOT exercised in
  this drill** (it is the standard, already-drilled restore path — see
  `_verify-restore.sh` / `_verify-app-restore.sh` — pointed at an old-tag plane).

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
