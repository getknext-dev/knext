# Deploying the docs site to OKE

The docs site is deployed **through knext itself**, the way a knext user deploys. A push to `main`
that touches the docs (or the CLI/action it is built with) runs
[`.github/workflows/docs-deploy-oke.yml`](../../../../.github/workflows/docs-deploy-oke.yml), which
runs `kn-next deploy` through the in-repo GitHub Action (`packages/kn-next-action`). That builds the
image from `apps/docs/Dockerfile`, pushes it to OCIR, and writes **one** object: the `knext-docs`
`NextApp` in namespace `knext-docs`. The operator renders the Knative Service from it (ADR-0001),
behind the existing Kourier ingress. There is no hand-applied Knative Service any more.

| What | Where |
|---|---|
| Deploy config | `apps/docs/knext.config.ts`: name, registry, scale 0..5, resources |
| Image | `apps/docs/Dockerfile`: vinext `.output` run under Bun, built by `kn-next deploy` |
| Readiness | `apps/docs/app/api/health/route.ts`: the operator probes `/api/health` |
| CI credential | `ci-rbac.yaml` + `mint-ci-kubeconfig.sh` (below) |
| Custom domains | `domainmapping.yaml`: `knext.dev` / `www.knext.dev` → ksvc `knext-docs` |

## How a deploy runs

- **Pull request:** the `dry-run` job builds the CLI from the PR, runs the closure audit, and runs
  `kn-next deploy --dry-run`. It prints the `NextApp` it would apply. It references **no secrets**
  and cannot reach the cluster.
- **Push to `main` / manual dispatch on `main`:** the `deploy` job runs in the `docs-oke`
  environment, the only place the kubeconfig secret exists. It runs the closure audit (SBOM +
  HIGH/CRITICAL, before anything is built), logs in to OCIR, and deploys through the action with
  `tag: <commit sha>` and `skip-upload: true`. It then waits for the operator to report that
  `NextApp` generation Ready, checks that the image is this commit's (digest-pinned), and smoke-tests
  `/api/health`, `/` and `/docs` on `https://knext.dev`. The step summary records the image and revision.

To redeploy without a docs change: **Actions → Docs deploy (OKE) → Run workflow** on `main`.

## Scale to zero

`minScale: 0`. The hand-applied Knative Service this replaced pinned `min-scale: 1` to keep a pod
warm. The docs site now uses the product default: an idle site holds no pod, and the first request
after idle pays one cold start. To trade that back, set `scaling.minScale: 1` in
`knext.config.ts`. Do not patch the ksvc, because the operator reverts it on the next reconcile.

## Static assets: served from the image

The config has no `storage` block and the deploy passes `--skip-upload`. Static assets are served by
the app from its own image. That costs the CDN offload, cross-deploy asset retention, and skew
protection: a browser still holding the previous build can 404 on its chunks once that revision
scales away. That is acceptable for a docs site. Adding an object-storage bucket on OKE and a
`storage` block is a follow-up (#1481's PR lists it).

## Custom domains

The `NextApp` CRD has no domain field, so the domains live in `domainmapping.yaml`: two
`ClusterDomainClaim`s (this cluster has `autocreate-cluster-domain-claims` off) and two
`DomainMapping`s whose `spec.ref.name` is `knext-docs`. That works because the operator names the
Knative Service after the `NextApp` (`metadata.name`, which is `name` in `knext.config.ts`).
**Renaming the app orphans both domains.** Change `domainmapping.yaml` in the same PR.

The domain mappings are applied once by a cluster admin (`kubectl apply -f domainmapping.yaml`).
Cloudflare points both hosts at the Kourier LoadBalancer (`51.170.89.13`).

**Cut-over from the hand-applied ksvc:** the old `knext-docs` Knative Service has the same name the
operator renders, so the first deploy **adopts** it in place. The operator takes controller
ownership, replaces the template, and rolls a new revision. The ksvc name and URL do not change, so
the DomainMappings keep resolving and no manual step is needed. Proven on OKE in a scratch namespace
with the same manifests: a raw ksvc was adopted, the new revision went Ready, and min-scale went
1 → 0.

## The CI credential

CI holds the `knext-deployer` ServiceAccount from `kn-next init-ci --namespace knext-docs`. It can
`get/list/create/patch/update` **`nextapps` in `knext-docs` and nothing else**: no Secrets, no
Knative objects, no delete. The action's credential preflight refuses anything broader, so a
cluster-admin kubeconfig cannot be substituted.

One-time setup, by a cluster admin:

```sh
kubectl --context <admin-ctx> apply -f apps/docs/deploy/oke/ci-rbac.yaml
apps/docs/deploy/oke/mint-ci-kubeconfig.sh <admin-ctx>
```

`ci-rbac.yaml` is the `init-ci` output plus a `service-account-token` Secret, so the token does not
expire the way a `kubectl create token` one does. The manifest carries no token; Kubernetes fills it
in. The script reads the API server address and that token, builds a kubeconfig that authenticates as
`knext-deployer`, checks that it can patch `nextapps` and **cannot** read Secrets, and stores it as
the `KNEXT_DOCS_KUBECONFIG_B64` secret of the **`docs-oke` environment**. Nothing sensitive is
printed, and the temp file is deleted on exit. The environment's deployment-branch policy admits
`main` only, so a PR that edits the workflow still cannot read the secret.

**Rotate:** delete the `knext-deployer-token` Secret, re-apply `ci-rbac.yaml`, and re-run the script.
The old token dies with its Secret.

Registry push uses the repository secrets `OCIR_USER` / `OCIR_TOKEN` (an OCI auth token). The OCIR
repository `me-abudhabi-1.ocir.io/axfqznklsd2t/knext-docs` is **public**, so the cluster pulls
without an `imagePullSecret`. The config's `registry` is the namespace
(`me-abudhabi-1.ocir.io/axfqznklsd2t`), and the CLI appends the app name.

`doctor: false` in the workflow is deliberate. `kn-next doctor` reads cluster-scoped state (CRDs,
the operator's Deployment, Knative's ConfigMaps) that this credential is not allowed to read, so it
would fail every run on RBAC probe errors. `kn-next deploy` still server-side dry-runs the `NextApp`
against the live CRD schema before it applies.

## Retired files (#1488)

`docs-ksvc.yaml` (the hand-applied Knative Service), `docs.yaml` (a plain-k8s variant), and
`../../Dockerfile.oke` (the `node:22-alpine` image they built) were kept until the first green run
of this workflow on `main` — that ran clean, and the operator has owned `knext-docs` since. All
three are removed; do not re-add a hand-applied Knative Service or manifest here. The operator
reverts anything applied out of band (ADR-0001).
