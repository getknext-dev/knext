# Design gate — #952: pull-secret story for private registries

**Gate:** Architect (design decision, convened per `.claude/rules/workflow.md` escalation trigger —
this touches the **CRD** and `kn-next.config.ts` schema).
**Date:** 2026-09-05 · **Status:** RECOMMENDATION (read-only; nothing implemented, nothing posted)
**Decision:** **Option (a)** — a first-class `spec.imagePullSecrets` CRD field, written by the
operator to **both** the app ServiceAccount **and** the Knative revision template.

---

## 1. What the code actually says (measured, not assumed)

| Fact | Evidence |
|---|---|
| The operator creates and **owns** the app SA `<app>-sa` | `nextapp_controller.go:392-404` (`CreateOrUpdate`), `:1752` `Owns(&corev1.ServiceAccount{})` |
| That mutate func sets **only** `AutomountServiceAccountToken=false` — it never touches `ImagePullSecrets` | `nextapp_controller.go:402` |
| ⇒ a hand-patched `imagePullSecrets` on `<app>-sa` **survives** reconcile today, by omission rather than by design | same |
| The revision template already gets `ServiceAccountName = <app>-sa` | `nextapp_controller.go:1017` |
| The prewarm DaemonSet **already reads pull secrets off that SA** | `image_prewarm.go:237-247` `appImagePullSecrets` (ADR-0037) |
| **Knative allows `imagePullSecrets` on the revision PodSpec unconditionally — no feature flag** | `knative.dev/serving@v0.48.0/pkg/apis/serving/fieldmask.go:230`, inside `PodSpecMask`'s *Allowed fields* block, above every `cfg.Features.*` branch |
| `doctor` already has a registry pullability probe, applied to the **operator** image only | `doctor.ts:89, 407-480, 1119-1135` (#198) |
| Precedent for the friendly-over-k8s-native shape | `spec.env` is `map[string]string`, not `[]corev1.EnvVar` (`nextapp_types.go:91`) |
| Precedent for a named same-namespace secret ref | `spec.database.secretRef` (`nextapp_types.go:242-268`, ADR-0019) |

**The load-bearing discovery is the fieldmask line.** Both the issue and the S3-V finding frame this
as a ServiceAccount problem, and the issue explicitly records the trap that follows from that
framing: *"patching the SA after the fact does not rescue the current revision (pull secrets are
resolved at pod creation), so the natural recovery is confusing: patch, then redeploy."* That trap
is an artefact of using the SA as the **only** carrier. Setting the field on the revision template
changes the template, so **Knative rolls a new revision automatically** and the fix takes effect
without a redeploy. Any design that writes only the SA re-ships the confusing recovery as a feature.

**The second discovery is that option (c) does not work as well as it appears to.** The recipe
"patch the SA yourself" works today only because the operator's mutate func happens not to set that
field. The operator *owns* the object (`SetControllerReference` + `Owns`), so the day anyone adds a
line to that closure — or switches it to a full-object `Update` — every hand-patched cluster
silently loses its credentials and every app stops pulling. That is not a documented contract; it is
an unguarded coincidence. Recommending (c) as the **endpoint** means shipping a recipe whose
correctness depends on a line of operator code never being written.

---

## 2. Options considered

