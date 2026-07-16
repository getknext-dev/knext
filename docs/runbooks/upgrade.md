# Runbook — Operator + CRD upgrade

How to roll a new `kn-next-operator` image and CRD onto a live cluster safely.
Grounded in the operator's real install path
([`docs/QUICKSTART.md` § Step 1](../QUICKSTART.md#step-1--install-the-operator)),
its digest-pinning contract
([`config/manager/kustomization.yaml`](../../packages/kn-next-operator/config/manager/kustomization.yaml),
[`config/manager/manager.yaml`](../../packages/kn-next-operator/config/manager/manager.yaml)),
and the CRD-versioning decision in
[ADR-0017](../adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md).

> **Single-writer, single-version.** The operator is the only writer of cluster
> state (ADR-0001) and the CRD is served at one version only,
> `apps.kn-next.dev/v1alpha1` — there is **no conversion webhook** (ADR-0017).
> An upgrade is therefore "apply a newer bundle + let the manager reconverge",
> not a multi-version migration dance.

---

## Version-skew policy

| Axis | Policy |
| --- | --- |
| **CRD API version** | Stays `v1alpha1`; single served/stored version, **no conversion webhook** (ADR-0017). Kubernetes' own convention is that `vNalphaM` carries **no** compatibility guarantee — knext honours that honestly. **Breaking CRD schema changes are allowed at alpha and are called out in the release notes** for that version. |
| **Interim stability surface** | What you may build CI/CD and dashboards on is the **status contract**, not the API version: honest `.status.conditions[Ready]` (gated on the child Knative Service's own readiness, #145) plus the `URL` / `Ready` / `Age` printcolumns. Those do not break silently. |
| **Operator ⇄ CLI (`kn-next`)** | The CLI only ever emits intent (patches the `NextApp` CR); it never writes Knative objects (ADR-0001/0014). Run a CLI whose `NextApp` fields the deployed operator understands. On a breaking CRD bump, upgrade the operator **first**, then the CLI. |
| **Operator ⇄ Knative** | The operator reconciles Knative Serving objects and ships the `config-network` / `config-features` ConfigMaps it needs. Follow Knative's own skew policy for Serving itself; the operator does not pin a Knative version. |
| **Asset / build-id skew** | Independent of operator version: in-flight clients on an older build keep working because assets are build-id-namespaced and uploads are additive (ADR-0011). Upgrading the operator does not reap live builds. |

**Rule of thumb:** read the release notes for the target version first. If they
list a **breaking CRD change**, treat the upgrade as a schema migration (see
[CRD migration](#crd-migration-breaking-alpha-change) below); otherwise it is a
plain rolling image update.

---

## Preconditions

```sh
# You are on the right cluster/context.
kubectl config current-context

# cert-manager is present (the bundle ships the webhook's serving Certificate;
# the manager stays NotReady until the cert is mounted and the webhook can admit).
kubectl get pods -n cert-manager

# Current operator + CRD state, so you can compare after.
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl get crd nextapps.apps.kn-next.dev \
  -o jsonpath='{.spec.versions[*].name}{"\n"}'    # → v1alpha1
```

---

## 1. Roll a new operator image (digest-pinned)

The install bundle (`install.yaml`) is **digest-pinned**: `config/manager`'s
`images:` entry rewrites the logical `controller` name to
`ghcr.io/getknext-dev/kn-next-operator:<tag>@sha256:<digest>` in every rendered
bundle, and `hack/check-no-latest.sh` fails the build if a `:latest` or
un-pinned ref sneaks in. So an upgrade is: apply a **newer** bundle.

```sh
# (Recommended) verify the image signature before trusting the new bundle.
# cosign keyless-signed via Sigstore (operator-supply-chain.yml):
curl -sL -o install-new.yaml \
  https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
grep 'image: ghcr.io/getknext-dev/kn-next-operator' install-new.yaml   # note the @sha256 digest

cosign verify ghcr.io/getknext-dev/kn-next-operator@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/getknext-dev/knext/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Apply the newer bundle (same `--server-side` flag as install, so the
`config-network` / `config-features` ConfigMaps **merge** into Knative's copies
rather than replacing them):

```sh
kubectl apply --server-side -f install-new.yaml
```

> To pin an exact release instead of `latest`, use the versioned asset URL:
> `.../releases/download/<tag>/install.yaml`.

### Watch the roll

The manager runs **2 replicas behind leader election** (HA, #307). A rolling
update replaces one pod at a time; the standby holds the lease so reconciliation
never stops.

```sh
kubectl rollout status deploy/kn-next-operator-controller-manager \
  -n kn-next-operator-system --timeout=180s

# Confirm the new digest is live:
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Which replica currently holds the leader lease:
kubectl get lease -n kn-next-operator-system
```

> **Readiness gates on the webhook, by design.** `/readyz` only passes once the
> manager's TLS webhook listener is up (`StartedChecker`, #252), so a new pod
> stays `NotReady` — and the Deployment un-`Available` — until cert-manager has
> issued/mounted the cert and the `failurePolicy=Fail` validating webhook can
> admit `NextApp`s. A slow cert issuance just delays Ready; it does **not**
> restart the pod. Wait it out rather than forcing a restart.

### From-source alternative (in-cluster dev / custom digest)

If you build the operator yourself, the Makefile targets set the image the same
digest-pinned way (they run `kustomize edit set image controller=$IMG`):

```sh
cd packages/kn-next-operator
make deploy IMG=ghcr.io/getknext-dev/kn-next-operator:<tag>@sha256:<digest>
```

`IMG` must be a `@sha256:`-pinned ref — the operator rejects un-pinned images and
the no-`:latest` guard enforces it in CI.

---

## 2. CRD upgrade

### Non-breaking (the common case)

Applying the newer `install.yaml` (step 1) already re-applies the CRD. A
**purely additive** schema change (new optional fields, new printcolumns) needs
no migration — existing `NextApp` objects remain valid and the operator
reconverges them.

```sh
# CRDs only, if you want to stage them ahead of the manager:
kubectl apply --server-side -f install-new.yaml   # bundle includes the CRD
kubectl get crd nextapps.apps.kn-next.dev -o jsonpath='{.spec.versions[*].name}{"\n"}'
```

> `--server-side` matters: the NextApp CRD's OpenAPI schema is large, and a
> client-side `kubectl apply` can trip the `metadata.annotations` last-applied
> size limit. Server-side apply avoids it.

### CRD migration (breaking alpha change)

There is **no conversion webhook** (ADR-0017), so a breaking schema change cannot
be auto-migrated. When the release notes flag a breaking CRD change:

1. **Read the release notes' migration section** — it is the authoritative list
   of renamed/removed/retyped fields for that version.
2. **Inventory affected objects** before upgrading:
   ```sh
   kubectl get nextapp -A -o yaml > nextapps-backup-$(date +%F).yaml
   ```
3. **Apply the new CRD** (`kubectl apply --server-side -f install-new.yaml`).
4. **Re-apply each `NextApp` with the corrected fields.** Because the CLI only
   emits intent, the cleanest path is to re-run your source of truth:
   ```sh
   kn-next deploy         # from the app dir — re-emits the CR in the new shape
   # or hand-edit + re-apply the CR:
   kubectl apply -f <app>-nextapp.yaml
   ```
5. **Verify** the operator accepts and reconverges each app (next section).

> Since the API is single-version, there is nothing to "convert between" — the
> migration is a re-apply of intent, not a stored-version rewrite.

---

## 3. Post-upgrade verification

```sh
# Manager healthy, new digest, both replicas Available:
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system

# CRD served version unchanged (v1alpha1) and established:
kubectl get crd nextapps.apps.kn-next.dev \
  -o jsonpath='{.status.conditions[?(@.type=="Established")].status}{"\n"}'   # → True

# Every app still reports Ready via the honest status contract (#145):
kubectl get nextapp -A          # URL / Ready / Age printcolumns

# No reconcile errors after the roll:
kubectl logs -n kn-next-operator-system \
  deploy/kn-next-operator-controller-manager --tail=100 | grep -i error
```

If an app went `Ready=False` / `Degraded=True` after the upgrade, treat it as an
incident — see [incident.md](./incident.md). If the **operator upgrade itself**
is the regression (crash-loop, reconcile storm, bad manager image), revert it via
[rollback.md § Bad operator upgrade](./rollback.md#part-b--roll-back-a-bad-operator-upgrade).

---

## See also

- [rollback.md](./rollback.md) — revert a bad app release or a bad operator upgrade.
- [../RELEASING.md](../RELEASING.md) — how operator images and npm packages are cut.
- [ADR-0017](../adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md) — why v1alpha1, no webhook.
- [ADR-0011](../adr/0011-asset-retention-and-build-id-versioning.md) — build-id asset skew protection.
