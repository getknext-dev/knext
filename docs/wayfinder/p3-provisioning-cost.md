# P3 — What does multi-cloud cluster provisioning cost to build, and to keep working?

> Wayfinder ticket **#617** (child of map **#614**).
> **Research date: 2026-08-03.** Every number below is traceable to a primary source cited inline —
> a vendor lifecycle page, a GitHub release list queried on the date above, or a file in this repo.
> Where something could not be established from a primary source it says **not established**
> rather than being estimated from intuition.

## The proposal under test

> knext provisions a managed Kubernetes cluster **into the user's own cloud account** across AWS
> (EKS), Oracle (OKE), Azure (AKS) and Google (GKE), then installs Knative + Kourier + cert-manager
> + the knext operator into it.

Two costs, and the ticket is right that the second is the one that matters:

| | Verdict |
|---|---|
| **Build** | Tractable, and not the decision. A working `create cluster` path per cloud is weeks, not months — the vendor CLIs each do it in one command (~15–20 min for EKS). |
| **Keep working** | **This is the whole cost: ≈ 8 externally-forced migration events per year via the vendor CLIs, ≈ 20 via Cluster API, ≈ 20–23 via Terraform** — one every **2–7 weeks, permanently**, on release trains knext does not control and cannot pin (§6.1, arithmetic shown). |
| **Credential surface** | **The blocking finding. Only GCP has a shape that can honestly be called least-privilege**, and only with extra work. On **AWS it is structurally impossible** — creating an EKS cluster requires `iam:CreateRole` + `AttachRolePolicy` + `PassRole`, which *is* escalation to account admin. Azure lands on subscription/RG **Contributor** (Owner if identities are wired). Oracle stays broad but is genuinely **compartment-containable**. |

**Recommendation: do not build it** (§7). Ship a documented "you bring the cluster" prerequisite and
spend the same effort on a read-only `knext doctor` preflight instead.

---

## 1. The clock nobody in this repo controls

Provisioning is not a feature you ship once. The moment knext creates a cluster in a user's
account, knext has taken on that cluster's *lifecycle*, and every cloud force-expires Kubernetes
versions on a published schedule.

### 1.1 Per-cloud version lifecycle (primary sources)

