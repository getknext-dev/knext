# ADR-0061: The cloud contract — a conformance profile and a verify-and-emit `knext cluster` surface

- **Status:** **Proposed (2026-09-27). Design only.** Founder decision of 2026-09-27: this sprint
  records the contract and files the open questions; **no cloud code lands this sprint.** Sprint C1
  of the *Developer Experience sprint* (#1531). Trigger-class (ADR + security: it draws the
  credential-custody line), so the architect and system designer review it at sprint close per
  `.claude/rules/workflow.md` — it is not a merge gate.
- **Answers:** the positioning map #614 ("should knext own zero-knowledge onboarding?") — see
  [§ Answer to #614](#answer-to-614).
- **Relates to:** ADR-0001 (the operator is the single source of truth — this ADR adds **no**
  exception to it), ADR-0049 (the client-side CI deploy path: `kn-next init-ci` + the
  `kn-next-action` credential preflight, which this ADR generalises across clouds), #1495 (the
  preflight fails open on webhook-authorized clusters — the first authorizer quirk this ADR turns
  into a data row).
- **Wayfinding map:** #1536, "[wayfinder map] cloud contract for knext cluster". Its five child
  decision tickets are #1537 (verify-and-emit vs. an install exception), #1538 (token form and
  rotation), #1539 (profile versioned with operator or CLI), #1540 (generic as baseline or
  first-class row), #1541 (storage/registry: docs or emitted IaC). #1537 blocks #1538 and #1541.

## Context

The founder's framing, verbatim: *"the whole point of this platform is a Vercel-like experience for
non-DevOps users; zero cloud/Kubernetes knowledge; git integration that prepares all clouds (AWS,
OCI, Azure, GCP, generic K8s) and easily deploys."*

That ask collides with four standing rules, and the collision is the whole design problem:

1. **Positioning** (`CLAUDE.md` §1, `architecture.md` §5): knext is the narrow scale-to-zero
   Next.js adapter for Knative, **not** a PaaS. Resist scope drift.
2. **ADR-0001:** every CLI cluster write targets the `NextApp` CR and nothing else.
3. **Credential custody** (`security.md`): secrets live only in Kubernetes Secrets or CI secrets.
   knext holds **no cloud-account credentials**, ever.