| | (a) `spec.imagePullSecrets` CRD field | (b) operator-level default secret | (c) document the Knative-native recipe |
|---|---|---|---|
| **Mechanism** | CR names secret(s) in the app's own namespace; operator threads them to SA + revision template | operator config/annotation names one secret attached to every app SA | user creates the secret and patches `<app>-sa` by hand; docs only |
| **ADR-0001 (operator = source of truth)** | ✅ cluster state derives from the CR | ⚠️ cluster state derives from operator *config*, not the CR — the CR no longer describes the app | ❌ the working state lives in a hand-patch the operator does not know about |
| **Multi-tenant semantics** | ✅ per-app, per-namespace, no cross-tenant surface | ❌ one tenant's registry creds land on **every** app SA cluster-wide; a namespace that should not pull from that registry now can | ✅ per-namespace (but manual) |
| **Cures the "patch doesn't rescue the current revision" trap** | ✅ (template change ⇒ new revision) | ❌ SA-only | ❌ — it *is* the trap |
| **Survives the operator owning the SA** | ✅ operator writes it deliberately | ✅ | ❌ unguarded coincidence (§1) |
| **Prewarm (ADR-0037) picks it up** | ✅ free — `appImagePullSecrets` already reads the SA | ✅ | ⚠️ only if the user patches the right SA |
| **CRD/#548 skew cost** | ⚠️ additive optional field; operator/CRD **before** CLI | ✅ none | ✅ none |
| **Cost to build** | ~1 field + 2 assignments + envtest; CLI schema + doctor + docs | small | docs only |
| **Fits "zero-devops-knowledge" positioning** | ✅ one config line | ⚠️ invisible magic, wrong blast radius | ❌ contradicts it outright |

**Rejected — (b).** The blast radius is the disqualifier, not the ergonomics. A single operator-level
secret attached to every app SA gives every tenant's pods pull rights to every other tenant's
registry, and it moves the description of an app out of the app's CR — squarely against ADR-0001.
There is a narrower variant (operator *copies* a designated registry secret into each app namespace,
the true "you never see a secret" Vercel experience); it is worth a future ADR but not this one,
because it requires cluster-wide secret **read** in the operator's RBAC — a real
privilege-escalation surface that deserves its own security review, not a footnote here.

