# Runbook — Rollback

Two independent rollback paths:

- **[Part A](#part-a--roll-back-a-bad-app-release-traffic-split)** — a bad **app**
  release, reverted by shifting Knative traffic to a prior revision (ADR-0014).
- **[Part B](#part-b--roll-back-a-bad-operator-upgrade)** — a bad **operator**
  upgrade, reverted by rolling the manager image back (HA leader-election
  failover keeps reconciliation live).

They do not interact: an app rollback is a `NextApp` CR field; an operator
rollback is a Deployment change in `kn-next-operator-system`.

---

## Part A — Roll back a bad app release (traffic split)

This is the **ADR-0014** path. `kn-next deploy` produces a new Knative
**Revision**; you revert by pinning serving traffic to a prior revision via
`NextApp.spec.traffic`. The operator is the sole writer of `ksvc.spec.traffic`
(ADR-0001) — the CLI only patches the CR. This is the same procedure as
[incident.md § Scenario 4](./incident.md#scenario-4-rollback--bad-revision);
it lives here too as the canonical rollback reference.

### 1. Identify the last-good revision

```sh
# What is serving right now:
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.currentTraffic}' | jq

# Revisions newest-last — pick the last-good name, e.g. <app>-00007:
kubectl get revision -n <ns> -l serving.knative.dev/service=<app> \
  --sort-by=.metadata.creationTimestamp
```

### 2. Pin traffic to it

Preferred — the CLI (`kn-next rollback` only `kubectl patch`es the CR; it never
mutates the ksvc, honouring ADR-0001). Flags are exactly those parsed in
[`packages/kn-next/src/cli/rollback.ts`](../../packages/kn-next/src/cli/rollback.ts):

```sh
# 100% back to the last-good revision:
kn-next rollback <app> --to <app>-00007 -n <ns>

# Cautious canary — send N% (1..99) to latest-ready, the rest to the pinned revision:
kn-next rollback <app> --to <app>-00007 --canary 10 -n <ns>

# After the fix is deployed, clear the pin to resume latest-ready:
kn-next rollback <app> -n <ns>
```

Equivalent raw CR edit (`spec.traffic`, fields from
[`api/v1alpha1/nextapp_types.go`](../../packages/kn-next-operator/api/v1alpha1/nextapp_types.go)):

```sh
kubectl patch nextapp <app> -n <ns> --type merge -p \
  '{"spec":{"traffic":{"revisionName":"<app>-00007","canaryPercent":10}}}'
```

- `spec.traffic.revisionName` — pins serving traffic to that prior revision
  (empty ⇒ latest-ready, no pin).
- `spec.traffic.canaryPercent` — `1..99` sends that % to **latest-ready** and the
  remainder to the pinned revision; `0`/unset ⇒ 100% pinned.

### 3. Verify

```sh
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.currentTraffic}' | jq
```

`status.currentTraffic` should report the pinned revision serving the expected
percentage; `KnextHighErrorRate` / `KnextNextAppDegraded` should clear within the
alert's `for:` window.

### Gotcha — the pinned revision was garbage-collected

If you pin a revision Knative has already reaped, the operator surfaces it as
`Ready=False` / `Degraded=True`, reason **`PinnedRevisionNotFound`** (ADR-0014,
with an actionable message). Fix by re-pinning to an existing revision:

```sh
kubectl get revision -n <ns> -l serving.knative.dev/service=<app>   # list existing
kn-next rollback <app> --to <an-existing-revision> -n <ns>          # re-pin
# or clear the pin to resume latest-ready:
kn-next rollback <app> -n <ns>
```

> Rollback interacts safely with asset skew protection (ADR-0011): any revision
> named in `status.currentTraffic` is treated as **live**, so the build-id GC
> never reaps its assets — a rolled-back/canary revision keeps serving its own
> chunks.

---

## Part B — Roll back a bad operator upgrade

Use this when an [operator upgrade](./upgrade.md) itself regressed — the manager
crash-loops, floods `reconcile_errors`, or a bad image reconciles apps wrongly.
The manager runs **2 replicas behind leader election** (HA, #307), so only the
lease holder reconciles and a standby is always ready to take over.

### 1. Confirm it is the operator, not an app

```sh
kubectl get pods -n kn-next-operator-system
kubectl logs -n kn-next-operator-system \
  deploy/kn-next-operator-controller-manager --tail=200 | grep -i 'error\|panic\|leaderelection'
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # the suspect digest
```

### 2. Revert the manager image

**Option A — roll back to the previous pod template (fastest).** The Deployment
keeps its prior ReplicaSet, so this reverts to the exact previous digest without
needing the old bundle on hand:

```sh
kubectl rollout undo deploy/kn-next-operator-controller-manager \
  -n kn-next-operator-system

# or to a specific prior revision from the history:
kubectl rollout history deploy/kn-next-operator-controller-manager -n kn-next-operator-system
kubectl rollout undo deploy/kn-next-operator-controller-manager \
  -n kn-next-operator-system --to-revision=<N>
```

**Option B — re-apply the known-good bundle (authoritative).** If the CRD/RBAC
also changed in the bad upgrade, re-apply the previous release's full bundle so
CRD + RBAC + manager all revert together:

```sh
kubectl apply --server-side -f \
  https://github.com/getknext-dev/knext/releases/download/<last-good-tag>/install.yaml
```

> If the bad upgrade included a **breaking CRD change**, reverting the CRD may
> reject `NextApp` objects written in the new shape. Re-apply your apps' intent
> after the CRD revert — see
> [upgrade.md § CRD migration](./upgrade.md#crd-migration-breaking-alpha-change).

### 3. Force leader-election failover (if a bad pod holds the lease)

If the reverted (or a wedged) pod is still the leader and reconciliation is
stuck, hand the lease to the healthy replica by deleting the wedged pod. Leader
election re-elects within the lease's renew/expiry window:

```sh
# Who holds the lease now:
kubectl get lease -n kn-next-operator-system -o wide

# Delete the wedged leader pod; the standby acquires the lease and reconciles.
# (Deployment recreates the deleted pod; PDB minAvailable:1 keeps a candidate up.)
kubectl delete pod <wedged-leader-pod> -n kn-next-operator-system
```

> Never scale the manager to 0 to "reset" it — that removes every lease candidate
> and halts reconciliation platform-wide. Deleting one pod is enough; the standby
> takes over immediately.

### 4. Verify recovery

```sh
kubectl rollout status deploy/kn-next-operator-controller-manager \
  -n kn-next-operator-system --timeout=180s
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # back to the good digest
kubectl get lease -n kn-next-operator-system                      # a healthy holder
kubectl get nextapp -A                                            # apps Ready again
kubectl logs -n kn-next-operator-system \
  deploy/kn-next-operator-controller-manager --tail=100 | grep -i error   # quiet
```

---

## See also

- [upgrade.md](./upgrade.md) — the forward path these rollbacks reverse.
- [incident.md § Scenario 4](./incident.md#scenario-4-rollback--bad-revision) — app rollback in the incident-response flow.
- [ADR-0014](../adr/0014-rollback-traffic-split.md) — rollback via Knative traffic split.
- [ADR-0001](../adr/0001-operator-single-source-of-truth.md) — operator is the single source of truth.
