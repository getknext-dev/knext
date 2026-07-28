# ADR-0017: NextApp CRD stays v1alpha1; conversion webhook deferred

- Status: Accepted (amended 2026-07-28: CRD versioning at 1.0 — see the amendment below)
- Date: 2026-06-27
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0008 (finalizer + reconcile predicate),
  ADR-0016 (status-condition deferral pattern), ADR-0020 (release channels; upgrade order),
  issue #145 (honest Ready + printcolumns),
  the production-hardening scorecard ("no v1alpha1 stability story") and operator-robustness GAP 3

## Context

The NextApp CRD is served at **`apps.kn-next.dev/v1alpha1`**
(`packages/kn-next-operator/api/v1alpha1/groupversion_info.go:29` →
`GroupVersion = schema.GroupVersion{Group: "apps.kn-next.dev", Version: "v1alpha1"}`;
`+groupName=apps.kn-next.dev` on the package). It is the **only** served version. **No conversion
webhook exists** — there is no second API version to convert between, and none is wired into the
manager.

Two reviews flagged the same gap from opposite angles:

- the **production-hardening scorecard** records "no v1alpha1 stability story" — nothing tells a
  user what is or is not safe to depend on across releases;
- **operator-robustness GAP 3** asks whether the CRD should graduate (v1beta1/v1 + conversion
  webhook) before adopters arrive.

knext is **fame-first, pre-1.0, and pre-external-adoption** (no npm publish yet; verified-adapter
status is the north star). The honest question is not "is the schema perfect" but "what stability do
we actually owe today, and to whom." Right now: nobody external depends on the API version.

