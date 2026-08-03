# P7 — Cloud marketplaces and a GitHub Action: what they actually require

**Ticket:** #621 (child of map #614)
**Question:** What do cloud-marketplace listings and a GitHub Action actually require, and do they change the positioning answer?

**Short answer:** They fall on **opposite sides** of the positioning line, and not marginally.

- **Cloud marketplaces — wrong side.** Three of the four (Azure, Google, Oracle) hard-require a
  **registered company**; a solo individual cannot list at all. AWS is the single exception — a free
  listing genuinely needs no legal entity, no tax form, no bank account — but its *architecture*
  requirements would turn knext into an AWS-shaped product, and every marketplace attaches a
  standing support-organization commitment and a continuous re-compliance treadmill.
- **GitHub Action — right side.** No legal entity, no fee, no review, published instantly. It wraps
  the CLI that exists today, needs only **kubeconfig + registry auth** on the required path, and needs
  **no provisioning layer whatsoever**. Cloud credentials are needed only for the *optional* static-asset
  upload step, which already has an opt-out flag.

---

## Part A — cloud marketplaces

### A.1 The decision-relevant fact first: can an individual list?

| Marketplace | Individual can list? | What is actually required |
|---|---|---|
| **AWS** | **Yes — for a free listing** | AWS account in good standing, defined customer-support process, production-ready software. **No banking, no tax form, no incorporation** for free-only sellers. A *paid or BYOL* listing requires residency/citizenship in an eligible jurisdiction **or** a business entity — note AWS accepts an **individual** here too, but demands W-9/W-8, a bank account accepting USD, KYC, and bank verification. |
| **Azure** | **No** | "You must use a **work account** associated with your company or organization. **Personal accounts aren't supported.**" Also: know your company's legal business name and address, and "you must have authority to sign legal agreements **on your company's behalf**." Partner Center verification exists specifically to confirm "your business is **legally registered** with an active registration at the stated address." |
| **Google Cloud** | **No** | "Your **organization** must join and maintain good standing in Google Cloud Partner Network"; "Your organization must be **incorporated** in one of the supported regions"; must hold a Cloud Marketplace vendor account and payment profile. |
| **Oracle** | **No** | Publishers "belong to the Oracle Partner Network." Registration requires an **OPN membership number** (OPN membership is a paid annual programme, ~$500 USD). Paid *package* listings additionally require the entity be **domiciled in the United States** — incorporated in the US, OPN membership tied to that US entity, a USD bank account, and a signed US OCMA agreement. |

**This alone settles it for three of four.** Azure, Google and Oracle are not available to knext in its
current form — not "harder," *unavailable* — until a company exists.

> **One documented inconsistency, recorded rather than smoothed over.** AWS's *Seller eligibility*
> page says free-only sellers need no banking or tax information, and the *Getting started as a seller*
> page repeats it ("If you offer only free products, you don't have to provide banking information").
> But the *container product* getting-started page lists as prerequisite #2: "Register as a seller, and
> **submit your tax and banking information**." The eligibility page is the more specific and more
> recent statement of policy, so the free path is very likely real — but this is a **contradiction in
> AWS's own primary sources**, and it would need confirming with AWS Seller Operations before anyone
> plans around it.

### A.2 Which listing type fits an open-source Kubernetes operator + CLI?

| Marketplace | Relevant listing type | Fit for knext |
|---|---|---|
| **AWS** | **Container product**, with a **Helm chart delivery option** (up to 4 delivery options per product) | Nominally the right shape — but see the architecture constraints below. Note: AWS **discontinues Quick Launch for Helm on EKS on 2026-03-01**; buyers get step-by-step `helm` instructions instead. |
| **Azure** | **Azure Container offer** — since 2024-01-18 all new container offers publish as **Kubernetes Applications** | Poor fit. Targets a **managed AKS cluster** specifically, via the AKS cluster-extension mechanism. knext is Knative-on-any-Kubernetes; the Azure model is AKS-shaped by construction. |
| **Google Cloud** | **Kubernetes app** package (container images + config + a *deployment container* that pushes config to the K8s API) | Poor fit — and blocked on a separate requirement, below. |
| **Oracle** | Package/stack listings (Terraform stacks, images) or non-package listings | Non-package listings escape the US-domicile rule, but still require OPN membership. |

