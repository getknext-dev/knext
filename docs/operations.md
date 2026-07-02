# Operations guide

Day-2 reference for running the platform: configuration, monitoring, failure
behavior, and troubleshooting.

## Gateway configuration (env on `deploy/pggw`)

| Variable | Default | Meaning |
|---|---|---|
| `GW_PORT` | 55432 | Postgres wire listener |
| `GW_METRICS_PORT` | 9090 | `/metrics` (Prometheus), `/metrics.json`, `/healthz` |
| `GW_COMPUTE_MODE` | static | `static` \| `exec` \| `kubectl` \| `template` |
| `GW_TARGET` | 127.0.0.1:55432 | compute address (static/exec/kubectl) |
| `GW_K8S_NAMESPACE` / `GW_K8S_DEPLOYMENT` | scale-zero-pg / compute | what `kubectl` mode scales 0↔1 |
| `GW_TARGET_TEMPLATE` / `GW_K8S_DEPLOYMENT_TEMPLATE` | — | `template` mode: `{system}` = database name (multi-DB, parked) |
| `GW_IDLE_MS` | 300000 | idle window before scale-to-zero (deployed: 60000) |
| `GW_WAKE_TIMEOUT_MS` | 60000 | give up waking after this (deployed: 120000) |
| `GW_CONNECT_TIMEOUT_MS` / `GW_RETRY_MS` | 1000 / 250 | per-attempt connect timeout / poll interval (deployed retry: 100) |
| `GW_PEER_SELECTOR` | — | label selector for sibling gateways (peer-aware idle); empty disables |
| `GW_POD_NAMESPACE` / `GW_POD_IP` | — | downward API; self-exclusion for the peer check |

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

**Alert on:** `wake_failures_total` increasing; a system whose `active_connections`
is 0 for hours but never sleeps (phantom keepalive — usually a client pool holding
idle connections; see [connecting](connecting.md#connection-pooling-rules));
`wake_latency_ms_last` drifting above ~5s (node image/pressure problem).

Quick look without Prometheus: `sh deploy/_metrics.sh`.

## Durability model (what you can lose, and when)

- A **committed write is durable once 2/3 safekeepers ack** its WAL. Losing any one
  safekeeper pod/PVC loses nothing and doesn't block writes (drill-verified).
- The **compute is disposable** — kill it any time; no volume, no restore. Data is
  never in the pod.
- **Pageserver loss** (single, MVP): serving stops until it restarts (PVC-backed);
  history also lives in MinIO. Production: add a secondary pageserver.
- **MinIO loss**: running computes keep serving from safekeepers+pageserver; new
  timeline creation and long-term history offload pause. PVC-backed.
- **Both gateways down**: new connections fail (existing pipes drop); data unaffected.

## Password rotation

`ALTER USER ... PASSWORD` does **not** stick — `compute_ctl` re-applies the spec's
roles on every boot. To rotate:

1. Compute the hash: `md5` of `password + username`, e.g.
   `printf 'NEWPASScloud_admin' | md5`.
2. Put it in `roles[].encrypted_password` inside `deploy/54-compute-files.yaml`
   (the `config.json` key) and `kubectl apply -f deploy/54-compute-files.yaml`.
3. Update the app Secrets (`30-knext-secret.yaml`) and restart the compute:
   `kubectl -n scale-zero-pg rollout restart deploy/compute`.

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
- **Compute ↔ storage are a version PAIR.** The compute (`compute-node-v17:8464`)
  and storage plane (`neon:8464`) are built from the same Neon release and must be
  upgraded together — the pageserver wire protocol and layer formats are internal
  interfaces with no cross-version guarantee. Supported pair today: **8464 + 8464**.
- **Upgrade procedure** (both images): bump both tags in `deploy/` on a throwaway
  cluster, run the full verify battery, then promote. Never `:latest` anywhere.
  The compute is stateless so its rollback is trivial; storage rollback is NOT
  (layer formats may migrate forward) — snapshot PVCs/bucket before a storage bump.
