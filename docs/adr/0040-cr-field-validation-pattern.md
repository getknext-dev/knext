# ADR-0040: How a new user-supplied `NextApp` field gets validated

- **Status:** Accepted (2026-08-04, #455). Codifies a shape already used three times — #431
  (`spec.cache.bytecodeCacheSize`), #433 (scaling knobs), #435 (`spec.resources.*`) — so the fourth
  field follows it by rule instead of by precedent.
- **Amends:** ADR-0036 §"Retires the pre-existing `runtime: bun` + Next-standalone combo" (0036:108)
  — its "reject-with-guidance **via `computeStatusVerdict`**" destination only; the "not panic"
  intent stands. See §"Where the code goes".
- **Depends on:** ADR-0001 (the operator is the single source of truth for cluster state)
- **Governs:** every new free-text / numeric field added to `NextAppSpec` that the reconciler turns
  into a Kubernetes object

## Context

`NextAppSpec` fields are user-supplied text. The reconciler feeds several of them straight into
apimachinery constructors, and the first three times that happened the constructor was
`resource.MustParse`. That is a **cluster-wide** failure mode, not a per-app one: the reconcile loop
is shared, so a panic on one stored CR is a fault in the path every other `NextApp` reconciles
through. #431 found it on `spec.cache.bytecodeCacheSize` (`"512K"` — uppercase K is not a Kubernetes
suffix), #435 found the same shape on all four `spec.resources.*` quantities.

Each fix landed the same three-part shape, and each was re-derived from scratch by whoever picked up
the issue. Two facts make writing it down worth more than it looks:

- **Admission validation is not sufficient on its own.** A CR stored before the check existed — or
  written while the webhook was down, or applied by a GitOps controller that does not assert strict
  validation — reaches the reconciler unvalidated. Validation and safe parsing are two layers, not
  one decision.