**AWS's architecture requirements are the ones that would actually reshape the product:**

- "Source container images for AWS Marketplace **must be pushed to the Amazon ECR repository owned by
  AWS Marketplace**." The operator image would have to be mirrored into an AWS-controlled registry —
  it could not simply be the GHCR image knext publishes.
- "Container-based products **must not require a user to launch the product using any images from
  outside AWS Marketplace**." knext's install depends on **Knative Serving, Kourier and cert-manager**,
  none of which are knext's images. This is not a formatting issue; it goes to whether knext is
  listable as a self-contained container product at all. There is an escape hatch — external
  dependencies are permitted **if disclosed** in the description or usage instructions — but the
  listing then advertises a multi-step manual prerequisite install.
- Helm charts must define **all** image references exclusively in `values.yaml`, with no hardcoding
  and no conditional logic that bypasses them, so AWS can rewrite them per region. "Products that do
  not meet these requirements **will be rejected**."
- "Sellers can only list **fully functioning** products. Beta or prerelease products for trial or
  evaluation purposes are not allowed."

**Google Cloud has a requirement that is disqualifying on strategy grounds, not just capacity:**

> "You must verify to Google Cloud through an approval process during onboarding that you **host your
> software product primarily on Google Cloud**."

knext's stated positioning (`CLAUDE.md` §8) is explicitly *multi-cloud / no lock-in*. Committing to
"primarily on Google Cloud" would contradict the product's own differentiator. This is a genuine
conflict, not a paperwork hurdle.

### A.3 Is billing/metering integration mandatory?

**No — a free or BYOL listing avoids metering everywhere.** This is the one dimension where all four
marketplaces are accommodating.

- **AWS:** metering integration is explicitly "**for paid products only**" (AWS Marketplace Metering
  Service for usage pricing, AWS License Manager for contract pricing). Free and BYOL container
  products can run "on any Docker-compatible runtime."
- **Azure:** licensing options include **Free** and **BYOL**. "BYOL means you'll bill your customers
  directly, and Microsoft won't charge you any fees." (Everything else — per-core, per-node,
  per-pod, per-cluster — is metered.)
- **Google Cloud:** supports agency and Merchant-of-Record transaction models; neither is forced on a
  non-transacting listing, but the organization must still hold a **vendor account and payment
  profile in good standing** regardless.
- **Oracle:** BYOL is a supported pricing model; the supplier/iSupplier registration is required only
  for paid listings.

**But note the asymmetry that matters:** on AWS, **BYOL is classified with paid products**, so choosing
BYOL over free re-triggers the tax/bank/KYC requirements. If knext ever lists on AWS, it must be a
**Free** listing, not BYOL, to stay entity-free.

### A.4 Review process and recurring burden

| Marketplace | Review | Recurring burden |
|---|---|---|
| **AWS** | Products start in **Limited** (allowlisted accounts only). Moving Limited → **Public** "must go through an **AWS Marketplace Seller Operations team approval process**." Every subsequent edit is a **change request** that enters "Under review." AWS's docs state the process but **publish no SLA or typical duration**. | High and continuous. "AWS Marketplace **continuously scans** products to verify that existing listings continue to meet any changes to these requirements. If a product falls out of compliance, AWS Marketplace will contact the seller… products might be **temporarily made unavailable to new subscribers**." Images must stay free of known vulnerabilities and EoL packages — indefinitely. Plus a standing "defined customer support process and support organization." |
| **Azure** | "All offers go through our **certification process**." Must meet the Microsoft Marketplace certification policies. No published duration. | Re-certification on every republish; edits are invisible to customers until the offer is republished. |
| **Google Cloud** | Onboarding approval + "a **business case review** during Google's internal product validation process." Failing it does not necessarily block listing but results in an "adjusted revenue share." | "If you make changes to your product or organization that affect your compliance… you must notify Google and **submit your product for re-review and re-approval**." Product must remain "enterprise-ready, including a professional online presence, **a defined sales motion**, customer support." |
| **Oracle** | "Oracle **reviews and approves** the applications submitted by publishers." OCI tenancy must be subscribed to **US East (Ashburn)**. | OPN membership must be maintained (annual fee). |

