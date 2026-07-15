# Operator high availability

> Issue #307. The kn-next operator is the control-plane linchpin: it reconciles
> every `NextApp` CR into its Knative Service, assets, database binding, and
> zone wiring. This document is the HA story — how the operator survives a crash,
> an OOM-kill, a node drain, or a rolling update **without stalling
> reconciliation**, and exactly what does and does not break when it is down.

## TL;DR

- The operator Deployment runs **2 replicas** behind **leader election**.
- Only the current Lease holder reconciles → there is still **exactly one active
  writer** (ADR-0001). The second replica is a warm standby.
- Killing/draining the leader hands the Lease to the standby, which resumes
  reconciliation within a second or two — **no reconciliation gap** that a human
  would notice.
- **Blast radius when the operator is fully down:** already-deployed apps
  **keep serving traffic**. Only *reconciliation* pauses — new/changed
  `NextApp`s aren't applied until an operator replica is back.

## How it works

### Leader election (single active writer)

`cmd/main.go` runs the manager with leader election enabled
(`--leader-elect`, `buildManagerOptions`). Both replicas contend on a single
`coordination.k8s.io` **Lease** (`leaderElectionID = 2dd0b3e2.kn-next.dev`):

- The replica that holds the Lease is the **leader** and is the only one running
  the `NextApp` reconciler and the validating webhook's reconcile side-effects.
- The other replica is **fully started but idle** — its caches are warm and it
  is ready to acquire the Lease the moment the leader stops renewing it.

This preserves the **single-source-of-truth / single-writer** invariant of
ADR-0001: horizontal replicas give us *availability*, not concurrent writers.
Two active reconcilers would be a split-brain footgun (racing Service/asset
writes), so a `replicas: 2` Deployment **without** leader election is explicitly
disallowed — a contract test (`internal/install/ha_test.go`) fails if the
`--leader-elect` flag is ever dropped.

`LeaderElectionReleaseOnCancel` is **on**: when a leader is stopped *gracefully*
(rolling update, `kubectl drain`, SIGTERM) it **releases the Lease on the way
out**, so the standby takes over immediately instead of waiting the full
`LeaseDuration` (~15s) for the stale Lease to expire. This is safe because
`main()` does no work after `mgr.Start()` returns — the process exits the instant
the manager stops.

### RBAC

Leader election needs `get/list/watch/create/update/patch/delete` on
`coordination.k8s.io/leases` (and `events`); these are granted by
`config/rbac/leader_election_role.yaml`, bound to the manager ServiceAccount.

### Resource requests + limits

The manager container declares both **requests** and **limits** for CPU and
memory (`config/manager/manager.yaml`). Requests keep each replica schedulable
(and keep the PodDisruptionBudget honest); limits bound a runaway/leaking
operator so it can't starve co-tenants — and if it does exceed memory it is
OOM-killed and restarted rather than degrading the whole node.

### Health probes and restart behaviour

Both probes hit the health-probe port (`:8081`):

- **Liveness** — `GET /healthz` (a plain Ping). A pod merely *waiting on
  cert-manager's cert mount* is alive; it must go **NotReady**, never
  crash-loop. If the process wedges, liveness fails and the kubelet restarts it
  with the standard exponential back-off.
- **Readiness** — `GET /readyz`. In-cluster this additionally gates on the
  validating webhook's TLS listener (#252): a replica is **NotReady** until it
  can actually admit `NextApp`s, so a rolling update never removes the last
  serving replica before the new one can admit writes.

Readiness failures **never restart** the pod — they only pull it out of
rotation — so slow cert issuance delays Ready instead of triggering a crash
loop.

### PodDisruptionBudget + anti-affinity

- **PDB** (`config/manager/pdb.yaml`): `minAvailable: 1`. Across *voluntary*
  disruptions (node drains, cluster upgrades) at least one replica stays up, so
  leader election always has a live candidate. It is deliberately **not**
  `minAvailable: 2` / `maxUnavailable: 0` — with only 2 replicas a stricter
  budget would block node drains and deadlock cluster maintenance.
- **Soft pod anti-affinity** (`preferredDuringScheduling…`): the scheduler
  *prefers* to place the 2 replicas on different nodes so a single node loss
  can't take out both. It stays **soft** on purpose — hard anti-affinity would
  strand the 2nd replica `Pending` forever on single-node / kind / CI clusters.

### Digest-pinned image

The operator image is **digest-pinned** (`@sha256:…`, never `:latest`) in
`config/manager/kustomization.yaml` (CLAUDE.md §4). An operator that silently
pulled a moving tag on restart would defeat the whole HA story — a restart could
quietly change the reconciler's behaviour.

## Blast radius: what breaks when the operator is down

| Operator state | Running apps serve traffic? | Reconciliation of `NextApp` changes |
| --- | --- | --- |
| 1 of 2 replicas down | ✅ yes | ✅ standby holds/takes the Lease — no gap |
| Both replicas down (total outage) | ✅ **yes — apps keep serving** | ⏸️ paused until a replica returns |

Why apps keep serving: the operator only **reconciles desired state into
Knative/K8s objects**. Once an app's Knative Service, Revision, and routing are
applied, they are owned and run by **Knative + Kubernetes**, not by the
operator. Serving requests, scale-to-zero, and cold starts all continue with the
operator absent. What you lose while the operator is down is *convergence*:

- new or edited `NextApp`s are not applied,
- deletions/finalizers (ADR-0008) don't progress,
- drift isn't corrected.

All of that simply **resumes** — from the live cluster state — as soon as an
operator replica comes back and acquires the Lease. There is no data loss,
because the `NextApp` CRs remain the source of truth in etcd the entire time.

## Verifying failover

```sh
# 2 replicas, exactly one leader:
kubectl -n kn-next-operator-system get deploy controller-manager      # READY 2/2
kubectl -n kn-next-operator-system get lease 2dd0b3e2.kn-next.dev \
  -o jsonpath='{.spec.holderIdentity}{"\n"}'                          # -> pod A

# Kill the leader; the standby should pick up the Lease within ~1–2s:
kubectl -n kn-next-operator-system delete pod <leader-pod>
kubectl -n kn-next-operator-system get lease 2dd0b3e2.kn-next.dev \
  -o jsonpath='{.spec.holderIdentity}{"\n"}'                          # -> pod B

# Apply a NextApp change during/after the swap — it still reconciles.
```
