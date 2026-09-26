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

## Publishing the image from CI

The `docs-oke-image` workflow builds `Dockerfile.oke` (linux/amd64), smoke-boots
it, pushes `me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64`, and
commits the digest bump of `docs-ksvc.yaml` to a branch `docs-image/<short>`. It
runs on `workflow_dispatch` (input `ref`, default `main`) and on pushes to `main`
that touch the docs or the packages they consume. The job summary prints the
`gh pr create` command for the bump (Actions cannot open PRs in this org).

It fails closed, before checking anything out, if either secret is missing.

### One-time setup: the two secrets

```sh
# namespace of the tenancy (the first path segment of the registry repo)
oci os ns get                                   # -> axfqznklsd2t
# your user's OCID and login (identity-domain users: <namespace>/<domain>/<user>)
oci iam user list --query 'data[].{name:name,id:id}' --output table

# auth token: the value is shown ONCE
oci iam auth-token create --user-id <user-ocid> --description "github docs-oke-image"

gh secret set OCIR_TOKEN --repo getknext-dev/knext          # paste the token
gh secret set OCIR_USER  --repo getknext-dev/knext --body "axfqznklsd2t/<user login>"
```

`OCIR_USER` is `<tenancy-namespace>/<username>`; for identity-domain users it is
`<tenancy-namespace>/<domain>/<username>`. A wrong username shows up as a login
failure in the workflow's "Log in to OCIR" step.

Then run it: `gh workflow run docs-oke-image.yml -f ref=main`, open the PR from
the summary, merge, and `kubectl apply` the manifest as in step 2 below.

## Redeploy (manual fallback, fresh machine)

Prefer the workflow above. Build from the **repo root** (the docs depend on
`@getknext/core` through the workspace):

```sh
# 1. build amd64 + push to OCIR (now public; no pull secret needed)
docker build --platform linux/amd64 -f apps/docs/Dockerfile.oke -t me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64 .
docker push me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs:sha-<short>-amd64
# 2. pin the new image (with @sha256 digest) in docs-ksvc.yaml, then:
kubectl apply --context knext-oke-sa -f apps/docs/deploy/oke/docs-ksvc.yaml
kubectl -n knext-docs rollout status ksvc/knext-docs   # or check .status.latestReadyRevisionName
# 3. verify live (retry through any ISP interstitial):
#    http://knext-docs.knext-docs.51.170.89.13.sslip.io/docs/scale-zero-pg
```