What users *do* rely on today is not an API-version guarantee — it is the operator's **honest status
contract**: `.status.conditions[Ready]` is now gated on the **child Knative Service's own** real
readiness (issue #145; `nextapp_controller.go` "Honest Ready" gate, ~L615), and the CRD exposes
`URL` / `Ready` / `Age` **printcolumns** (#145; `nextapp_types.go:287-289`). That is the surface a
deployer reads to know whether their app is actually up.

## Decision

**Stay at `v1alpha1` for now. Do NOT build a conversion webhook yet.**

- The CRD remains single-version `apps.kn-next.dev/v1alpha1`. No `v1beta1`/`v1`, no
  `+kubebuilder:storageversion`/conversion machinery added.
- **Breaking CRD changes are acceptable at alpha** and will be **called out in release notes**.
  Kubernetes API convention is explicit that `vNalphaM` carries no compatibility guarantee; we honor
  that contract honestly rather than implying stability we do not provide.
- The **interim stability surface** users may rely on is the **status contract**, not the API
  version: honest `Ready` gating (#145) and the `URL`/`Ready`/`Age` printcolumns (#145). Those are
  what observability and CI/CD glue should key off.
- **Revisit trigger:** build the conversion webhook and graduate to `v1beta1`/`v1` **when real
  external adopters depend on API stability** — i.e. **after** verified-adapter status / npm publish,
  not before.

## Options considered

| Option | What | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| (a) Stay v1alpha1, no webhook | Keep single-version CRD; breaking changes allowed + noted in release notes; status contract is the interim stability surface | Honest about the (lack of) guarantee; zero build cost; keeps scope narrow/fame-first; matches the no-adopters reality | No cross-version migration safety net (acceptable: nothing to migrate, no one depends on it) | **Chosen** |
| (b) Graduate to v1beta1 + conversion webhook now | Add a 2nd version + conversion webhook, cert wiring, storage-version handling | Signals maturity; future-proofs migrations | Premature: real build + TLS/webhook ops cost with **no adopters** whose stability it would protect; couples to webhook cert infra before it's needed | Rejected (now) |
| (c) Freeze the schema as-is informally | Stop making breaking changes but add no versioning machinery | Cheap | **Worst** — implies a stability guarantee we do not actually provide or test; pins design mistakes pre-adoption with no upgrade path | Rejected |

**Recommendation: (a).** It is the only option that is honest about today's reality (no external
adopters, alpha API) while leaving a clean, well-understood upgrade path (option b) for the moment
real adopters need it.

## Consequences

- **Scope stays narrow / fame-first.** No webhook cert plumbing, no second API version to maintain,
  no `make manifests` churn — the operator keeps reconciling one version.
- **We are honest about no API-stability guarantee yet.** Release notes own breaking CRD changes;
  users are told the API is alpha and the *status contract* (Ready gating + printcolumns) is the
  surface to build on.
- **A clean graduation path remains.** When adopters depend on API stability, option (b) is the
  understood next step: add `v1beta1`, mark a storage version, ship a conversion webhook, and
  deprecate `v1alpha1` on the standard Kubernetes timeline.
- **Trade-off accepted:** if we ship a breaking schema change before graduation, existing CRs may
  need a hand-edit; acceptable at alpha and documented in the release notes, vs. paying webhook cost
  now for adopters who don't exist.

## Amendment (2026-07-28) — CRD versioning at 1.0

The original decision's revisit trigger was "**after** verified-adapter status / npm publish". **The
npm half of that trigger has fired**: `@getknext/core`, `@getknext/lib` and `@getknext/db` are
published, so a user can now move the CLI without touching the cluster. That changes the question
from "what do we owe nobody" to "what do we owe a user who upgraded one half of knext". This
amendment answers it. It does **not** reverse the decision above — the CRD stays `v1alpha1` and
there is still no conversion webhook.

### 1. The CRD is versioned separately from the npm packages

Two independent version axes, deliberately:

| axis | what it versions | who bumps it | scheme |
| --- | --- | --- | --- |
| `@getknext/*` semver | the published npm surface documented in `docs/PUBLIC_API.md` | changesets, per release | semver |
| **CRD API version** | the `NextApp` schema the operator serves and the CLI emits | the Kubernetes API-convention ladder | `v1alpha1` → `v1beta1` → `v1` |

**Neither implies the other.** `@getknext/core` reaching 1.0 does **not** graduate the CRD, and a
future `v1beta1` does **not** force a major npm bump. The CRD ships with the **operator image**, not
with an npm package; the operator's own release tag is a third thing again (ADR-0020).

**The declared CRD API version — the single source of truth, machine-read by
`packages/kn-next/src/__tests__/crd-api-version.test.ts`:**

<!-- CRD_API_VERSION: apps.kn-next.dev/v1alpha1 -->

    apps.kn-next.dev/v1alpha1

That test reads the anchor above out of this file, asserts it occurs exactly once, and fails if the
CLI emits (or merely *names*, anywhere under `packages/kn-next/src/cli/`) any other
`apps.kn-next.dev/vN…` literal. It scans rather than enumerating call sites, so a *second* emitter
with a different version is a failure and not an omission. Without it this section is prose and
`cr-builder.ts`'s hardcoded string is free to drift away from it.

### 2. What `v1alpha1` means here — the honest version

By Kubernetes convention `vNalphaM` carries **no** compatibility guarantee: fields may be renamed,
removed or re-interpreted between releases, with no conversion webhook and no deprecation window.
That is still the **nominal** contract, and it is what the CRD's version string tells a reader.

**But the published CLI has made the practical guarantee stronger than the label, and pretending
otherwise would be dishonest.** Since #547 every `kubectl apply` the CLI issues carries
`--validate=strict`, so a CLI that emits a field the installed CRD does not know **fails the apply
loudly** instead of being silently pruned (measured on a live cluster; the table is in ADR-0020's
amendment). Combined with independent upgradability, that means a breaking `v1alpha1` schema edit is
no longer free — it breaks every user whose operator is behind their CLI, at deploy time.

So, concretely:

**A user MAY rely on:**

- the CR they wrote against a given knext release continuing to apply against **that release's
  operator and any later one** — the schema only grows within `v1alpha1`;
- **`apiVersion: apps.kn-next.dev/v1alpha1`** being the value to write in a hand-authored or
  GitOps-managed manifest, and the only value the CLI emits (asserted by the test above);
- an **older CLI against a newer CRD always working** — unknown-field validation is one-directional
  (ADR-0020);
- the operator's **status contract** — honest `Ready` gating and the `URL`/`Ready`/`Age`
  printcolumns (#145) — as the surface to key CI/CD and observability off.

**A user MAY NOT rely on:**

- **any conversion machinery.** There is one served version and no webhook. If the group/version
  string ever changes, existing CRs and GitOps manifests must be re-written by hand;
- `v1alpha1` being permanent, or on a deprecation clock — graduation is trigger-driven (§3), not
  scheduled;
- **field semantics** being frozen. Additive-only constrains the *schema*, not every behaviour a
  field drives; a semantic change that alters what an existing field does is announced in release
  notes, not prevented by the version string;
- **CLI-ahead-of-operator working.** That is unsupported, not merely undefined — see §4.

### 2.1 The constraint this creates

Naming the stronger guarantee is only honest if we also name its price, because the price is what
gets quietly dropped later:

> **Within `v1alpha1`, `NextApp` schema changes are additive-only.** New optional fields are fine.
> Removing a field, renaming one, narrowing its type, or making a previously-optional field required
> is **not** an in-place `v1alpha1` edit — it requires a new API version (§3), even though the alpha
> label would nominally permit it.

We are therefore holding ourselves to roughly a **beta** discipline while serving an **alpha**
version string. That is deliberate — the alternative is a version string that promises less than we
intend to deliver *and* users broken by us exercising the promise. It has a real cost: a design
mistake found in the schema now cannot be corrected cheaply; it either waits for graduation or is
worked around additively. That cost is accepted, and it is itself an argument for graduating sooner
rather than later.

### 3. Graduation trigger

Graduate to **`v1beta1`** (second served version, `+kubebuilder:storageversion` on the new one, a
conversion webhook, and a deprecation timeline for `v1alpha1`) when **any** of these becomes true:

- **T-a — a required schema change cannot be expressed additively.** The moment §2.1 blocks a change
  we actually need, the version string is the thing that must move, not the constraint.
- **T-b — an external consumer depends on the CR shape across an upgrade.** Concretely: a GitOps
  repository (Argo CD / Flux) outside this project holding hand-authored `NextApp` manifests. These
  users never run the CLI's strict-validated apply, so they get neither the loud failure nor the
  additive-only benefit by construction — they get pruning (ADR-0020's first residual).
- **T-c — `spec.security`, `spec.database` or `spec.revalidation` acquires a field the operator
  treats as security-load-bearing** and whose silent pruning would be a *security* regression rather
  than a functional one.

Each is falsifiable: T-a by pointing at the blocked change, T-b by naming the repository, T-c by
naming the field. "It feels mature enough" is not a trigger.

### 3.1 ESCALATED, not decided — does 1.0 itself require `v1beta1`?

**This amendment does not decide whether declaring knext 1.0 is itself a graduation trigger.** That
is a CRD-surface change and therefore a design-gate trigger under `.claude/rules/workflow.md`; it is
not an implementer's call, and recording it here is the whole of what was in scope.

The argument is genuinely two-sided and both halves are recorded so the gate does not have to
re-derive them:

- **For graduating before 1.0.** Shipping a product labelled 1.0 whose only API version is `alpha`
  is a mismatch users will read as either careless or dishonest — and §2.1 concedes we are already
  behaving like beta. Worse, the bump gets *more* expensive after 1.0, not less: every GitOps
  manifest in the wild hardcodes the group/version string, and there are more of them at 1.1 than at
  1.0. If the bump is ever going to happen, the cheapest moment is the one before adopters
  accumulate.
- **Against.** A conversion webhook is real, ongoing cost — a second served version to maintain,
  TLS cert plumbing, storage-version migration — bought for adopters who, per T-b, may not exist
  yet. And the version string is not what users actually key off today; the status contract is.
  Graduating to `v1beta1` with an identical schema and one consumer buys a label.

A third option the gate should weigh explicitly rather than treat as a compromise: **ship 1.0 on
`v1alpha1` and say so loudly in `PUBLIC_API.md`** — i.e. state that the npm surface is 1.0-stable
and the CRD is not, which is exactly what §1's two-axis model already says.

### 4. Upgrade order

**Operator/CRD first, then CLI.** This is decided elsewhere and is **not** re-litigated or restated
here: the decision, the measured apiserver behaviour it rests on, the safe direction
(older-CLI-against-newer-CRD is always valid), and the three residuals — GitOps controllers not
asserting strict validation, a `kubectl` shim appending `--validate=ignore` and winning on pflag's
last-occurrence rule, and `doctor` checking only that the CRD *exists* — live in **ADR-0020's
2026-07-28 amendment** (#548). The user-facing runbook is `docs/RELEASING.md` § "Upgrade order".

The connection to this ADR is one sentence: **the additive-only constraint in §2.1 is what makes
that ordering rule survivable rather than merely documented.** Ordering protects the CLI-ahead case;
additive-only is why the operator-ahead case never needs protecting.

## Action items

- [x] Record the deferral: CRD stays `apps.kn-next.dev/v1alpha1`, no conversion webhook (this ADR).
- [x] Interim stability surface documented as the **status contract** — honest `Ready` gating and
      `URL`/`Ready`/`Age` printcolumns (#145) — not the API version.
- [ ] Revisit (post-adoption): add `v1beta1`/`v1` + a conversion webhook and a deprecation timeline
      **when real external adopters depend on API stability** (after verified-adapter / npm publish).
      *Superseded in substance by the amendment's §3 — graduation is now trigger-driven (T-a/T-b/T-c),
      not "post-adoption" in the abstract.*
- [ ] Until then: call out any breaking CRD schema change in release notes.
- [x] **(amendment)** Declare the CRD version axis as independent of npm semver, with the declared
      value carried in a single machine-readable anchor (§1).
- [x] **(amendment)** Assert the emitted `apiVersion` against that anchor —
      `packages/kn-next/src/__tests__/crd-api-version.test.ts`, scanning `src/cli/` rather than
      enumerating emitters.
- [x] **(amendment)** Cross-link this ADR from `docs/PUBLIC_API.md` § "Stability & versioning".
- [ ] **(amendment, ESCALATED)** Design gate to decide §3.1 — whether declaring 1.0 is itself a
      graduation trigger. CRD-surface change; not an implementer's call.
- [ ] **(amendment)** Enforce §2.1 (additive-only within `v1alpha1`) mechanically. Today it is
      documented practice, which this repo's own rules say degrades unobservably; the schema-diff
      preflight (#314) is the natural place for it.
