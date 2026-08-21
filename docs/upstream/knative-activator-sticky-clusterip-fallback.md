# DRAFT upstream issue — knative/serving: activator revisionWatcher's clusterIP fallback is sticky and never retries pod-direct probing

> Status: DRAFT — posting to github.com/knative/serving is a public action and waits for the
> maintainer's go-ahead. Evidence measured 2026-08-21 on OKE (k8s 1.34, Knative Serving
> activator commit 370ad5a per its own logs, flannel CNI, Kourier ingress).

## Summary

When the activator's `revisionWatcher` falls back from pod-direct probing to clusterIP probing
(`podsAddressable = false` in `pkg/activator/net/revision_backends.go`), the fallback is **sticky
for the watcher's lifetime**: no later success ever returns it to pod-direct mode. On our cluster
this added a consistent **~1.2–1.7s to every scale-from-zero wake** of the affected revision,
silently, for what was likely days — the regression is invisible unless someone decomposes wake
latency.

## Evidence

Four consecutive cold wakes (scale-to-zero revision, in-cluster requester, pod condition
timestamps vs activator log timestamps):

| wake | pod Ready (kubelet) | throttler `backends = 1` (activator log) | gap |
|---|---|---|---|
| 1 | 09:00:56 | 09:00:57.758 | ~1.76s |
| 2 | 09:05:28 | 09:05:29.640 | ~1.64s |
| 3 | 09:07:18 | 09:07:19.635 | ~1.64s |
| 4 | 09:09:08 | 09:09:09.934 | ~1.93s |

During each gap the activator logs a `connection refused` retry loop against the revision's
**private-Service clusterIP** (`error roundtripping http://10.96.174.147:80/healthz: dial tcp …
connect: connection refused`, from `revisionWatcher.checkDests`), i.e. it is waiting on
kube-proxy dataplane programming before it can see the pod that kubelet already reported Ready.
Throttler updates during this period show clusterIP tracking: `clusterIP = 10.96.174.147:80,
trackers = 0, backends = 1`.

After `kubectl rollout restart deploy/activator` (nothing else changed), three consecutive wakes
of the same revision:

| wake | pod Ready | throttler `backends = 1` | gap |
|---|---|---|---|
| 1 | 09:11:05 | 09:11:05.144 | ~0.14s |
| 2 | 09:12:55 | 09:12:55.540 | ~0.54s |
| 3 | 09:14:45 | 09:14:45.859 | ~0.86s |

Throttler updates now show pod-direct tracking: `clusterIP = <nil>, trackers = 1, backends = 1`.
Same revision, same cluster, same hour — the only difference is fresh watcher state.

## Likely trip cause (not directly observed)

The cluster had a since-fixed period of fresh-pod SYN drops (conntrack race class) during which
pod-direct probes would have failed repeatedly — consistent with `checkDests` deciding pods are
not addressable. Retained activator logs no longer cover the trip moment, so this is inference
from the failure signature, stated as such.

## Why this deserves a fix (or at least a signal)

- The fallback exists for meshes where pod IPs are genuinely unreachable — reasonable. But on a
  non-mesh cluster a *transient* network fault permanently degrades every future cold start of
  the revision, and nothing surfaces it: no metric, no event, no log at trip time that an
  operator would alert on.
- Suggested directions (either would do):
  1. Periodically re-attempt pod-direct probing after the fallback (e.g. exponential backoff
     capped at minutes), restoring the fast path when the network heals; or
  2. Emit a metric/event when a revision's watcher is in clusterIP mode while its pods are
     Ready, so operators can detect and remediate (today the only remedy is an activator
     restart, which is invisible folklore).

## Environment

- Knative Serving activator log `commit: 370ad5a`
- Kubernetes 1.34 (Oracle OKE), flannel CNI (no NetworkPolicy enforcement), Kourier
- Non-mesh; `config-network` defaults except `ingress-class`; `config-observability` defaults