- **The CLI mirrors these rules, and mirrors drift.** Three rules are mirrored in
  `packages/kn-next/src/cli/validate.ts` today (#431/#433/#435). The mirror exists for fast
  `kn-next deploy` feedback, and it is *advisory* — but an advisory check that has silently drifted
  is worse than none, because it either rejects what the cluster accepts or waves through what the
  operator will reject after the user has already built and pushed an image.

## Decision

A new user-supplied `NextAppSpec` field that the reconciler parses or converts gets **all three** of
the following. Not two.

1. **Validate at admission.** Add the rule to `internal/validation` so it runs both in the
   validating webhook (write-time rejection) and at the top of `Reconcile` (fail-closed for stored
   CRs). Reject on parseability *and* on the semantic constraint (positive, within range, request ≤
   limit) — a CR the cluster cannot serve should fail loudly at write time, not opaquely later.
2. **Never `MustParse` unvalidated input at the use site.** The reconcile-site conversion returns an
   error naming the field; the reconciler surfaces it as a Warning event + status condition and lets
   the workqueue back off. This is defense-in-depth for CRs that predate the rule, and it is the
   layer that keeps one bad object from being a cluster-wide outage.
3. **Mirror in the CLI only if the mirror is pinned.** A CLI-side copy is optional. If added, it is
   advisory-only (never a second source of truth), and it must be pinned to the operator's verdict
   by a **shared fixture** — `packages/kn-next-operator/test/fixtures/quantity-grammar.json` is the
   pattern: the Go suite re-derives every row from the real parser, and the CLI suite asserts the
   same verdict on the same rows. No fixture, no mirror.
   **The fixture must be a cross-product, not a curated sample.** A hand-picked 59-row version of
   that file passed while the CLI regex was rejecting 22 values apimachinery accepts (the
   trailing-dot mantissa `"1."`, `"1.Gi"`, `"+1.e3"`) — the parity claim was true of the rows it
   checked and false of the grammar. Enumerate the axes (sign × mantissa × suffix) and assert the
   fixture covers their product.

### Where the code goes

- Validation rules: `internal/validation/validate.go`, called from `ValidateNextAppSpec`.
- Status conditions / events / requeues: `computeStatusVerdict` (`status_verdict.go`). The hard rule
  in `.claude/rules/architecture.md` is **absolute and stays absolute** — it governs **new** branches
  in `Reconcile`, and **this ADR carves no exception to it.**

  The spec-validation gate at `nextapp_controller.go:322-346` sets `Degraded`/`Ready=False` inline
  and is **not** a new branch: it landed in `2b1de76` (#85, 2026-06-22); the rule landed in
  `35c259b` (#274, 2026-07-13), a month later. The rule's own wording therefore already excludes it,
  and it stays where it is on the merits — it is a **precondition**, not a verdict. It runs before
  any child state has been observed, so routing it through `computeStatusVerdict` would force that
  function to short-circuit every other input, destroying the pure-composition contract the #254
  extraction exists to protect.

  **The invariant is a count: inline status-condition branches in `Reconcile` are, and stay,
  exactly one.** That is not left as prose —
  `internal/controller/inline_status_branch_guard_test.go` walks the AST of
  `nextapp_controller.go` and fails on any `SetStatusCondition` outside `applyStatusVerdict` and
  that single pre-existing branch. A new rule of the kind this ADR describes belongs *inside*
  `validation.ValidateNextAppSpec`, reusing that one branch; anything reporting on OBSERVED state
  (child ksvc, revisions, database, prewarm) goes in `computeStatusVerdict`.

  **Amends ADR-0036 §"stored `runtime: bun`" (0036:108)**, which prescribes handling a stored
  `runtime: bun` + standalone-artifact CR as "reject-with-guidance **via `computeStatusVerdict`**,
  not panic". The intent there was *don't panic*, and it stands; the specific destination does not.
  That case is a **spec precondition** — it is decidable from the spec alone, before any child is
  observed — so under this ADR it belongs in `validation.ValidateNextAppSpec`, surfacing through the
  one existing branch. ADR-0037's restatement of the rule is **unchanged and unconflicted**:
  `ImageCacheReady` reports OBSERVED DaemonSet state, which is `computeStatusVerdict`'s job.
- Coverage: **scan, do not enumerate.** `TestEveryResourcesFieldIsQuantityChecked` reflects over
  `ResourcesSpec` and fails on any field a malformed value gets past, so adding a fifth field
  without wiring it in is red. A hand-written list of checked fields is how the next field gets
  missed.

## Options considered

| Option | Blast radius of a bad stored CR | Feedback speed | Drift risk | Verdict |
| --- | --- | --- | --- | --- |
| Admission validation only | Cluster-wide panic on any CR that predates the rule | Good | — | Rejected: the stored-CR case is exactly the one that hurts |
| Safe parse at use site only | Contained (one object errors, backs off) | Poor — failure appears after the deploy | — | Rejected: users get an opaque late failure for a typo |
| **Both, plus a fixture-pinned advisory CLI mirror** | **Contained** | **Fast (pre-flight)** | **Pinned by a shared fixture** | **Adopted** |
| Both, plus an unpinned CLI mirror | Contained | Fast | Silent drift; 3 mirrors already | Rejected — this is the failure #455 (2) was filed about |
| Generate the CLI check from the Go rule | Contained | Fast | None | Deferred: a codegen step for three regexes is not worth its own build stage yet. Revisit at the fifth mirror. |

## Consequences

- Every quantity-shaped field costs three edits instead of one. That is the price of the property
  being provable rather than asserted.
- The `NextApp` CRD keeps plain `string` for these fields (no CEL `pattern`), so the apiserver will
  *store* a malformed value. That is deliberate — the error message from `internal/validation` names
  the field and the grammar, which a schema pattern violation does not — and it is why layer 2 is
  mandatory rather than belt-and-braces.
- The blast-radius property itself is now asserted end to end
  (`internal/controller/blast_radius_envtest_test.go`, #455): a stored-malformed CR leaves a sibling
  `NextApp` reaching `Ready=True`, produces no reconcile panic, and settles into rate-limited
  backoff.
- The "exactly one inline branch" count is now a **gate**, not a convention
  (`inline_status_branch_guard_test.go`). Anyone adding a second one gets a failing test naming the
  file, line and function, and pointing at the two legitimate destinations.
- **Honest limit:** controller-runtime defaults `RecoverPanic` to true, so a `MustParse` regression
  today degrades to a recovered panic rather than a crashed manager. That is a safety net, not the
  guarantee — it is per-reconcile, it depends on a default this project does not own, and a panic in
  a goroutine the reconciler spawns is not covered by it at all. Rule 2 stands on its own.

## Action items

- [x] Shared quantity fixture + both halves of the parity contract (#455).
- [x] Reflective coverage scan over `ResourcesSpec` (#455).
- [x] Fix the drift the fixture found on landing: the CLI mantissa now accepts the trailing-dot
      form, and the fixture walks the full cross-product so that class cannot hide again (#455).
- [x] Guard the "exactly one inline branch" count with an AST scan (#455).
- [ ] When ADR-0036's `bun-exec` target is implemented, put the stored-`runtime: bun` rejection in
      `ValidateNextAppSpec` per the amendment above — not in `computeStatusVerdict`.
- [ ] When a **fourth** rule gets mirrored in the CLI, re-open the codegen option in the table above.
