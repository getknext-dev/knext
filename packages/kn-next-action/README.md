# Deploy with knext

A GitHub Action that deploys a Next.js app to **your own** Kubernetes cluster on **your own** cloud.

knext hosts nothing and holds none of your credentials. This runs in your CI, builds your image,
pushes it to your registry, and writes one object to your cluster — a `NextApp` resource. The knext
operator running in your cluster does everything after that.

## Quick start

```bash
kn-next init-ci --namespace my-app
```

That generates the workflow and the RBAC manifest that creates the credential it uses. Read the
manifest, apply it, add four repository secrets, and push.

Full walkthrough: <https://knext.dev/docs/github-action>

## What the credential can do

```yaml
rules:
  - apiGroups: [apps.kn-next.dev]
    resources: [nextapps]
    verbs: [get, list, create, patch, update]
```

That is the whole grant. No `delete`, so a leaked token cannot remove your app. No `secrets`. No
Deployments, Services or Pods.

This is only possible because deploying *is* writing one object — the operator is the single source
of truth for what runs, so CI never needs to touch Knative, autoscaling or networking directly.

## A cloud-credential kubeconfig is refused, before any cluster call

If the kubeconfig authenticates via an `exec:` or `auth-provider:` user entry — the shape
`aws eks get-token`, `gke-gcloud-auth-plugin`, `oci ce cluster generate-token` or `kubelogin` use —
the action refuses it immediately, with:

> This kubeconfig needs cloud-account credentials on the runner. Use the knext-deployer
> ServiceAccount token.

This is its own step (`kubeconfig-check.mjs`), and `skip-credential-preflight` does **not** turn it
off: it reads only the kubeconfig file, so there is no cluster limitation to work around.

knext holds no cloud-account credentials, ever. It accepts credentials that run nothing on the
runner: a bearer token — the kind `kn-next init-ci` prints the commands to mint, and
`kn-next init-ci --push-secret` can push straight to your repository as the `KNEXT_KUBECONFIG`
secret — or a client certificate and key. This is the same classifier
`knext doctor --ci-kubeconfig <path>` uses, so you can check a kubeconfig FILE before it ever
reaches CI. A file that is not valid YAML is refused with at most a line number — never its
contents, which are a credential.

## An over-broad kubeconfig is refused

On startup the action asks your cluster what the supplied credential can actually do, and fails if
the answer is broader than the Role above — printing the Role instead of deploying.

That is deliberate, and it is the reason the credential is worth granting at all: asking for less
than you are offered is what makes the request reasonable. Advice would not do it, because the
kubeconfig most people have to hand is the admin one.

If your cluster cannot answer that question at all, the action fails rather than assuming the best.
A check that goes green when it cannot see is not a check. `skip-credential-preflight: true` exists
for that case and turns the check **off** — it does not satisfy it.

Some clusters answer but mark the answer incomplete — their authorizer cannot fully resolve what a
credential can do (common on webhook-authorized clusters such as OKE or GKE with IAM). The action
does **not** fail closed on that incompleteness alone: refusing there would refuse the scoped
credential this check exists to allow, not just an over-broad one. `status.incomplete` alone no
longer decides anything by itself. Instead the action asks point questions via
`SelfSubjectAccessReview`, which a webhook authorizer answers even when it cannot answer the broader
review. The question set is derived from the Role (`hazardProbes()` in `@getknext/core`, beside the
Role definition): every Role verb asked in another namespace, every `nextapps` verb
the Role does not grant, and a fixed escalation list (Pod exec/create, ServiceAccount create and
token minting, Secret get/list/watch, cluster-wide Deployment patch, Role/ClusterRole
escalate/bind, (Cluster)RoleBinding create, impersonation, node proxy, wildcards). It refuses if ANY
is allowed, or if any review errors, is not JSON, carries an `evaluationError`, or has no boolean
`allowed` — a review with no verdict is a review that did not run. On these clusters it is a
spot-check, not a proof: a permission outside the set is not asked about. `skip-credential-preflight`
turns these checks off; it never reaches the cloud-credential refusal above.

This check does not depend on the `kubectl` version your runner happens to ship — it asks the
cluster directly rather than parsing a command's table output, so it behaves the same on
`ubuntu-latest` as it does on your laptop. It submits every review as a raw POST to the apiserver,
with no client-side validation, so it works with the scoped credential this action expects and not
only with a cluster-admin one.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `kubeconfig` | yes | — | base64-encoded, from the scoped ServiceAccount |
| `namespace` | yes | — | no default: it bounds the credential's blast radius |
| `registry` | yes | — | registry host and namespace; the app's `name` is appended (`ghcr.io/acme` → `ghcr.io/acme/<name>`) |
| `registry-token` | no | — | on GHCR, `github.token` suffices |
| `registry-username` | no | `github.actor` | |
| `working-directory` | no | `.` | where `knext.config.ts` lives |
| `tag` | no | `github.sha` | a timestamp cannot be traced to a commit |
| `bucket` | no | from config | object storage for static assets |
| `skip-upload` | no | `false` | the credential-free path — no cloud CLI needed |
| `skip-build` | no | `false` | when a previous job already produced the output |
| `dry-run` | no | `false` | print the resource, apply nothing |
| `doctor` | no | `true` | read-only cluster preflight |
| `auth` | no | `kubeconfig` | reserved for short-lived cloud credentials |
| `skip-credential-preflight` | no | `false` | read the section above first |
| `cli` | no | `npx --yes @getknext/core` | the command that runs the CLI, split on whitespace. Leave it at the default unless you are dogfooding this action from its own checkout — point it at a locally built CLI (e.g. `node ./packages/kn-next/dist/cli/kn-next.js`) to deploy with that build instead of the published package |

No outputs. The deployed URL comes from the cluster — `kn-next status`, or
`kubectl get ksvc -n <namespace>`.

## What this deliberately does not do

It never asks for cloud-account credentials and it does not create clusters. Creating managed
Kubernetes needs permissions that cannot be scoped down; a kubeconfig is different in kind, because
it is scoped to one cluster and can be scoped further to one namespace. Leaked, it costs you that
cluster — not your cloud account.

You bring a cluster with the knext operator installed. This does everything after it.
