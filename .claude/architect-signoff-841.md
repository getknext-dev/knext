# Architect sign-off — PR #841 (feat/netpol-inert-observability, issue #744)

**SIGN-OFF** — no ADR or hard rule violated. ADR-0044 (Amendment 1) explicitly records that the
default NetworkPolicy's enforcement is **CNI-conditional**, and CLAUDE.md §7 requires that
"any claim that knext 'isolates' app pods must carry that caveat". This PR converts that
documented caveat into an observed, per-cluster fact on both surfaces. That is compliance work,
not new scope.

## The five sign-off questions

**1. ADR compliance — clean.**
- **ADR-0001 (operator = single source of truth).** No second writer. Operator side is a
  `List` of DaemonSets; CLI side is `kubectl get daemonsets -o json` inside doctor, which is
  read-only by contract. The design note in `netpol_enforcement.go:38-44` explicitly *rejects*
  the active-probe alternative (canary pods + a blocked dial) **because it would be
  cluster-mutating and ADR-0001 confines mutation to the CR path**. The correct reasoning, made
  explicit in the code — that is the ADR working as intended.
- **No CRD/API change.** `ConditionNetworkPolicyEnforced` is a string into the generic
  `status.conditions` list; `api/v1alpha1/` is untouched. So ADR-0017 (stay `v1alpha1`, no
  conversion webhook) is unaffected and no version-skew hazard is introduced.
- **`architecture.md` §4 status rule — satisfied exactly.** "New honest-status
  conditions/events/requeues go in `computeStatusVerdict` (status_verdict.go), never as new
  branches in Reconcile." The Reconcile delta is observation-only (an I/O call whose result is
  passed in), mirroring the existing `imageCacheState` seam; every branch of the decision lives
  in `status_verdict.go`, and `classifyCNIEnforcement` is a pure function on both sides.
- **ADR-0022 (doctor exit contract) — preserved.** All new outcomes are `pass`/`warn`; only
  FAIL/ERROR exit 1, and the unreachable gate SKIPs. An RBAC-denied DaemonSet list is
  deliberately classified `warn`, not `error` — defensible, because the honest fallback ("treat
  as unenforced") holds with or without the permission, so a denied read changes nothing about
  the advice. Note the consequence: under a future `--strict`, flannel clusters (OKE GA,
  OrbStack) go red. That is the correct behaviour for a CI gate, and worth stating in the
  ADR-0022 implementation PR when it lands.
- **No RBAC expansion.** `+kubebuilder:rbac:groups=apps,resources=daemonsets,verbs=get;list;...`
  already exists at `nextapp_controller.go:275` for the ADR-0037 prewarm DaemonSet. This adds a
  read on a permission already held; it does not widen the operator's blast radius.

**2. Sequencing / scope — correct tier.** This is Tier-A/security-honesty work required by
§7, not deferred Tier-B/C capability. It builds **no** enforcement machinery — knext does not
install a CNI, does not mutate cluster networking, and does not attempt to compensate for
flannel. Exactly the right line: observe and report, do not take ownership.

**3. Boundaries & contracts — hold.**
- `Ready` is computed from the ksvc's own condition (`status_verdict.go:181-291`) and is **not**
  aggregated over the condition list, so `NetworkPolicyEnforced=False` cannot flip an app
  NotReady. That is the right call and answers the lead's question (2) directly: the operator
  must not fail an app for a cluster fact it does not control. Reporting a fact it cannot
  change is precisely what a status condition is *for* — it is level-triggered and re-truthful
  every reconcile, whereas an Event is edge-triggered and expires from etcd. The PR uses both
  correctly: **condition** for the standing fact, **Warning event only on transition into**
  the unenforced state.
- **One real smell, non-blocking:** the CNI signature table is duplicated in Go and TS with a
  "keep the two in sync" comment. By `workflow.md`'s own standard a documented expectation
  decays. It does not block because divergence cannot manufacture a false green — the two
  surfaces would disagree (one `enforced`, one `unknown`), and both messages are already
  bounded by the honest ceiling. Follow-up: a shared fixture both suites read, so drift reds.

**4. Positioning — no PaaS drift.** The line to hold for `doctor` is: it checks **preconditions
for knext-owned artifacts**, not general cluster health. This check diagnoses whether a
NetworkPolicy *knext itself writes by default* has any effect. That is on the right side of the
line. It would be drift if doctor started reporting unrelated cluster posture (etcd health, node
pressure, other CNI features); it does not, and that boundary should be the stated norm for
future doctor checks.

**5. Honesty ceiling — audited, and it is right.** This is a security claim, so I checked
whether any path lets a user conclude they are protected when they are not:
- `enforced` never claims more than "an enforcing agent is **running**", and hedges the residual
  ("per-CNI configuration can still exempt traffic — verify directly if isolation is
  load-bearing"). Cilium `policyEnforcementMode` and Calico exemptions are named in the code as
  the known unreachable residue. Correct ceiling: signature detection cannot see policy
  semantics, and the wording does not pretend otherwise.
- An installed-but-dead agent (0 ready pods) is **Unknown, not enforced** — the round-1 defect,
  and the single most important property in the change. `numberReady > 0` with a documented
  rationale for choosing it over `numberUnavailable == 0`, and absent status defaults to 0
  (never assume health).
- The zero value of `netpolEnforcement` is `Unknown`, so an unpopulated struct can never claim
  enforcement. Fail-open is structurally unreachable.
- Every `unknown` path — no signature, dead agent, RBAC denial, failed list — carries "treat as
  **UNENFORCED** until verified". So no, `unknown` cannot be read as safe anywhere: doctor,
  condition message, and docs all say the same thing in the same direction.
- Docs are honest and name the cases users are actually in ("flannel is what OrbStack and stock
  OKE clusters run — treat network isolation as absent").

## Follow-up ADR (not a blocker)

Add **Amendment 2 to ADR-0044** recording the enforcement-observability decision now that it is
implemented: signature-based detection over an active probe (with the ADR-0001 reason),
the three-valued outcome with `Unknown ≡ unenforced`, the ceiling on what `enforced` may claim,
and the dual-table sync obligation. It belongs on 0044 rather than a new ADR — it closes 0044's
own CNI-conditional caveat rather than deciding something new.
