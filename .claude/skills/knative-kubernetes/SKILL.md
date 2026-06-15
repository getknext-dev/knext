---
name: knative-kubernetes
description: Knative Serving on Kubernetes for knext — scale-to-zero, KPA autoscaling annotations (minScale/maxScale/target/containerConcurrency), the Go operator + NextApp CRD pattern, cluster-local gRPC over h2c, networking layers (Kourier/Istio/Contour) and their gotchas, and bytecode-cache PVCs. Use when deploying/operating knext on Knative, writing operator reconcile logic, debugging ingress/scale-to-zero, or choosing a networking layer.
---

# Knative on Kubernetes (knext)

knext's differentiator is **Knative + scale-to-zero**. The **Go operator is the single source of
truth** for cluster state (ADR-0001) — express desired state as a `NextApp` CR; nothing else
mutates Knative resources.

## Knative Service essentials
A `serving.knative.dev/v1` `Service` autoscaled by the **KPA**. Key annotations on the revision
template:
```yaml
autoscaling.knative.dev/min-scale: "1"   # pre-warm (no cold start); "0" = scale to zero
autoscaling.knative.dev/max-scale: "5"
autoscaling.knative.dev/target: "100"    # target concurrent requests/pod
spec.template.spec.containerConcurrency: 100   # hard per-pod concurrency cap
```
Scale-to-zero: idle pods terminate (~30–60s default); next request cold-starts (sub-second with
`NODE_COMPILE_CACHE` — see node-bytecode-caching). Pre-warm with `minScale: 1`.

## The operator / `NextApp` CRD pattern
`packages/kn-next-operator` (Kubebuilder). `NextAppSpec`: image, scaling, resources, storage,
cache (`enableBytecodeCache`, `bytecodeCacheSize`), revalidation (Kafka), secrets, observability,
preview. Reconciler (`internal/controller/nextapp_controller.go`) creates, with owner refs +
least-privilege SA (`AutomountServiceAccountToken:false`):
ServiceAccount → bytecode PVC (when `enableBytecodeCache`) → Knative caching Image → Knative
Service → (KafkaSource if `revalidation.queue==kafka`) → status. It **rejects `:latest`** (digest
pin). Gaps to fix: `status.Conditions` defined but **unpopulated**; no finalizers; happy-path only.

## gRPC backends on Knative (ADR-0004)
Each `BackendService` = a Knative Service with the container port **named `h2c`**
(`appProtocol: h2c`) so Knative routes gRPC and scales to zero, plus label
**`networking.knative.dev/visibility: cluster-local`** → **no public ingress** (satisfies the
no-unauth-endpoint rule). The operator injects `<NAME>_SERVICE_URL` into the gateway.

## Networking layer — choose deliberately (real gotcha)
Knative needs a networking layer: **Kourier** (lightweight, default), **Istio** (mesh/mTLS), or
**Contour**. ⚠️ **Verified failure:** Knative 1.19 **Kourier did not program ingress on k8s
1.34** (Serving healthy, route never configured → 404); a version-matched 1.22 install did not fix
it either. Workaround used on OKE: a direct `type: LoadBalancer` Service → the pod's queue-proxy
(`targetPort: 8012`), bypassing Kourier. **Action:** record a supported-ingress ADR; for mTLS
between gateway and backends, Istio is the path.

## Cloud bytecode-cache PVC (cross-cold-start)
`NODE_COMPILE_CACHE` → a PVC. RWO = same-node reuse; **RWX** for cross-node multi-pod sharing:
EFS (EKS), Filestore (GKE), Azure Files (AKS), FSS (OKE), NFS/Longhorn (on-prem).

## Install (dev / kind)
```bash
kubectl apply -f https://github.com/knative/serving/releases/download/knative-vX/serving-crds.yaml
kubectl apply -f https://github.com/knative/serving/releases/download/knative-vX/serving-core.yaml
kubectl apply -f https://github.com/knative-extensions/net-kourier/releases/download/knative-vX/kourier.yaml
kubectl patch cm/config-network -n knative-serving --type merge \
  -p '{"data":{"ingress-class":"kourier.knative.dev"}}'
```
⚠️ Match the Knative version to the cluster's k8s version (Knative ≤1.19 predates k8s 1.34).

## Debugging
- ksvc `Ready=Unknown / IngressNotConfigured` → networking layer didn't reconcile the KIngress
  (check `observedGeneration`, controller logs; the Kourier-on-new-k8s bug above).
- 0 pods is normal at scale-to-zero. `kubectl get ksvc`, `revisions`, then the
  `*-deployment-*` pods (2/2 = user-container + queue-proxy).

Related: `nextjs-deployment-adapter`, `grpc-services`, `node-bytecode-caching`, and the
community `knative` skill.