**Rejected as the endpoint, accepted as today's stopgap — (c).** The founder's positioning is
explicit and this repo's rules restate it: knext is a *deployment framework*, and the honest reading
of `CLAUDE.md` §8 is that a documented recipe is not a platform feature ("rate limiting and payload
caps are documented recipes today … not platform features — do not claim otherwise"). A private
registry is not an exotic case: **OCIR, private GHCR, and ECR are the normal deployment targets** —
the S3-V evidence is a *fresh namespace on our own reference cluster* dying in `ImagePullBackOff`,
and the only reason the long-lived `knext-prewarm` namespace works is that someone hand-patched it.
"Every working private-registry deployment in this project is hand-fixed" is a product verdict, not
an ops anecdote. Sequencing-wise (c)'s *diagnosis* half is genuinely the right first move (§5) —
what is wrong is stopping there.

---

## 3. Recommended shape (option a)

### 3.1 CRD field — `packages/kn-next-operator/api/v1alpha1/nextapp_types.go`

Top-level and additive. It does **not** nest under a new `spec.image` object: `Image` is a required
`string` today and re-shaping it would be a breaking change for every CR ever written.

```go
	// ImagePullSecrets names Secrets IN THE APP'S OWN NAMESPACE that hold
	// registry credentials for pulling spec.image (type
	// kubernetes.io/dockerconfigjson). Most real registries — OCIR, private
	// GHCR, ECR — require them; without one the first revision sits in
	// ImagePullBackOff (#952).
	//
	// The operator writes these to BOTH the app ServiceAccount (<app>-sa) and
	// the Knative revision template. The revision template is the load-bearing
	// half: pull secrets are resolved at POD CREATION, so an SA-only write does
	// not rescue the running revision — and because the template changes,
	// Knative rolls a NEW revision and the fix lands without a redeploy.
	// Knative permits imagePullSecrets on the revision PodSpec unconditionally
	// (serving PodSpecMask "Allowed fields" — no feature flag to enable).
	// The SA half is not redundant: the ADR-0037 prewarm DaemonSet reads its
	// pull secrets off that SA (image_prewarm.go appImagePullSecrets).
	//
	// ABSENT means UNMANAGED, not "none": the operator leaves the SA's
	// imagePullSecrets untouched, so a cluster that hand-patched <app>-sa
	// (as knext-prewarm's pw-sa did) keeps working byte-identically. Set the
	// field to take ownership — the operator then overwrites both sites.
	//
	// Same-namespace only, by construction: a LocalObjectReference cannot name
	// another namespace, so this adds no cross-namespace read surface.
	//
	// Order matters for upgrades (#548): a cluster whose CRD predates this
	// field REJECTS such a CR under --validate=strict, which the CLI always
	// passes — a loud stop, not a silent mis-run. Upgrade operator/CRD first.
	// +optional
	// +kubebuilder:validation:MaxItems=8
	// +kubebuilder:validation:items:MinLength=1
	// +kubebuilder:validation:items:MaxLength=253
	// +kubebuilder:validation:items:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	// +kubebuilder:validation:XValidation:rule="self.all(x, self.exists_one(y, y == x))",message="spec.imagePullSecrets entries must be unique"
	ImagePullSecrets []string `json:"imagePullSecrets,omitempty"`
```

`[]string` rather than `[]corev1.LocalObjectReference`: the in-repo precedent is the flattened,
friendlier shape (`spec.env` is `map[string]string`, not `[]corev1.EnvVar`), it maps 1:1 onto the TS
config, and the operator converts at the boundary. The DNS-1123-subdomain pattern is copied verbatim
from `DatabaseSecretRef.Name` (`nextapp_types.go:263`) so secret-name validation stays uniform.

### 3.2 Controller — two writes, one helper

```go
func pullSecretRefs(names []string) []corev1.LocalObjectReference { /* nil-in ⇒ nil-out */ }
```

- `nextapp_controller.go:~402`, inside the existing SA `CreateOrUpdate` closure:
  `if len(nextApp.Spec.ImagePullSecrets) > 0 { sa.ImagePullSecrets = pullSecretRefs(...) }`
  — guarded, so absent ⇒ the hand-patched-SA case is preserved (§3.1).
- `nextapp_controller.go:~1017`, beside `ServiceAccountName`:
  `ksvc.Spec.Template.Spec.ImagePullSecrets = pullSecretRefs(nextApp.Spec.ImagePullSecrets)`
  — unguarded is fine here; the operator already owns the whole template.

Nothing goes in `Reconcile` as a new status branch — no new condition is proposed. If a later round
wants an honest `ImagePullFailed` condition it belongs in `computeStatusVerdict`
(`status_verdict.go`), per `architecture.md` §4. **Out of scope for this decision.**

### 3.3 CLI + config

`packages/kn-next/src/config.ts` → `deploy.imagePullSecrets?: string[]`;
`cr-builder.ts` emits `spec.imagePullSecrets` only when non-empty, so CRs from unchanged configs stay
byte-identical (which is what keeps the #548 preflight quiet for everyone who does not need this).

### 3.4 Tests the implementer owes

- **envtest**: set `spec.imagePullSecrets` ⇒ assert the refs land on `<app>-sa` **and** on
  `ksvc.Spec.Template.Spec.ImagePullSecrets` — AC#4 says "the ServiceAccount the revision actually
  uses", so the test must read `ServiceAccountName` off the ksvc and resolve *that* SA, never
  hardcode `<app>-sa`.
- **back-compat**: a CR **without** the field, against an SA pre-patched with `ocir-secret` ⇒ assert
  the secret is still there after reconcile. This is the `knext-prewarm` regression guard and it is
  the one a reviewer will be tempted to skip.
- **mutation proof**: delete each of the two assignment lines independently and watch the
  corresponding assertion go red. Per `workflow.md`, a guard that stays green when its subject is
  removed is decoration — and the two halves must be proved **separately** (`knext-guard-both-halves`
  is this repo's most common PR defect).

### 3.5 ADR skeleton — `docs/adr/0050-image-pull-secrets.md`

Next free number (`0049` is the highest present).

- **Context** — §1 of this note: the S3-V ImagePullBackOff on a fresh OKE namespace; every working
  private-registry deploy is hand-fixed; the operator owns the SA so the recipe is unguarded.
- **Decision** — `spec.imagePullSecrets: []string`, written to SA **and** revision template; absent
  means unmanaged; same-namespace only.
- **Options considered** — the table in §2, plus the rejected *operator-copies-a-secret* variant and
  the RBAC reason it is deferred.
- **Consequences** — one additive CRD field; **upgrade order operator/CRD → CLI (#548)**; `absent ≠
  none` is a real semantic wart, stated not hidden; changing the field rolls a new revision (a
  desired *and* user-visible side effect that belongs in the docs); the ADR-0037 prewarmer inherits
  the credentials with no code change.
- **Action items** — CRD + controller + envtest; CLI schema + `cr-builder`; doctor probe (§5); docs
  page; note the upgrade order in the release notes.

---

## 4. Upgrade order (#548) — state it in the PR, not just the ADR

Additive and optional, so a **new CRD + old CLI** is a no-op. The failing direction is **old CRD +
new CLI**: the CLI always passes `--validate=strict`, so the apiserver **rejects** the unknown field
outright (`strict decoding error`) rather than pruning it — and `preflightCRSchema`
(`deploy.ts:287`) server-side dry-runs before the cluster is touched, so the stop happens before any
mutation. That is a loud, correct failure. **Upgrade the operator/CRD first, then the CLI.** The one
population that does *not* get the loud stop is GitOps (Argo CD / Flux), which does not assert strict
validation — there the field is silently pruned and the app fails to pull with no explanation, so
the docs page must say "operator first" in its own right rather than relying on the CLI's guard.

---

## 5. Decision-free first step for this sprint

**Extend the existing registry-pullability probe from the operator image to the app image, and warn
in `doctor` / deploy preflight.** This is AC#2 plus most of AC#3, it lands identically under (a),
(b) or (c), and it needs **no CRD change** — so it trips no escalation trigger and can start today.

Concretely, in `packages/kn-next/src/cli/doctor.ts` (the machinery already exists — `parseImageRef`
:407, the probe :454, the operator-image verdict :1119):

1. Run the same anonymous-manifest probe against `spec.image` / the configured app image.
2. If it is **not** anonymously pullable, check the target namespace for a
   `kubernetes.io/dockerconfigjson` Secret **and** for `imagePullSecrets` on `<app>-sa`.
3. Not pullable **and** neither present ⇒ a **warning** naming the exact failure the user would
   otherwise meet (`ImagePullBackOff`, "Anonymous users are only allowed read access") plus the
   `kubectl create secret docker-registry …` remediation.
4. Registry unreachable ⇒ degrade to "not verified", never to a pass — matching the existing
   `:1135` behaviour and `security.md`'s rule that a checker which goes green when it cannot reach
   upstream is worse than none.
5. Docs: the private-registry page (AC#3), written against the recipe — it stays correct after (a)
   lands, gaining a shorter path rather than being replaced.

Deliberately **not** in the first step: the CRD field, the controller writes, and any new status
condition. Those wait on this recommendation being accepted.

---

## 6. Residual risks, stated

- **`absent ≠ none`.** A user who wants "no pull secrets at all" cannot express it, and clearing the
  field leaves the last-written value on the SA. Acceptable because it buys byte-identical
  back-compat for the hand-patched clusters that exist right now; revisit if anyone asks. If a later
  round wants explicit clearing, `[]` (present but empty) is the free slot — the CEL above already
  admits it, so **do not** add a `MinItems=1` marker that would close that door.
- **GitOps prunes silently** (§4). The mitigation is documentation, which this repo's own rules say
  degrades unobservably. Named, not solved.
- **Two write sites for one concept.** They can drift; §3.4's separate mutation proofs are the
  guard, and the field comment says why each exists so a future simplifier does not delete the one
  that looks redundant.
- **The true zero-devops answer is still unbuilt.** (a) makes the credential *referenceable* in one
  config line; it does not make it *disappear*. Closing that gap is the deferred operator-copies-
  a-secret ADR, and it is a security review, not a sprint task.
