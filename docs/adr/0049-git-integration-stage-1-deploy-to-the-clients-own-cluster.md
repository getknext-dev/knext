# ADR-0049 — Git integration, stage 1: deploy to the client's own cluster

- **Status:** Proposed
- **Date:** 2026-08-29
- **Supersedes / amends:** nothing. Extends ADR-0001 (operator is the single
  source of truth) rather than altering it.

## Context

knext deploys today by a human running `kn-next deploy`. That is fine for the
author and useless for the audience the platform is aimed at — someone who wants
a Vercel-like experience and has no Kubernetes knowledge. Push-to-deploy is the
single largest gap between what knext does and what it is *for*.

The temptation is to build the Vercel shape directly: a knext-hosted control
plane that holds customer credentials, watches repositories, runs builds, and
deploys into clusters it manages. That is a multi-tenant SaaS. It brings
tenancy, quota, billing, credential custody and an availability obligation, none
of which exist today, and it would be built before anyone has confirmed they
want it.

Stage 1 therefore deliberately does **not** do that.

## Decision

**Ship a GitHub Action that runs in the client's own repository and deploys to
the client's own cluster on the client's own cloud. knext hosts nothing and
holds no credentials.**

The client installs the Action, provides a small set of repository secrets, and
pushes. The Action builds the image, pushes it to a registry the client already
owns, emits a `NextApp` custom resource, and applies it. The operator — already
the single source of truth (ADR-0001) — reconciles from there.

### Why this shape

The operator is what makes it small. Because every cluster write goes through
one CRD, **CI needs permission to write exactly one kind of object in one
namespace.** Not cluster-admin, not the ability to create Deployments or
Services or read Secrets. That is a genuinely defensible credential to ask a
stranger for, and it is only possible because the control plane was built this
way first.

It also means the Action is thin. It does not know how to configure Knative,
autoscaling, NetworkPolicies or ingress — it emits a CR and stops. Everything
the operator learns later is inherited for free.

## What the client must provide

Four repository secrets, and a short explanation of each, because a user who
does not understand a permission cannot consent to it:

| Secret | What it is | Why it is needed |
| --- | --- | --- |
| `KNEXT_KUBECONFIG` | base64 kubeconfig for a **scoped ServiceAccount**, not an admin user | So the Action can apply the `NextApp` CR. Scope below. |
| `KNEXT_NAMESPACE` | the namespace to deploy into | Keeps the credential's blast radius to one namespace. |
| `KNEXT_REGISTRY` | registry host + repository, e.g. `ghcr.io/acme/app` | Where the built image is pushed. The client owns it. |
| `KNEXT_REGISTRY_TOKEN` | a push token for that registry | As above. On GHCR the built-in `GITHUB_TOKEN` suffices and this can be omitted. |

The kubeconfig's ServiceAccount needs exactly this, and the docs must show the
Role verbatim so it can be read before it is applied:

```yaml
rules:
  - apiGroups: ['apps.kn-next.dev']
    resources: ['nextapps']
    verbs: ['get', 'list', 'create', 'patch', 'update']
```

No `delete`. No `secrets`. No core resources at all. A leaked CI token can
change one application's spec in one namespace — bad, and bounded.

**A cluster-admin kubeconfig must be refused, not merely discouraged.** The
Action should detect over-broad credentials (a `SelfSubjectRulesReview` at
startup) and fail with the Role above, rather than quietly accepting whatever it
was handed. Asking for less than you are offered is the whole trust argument.

### The hardening path, named now so it is not "later"

A long-lived kubeconfig in a repository secret is the pragmatic option, not the
right one. GitHub OIDC federation — GitHub issues a short-lived token, the
client's cloud exchanges it for cluster access — removes the standing credential
entirely. It is per-cloud work (EKS/GKE/AKS/OKE each differ), which is why it is
not stage 1, but the Action's auth should be a seam from the first commit so
adding it is not a rewrite.

## What stage 1 explicitly does NOT include

Naming these prevents the scope drift `CLAUDE.md` §1 warns about:

- **No knext-hosted anything.** No control plane, no build service, no dashboard
  we operate, no credentials we hold.
- **No multi-tenancy.** One repository, one cluster, one namespace.
- **No preview environments per PR.** `preview.ts` exists and can follow, but it
  multiplies namespaces and DNS and is a separate decision.
- **No domain/TLS automation.** Knative and cert-manager already own that; the
  Action does not touch it.
- **No cluster provisioning.** The client brings a cluster. "Prepare all clouds"
  is a real goal and a much larger one; it is not this.

## Consequences

**For:** the smallest thing that delivers push-to-deploy. No new trust
relationship, no service to run, no data to lose. It works on any conformant
cluster — EKS, GKE, AKS, OKE, on-prem — because it only needs the CRD. And it
is a genuine proof that the operator-first architecture pays: the entire
integration is "write one object".

**Against, stated plainly:**

- It is not the Vercel experience. There is no dashboard, no preview URL in the
  PR, no rollback button. The client gets a green check and a deployed app.
- The client still needs a cluster with the operator installed. That is the real
  onboarding cliff, and this ADR does not remove it — it moves it to a one-time
  step instead of a per-deploy one.
- A repository secret holding cluster access is a standing credential. Scoped as
  above it is small, but it is not zero, and the OIDC path above is the answer
  rather than a mitigation.

## Action items

1. `packages/kn-next-action/` — the composite Action: build, push, emit CR,
   apply, wait for the operator's status condition.
2. Credential preflight: `SelfSubjectRulesReview` on startup; fail on
   over-broad rights with the exact Role to apply.
3. `kn-next init-ci` — generate the workflow file, the ServiceAccount, the Role
   and the RoleBinding, so the client applies a reviewed manifest rather than
   pasting YAML from a docs page.
4. Docs page: the four secrets, what each is for, and the Role in full.
5. Auth as a seam, so OIDC federation is an addition rather than a rewrite.