Every one of the four attaches a **customer-support organization** commitment. For a solo project that
is the most expensive recurring obligation on this page — more than the incorporation, and it does not
go away.

### A.5 Verdict on marketplaces

A marketplace listing is a **weaker credibility signal than being listed in the Next.js docs**, and a far
more expensive one. The Next.js listing certifies the thing knext's north star actually is — a verified
adapter. A cloud-marketplace listing certifies that a *vendor* exists with a support organization and,
in three of four cases, a legal entity and a payment relationship.

Against `CLAUDE.md` §2 ("fame-first now", "**do not bet financial security on product revenue**") this
lands clearly on the **wrong side of the line**:

- Azure / Google / Oracle: **blocked outright** — no company, no listing. Google additionally requires
  a hosting commitment that contradicts knext's stated no-lock-in positioning.
- AWS: **technically open** via a free container listing with no entity, but it would demand mirroring
  images into AWS-owned ECR, disclosing Knative/cert-manager as external prerequisites, a permanent
  vulnerability-remediation obligation, and a support organization — i.e. it converts a fame-phase OSS
  project into a vendor with SLAs, while pulling the product's centre of gravity toward EKS.

**Recommendation: defer all four.** Revisit only if (a) a legal entity exists for other reasons, and
(b) the open-core pivot in §2 has actually been taken. Do not treat "marketplace listing" as a fame
lever; it is a go-to-market lever that presupposes a company.

---

## Part B — the GitHub Action

### B.1 What `kn-next deploy` actually needs at runtime

Established by reading `packages/kn-next/src/cli/` in this repo.

**Kubernetes access — `kubectl` on PATH, ambient kubeconfig.** The CLI has **no Kubernetes client
library** (no `@kubernetes/client-node` in the dependency set). Every cluster interaction is an
`execFileSync`/`spawnSync` with `shell: false` onto `kubectl` — server-side dry-run preflight
(`schema/preflight.ts:95-97`), the real apply (`deploy.ts:573-581`), URL read-back
(`deploy.ts:594-603`), post-deploy GC (`gc.ts:148,172,241,269`). The string `KUBECONFIG` appears
**nowhere** in `packages/kn-next/src` — kubectl resolves its own context from the environment. Hard
requirement: **kubectl ≥ v1.25** (below that, `--validate=strict` fails at flag parsing;
`deploy.ts:211-241`, `doctor.ts:474-486`).

**Registry auth — ambient docker credentials, never read by knext.** `deploy.ts:428-442` runs
`docker buildx build --platform linux/amd64 … --push`, then resolves the digest from the buildx
metadata file with a `docker inspect` fallback (`deploy.ts:493-509`). The CLI never touches
`~/.docker/config.json`, never invokes `docker login`, and handles no `DOCKER_*` env. Auth is entirely
the daemon's / credential helper's business — which is exactly what `docker/login-action` already
provides in a GitHub Action.

**Object storage — real cloud credentials, but opt-out.** `deploy` shells out to the provider's own
CLI: `gsutil` / `aws` / `mc` / `az` (`utils/asset-upload.ts:196,244,298,347`). These take genuine cloud
credentials (ADC or service account for GCS, IAM role or keys for S3, service principal or managed
identity for Azure, an `mc alias` for MinIO). The GCS path is the heaviest: `asset-upload.ts:209-215`
runs `gsutil iam ch allUsers:objectViewer gs://<bucket>` on every bulk upload, so that credential needs
`storage.buckets.setIamPolicy` — a **bucket-IAM write**, not merely object write.

The gate is the **`--skip-upload` flag**, not a config key — `storage` is a *required* config block
(`cli/validate.ts:101-114`, `config.ts:2-9,267`), so there is no "no storage configured" state:

```ts
// deploy.ts:404-412
if (!options.skipUpload) {
    log.info("Running parallel tasks: asset upload + Docker build");
    uploadPromise = (async () => { await uploadAssets(config); uploadSucceeded = true; ... })();
    tasks.push(uploadPromise);
}
```