4. **Measured cost of provisioning** (#617, a child of #614): roughly eight forced upstream
   migrations a year across four clouds, and on AWS **no least-privilege provisioning path can
   exist** — `CreateRole` + `AttachRolePolicy` + `PassRole` is privilege escalation, verified against
   the live policy. Every comparable tool started with one substrate (#616).

What the user actually hits today is measured, not felt. Before `kn-next deploy` works, a user must
assemble: a cluster; Knative Serving at a compatible version; Kourier as the ingress class;
cert-manager; the knext operator at a version whose CRD covers what the CLI emits; a registry the
cluster can pull from; an object-storage bucket; and a CI credential scoped to one namespace. The
per-cloud docs (first-cluster, OKE, AKS, EKS, GKE) walk each of those by hand, and each cloud
differs in only a handful of **facts** — the registry host shape, which storage provider applies,
which exec plugin the kubeconfig calls, and how the cluster's authorizer answers a
`SelfSubjectRulesReview`.

Two pieces of the answer already exist and point the way:

- `kn-next init-ci` **writes files and touches no cluster**: a workflow plus a scoped
  ServiceAccount/Role/RoleBinding the user applies themselves. Its RBAC comes from the same
  `CI_ROLE_RULES` constant the preflight checks against, so what knext tells you to create and what
  it accepts cannot drift.
- `kn-next doctor` already reads the cluster (CRD present, known CRD fields vs. what the CLI emits,
  operator webhook, ingress class, Knative Serving) without writing to it.

The gap is that neither knows **which cloud it is on**, neither states **one versioned bar** a
cluster must meet, and the cloud-specific facts live only in prose. OKE's webhook authorizer
returning `incomplete: true` for every rules review (#1495) is the proof: that fact changed the
security behaviour of the preflight, and it was discovered in review rather than read from a table.

## Decision

**knext owns a contract with the cluster, not the cluster.** Concretely, two things:

### 1. A conformance profile

A single, versioned, machine-readable statement of what a cluster must provide for knext to deploy
to it:

| Field | Meaning |
|---|---|
| Knative Serving version range | the range the compat suite and OKE verification ran against |
| Kourier version + ingress-class value | the ingress contract the operator assumes |
| cert-manager version range | required by the operator's admission webhook |
| operator + CRD lockstep version | the operator release whose CRD covers every field this CLI emits (upgrade order: operator/CRD first, then CLI) |
| scoped-credential shape | the Role rules (`CI_ROLE_RULES`), namespace scope, and accepted token form (TokenRequest vs. ServiceAccount-secret — open ticket 2) |

The profile is **data**. It is consumed by the verifier and by the emitter; it is never a branch.

### 2. A verify-and-emit `knext cluster` surface

```
ClusterTarget = (kube-context) → conformance verdict + emitted manifests/commands
```

- **Verify** (read-only): given a kube-context, report pass/fail per profile field, with the exact
  remediation command for each failure. It subsumes `doctor`'s cluster checks rather than
  duplicating them. It writes nothing.
- **Emit**: print or write the artifacts the user runs themselves — the scoped RBAC manifest, the
  CI workflow (`init-ci`'s output, now cloud-aware), the operator install command (the published
  `install.yaml`), and, per open ticket 5, possibly the storage/registry snippets. knext **emits**;
  the user (or their CI, or their IaC) **applies**.

### Each cloud is a data row, never a code path

| Row | registry host pattern | storage provider | kubeconfig exec plugin | authorizer quirk | source / verified |
|---|---|---|---|---|---|
| OCI / OKE | `<region-key>.ocir.io/<tenancy-namespace>/…` | `s3` (OCI S3-compat endpoint) or `minio` | `oci ce cluster generate-token` | webhook authorizer: rules review returns `incomplete: true` (#1495, measured) | #1495 (measured); docs/oke.mdx |
| GCP / GKE | `<region>-docker.pkg.dev/<project>/…` | `gcs` | `gke-gcloud-auth-plugin` | IAM webhook: rules review may be `incomplete` | docs/gke.mdx; unverified (GKE exec plugin, GKE authorizer) |
| AWS / EKS | `<account>.dkr.ecr.<region>.amazonaws.com/…` | `s3` | `aws eks get-token` | user mapping: access entries / aws-auth | docs/eks.mdx; unverified (EKS exec plugin, access entries) |
| Azure / AKS | `<registry>.azurecr.io/…` | `azure` or `minio` | `kubelogin` | Entra ID / Azure RBAC may authorize outside Kubernetes RBAC | docs/aks.mdx; unverified (AKS exec plugin, Entra behavior) |
| generic (kind, on-prem) | any registry the nodes can pull | `minio` / `s3` | none / static | plain RBAC (baseline or first-class: open ticket 4) | docs/generic.mdx |

Each row carries a source / verified note: sourced items are drawn from documented paths (ADRs,
issue findings, or docs pages); unverified items are known unknowns pending live verification.
OKE is the first reference implementation; additional clouds are added once verified on their
own cluster. A new cloud is a new row plus its verification record. **If adding a cloud needs an
`if (cloud === …)` anywhere, the design has failed** — the row is missing a column, and the fix
is the column.

**The cloud's own CLI / IaC owns:** cluster creation, node pools, IAM, the registry, buckets, and
exec-plugin authentication. knext reads the kube-context the user already has; it never obtains
one.

**Recommended:** option (a) below.

## Options considered

| | (a) Verify-and-emit **(recommended)** | (b) Guided CLI wrapping cloud CLIs | (c) Terraform / Pulumi modules | (d) Full provisioning ("Vercel-like" literal) |
|---|---|---|---|---|
| What knext does | reads a kube-context; emits manifests + commands the user runs | shells out to `oci`/`aws`/`az`/`gcloud` to create cluster, IAM, registry | ships per-cloud IaC modules the user applies | a service or CLI that creates the whole stack from a repo connect |
| Cluster writes | **none** (ADR-0001 intact; `NextApp` CR stays the only CLI write) | many (Knative, cert-manager, operator, RBAC) — needs an ADR-0001 exception | none by knext, but knext owns the IaC that does them | all of them |
| Cloud credentials held by knext | **none** — only a namespace-scoped kube credential, in the user's CI secret | the user's cloud admin session, in knext's process | none in knext's process, but knext's modules request cloud-admin scope | cloud-admin, stored — on AWS provably not least-privilege (#617) |
| PaaS drift | **none** — stays the adapter | high — becomes a multi-cloud installer | medium — becomes an IaC vendor | total — it is the PaaS `CLAUDE.md` §1 forbids |
| Maintenance per cloud | a data row + one verification | a code path per cloud CLI × its version churn (~8 forced migrations/yr, #617) | a module per cloud × provider-version churn | all of (b) + (c) + an uptime liability |
| Founder's ask met | partially: "prepares" = verifies + emits every step, one command each; creation stays with the cloud | mostly | mostly, for IaC-literate users only (not "zero knowledge") | fully, at the cost of the positioning |
| Credibility lever (fame-first) | reinforces verified-adapter status | competes with it for effort | competes with it for effort | replaces it |

(b) is the tempting middle: it looks like a thin wrapper, but it moves the user's cloud-admin
session into knext's process and makes knext the writer of Knative, cert-manager and RBAC — two
hard-rule breaks for a convenience the emitted commands already give. (c) keeps credentials out of
knext's process but makes knext the maintainer of four IaC modules for users who, by the founder's
own framing, cannot read them. (d) is recorded because it is the literal reading of the ask; #617
already measured it as not buildable least-privilege on AWS.

## Tripwires — a PR with any of these stops

A PR that trips any line below does not merge on code review + CI; it is escalated as an ADR-0001 /
security trigger (`workflow.md`), and the default answer is no:

1. **A cloud SDK import** anywhere in `packages/` (`@aws-sdk/*`, `oci-*`, `@azure/*`,
   `@google-cloud/*`, and Go modules: `github.com/aws/aws-sdk-go-v2/*`, `cloud.google.com/go/*`,
   `github.com/Azure/azure-sdk-for-go/*`, `github.com/oracle/oci-go-sdk*`). State at the time of
   writing: two bounded exceptions exist: `packages/kn-next-operator/internal/controller/external_cleaner.go:23-25`
   imports `github.com/aws/aws-sdk-go-v2/{config,service/s3}` for S3 external cleanup (Go operator
   data-plane exception), and `packages/lib/src/clients.ts:2` imports the `minio` S3 client
   (storage client exception). `@getknext/core` still declares `@google-cloud/storage` as a dependency
   (externalised in the bundle, imported by nothing). That declaration is pre-existing debt to remove,
   not precedent to build on.
2. **A cloud CLI invoked by knext** to create, mutate or authenticate cloud resources
   (`aws`, `oci`, `az`, `gcloud`, `eksctl`, …). The existing storage-upload shell-outs
   (`gsutil`/`aws s3`/`mc`/`az storage`), which the user authenticates and which touch only the
   user's own asset bucket, are the pre-existing, bounded exception; they do not widen.
3. **A stored cloud-account / IAM credential** — in config, in a generated file, in a CRD field, in the operator,
   or in any knext-owned state. (Bucket-scoped or data-plane credentials held in Kubernetes Secrets
   are permitted — e.g. the OKE docs' "Customer Secret Key".)&nbsp;
4. **A per-cloud branch in the operator.** The operator reconciles `NextApp`; it does not know which
   cloud it runs on.
5. **Any `kubectl apply` (or API write) from the CLI (`packages/kn-next/src/cli`) or the action
   (`packages/kn-next-action`) other than the `NextApp` CR.** The one sanctioned exception is operator
   installation via the published `install.yaml`, **run by the user**, which knext may *emit* as a
   command but never executes. (Note: `packages/kn-next/src/cli/loadtest.ts:92` runs `kubectl apply`
   of a ConfigMap + Job; this is pre-existing debt tracked in #1544, not precedent. The operator writes
   Knative objects by design and is out of scope for this tripwire.)

## Tripwire enforcement — scan-backed vs. review-only

- **Tripwire 1** (cloud SDK imports): scan-backed via `package.json` / `go.mod` dependency graphs +
  grep imports in `packages/*/src` and Go source.
- **Tripwire 2** (cloud CLI invoked): scan-backed via argv scan for `aws|oci|az|gcloud|eksctl|gsutil|mc`
  in `packages/kn-next/src/cli/`, against an allowlist of (CLI, subcommand) pairs in
  `utils/asset-upload.ts`.
- **Tripwire 3** (stored cloud-account credential): review-only + gitleaks for committed secrets.
- **Tripwire 4** (per-cloud operator branch): heuristic Go scan for cloud-identity strings in
  non-comment code. The storage-provider switch (e.g. `external_cleaner.go:59 case "s3","minio"`)
  remains legal because it is a row attribute.
- **Tripwire 5** (non-`NextApp` API write from CLI): scan-backed via argv scan for
  `kubectl apply|create|patch|replace|delete` in `packages/kn-next/src/cli`, with resource-kind
  checking for `apply -f` manifests.

(Per `.claude/rules/workflow.md`: a documented expectation that is not scan-backed degrades over
time. Tripwire 3 is review-only by necessity, not design.)

## knext does not own

- creating, upgrading or deleting clusters or node pools;
- cloud IAM: roles, policies, service principals, workload identity, IRSA bindings;
- registries (creation, auth, retention) and pull-secret provisioning in the cloud;
- object-storage buckets, their policies and CDN fronting;
- managed Redis / Postgres provisioning;
- kubeconfig acquisition and exec-plugin authentication;
- installing Knative, Kourier or cert-manager (knext verifies their versions and emits the
  commands; the user runs them);
- DNS, TLS certificates for custom domains, and WAF;
- a hosted control plane, multi-tenancy, or anyone's uptime.

## Answer to #614

**Out of scope for the adapter.** Zero-knowledge onboarding *as provisioning* is not something
knext will own: it breaks ADR-0001, it moves cloud credentials into knext, #617 measured it as not
buildable least-privilege on AWS, and it competes with the verified-adapter credential for the same
effort. What knext does own is the part of onboarding that is genuinely adapter-shaped — telling a
user precisely what their cluster lacks and handing them the exact artifacts to fix it — which is
this ADR.

A hosted or managed layer ("connect a repo, we run it") would be a **separate product decision**,
not an extension of this adapter. For it even to be considered it would need: its own positioning
ADR amending `CLAUDE.md` §1–2 (it is the product-revenue path the strategy defers); a legal entity
(3 of 4 marketplaces require one, #621); an operated control plane with on-call and liability; a
credential-custody model for customers' cloud accounts with its own threat model; and a decision on
what it de-prioritises from the compat credential. None of that is in this ADR, and nothing here
presupposes it: a managed layer would consume the same conformance profile as an input, so this
design does not foreclose it.

## Consequences

- **Positive.** ADR-0001's `NextApp` CR invariant stays intact; tripwire 5 is scoped to the CLI and
  action. Credential custody holds (cloud-account credentials never stored); bucket-scoped data-plane
  credentials in K8s Secrets are permitted. Adding a cloud is a data row plus a verification record.
  The profile gives #1495's authorizer quirk a home that is read, not rediscovered. `doctor` and
  `init-ci` converge into one surface instead of a third. The emitted artifacts are diffable,
  reviewable and GitOps-compatible.
- **Negative, stated rather than dressed up.** The founder's "zero cloud knowledge" is **not fully
  met**: the user still runs the cloud's own cluster-create command and still owns IAM. The honest
  claim is "one cluster-create command from your cloud's docs, then knext tells you every remaining
  step and hands you the files." The data-row table also needs periodic re-verification per cloud;
  a stale row is a wrong emitted command.
- **Security.** Verify is read-only, but it runs with whatever kube-context the user supplies, which
  is often cluster-admin. It must never *use* that breadth (no writes, no Secret reads), and its
  output must not echo credentials. The scoped-credential shape in the profile is what CI gets;
  the admin context never leaves the user's machine.

## Sequencing and action items

**Not before the v1.0 credential windows are banked** (the four-cell matrix, ADR-0056/0058). The
compat credential is the north-star lever; this work does not compete with it for the same sprint.

1. **This sprint (done by landing this ADR):** the contract, the tripwires, the "does not own"
   list, #614 answered, the wayfinding map and its five decision tickets filed.
2. **First implementation slice, after the windows bank:** `knext cluster verify` (read-only,
   profile-driven, subsuming `doctor`'s cluster checks) + cloud-aware emitted `init-ci` artifacts,
   on **one reference cloud: OKE, dogfooded** (the docs site already deploys there). The OKE row
   must carry the webhook-authorizer quirk and resolve #1495's fail-open behaviour through it.
3. **Then:** one row per additional cloud, each gated on its own live verification, in the order
   the credential-window work already exercises clusters (GKE, EKS, AKS), with generic placed per
   ticket 4.
4. **Before any slice:** the five wayfinding tickets (#1537–#1541) resolve — (1) verify-and-emit only vs. an
   ADR-0001 exception for a `knext cluster install`; (2) token form and rotation; (3) profile
   versioned with the operator or the CLI; (4) generic as baseline row or first-class row;
   (5) storage/registry: docs only or emitted IaC snippets.
