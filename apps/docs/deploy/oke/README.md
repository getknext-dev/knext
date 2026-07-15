# Deploying the docs site to OKE

The docs site (Fumadocs/Next.js) runs as a **Knative Service** on the OKE cluster,
behind the existing Kourier ingress (no new LoadBalancer — the OCI LB quota is exhausted).

## Files
- `../../Dockerfile.oke` — builds the standalone Next.js image. **Build for amd64** (OKE
  nodes are amd64; an arm64 image from a Mac crashes with exec-format-error).
- `docs-ksvc.yaml` — the **authoritative** deploy: the Knative Service `knext-docs` in ns
  `knext-docs`, digest-pinned to the current image.
- `docs.yaml` — an alternative plain-k8s Deployment+Service variant (not the deployed path).
- `../../.dockerignore`.

## Redeploy (fresh machine)
```sh
# 1. build amd64 + push to OCIR (private; the pod needs the `ocir-pull` dockerconfigjson
#    secret in ns knext-docs — copy it from another ns if missing)
docker build --platform linux/amd64 -f Dockerfile.oke -t me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64 .
docker push me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64
# 2. pin the new image (with @sha256 digest) in docs-ksvc.yaml, then:
kubectl config use-context context-ckmva7v7zvq   # OKE; verify current-context first
kubectl apply -f deploy/oke/docs-ksvc.yaml
kubectl -n knext-docs rollout status ksvc/knext-docs   # or check .status.latestReadyRevisionName
# 3. verify live (retry through any ISP interstitial):
#    http://knext-docs.knext-docs.51.170.86.139.sslip.io/docs/scale-zero-pg
```