Post-deploy asset GC is gated identically (`deploy.ts:617`).

**No cloud-provider API calls, ever.** There is no cloud SDK, no cluster provisioning, no bucket
creation, no IAM/compute API client anywhere in the CLI. It talks only to an **already-existing**
cluster (via kubectl) and an **already-existing** bucket (via the provider CLI). ADR-0001 holds:
build → push → apply a `NextApp` CR, and nothing else.

**Minimum binaries on PATH:** `node` ≥ 22.18, `npm` (`deploy.ts:347` hardcodes `npm run build`),
`docker` with `buildx`, `kubectl` ≥ 1.25 — plus exactly one of `gsutil`/`aws`/`mc`/`az` **unless
`--skip-upload`**. `bun` is optional (bytecode pass, fail-open, `build.ts:114-118`).
Worth flagging: `doctor.ts` checks *cluster* prerequisites and the local kubectl version only — it
**never probes for docker or any storage CLI** (`doctor.ts:9-31`), so a missing storage CLI surfaces as
a mid-deploy failure rather than a preflight one.

### B.2 Does the action need CLOUD credentials?

**No — not structurally.** The required path is **kubeconfig + registry auth**, both ambient, both
already solved by off-the-shelf actions (`azure/k8s-set-context` or a base64 secret, plus
`docker/login-action`).

**But yes on the default path, as the code stands today.** Asset upload runs unless `--skip-upload` is
passed, and it needs a real cloud credential — bucket-IAM-write on GCS. So a knext action has two
honest shapes:

1. **Credential-free** (`--skip-upload`): needs only kubeconfig + registry auth. Cost: no static-asset
   offload to the bucket and no post-deploy asset GC. This works **today, against the existing narrow
   adapter, with no provisioning layer at all.**
2. **Full parity**: exposes an optional storage-auth step keyed off `config.storage.provider`, composing
   with `google-github-actions/auth`, `aws-actions/configure-aws-credentials`, `azure/login`, or an
   `mc alias set`. Still no provisioning layer — the action authenticates to a bucket the user already
   owns; it never creates one.

Either way, **the action never needs a cloud account to exist for knext's benefit.** It borrows the
user's.

### B.3 What exists in the repo today

**No `action.yml` or `action.yaml` anywhere** — there is no local action and no workflow that `uses: ./`.
The nearest prior art is `.github/workflows/preview.yml`, which wraps `node dist/cli/preview.js deploy`
and base64-decodes `secrets.PREVIEW_KUBECONFIG` into `$HOME/.kube/config` (`preview.yml:96-105`). Its own
comment concedes registry credentials are still a TODO, there is no storage-credential step at all, and
the whole job is gated behind `vars.PREVIEW_ENABLED` (`preview.yml:61`) — so **it has never run against a
live cluster.** CI and the operator e2e nightly run against a throwaway `kind` cluster with an
in-namespace MinIO seeded over the S3 API, using no cloud accounts.

### B.4 What publishing to the GitHub Marketplace requires

From GitHub's own docs — and the contrast with the cloud marketplaces is the finding:

- The action must live in a **public repository**.
- Exactly one action metadata file (`action.yml` or `action.yaml`) **at the repository root**.
- The `name` must be globally unique across GitHub Marketplace, must not collide with a GitHub user or
  organization (unless you own it), must not match a Marketplace category, and must avoid names GitHub
  reserves for its own features.
- The repository owner must accept the **GitHub Marketplace Developer Agreement** (the publish checkbox
  is disabled until they do).
- Publish by drafting a release and ticking "Publish this Action to the GitHub Marketplace."

> "Actions are published to GitHub Marketplace **immediately and aren't reviewed by GitHub**" so long as
> those requirements are met.

**No legal entity. No tax form. No bank account. No fee. No certification. No support SLA. No recurring
compliance scan.** The only ongoing obligation is the one knext already has: keep the repo working.

