# Multi-cloud portability — per-cloud prerequisites

> **Status (issue #46):** knext is **portable by design** — it is a Knative/Kubernetes
> adapter with no cloud-vendor SDK lock-in in the control plane. But end-to-end deploys
> are currently **verified only on GKE and kind**. Standing up a 2nd cloud (EKS / AKS /
> OKE) and proving a live `200` route is **human-only work tracked in #46**. This document
> removes the *config and documentation* blockers ahead of that verification: the exact
> per-cloud prerequisites you must satisfy, with the real config keys/files.

knext does **not** abstract these away — they are properties of *your* Knative install and
cluster, not of knext. The four portability couplings below are the ones most likely to
break a first deploy on a non-GKE cluster.

---

## 1. Knative ingress-class (Kourier vs Istio vs Contour)

**What knext ships.** The operator install bundle ships a `config-network` ConfigMap
(`packages/kn-next-operator/config/knative/config-network.yaml`) that pins the Knative
Serving **ingress-class**. It defaults to **Kourier**:

```yaml
# config-network ConfigMap, namespace: knative-serving
data:
  ingress-class: kourier.ingress.networking.knative.dev
```

This is the default because an **unset** ingress-class is what caused the earlier
"Kourier broken on k8s 1.34" misdiagnosis (see `docs/adr/0009-kourier-ingress-class.md`):
Serving never wired routes to the installed ingress.

**If your cluster uses a different networking layer**, the class must match the controller
you installed. The value **must be the full controller-qualified form** — short forms do
not match and leave routes unprogrammed.

| Networking layer | `ingress-class` value |
| --- | --- |
| Kourier (default) | `kourier.ingress.networking.knative.dev` |
| Istio (net-istio) | `istio.ingress.networking.knative.dev` |
| Contour (net-contour) | `contour.ingress.networking.knative.dev` |

**How to override** — do **not** hand-edit the manifest. The bundle exposes the override
the same way it substitutes the release digest. Run the helper on the rendered bundle:

```bash
# in packages/kn-next-operator/
make build-installer INGRESS_CLASS=istio.ingress.networking.knative.dev
# or, against an already-rendered bundle:
./hack/set-ingress-class.sh dist/install.yaml contour.ingress.networking.knative.dev
kubectl apply --server-side -f dist/install.yaml
```

`make build-installer` with no `INGRESS_CLASS` keeps the Kourier default (a no-op). The
helper is `packages/kn-next-operator/hack/set-ingress-class.sh`.

> If your Knative install **owns** `config-network` itself (a managed Knative add-on may),
> the bundle's `--server-side` apply merges the `ingress-class` key without clobbering the
> install's other keys. On clusters where you'd rather not let the bundle touch
> `config-network` at all, build with the matching class anyway so the values agree.

---

## 2. StorageClass for the Postgres recipe

The reference Postgres recipe (CloudNativePG-backed zone databases) provisions
PersistentVolumeClaims and therefore depends on the cluster's **default StorageClass** /
provisioner. kind ships `local-path`; managed clouds ship their own:

| Cloud | Typical default StorageClass / provisioner |
| --- | --- |
| GKE | `standard-rwo` (pd.csi.storage.gke.io) |
| EKS | `gp2` / `gp3` (ebs.csi.aws.com) — install the EBS CSI driver add-on |
| AKS | `default` / `managed-csi` (disk.csi.azure.com) |
| OKE | `oci-bv` (blockvolume.csi.oraclecloud.com) |

Prerequisite checklist:

- A **default StorageClass** exists (`kubectl get storageclass` shows one marked
  `(default)`), or the recipe's PVCs explicitly set `storageClassName`.
- For the **bytecode-cache PVC** (`spec.enableBytecodeCache`), the Knative PVC feature
  flags must be enabled — the bundle ships these in `config-features`
  (`packages/kn-next-operator/config/knative/config-features.yaml`); they are
  networking-layer-independent. A writable RWO volume is sufficient for single-replica;
  RWX (Filestore / EFS / Azure Files) is only needed for shared multi-replica cache.

knext builds **no** storage-class machinery and does **not** scale Postgres to zero (see
the DB-engine scope decision) — provisioning the StorageClass is a cluster prerequisite,
not a knext feature.

---

## 3. Per-cloud LoadBalancer / gateway IP

The Knative ingress gateway (Kourier, or the Istio ingressgateway / Contour Envoy) is
exposed via a `Service type: LoadBalancer`. Each cloud provisions the external address
differently; knext does not allocate it.

| Cloud | How the external IP/hostname is provisioned |
| --- | --- |
| GKE | GCP L4 LB auto-provisioned for the `LoadBalancer` Service |
| EKS | AWS LB (NLB recommended) — install the AWS Load Balancer Controller; the Service gets a hostname, not an IP |
| AKS | Azure LB auto-provisioned; optionally a static public IP in the node resource group |
| OKE | OCI LB auto-provisioned via the `oci-load-balancer` annotations |

After install, read the gateway's external address and wire your DNS / Knative
`config-domain`:

```bash
# Kourier
kubectl get svc kourier -n kourier-system
# Istio
kubectl get svc istio-ingressgateway -n istio-system
# Contour
kubectl get svc envoy -n contour-external
```

On clouds that hand out a **hostname** (EKS NLB) rather than an IP, configure
`config-domain` / your DNS with a CNAME, not an A record.

---

## 4. Build-host CLI prerequisites (per storage provider)

`kn-next build` uploads static assets by **shelling out to the provider's CLI** (see
`packages/kn-next/src/utils/asset-upload.ts`). The matching binary must be present and
authenticated **on the build host / CI runner**:

| `storage.provider` | Required CLI on build host | Auth |
| --- | --- | --- |
| `gcs` | `gsutil` (Google Cloud SDK) | ADC / service-account / Workload Identity |
| `s3` | `aws` (AWS CLI v2) | IAM role / access keys |
| `minio` | `mc` (MinIO Client) | `mc alias` with access/secret key |
| `azure` | `az` (Azure CLI) | service principal / managed identity |

If the CLI is missing or unauthenticated, the asset upload step fails — this is a
**build-host** prerequisite, independent of the cluster. Provide credentials via env / CI
secrets only, never in `kn-next.config.ts` or images (see `.claude/rules/security.md`).

---

## What is verified vs. portable-by-design

| Concern | Status |
| --- | --- |
| GKE end-to-end deploy + scale-to-zero | **Verified** |
| kind (CI / e2e) | **Verified** |
| EKS / AKS / OKE end-to-end (live `200` route) | **Not yet verified — human work, #46** |
| Ingress-class override (Istio/Contour) | Config + test landed; **live route unverified** |

This is **not multi-region or CDN** work — knext matches Vercel's *compute* layer, not its
global edge. "Second cloud" here means *portability verified on one alternative cloud*, not
running across many simultaneously.
