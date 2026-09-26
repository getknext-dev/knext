# Deploying the docs site to OKE

The docs site (Fumadocs/Next.js) runs as a **Knative Service** on the OKE cluster,
behind the existing Kourier ingress (no new LoadBalancer — the OCI LB quota is exhausted).

## Files
- `../../Dockerfile.oke` — builds the Node image (vinext/vite under
  `NITRO_PRESET=node`; it was a standalone Next.js image before the vinext
  migration). **Build for amd64** (OKE
  nodes are amd64; an arm64 image from a Mac crashes with exec-format-error).
- `docs-ksvc.yaml` — the **authoritative** deploy: the Knative Service `knext-docs` in ns
  `knext-docs`, digest-pinned to the current image.
- `docs.yaml` — an alternative plain-k8s Deployment+Service variant (not the deployed path).
- `../../.dockerignore`.

## Public registry

The OCIR repository `me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs` is now **public**. No `imagePullSecrets` are needed. To make a private repository public:

```sh
oci artifacts container repository update --is-public true --repository-id <repo-id>
```

## Domain mapping

Knative needs two `ClusterDomainClaim` entries and two `DomainMapping` resources to serve the docs site at `www.knext.dev` and `knext.dev`. Apply `domainmapping.yaml`:

```sh
kubectl apply -f deploy/oke/domainmapping.yaml
```

The `ClusterDomainClaim` entries are required because `autocreate-cluster-domain-claims` is off in the cluster config. **Cloudflare must point both domains at the new LoadBalancer IP** (`51.170.89.13`).

## Cluster rebuilt

**2026-09-27:** The OKE cluster was rebuilt. The Kourier LoadBalancer IP changed from `51.170.86.139` to `51.170.89.13`. The site was redeployed from the July image; a fresh amd64 build is needed in CI (the lead's Mac cannot build Docker images for amd64).

## Redeploy (fresh machine)

```sh
# 1. build amd64 + push to OCIR (now public; no pull secret needed)
docker build --platform linux/amd64 -f Dockerfile.oke -t me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64 .
docker push me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64
# 2. pin the new image (with @sha256 digest) in docs-ksvc.yaml, then:
kubectl apply --context knext-oke-sa -f deploy/oke/docs-ksvc.yaml
kubectl -n knext-docs rollout status ksvc/knext-docs   # or check .status.latestReadyRevisionName
# 3. verify live (retry through any ISP interstitial):
#    http://knext-docs.knext-docs.51.170.89.13.sslip.io/docs/scale-zero-pg
```