One structural note: the single-`action.yml`-at-root rule means the action wants its **own repository**
(GitHub's docs recommend exactly this — "Creating a single repository for the action allows you to tag,
release, and package the code in a single unit"). That fits the existing three-repo split recorded in
project memory (core+operator / docs / examples) as a fourth, small repo, or as a subdirectory action
that is simply not auto-listed.

### B.5 Verdict on the GitHub Action

**Right side of the positioning line, unambiguously.** It:

- costs nothing legally or financially, and carries no ongoing compliance burden;
- requires **no provisioning layer** — it authenticates to a cluster and a registry the user already has;
- wraps the product **as it exists today**, the narrow Knative adapter, with no scope drift toward PaaS;
- is a real distribution and credibility surface (`kn-next deploy` in someone else's CI is the single
  most credible demonstration that the adapter works);
- and lands squarely in the Track-P "fame work" bucket of `ROADMAP.md`.

It is also the cheapest fix for the honest gap in `preview.yml`: building the action forces registry
auth to actually be wired, which that workflow's own comment admits it is not.

---

## Answer to the question behind the question

They are **not comparable signals, and they do not belong in the same decision.**

- A **cloud-marketplace listing** signals *a vendor exists*: a legal entity (3 of 4 mandatory), a
  support organization (4 of 4), a payment relationship, and a permanent re-compliance obligation. It
  presupposes exactly the product-revenue posture `CLAUDE.md` §2 says not to bet on. Google's
  "primarily on Google Cloud" hosting requirement would additionally require abandoning knext's own
  no-lock-in claim. **Defer all four.**
- A **GitHub Action** signals *the adapter works in real pipelines*. It costs a repository and an
  `action.yml`, needs only kubeconfig + registry auth on the required path, and drags nothing behind it.
  **Build it.**

The nearest thing to a marketplace-grade credibility signal that is actually available at knext's
current stage remains the one already named as the north star: **verified-adapter status in the Next.js
docs.** Nothing on this page is a substitute for it, and nothing on this page should be sequenced ahead
of it.

---

## Sources

**AWS Marketplace**
- [Getting started as an AWS Marketplace seller](https://docs.aws.amazon.com/marketplace/latest/userguide/user-guide-for-sellers.html)
- [Seller eligibility requirements](https://docs.aws.amazon.com/marketplace/latest/userguide/seller-eligibility.html)
- [Container-based products on AWS Marketplace](https://docs.aws.amazon.com/marketplace/latest/userguide/container-based-products.html)
- [Getting started with container products](https://docs.aws.amazon.com/marketplace/latest/userguide/container-product-getting-started.html)
- [Container-based product requirements](https://docs.aws.amazon.com/marketplace/latest/userguide/container-product-policies.html)

**Microsoft / Azure**
- [Create a Microsoft Marketplace account in Partner Center](https://learn.microsoft.com/en-us/partner-center/account-settings/create-account)
- [Understand the verification process in Partner Center](https://learn.microsoft.com/en-us/partner-center/enroll/understand-the-verification-process)
- [Plan a Microsoft Marketplace Container offer](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/marketplace-containers)
- [Create an Azure Container offer](https://learn.microsoft.com/en-us/partner-center/marketplace/azure-container-offer-setup)

**Google Cloud**
- [Requirements for Google Cloud Marketplace](https://cloud.google.com/marketplace/docs/partners/get-started)
- [Requirements for packaging your app (Kubernetes)](https://cloud.google.com/marketplace/docs/partners/kubernetes/create-app-package)
- [Transaction models](https://cloud.google.com/marketplace/docs/partners/transaction-models)

**Oracle Cloud**
- [Overview of Oracle Marketplace](https://docs.oracle.com/en-us/iaas/Content/Marketplace/Concepts/marketoverview.htm)
- [Becoming an OCI Partner and Publisher](https://docs.oracle.com/en-us/iaas/Content/Marketplace/become-oci-partner.htm)
- [Publishing Listings](https://docs.oracle.com/en-us/iaas/Content/Marketplace/Tasks/publish-listings.htm)

**GitHub**
- [Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace)

**This repository** — `packages/kn-next/src/cli/{deploy,build,doctor,preview,validate}.ts`,
`packages/kn-next/src/cli/schema/preflight.ts`, `packages/kn-next/src/utils/asset-upload.ts`,
`packages/kn-next/src/config.ts`, `.github/workflows/preview.yml`.