| Cloud | Supported window | What happens at the end | Source |
|---|---|---|---|
| **EKS** | **14 months** standard support, then **12 months** extended | Cluster is **auto-upgraded** to the oldest supported extended version if you do nothing. Extended support is **on by default**. | [EKS Kubernetes version lifecycle](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html) |
| **GKE** | **~14 months** standard, **up to 24 months** total with extended | GKE **automatically upgrades** the control plane. Clusters not in a release channel are upgraded anyway; maintenance exclusions cap at **30 days**. | [GKE versioning and support](https://cloud.google.com/kubernetes-engine/versioning), [GKE release schedule](https://cloud.google.com/kubernetes-engine/docs/release-schedule) |
| **AKS** | **N-2** (three GA minors), i.e. ~**12 months** community support, then **N-3** platform support only, then **N-4** = nothing. One year of LTS available. | Platform support explicitly **does not cover Kubernetes functionality** — only "AKS/Azure platform related issues". | [AKS supported Kubernetes versions](https://learn.microsoft.com/en-us/azure/aks/supported-kubernetes-versions) |
| **OKE** | **Three** minors for new clusters, plus the fourth-oldest for a **minimum of 30 days** after a new version is announced | Older version simply "ceases to be supported". | [OKE supported Kubernetes versions](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengaboutk8sversions.htm) |

**OKE has the shortest window of the four, by a wide margin, and it is not close.** From OKE's own
release calendar: 1.34 released to OKE 2026-02-03, 1.35 on 2026-04-28, 1.36 on 2026-07-07 — a new
minor roughly **every 2.5 months**, with only three supported at a time. That is an effective
support window of **~7–9 months**, against EKS's 14 (+12). A knext user on OKE therefore hits a
forced upgrade roughly **twice as often** as the same user on EKS.

The windows are not aligned. They are not even the same *shape*: EKS and GKE sell you extra time
for money, AKS gives you a degraded-support tier, OKE gives you 30 days' grace. A tool that
provisions across all four is signing up to track four unrelated calendars.

### 1.2 Cost, not just effort

EKS extended support is **$0.60 per cluster-hour versus $0.10** standard —
[EKS pricing](https://aws.amazon.com/eks/pricing/). That is a **6× control-plane bill** as the
automatic consequence of not upgrading in time. If knext provisions the cluster, the user will
reasonably read that bill as knext's fault.

### 1.3 Deprecations land on dates, and they are already scheduled

This is not speculative. Two dated examples found in the primary sources while researching this
ticket, neither of which knext chose:

- **GKE**: "Not enrolling your cluster in a release channel (known as *No channel*, and formerly as
  *Static*) is a deprecated configuration option and **will be removed on June 14, 2027**. After the
  removal date, GKE enrolls all remaining clusters in the Stable channel."
  ([GKE release schedule](https://cloud.google.com/kubernetes-engine/docs/release-schedule))
- **AKS**: "Starting on **November 30, 2025**, AKS no longer supports or provides security updates
  for Azure Linux 2.0… Beginning on **March 31, 2026**, node images will be removed, and **you'll be
  unable to scale your node pools**."
  ([AKS supported Kubernetes versions](https://learn.microsoft.com/en-us/azure/aks/supported-kubernetes-versions))

A node-image retirement that silently breaks *scaling* is precisely the failure knext would be
blamed for, because knext's entire value proposition is scale-to-zero — i.e. scaling.

### 1.4 The vendor CLIs move faster than the clouds do

Release cadence measured from GitHub on 2026-08-03 (`gh api .../releases`):

| Tool | Recent cadence | Evidence |
|---|---|---|
| `eksctl` | **~7 releases in 5 months** (v0.224.0 2026-03-04 → v0.229.0 2026-07-01) — roughly monthly. 129 open issues. | `repos/eksctl-io/eksctl/releases` |
| `az` (azure-cli) | **Monthly minor** (2.82.0 2026-01-13 → 2.88.0 2026-07-07 — 6 minors in 6 months) | `repos/Azure/azure-cli/releases` |
| `oci` CLI | **Weekly** (v3.84.0 2026-05-26 → v3.90.0 2026-07-28 — 10 releases in 9 weeks) | `repos/oracle/oci-cli/releases` |
| AKS platform release notes | **~monthly** (8 releases 2026-01-04 → 2026-07-17) | `repos/Azure/AKS/releases` |

The `oci` CLI ships **weekly**. Any knext code that shells out to it, parses its output, or pins its
version is subscribing to a weekly upstream. Azure's `Azure/AKS` repo carries **19 issues with
"deprecation" in the title** and **8 open issues labelled `announcement`** (queried 2026-08-03) —
that is the ambient deprecation rate on one cloud.

---

## 2. Evidence from this repo: the second cloud already cost real work

This is the strongest evidence available, because it is knext's own, and it is not a guess.

**knext has been stood up on two clouds, and reaching the second one produced an ADR.**
`docs/adr/0009-kourier-ingress-class.md` (Accepted, 2026-06-22) records it verbatim:

> *"During OKE validation, knext apps were unreachable through the ingress and the symptom was
> diagnosed as **'Kourier broken on k8s 1.34.'** That diagnosis was **wrong**. The real cause:
> Knative Serving's `config-network` ConfigMap … left `ingress-class` **unset**, so Serving never
> programmed routes against the installed Kourier ingress."*

Read that as a cost estimate for the *n*th cloud:

1. It presented as a **Kubernetes-version bug** and was not one. Debugging time was spent on the
   wrong hypothesis first.
2. The fix was a **manual, undocumented, easy-to-forget `kubectl patch`** — exactly the class of
   step that rots.
3. Making it durable required an **ADR, a bundle ConfigMap, a `--server-side` apply semantics
   decision, and a kustomize `PatchTransformer`** to survive the operator's own `namePrefix`
   rewriting. That is a non-trivial engineering change caused by one cloud's default differing.
4. A **secondary defect** shipped alongside it: internal docs carried a short `kourier.knative.dev`
   ingress-class form that "does **not** match Kourier's ingress class and leaves routes
   unprogrammed."

That is the real per-cloud tax, observed once, at *n*=2, for the *installation* layer only —
before any provisioning code existed at all.

**And the honest coverage state today is 2 of 4, not 4 of 4.**
`docs/operator/multi-cloud-portability.md` (last touched 2026-07-24) reports GKE end-to-end and
kind as **Verified**, and EKS/AKS as not. OKE is now demonstrably live (the scale-to-zero benchmarks
in `docs/benchmarks/scale-to-zero-oke.md` and ADR-0025 both run against it), so that table's OKE row
is stale — but **EKS and AKS have never been validated end-to-end**, and issue **#306
("Validate end-to-end deploy on a second real cloud (EKS)") is still open**, gated on account access
and a ~$75 bounded spend per `docs/SPRINT_2.md`.

So the proposal is to build *provisioning* for four clouds when knext has *deployment* verified on
two, and the second one cost an ADR.

### 2.1 The per-cloud divergences are already enumerated — and they are not small

`docs/operator/multi-cloud-portability.md` already documents four axes on which the four clouds
differ, each of which a provisioner would have to get right:

| Axis | Divergence |
|---|---|
| Default StorageClass | GKE `standard-rwo` · EKS `gp2`/`gp3` (**and you must install the EBS CSI driver add-on**) · AKS `managed-csi` · OKE `oci-bv` |
| LoadBalancer / gateway | GKE auto L4 · **EKS needs the AWS Load Balancer Controller and returns a hostname, not an IP** · AKS auto · OKE via `oci-load-balancer` annotations |
| Ingress class | The ADR-0009 case above |
| Build-host CLI + auth | `gsutil`/ADC · `aws`/IAM · `mc`/access keys · `az`/service principal |

"EKS returns a hostname, not an IP" is a data-shape difference, not a config difference. Code that
assumes an IP does not fail loudly on EKS at provision time — it fails later, in routing.

---

## 3. The credential surface — the security finding

`.claude/rules/security.md` binds here. The relevant invariant is not one of the endpoint rules; it
is the posture behind them: **no implicit trust, least privilege, and secrets in K8s Secrets only.**
A provisioning feature inverts that. It asks the user to hand knext a credential that can create
infrastructure in their account.

### 3.1 What a user must actually grant, per cloud

#### AWS (EKS) — **no least-privilege path exists**

`eksctl`'s own documented minimum (["Minimum IAM policies"](https://eksctl.io/usage/minimum-iam-policies/), the set AWS uses for eksctl's integration tests) is:

- **`AmazonEC2FullAccess`** (AWS managed policy)
- **`AWSCloudFormationFullAccess`** (AWS managed policy)
- **`EksAllAccess`**: `"Action": "eks:*"` on `"Resource": "*"`, plus `ssm:GetParameter*`,
  `kms:CreateGrant`, `kms:DescribeKey`, `logs:PutRetentionPolicy`
- **`IamLimitedAccess`**: `iam:CreateRole`, `iam:DeleteRole`, `iam:AttachRolePolicy`,
  `iam:PutRolePolicy`, `iam:UpdateAssumeRolePolicy`, **`iam:PassRole`**, `iam:CreatePolicy`,
  `iam:CreateOpenIDConnectProvider`, `iam:CreateInstanceProfile` … scoped to `.../role/eksctl-*`,
  `.../policy/eksctl-*`, `.../instance-profile/eksctl-*`

**This is administrator access wearing a name badge.** Three independent reasons, each sufficient:

1. **`iam:CreateRole` + `iam:AttachRolePolicy` + `iam:PassRole` is the textbook IAM
   privilege-escalation primitive.** Even scoped to the `eksctl-*` name prefix, the holder can
   create a role named `eksctl-anything`, attach `AdministratorAccess` to it (`AttachRolePolicy`'s
   *resource* is the role, not the policy being attached), and pass it to a service they control.
   The name-prefix scoping constrains the role's *name*, not its *permissions*.
2. **`AmazonEC2FullAccess`** alone is account-wide compute: launch instances, and — with the above —
   launch them with an attached instance profile.
3. **`AWSCloudFormationFullAccess`** lets the holder run arbitrary stacks, which is a generic
   "do anything the passed role can do" engine.

Verified against the live policy document on 2026-08-03: the *only* `Condition` block in
`IamLimitedAccess` is on `iam:CreateServiceLinkedRole` (constraining `iam:AWSServiceName`). There is
**no `iam:PolicyARN` condition on `AttachRolePolicy`** and **no `iam:PassedToService` condition on
`PassRole`**. The escalation above is not theoretical — nothing in the documented minimum blocks it.

There is no AWS managed policy for "may create an EKS cluster and nothing else," and none can exist,
because creating an EKS cluster *inherently* requires creating and passing IAM roles (the cluster
role and the node role).

**The one real mitigation, stated fairly:** an AWS **permissions boundary** attached to the role
knext assumes would cap the effective permissions of any role it creates or passes, defusing the
escalation. eksctl supports this (`userdocs/src/usage/iam-permissions-boundary.md`,
`pkg/apis/eksctl.io/v1alpha5/iam.go` — confirmed via GitHub code search 2026-08-03). But it is
**user-side configuration knext cannot assume, cannot verify from inside, and cannot enforce**. A
security posture that is correct only when the customer has independently done an advanced IAM
setup is a documented expectation, not a control — and `.claude/rules/security.md` is explicit that
a documented expectation degrades and its efficacy is unobservable until it has already failed.

**Blast radius if it leaks: the entire AWS account**, and the leak is durable if delivered as
long-lived access keys. AWS's documented pattern for third-party access is a cross-account role with
an **external ID** ([Access to AWS accounts owned by third parties](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html)) — which mitigates the *confused-deputy* problem but does nothing about the scope above. That page's own warning is the honest summary: *"When you grant third parties access to your AWS resources, they can access any resource that you specify in the policy. Their use of your resources is billed to you."*

A second, quieter blast radius: per [EKS access management](https://docs.aws.amazon.com/eks/latest/userguide/grant-k8s-access.html), the IAM principal that creates a cluster is the one wired into its Kubernetes access. **Whoever provisions the cluster holds cluster-admin on it.** knext would be that principal.

#### Azure (AKS) — a real least-privilege role exists, but it is not sufficient alone

`Azure Kubernetes Service Contributor Role` (`ed7f3fbd-…`) grants
`Microsoft.ContainerService/managedClusters/*` + `Microsoft.ContainerService/locations/*` +
`Microsoft.Authorization/*/read`
([Azure built-in roles for Containers](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers)).
That is genuinely narrow — notably it grants **no** `Microsoft.Authorization/*/write`.

But that narrowness is exactly why it is not enough for a provisioner:

- It cannot create the **resource group**, the **VNet/subnet**, or the **public IP**.
- Attaching an AKS cluster to a pre-existing VNet requires giving the cluster's managed identity a
  role (e.g. Network Contributor) on the subnet, and **creating a role assignment requires
  `Microsoft.Authorization/roleAssignments/write` — i.e. Owner or User Access Administrator**, which
  this role does not have.

So in practice a provisioner asks for **Contributor on a subscription or resource group**, and for
anything involving identity wiring, **Owner / User Access Administrator**. Delegation to a
third-party tool means a **service principal with a client secret or certificate** — a long-lived
credential.

Also relevant to blast radius: `Azure Kubernetes Service Cluster Admin Role` grants
`listClusterAdminCredential` **and `managedClusters/runcommand/action`** — the latter executes
commands against the cluster's API server, bypassing network restrictions.

**Verdict: partial least privilege. Best of the four, still not clean.** Realistic ask is
subscription/RG **Contributor** (create anything, in that scope, including cost), escalating to
**Owner** if the tool wires identities.

#### Google (GKE) — narrow-ish IAM role, but a documented escalation to the node identity

`roles/container.clusterAdmin` grants `container.clusters.create|delete|update|get|list|connect`,
`container.operations.*`, `resourcemanager.projects.get|list`
([Create IAM allow policies](https://cloud.google.com/kubernetes-engine/docs/how-to/iam)) — much
tighter than the AWS set. But:

- **`roles/iam.serviceAccountUser` is additionally required** on the node service account. Google's
  own docs state it for both `container.admin` and `container.clusterAdmin`: *"To set a service
  account on nodes, you must also have the Service Account User role."*
- **The default node service account is the Compute Engine default SA**, which Google's hardening
  guide explicitly warns *"might have more permissions than GKE needs, which could expose you to
  security risks"* ([Hardening your cluster](https://cloud.google.com/kubernetes-engine/docs/how-to/hardening-your-cluster)). The escalation is: create a cluster → `clusters.connect` → schedule a pod → inherit the node SA. In the default configuration that is a project-level identity.
- **Delegating to a third party means a service account key** (a JSON private key). Google's own
  guidance is unambiguous that this is the risky path: *"Service account keys can become a security
  risk if not managed carefully. You should choose a more secure alternative for authentication
  whenever possible,"* naming **credential leakage** and **privilege escalation** as the top two
  threats ([Best practices for managing service account keys](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)). Workload Identity Federation is the alternative, and it is a materially more complex onboarding flow.

**Verdict: closest thing to a least-privilege path**, provided the provisioner also creates and uses
a **custom least-privilege node service account** rather than accepting the Compute Engine default.
That is extra work knext would have to do, and get right, or the "least privilege" claim is false.

#### Oracle (OKE) — policy language is expressive; the required set is still broad

OKE's documented **required** policy for a non-Administrators group
([Policy configuration for cluster creation](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengpolicyconfig.htm)) is:

```
Allow group <group> to manage instance-family        in <location>
Allow group <group> to use subnets                   in <location>
Allow group <group> to manage virtual-network-family in <location>
Allow group <group> to inspect compartments          in <location>
Allow group <group> to use vnics                     in <location>
```

`manage instance-family` + `manage virtual-network-family` is **create/delete any compute instance
and any network object** in that scope. The Quick-Create workflow additionally needs VCN\_CREATE.
Larger clusters need service policies such as `Allow service oke to manage private-ips in tenancy`.

The one genuinely good news: **`<location>` can be `compartment <name>` rather than `tenancy`**, and
OCI's compartment model gives a real, enforceable blast-radius boundary that AWS's name-prefix
scoping does not. Oracle documents scoping these to the cluster compartment explicitly. Cross-org
delegation has a first-class mechanism too — `Define`/`Endorse`/`Admit` cross-tenancy statements
([Accessing cluster-related resources across tenancies](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengaccessingokeresourcesacrosstenancies.htm)).

**Verdict: the best *containment* story of the four** (compartment-scoped), but the permission set
inside that compartment is still "manage all compute and all networking". Delegated credentials are
an **API signing key** (an RSA private key in a config file) — long-lived, like GCP's.

### 3.2 Credential surface summary

| Cloud | Minimum documented grant | Least-privilege path? | Blast radius if leaked | Credential shape for a 3rd party |
|---|---|---|---|---|
| **AWS** | `AmazonEC2FullAccess` + `AWSCloudFormationFullAccess` + `eks:*` + `iam:CreateRole`/`AttachRolePolicy`/`PassRole` | **No.** `CreateRole`+`AttachRolePolicy`+`PassRole` is escalation to admin by construction | **Whole account** | Cross-account role + external ID (better), or long-lived access keys (worse) |
| **Azure** | AKS Contributor Role for the cluster; **Contributor** on RG/subscription in practice; **Owner/UAA** if role assignments are needed | **Partial** | Whole resource group / subscription, incl. `runcommand` into the cluster | Service principal + client secret or cert (long-lived) |
| **GCP** | `roles/container.clusterAdmin` + `roles/iam.serviceAccountUser` | **Closest to yes**, *only if* a custom node SA is created | Project — and via the default node SA, potentially wider | SA JSON key (Google advises against) or Workload Identity Federation (complex) |
| **Oracle** | `manage instance-family`, `manage virtual-network-family`, `use subnets`, `use vnics`, `inspect compartments` | **No, but containable** — compartment scoping is real | The compartment (bounded), tenancy if scoped there | API signing key (long-lived), or cross-tenancy Endorse/Admit |

**The security verdict:** on **AWS this is structurally unfixable** — you cannot create an EKS
cluster without creating and passing IAM roles, and that capability is admin. On **Azure and Oracle**
the ask is "manage all compute and networking in a scope". Only **GCP** has a shape that could
honestly be called least-privilege, and only with extra work.

Whatever the mechanism, knext would hold a long-lived, high-privilege, cross-customer credential
store. That is a fundamentally different security posture from today's knext, which holds **no
customer credentials at all** — the user runs the CLI with their own already-present cloud
credentials, and every cluster write targets the `NextApp` CR (CLAUDE.md §4). Becoming a custodian
of four clouds' admin credentials is not an increment on that; it is a category change, and it makes
knext a supply-chain target whose compromise is worth four clouds' worth of customer accounts.

---

## 4. The four mechanisms, compared

| Mechanism | Build cost | Forced events/yr (§6.1) | What breaks | Who fixes it | Disqualifier |
|---|---|---:|---|---|---|
| **Per-cloud CLIs** | Lowest — one command each | **≈ 7.8** | Flag renames, default changes, output-shape drift, per-cloud divergence | **knext**, every time | None fatal — but *all* the integration is knext's |
| **Terraform / OpenTofu** | Medium | **≈ 20–23** | Module majors that **replace live infrastructure**; provider majors; OKE's *unsignalled* floor jumps | Upstream absorbs some; knext owns the migration | **Second source of truth** — collides with ADR-0001 |
| **Cluster API** | Highest | **≈ 20** | CAPI API restructuring; 12-month EOL; provider health | knext | **Needs a cluster to create a cluster** — see §4.3 |
| **Vendor quickstart (docs only)** | ~zero | **0** | Nothing knext owns | The cloud vendor | None — this is the recommendation (§7) |

### 4.1 Per-cloud CLIs (`eksctl`, `az aks`, `gcloud container`, `oci ce cluster`)

**Build cost: lowest of the four.** Each is one documented command. eksctl's own getting-started
page states cluster creation "typically takes 15-20 minutes."

**Maintenance cost: you inherit four independent, fast-moving CLIs** (cadences in §1.4 — `oci` is
*weekly*), and you own the **integration** yourself. There is no shared abstraction: the four have
different config schemas, different auth models, different output shapes, different error
vocabularies, and different ideas of what a cluster comes with by default (§2.1). Every per-cloud
divergence is knext code.

**What breaks:** a CLI flag is renamed or deprecated; a default changes (AL2023 vs AL2, admission
defaults, CNI); an output field moves. **Who fixes it: knext.** There is no upstream module
absorbing it on your behalf — that is the entire trade against Terraform.

**Honest advantage:** it is also the only mechanism with **no additional dependency to keep
current**, and the failure is usually loud and immediate (a command exits non-zero) rather than a
silent drift.

### 4.2 Terraform / OpenTofu modules

The community modules are the most-travelled path, and they are also the clearest available
measurement of what "keeping this working" costs, because their breaking changes are *published*.
All figures below computed from GitHub release/tag data on **2026-08-03**.

| Module | Majors shipped | Breaking-change cadence | Open issues | Provider-floor signal |
|---|---|---|---|---|
| `terraform-aws-modules/terraform-aws-eks` | 21 (v1 2018-06-11 → v21 2025-07-23) | **~12.5 months** over the last 4 majors | 10 (+5 PRs); 7 mention "provider" | Requires `aws >= 6.0`; AWS provider v6.0.0 shipped 2025-06-18 |
| `Azure/terraform-azurerm-aks` | 5 (2022-08-09 → 2025-09-02) | **~9.2 months** mean | 4 — smallest backlog | `azurerm >= 4.16, < 5.0`; **azurerm v5.0.0 shipped 2026-07-28 and the module has not adopted it** |
| `terraform-google-modules/terraform-google-kubernetes-engine` | **44** (2019-03-26 → 2026-03-06) | **~1.9 months** mean, **~1.3 months** over the last 4 | **54** (+27 PRs); 31 mention "google provider" | `google >= 7.17, < 8`; provider v7 shipped 2025-08-26, module floor caught up ~6 months later |
| `oracle-terraform-modules/terraform-oci-oke` | 5 (v1 2019-09-27 → **v5 2023-10-25**) | **No major in 2.75 years** | **69** — largest relative to its size | **The sharp finding — see below** |

Three things this table says that matter more than the averages:

1. **The cadences do not agree, so "keep the Terraform modules current" is not one job.** GKE's
   module treats nearly any breaking change as a major and ships one roughly **monthly**; AWS's and
   Azure's ship **annually**. A knext that pins all four is perpetually stale on one and churning on
   another.

2. **A major bump is not a version-string edit — it can replace live infrastructure.**
   - `terraform-aws-eks` **v21** (2025-07-23): removes the `aws-auth` submodule outright, renames
     `cluster_encryption_config` → `encryption_config`, and changes node-group defaults (IMDS hop
     limit → 1, `ami_type` → AL2023, `enable_monitoring` → false) that can **force node / launch-template
     replacement**. **v20** (2024-02-02): renames `resolve_conflicts` → `resolve_conflicts_on_create`/
     `_on_update`, and a Karpenter EventBridge rule key fix that **forces resource replacement**.
   - `terraform-azurerm-aks` **v10** (2025-05-06): removes 7 variables, restructures subnet inputs
     into nested `.id` objects, and states that `azurerm_role_assignment.network_contributor`
     **will be destroyed and re-created** because of a `for_each` key-type change. **v11**
     (2025-09-02) drops AzureRM v3 and renames `enable_auto_scaling` → `auto_scaling_enabled` (and
     two siblings), top-level *and* inside `node_pools[*]`.
   - `terraform-google-kubernetes-engine` **v43** (2026-01-06): removes `kalm_config`, `istio`,
     `istio_auth` and the `istio_enabled` output entirely — users must migrate to Cloud Service Mesh.

   "Destroy and re-create a role assignment" and "force node replacement" are not upgrade chores in
   someone else's repo. If knext provisioned the cluster, they are **downtime in a customer's
   account**, executed by knext's code.

3. **OKE's module is the one that should stop this proposal on its own.** Its SemVer major has been
   frozen at **v5 since 2023-10-25** — 2.75 years — while its `versions.tf` floor climbed to
   `oci >= 8.14.0`, absorbing **three full OCI provider majors** (v6 2024-06-26, v7 2025-05-06,
   v8 2026-02-04) through **minor and patch releases**. A `~> 5.0` pin therefore still receives
   de-facto-breaking provider jumps that the module's own version number does not signal. That is the
   worst possible maintenance property: **breakage that arrives without a version bump to warn you.**
   It also carries the largest issue backlog of the four (69 open) relative to its size.

**Terraform also imports a state problem knext does not have today.** Terraform state is a
stateful, lockable, corruptible artifact that must live somewhere and be owned by someone. knext's
current architecture has exactly one source of truth for cluster state — the operator (ADR-0001).
Adding Terraform adds a **second** one, off-cluster, with its own drift and locking semantics. That
is an ADR-0001 collision, not a detail.

**OpenTofu**: whether it changes any of the above is **not established**. Issue-tracker search across
all four repos surfaced no OpenTofu-specific compatibility bug, but none of the four was confirmed
to gate CI on OpenTofu either.

### 4.3 Cluster API providers (CAPA / CAPZ / CAPG / CAPOCI)

Cluster API is the most architecturally appealing option — one declarative CRD surface across four
clouds, reconciled by controllers, which is *exactly* the shape knext already likes (ADR-0001). It
is also, on the evidence, the **worst fit for this particular project**, for three separable reasons.

**1. The bootstrap problem is fatal for knext's use case.** Cluster API is a set of Kubernetes
controllers, so **it needs a Kubernetes cluster to run in before it can create one**. The CAPI book
is explicit: *"It is a common practice to create a temporary, local bootstrap cluster which is then
used to provision a target management cluster on the selected infrastructure provider"*, and for the
management cluster itself, *"for production use-cases a 'real' Kubernetes cluster should be used with
appropriate backup and disaster recovery policies and procedures in place"* — while *"kind is not
designed for production use."* Moving from the bootstrap cluster to the real one is `clusterctl move`
("pivoting"), which the docs gate behind a warning to prepare the target first.

So the answer to "knext creates your first cluster" becomes "first, have a cluster." Either the user
runs a local kind cluster (not production, and now a *local Docker* dependency on the deploy path),
or knext operates a **central management cluster** — which means knext is running always-on
infrastructure that holds four clouds' admin credentials and every customer's cluster state. That is
a hosted control plane. It is a different company.

**2. The API surface is still moving.** Measured from the repo on 2026-08-03: CAPI's `api/`
directory was a flat `v1beta1` through **v1.10.0** (2025-04-22) and was **restructured wholesale in
v1.11.0** (2025-08-19) into `core/`, `bootstrap/`, `controlplane/`, `ipam/`, `runtime/`, `addons/`
subtrees — with a `deprecated/` tree at HEAD. This follows the project's long-running
`v1alpha*` → `v1beta*` progression. Consuming CAPI means consuming that migration, and every
provider's version of it.

**3. Support windows are shorter than any cloud's.** From
[`docs/book/src/reference/versions.md`](https://github.com/kubernetes-sigs/cluster-api/blob/main/docs/book/src/reference/versions.md):
*"a new Cluster API version approximately every four months (three releases each year)"*, with
**8 months standard support + 4 months maintenance mode = 12 months, then EOL.** Only N and N-1 are
actively supported. The published matrix shows **v1.11.x already EOL as of 2026-08-18**, v1.10.x EOL
2026-04-21, v1.9.x EOL 2025-12-18. That is a **12-month** window on the *provisioning tool* — shorter
than EKS's or GKE's window on the *cluster*.

**Provider health is the finding that settles it.** All figures `gh api`, 2026-08-03:

| Provider | Latest release | Commits, last 90d | Open issues | Stars |
|---|---|---:|---:|---:|
| `cluster-api` (core) | v1.13.4 (2026-07-15) | **456** | 206 | 4,273 |
| **CAPZ** (Azure) | v1.26.0 (2026-06-30) | **217** | 93 | 334 |
| **CAPA** (AWS) | v2.13.0 (2026-07-29) | **191** | 223 | 724 |
| **CAPG** (GCP) | v1.13.0 (2026-07-29) | **72** | 78 | 227 |
| **CAPOCI** (Oracle) | **v0.24.1** (2026-06-25) | **6** | 54 | **56** |

**CAPOCI is the weakest link and it is not close: 6 commits in 90 days, still pre-1.0 after years,
56 stars.** All four *do* expose managed control planes — CAPOCI has `OCIManagedControlPlane`,
`OCIManagedCluster` and `OCIManagedMachinePool` for OKE — so the capability exists on paper. But
a four-cloud strategy is only as strong as its weakest provider, and knext would be betting its
Oracle path on a repository with **6 commits a quarter**. Whether CAPOCI's managed-OKE path is
formally GA or gated behind a feature flag was **not established** from the sources read.

**Verdict on CAPI: architecturally the best idea, operationally disqualified by the bootstrap
requirement**, before the provider-health question is even reached.

### 4.4 Each cloud's own managed-cluster quickstart

Not a mechanism for a *product* — it is documentation for a human. Its only role here is as the
honest alternative in §7: knext tells the user to run the vendor's quickstart, and meets them at a
working cluster. Its maintenance cost to knext is **zero**, because the vendor maintains it, and its
credential cost to knext is **zero**, because the user's credentials never leave the user.

---

## 5. The in-cluster layer has its own clock, and it is faster

Provisioning the cluster is only half the proposal. The other half — "then installs Knative +
Kourier + cert-manager + the knext operator" — is a *second* maintenance obligation on a *faster*
release train, and this one knext already owns today.

| Component | Cadence | Support window | Source |
|---|---|---|---|
| **Knative Serving** | **Quarterly, on a fixed cron** — "Tuesday of the 4th week of January, April, July, October". Measured mean interval over the last 10 minors: **91.7 days**. | **Most recent 2 minors.** EOL = release date of the `n+2` release + 1 week → **~6 months**. | `knative/community` `RELEASE-SCHEDULE.md`, `RELEASE-VERSIONING-PRINCIPLES.md`; `gh api repos/knative/serving/releases` (2026-08-03) |
| **Kourier** (`net-kourier`) | **Hard minor-version lockstep with Serving.** Every `knative-vX.Y.0` tag has a matching serving tag published within 0–1 day. | Same as Serving. There is no "Kourier N+1 on Serving N". | `gh api repos/knative-extensions/net-kourier/releases` (2026-08-03) |
| **cert-manager** | **~every 4 months** (1.20 → 2026-03-10, 1.21 → 2026-07-08 = **120 days**) | "always at least two supported versions"; no free LTS | [cert-manager releases](https://cert-manager.io/docs/releases/) |

**Knative's supported Kubernetes floor rises roughly one minor per quarterly release** — 1.20→min
K8s 1.32, 1.21→1.33, 1.22→1.34, 1.24→1.35. So the in-cluster layer moves *faster* than any cloud's
version window, and in the same direction. Every quarter, the set of (cloud K8s version, Knative
version) pairs that actually work shifts.

**Bounding the matrix.** 4 clouds × 3 concurrently-offered K8s minors × 2 supported Knative minors ×
2 supported cert-manager minors = **48 combinations**. That is an *upper bound on the claim surface*,
not a count of valid configurations — some combinations are mutually incompatible because Knative's
K8s floor excludes an older-but-still-cloud-supported minor. The exact valid subset was **not
established**; it would require cross-referencing every release's floor against every cloud's
current offering, which is itself the recurring work being costed here. Either way, the honest
reading is: **the number of things a "supports four clouds" claim would have to be true of is in
the dozens, and it turns over every quarter.**

### 5.1 This breakage is documented, on more than one cloud

Named incidents found in the upstream trackers (accessed 2026-08-03), all of the shape
"managed-cluster behaviour broke Knative":

| Issue | What broke |
|---|---|
| [knative/serving#15877](https://github.com/knative/serving/issues/15877) (2025-05-09, **open**) | EKS connectivity during tag-to-digest resolution |
| [net-kourier#1030](https://github.com/knative-extensions/net-kourier/issues/1030) (2023-04-13) | Kourier vs. the EKS ALB — LoadBalancer-service interaction |
| [knative/serving#13298](https://github.com/knative/serving/issues/13298) (2022-09-12, **still open after ~4 years**) | Support for the `restricted` Pod Security Standard — i.e. a cluster whose admission defaults are stricter than Knative expects |
| [knative/serving#15208](https://github.com/knative/serving/issues/15208) (2024-05-15) | All Knative pods `CrashLoopBackOff` with "Failed to get k8s version" — API-server version discovery |
| [cert-manager#3237](https://github.com/cert-manager/cert-manager/issues/3237) (2020-08-30) | cert-manager webhook unusable on EKS Fargate |
| [cert-manager#4613](https://github.com/cert-manager/cert-manager/issues/4613) / [#7096](https://github.com/cert-manager/cert-manager/issues/7096) | Helm does not upgrade CRDs on `helm upgrade` — the standing cert-manager upgrade footgun |
| **ADR-0009 (this repo, 2026-06-22)** | Kourier ingress-class unset on OKE — §2 above |

Two of these deserve emphasis because they are *not* bugs anyone will fix for knext:

- **`restricted` Pod Security Standard has been open for ~4 years.** Clouds tighten admission
  defaults over time. When one does, knext's install bundle breaks, and the upstream fix is not
  coming on knext's schedule.
- **cert-manager API removal**: v1alpha2/v1alpha3/v1beta1 were deprecated in 1.4, removed in **1.6**,
  and manifests referencing them simply stop deploying after upgrade. A provisioner that installed
  cert-manager into a customer's cluster owns that migration for every customer.

---

## 6. The estimate

The ticket asked for a number, not an adjective. The honest way to produce one is **not** to guess
person-weeks — it is to count the **externally-forced migration events per year** implied by the
cadences cited above, because those are the events knext cannot decline, cannot pin away, and cannot
schedule. Every figure below is derived from a source cited earlier in this document; the arithmetic
is shown.

### 6.1 Forced events per year, by source

| Source | Rate | Derivation |
|---|---:|---|
| EKS forced version upgrade | **0.86/yr** | 14-month standard window (§1.1) → 12/14 |
| GKE forced version upgrade | **0.86/yr** | ~14-month standard window (§1.1) |
| AKS forced version upgrade | **1.0/yr** | N-2 ≈ 12-month community-support window (§1.1) |
| OKE forced version upgrade | **~1.6/yr** | 3 supported minors × ~2.5-month OKE release interval ≈ 7.5-month window (§1.1) |
| Knative Serving minor | **2.0/yr** | 4 releases/yr, support window = 2 minors → must move at least every 2 quarters (§5) |
| cert-manager minor | **~1.5/yr** | ~120-day cadence, 2 supported minors (§5) |
| **Subtotal — CLI mechanism** | **≈ 7.8/yr** | one forced event every **~6.7 weeks**, permanently |
| Terraform module majors | **8.6–11.5/yr** | AWS 0.96 (12.5-mo mean) + Azure 1.3 (9.2-mo) + GKE 6.3–9.2 (1.9-mo all-time / 1.3-mo recent) + OKE 0 *signalled* (§4.2) |
| Terraform provider majors | **~3.5/yr** | oci v6→v7 10.3 mo, v7→v8 9.0 mo; google v6→v7 12 mo; azurerm v4→v5 23 mo (§4.2) |
| **Subtotal — Terraform mechanism** | **≈ 20–23/yr** | one forced event every **2.3–2.6 weeks**, permanently |
| *(alt)* Cluster API core + 4 providers | **≈ 12/yr** | CAPI 3 releases/yr on a 12-month EOL → ~3 forced; plus 4 providers each tracking that cadence (§4.3) |
| **Subtotal — Cluster API mechanism** | **≈ 20/yr** | ≈ 7.8 + 12, *plus* the management-cluster the mechanism itself requires |

**Assumption, stated because it matters:** this counts *events that demand a decision*, not events
that each cost the same. Some will be no-ops (bump a pin, CI stays green). But each one has to be
**noticed, assessed, tested on the affected cloud, and released** — and the OKE Terraform module's
unsignalled provider jumps (§4.2) prove that "noticed" is not free either. The floor is not zero;
it is "somebody reads four release feeds every week."

### 6.2 What one event actually costs, measured

The only measured data point available is knext's own, and it is the right kind: **ADR-0009**.
Reaching **one** additional cloud, for the **installation** layer only, with **no provisioning code
involved**, produced:

- a wrong initial diagnosis ("Kourier broken on k8s 1.34") and the debugging spent on it,
- an accepted ADR,
- a new bundle ConfigMap plus a `--server-side` apply decision plus a kustomize `PatchTransformer`
  to survive the operator's own `namePrefix` rewriting,
- and a **shipped documentation defect** (`kourier.knative.dev` vs
  `kourier.ingress.networking.knative.dev`) that silently leaves routes unprogrammed.

That is the unit. Multiply by ~8–23 events per year, across four clouds, forever.

### 6.3 Build cost, for completeness

Build is the small number and it is genuinely small: each cloud's CLI creates a cluster in one
command (~15–20 minutes for EKS per eksctl's own docs). Standing up a first working
`knext provision` on **one** cloud is plausibly a couple of weeks. **This is not the decision.**
The decision is §6.1, and the ratio between them is the entire finding.

### 6.4 What this would do to the current architecture

Three collisions with things this repo has already decided, each of which is a trigger under
`.claude/rules/workflow.md` (contradicting an ADR or a hard rule):

1. **ADR-0001 — the operator is the single source of truth for cluster state.** A Terraform-based
   provisioner introduces a second, off-cluster source of truth with its own state file, locking,
   and drift. A CLI-based provisioner introduces direct cluster/cloud mutation from the CLI, which
   is precisely the pattern CLAUDE.md §4 records as *already removed* ("every CLI cluster write
   targets the `NextApp` CR and nothing else").
2. **`security.md`, secrets.** knext today holds **no customer cloud credentials**. Provisioning
   requires holding high-privilege ones for four clouds (§3). That is a category change in threat
   model, not an increment.
3. **Positioning (CLAUDE.md §1, `architecture.md` §5).** "Provisions and manages your Kubernetes
   clusters across four clouds" is the definition of the general-purpose PaaS the strategy
   explicitly refuses to become. The north star is **verified-adapter status** — open source, passing
   the official Next.js compatibility suite, listed in the Next.js docs. Provisioning contributes
   **nothing** to that, and consumes the maintenance capacity that gets there.

---

## 7. Verdict

**Do not build multi-cloud cluster provisioning.** Three independent reasons, any one of which is
sufficient:

1. **The maintenance obligation is permanent, externally clocked, and larger than the team.**
   ~8 forced migration events per year via CLIs, ~20 via Cluster API, ~20–23 via Terraform (§6.1) —
   one every **2–7 weeks, forever**, on release trains knext does not control. And **no mechanism is
   clean**: the cheapest (CLIs) makes every per-cloud divergence knext's own code; Terraform adds a
   second source of truth against ADR-0001; Cluster API needs a cluster before it can make one.
2. **There is no least-privilege path on AWS, and it is structural, not fixable** (§3.1). The
   credential knext would have to hold is account-admin by construction, and the only mitigation is
   a user-side control knext cannot verify or enforce.
3. **knext has not earned the claim.** Deployment is verified on **two** clouds (GKE, OKE), not four;
   EKS validation (#306) is still open; and reaching cloud #2 cost an ADR (§2). Building
   *provisioning* for four clouds while *deployment* is unvalidated on two of them inverts the order
   of work. This repo already corrected an overclaim in exactly this area — commit `0e097d6`, "the
   landing page overclaimed multi-cloud."

### What to do instead

**Meet the user at a working cluster, and make that the documented contract.** Concretely:

- **Keep provisioning out of scope, explicitly and in writing.** A short "you bring the cluster"
  prerequisite section that links each vendor's own quickstart. Vendor-maintained, zero maintenance
  to knext, zero credential surface.
- **Invest the same effort in `knext doctor` instead.** A preflight that *inspects* an
  already-existing cluster and reports what is missing (Knative present? ingress-class set per
  ADR-0009? StorageClass? LoadBalancer type?) captures most of the real user pain — "I have a
  cluster and knext doesn't work on it" — at a **fraction** of the maintenance cost and with **read-only**
  credentials the user already has. Every per-cloud divergence in
  `docs/operator/multi-cloud-portability.md` is already a check `doctor` could make.
- **Finish the second and third clouds for *deployment* first** (#306). "Verified on four clouds" is
  a far stronger and cheaper credibility claim than "provisions on four clouds", and it is the one
  the north star actually rewards.
- **If provisioning is ever revisited, revisit it for exactly one cloud**, and pick it on the
  evidence: **GCP has the only credential shape that can honestly be called least-privilege** (§3.2),
  and GKE is the one cloud where knext's deployment path is already verified.

---

## 8. What this research did *not* establish

Recorded so nobody reads a gap as a finding:

- **The valid subset of the 48-combination version matrix** (§5). Only the upper bound was computed.
  Establishing the genuinely-compatible subset requires cross-referencing every Knative and
  cert-manager release's stated Kubernetes floor against each cloud's currently-offered minors.
- **Whether OpenTofu changes the Terraform picture** (§4.2). No OpenTofu-specific compatibility bug
  was found in any of the four module trackers, but none of the four was confirmed to gate CI on
  OpenTofu either. Absence of reported breakage is not evidence of support.
- **Knative's tested *upper* Kubernetes bound.** Knative publishes a minimum supported Kubernetes
  version per release but — unlike cert-manager — no explicit tested ceiling. The effective ceiling
  was inferred, not read.
- **Person-week build estimates.** Deliberately not produced. §6.3 gives the one anchored figure
  (a first working path on one cloud), and §6.1/§6.2 give the recurring cost in units that are
  actually derivable from primary sources. Inventing a headline person-month number would have been
  exactly the intuition-estimate the ticket rules out.
- **Whether the Cluster API providers' managed control planes are GA or feature-gated.** All four
  expose managed kinds (§4.3), but whether `OCIManagedControlPlane` / `GCPManagedControlPlane` and
  siblings are GA, experimental, or behind a feature gate such as `EXP_MACHINE_POOL` was not
  established from the sources read. If CAPI is ever seriously considered, that is the first thing
  to check — and CAPOCI's 6-commits-per-quarter activity rate is the reason to check it.
- **AWS provider v5→v6 interval.** The v6.0.0 date (2025-06-18) is cited; the preceding major's date
  was not established, so AWS is absent from the provider-major rate in §6.1 — which makes that
  ~3.5/yr figure an **under**-count, not an over-count.

