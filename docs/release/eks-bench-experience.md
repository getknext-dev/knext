# Standing up a healthy cloud cluster to bench the bun-exec cold start — field notes

Context: OKE's cold-start numbers were taken on a CPU-request-saturated cluster and weren't
trustworthy. We stood up a fresh **AWS EKS** cluster to re-measure the compiled bun single-exec
(vinext `bun build --compile`) file-manager, and to settle the "GKE was sub-second" question.
Result summary lives in `eks-bunexec-bench.md`; this file is the **how it went + gotchas**, so the
GKE repeat is fast.

## What worked, in order
1. `eksctl create cluster -f docs/release/eks-cluster.yaml` — 2× t3.xlarge spot, OIDC, EBS-CSI addon. ~15 min.
2. Knative Serving + Kourier **v1.18** (matches k8s 1.31): `serving-crds`, `serving-core`, `kourier.yaml`;
   patch `config-network` ingress-class=kourier, `config-features` podspec-fieldref=enabled.
3. Domain: EKS Kourier LB is a **hostname** (ELB), not an IP. Resolve it (`dig`) and set
   `config-domain` to `<IP>.sslip.io`. (NLB IPs rotate — fine for a bench, use Route 53 for durable.)
4. Images: `crane copy` OCIR→ECR (digest preserved, so `@sha256:` refs stay valid). ECR pulls need
   **no imagePullSecret** — the managed-node instance role has ECR read; a dangling `ocir-secret`
   reference is non-fatal (kubelet falls back to the ECR credential provider).
5. App: Knative Service, `min-scale 0`, image pre-cached on node. Cold start measured client-side.

## Gotchas that cost time (fix once, know forever)
- **No default StorageClass on EKS.** eksctl's `gp2` is not marked default → every PVC hangs
  `Pending` ("unbound immediate"). Fix: create a `gp3` `ebs.csi.aws.com` class annotated
  `is-default-class: "true"`. On **k8s ≥1.28 the default is assigned retroactively**, so existing
  Pending PVCs bind without recreation (confirmed: all 7 bound instantly).
- **Docker Hub anonymous rate-limiting from the node NAT** → `ImagePullBackOff` on `minio/mc` etc.
  (`insufficient_scope: authorization failed`). Mirror docker.io images to ECR with `crane`. Note:
  the limit can also hit **your laptop's IP** mid-mirror — `minio/mc` had to come from `quay.io`
  instead of Docker Hub. quay.io + registry.k8s.io are not rate-limited.
- **Knative reserves the `PORT` env var** — setting it fails admission
  (`"PORT" is a reserved environment variable`). Remove it; Knative injects PORT = containerPort.
- **Template manifests must be excluded from `kubectl apply -f dir/`.** scale-zero-pg ships
  `*.template.yaml` (with `__APP__` placeholders) and an envsubst `88-loadsoak-k6.yaml` — they fail
  RFC-1123/quantity validation if applied raw. The operator instantiates templates; don't apply them.
- **Cross-namespace secret.** The app ksvc (ns `default`) can't read scale-zero-pg's `myapp-database`
  secret — copy it into the app namespace. The DSN host is an FQDN
  (`pggw.scale-zero-pg.svc.cluster.local.`), so it resolves cross-namespace fine.
- **Measurement bugs, not cluster bugs.** A `fetch(u).then(r=>r.text()).then(()=>console.log(r.status))`
  one-liner throws `r is not defined` (scope) — every trial reads ERR while the cluster is healthy.
  And a pod-count helper that emits a non-integer makes the scale-to-zero wait loop spin. Verify the
  harness can see a real value before trusting a run of zeros/errors.

## The finding (so the GKE run has a target)
- **Cold start: t3.xlarge median ~2.1s; c6i.xlarge median ~1.4s** (−33%). Burstable-CPU throttling of
  container-create/queue-proxy/bun-boot is real and measurable.
- **Image caching is NOT the variable** — every scale-up logged `already present on machine` and it's
  still 1.4–2.1s. The bun app itself boots + self-warms `/api/health` in **<1s**; the residual is the
  **platform** (VPC-CNI pod-IP + Knative activator scale-up + readiness gating).
- **Warm RPS: ~1143 req/s single pod**, matching local 1103 — app parity confirmed. (At low
  concurrency the remote client is **RTT-bound**, not app-bound: measure RPS **in-cluster** for a true
  ceiling.)

## Apples-to-apples checklist for the GKE run tomorrow
Replicate these or the comparison is meaningless:
1. **Same image** (the compiled bun-exec), pushed to Artifact Registry. Same Knative v1.18 + Kourier.
2. **`min-scale: 0`, and CONFIRM 0 pods before each timed request.** This is the crux — if GKE's
   ~600ms didn't verify scale-to-zero first, it was a *warm* hit (knext's warm latency is ~155ms,
   which *is* sub-second). Time from a genuinely cold state only.
3. **Image pre-cached on the node** (or note if GKE Image Streaming is on — it changes first-pull).
4. **Record the node machine type** and whether it's burstable (`e2`) or not (`n2`/`c2`). Compare like
   for like — c6i here ≈ n2/c2 there; t3 here ≈ e2 there.
5. **Capture the pod timeline** (creationTimestamp → container startedAt → app "LISTENING" log →
   Ready condition) to attribute the number across schedule / network / boot / readiness — that's how
   we proved the app wasn't the cost.
6. **Run the RPS load in-cluster** (a Job), not from a laptop, to remove network RTT from throughput.
7. Expect GKE cold ≈ EKS-c6i (~1.4s) **unless** GKE's pod networking (Alias-IP) beats VPC-CNI or the
   activator path is configured out — that residual ~0.8s is where any remaining GKE edge would live.

## Teardown
`eksctl delete cluster --name knext --region eu-west-1 --wait` — it auto-deletes the Kourier ELB
(k8s-created LoadBalancer) before the VPC, so no orphaned-ENI VPC-delete hang.
