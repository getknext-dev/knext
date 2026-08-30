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

## An over-broad kubeconfig is refused

On startup the action asks your cluster what the supplied credential can actually do, and fails if
the answer is broader than the Role above — printing the Role instead of deploying.

That is deliberate, and it is the reason the credential is worth granting at all: asking for less
than you are offered is what makes the request reasonable. Advice would not do it, because the
kubeconfig most people have to hand is the admin one.

If your cluster's authorizer cannot answer that question, the action fails rather than assuming the
best. A check that goes green when it cannot see is not a check. `skip-credential-preflight: true`
exists for that case and turns the check **off** — it does not satisfy it.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `kubeconfig` | yes | — | base64-encoded, from the scoped ServiceAccount |
| `namespace` | yes | — | no default: it bounds the credential's blast radius |
| `registry` | yes | — | registry host and repository |
| `registry-token` | no | — | on GHCR, `github.token` suffices |
| `registry-username` | no | `github.actor` | |
| `working-directory` | no | `.` | where `kn-next.config.ts` lives |
| `tag` | no | `github.sha` | a timestamp cannot be traced to a commit |
| `bucket` | no | from config | object storage for static assets |
| `skip-upload` | no | `false` | the credential-free path — no cloud CLI needed |
| `skip-build` | no | `false` | when a previous job already produced the output |
| `dry-run` | no | `false` | print the resource, apply nothing |
| `doctor` | no | `true` | read-only cluster preflight |
| `auth` | no | `kubeconfig` | reserved for short-lived cloud credentials |
| `skip-credential-preflight` | no | `false` | read the section above first |

No outputs. The deployed URL comes from the cluster — `kn-next status`, or
`kubectl get ksvc -n <namespace>`.

## What this deliberately does not do

It never asks for cloud-account credentials and it does not create clusters. Creating managed
Kubernetes needs permissions that cannot be scoped down; a kubeconfig is different in kind, because
it is scoped to one cluster and can be scoped further to one namespace. Leaked, it costs you that
cluster — not your cloud account.

You bring a cluster with the knext operator installed. This does everything after it.
