# Architect design gate — #766: the shape of the scale-zero-pg keep-warm knob

- **Gate:** architect, run **pre-implementation**, on the CR-surface shape only. The boundary
  ruling (this belongs on `AppDatabase`, not `NextApp`) is settled and not relitigated here.
- **Date:** 2026-08-19. **Read:** #766, ADR-0045, ADR-0030 + its 2026-07-18 addendum,
  `packages/scale-zero-pg/gateway/internal/appdb/{types,reconcile,ports,k8s,warmhold}.go`,
  `.../internal/gateway/gateway.go`, `.../internal/wake/{wake,k8s}.go`,
  `packages/scale-zero-pg/docs/appdatabase-api.md`, `deploy/81-apps-gateway.yaml`.

## Verdict

**BLOCK on options A, B and C. The ruling is D — no new `AppDatabase` spec field lands for #766.**

The keep-warm capability #766 asks for **already ships**, twice, and the measured gap it actually
names is a **platform tuning**, not a per-app product surface. Building a third way to say it is the
exact defect ADR-0045 rejected `warmPaths` for, one resource down.

## The four facts that decide it

1. **`spec.warmSchedule` already expresses "keep this DB warm", including 24/7.** Shipped, actuated
   by a held authenticated connection through the gateway (`warmhold.go`), with a `WarmHold`
   condition, an `appdb_warm_hold_active` gauge, degrade-not-fail semantics, and docs
   (`appdatabase-api.md` §3b). An always-warm app is one window; a benchmark exclusion is one window
   over the benchmark. **The spike's `apps/file-manager/deploy-spike/pg-keepwarm.yaml` is a
   hand-rolled duplicate of `warmhold.go`** — #766 reads as a missing-feature issue because the
   spike did not use the shipped feature, not because the feature is missing.
2. **A replica floor (`minWarm`) is not implementable by the owner it would sit on.** The appdb
   operator holds **no `deployments/scale` grant** by design, and `K8sCluster.ApplyCompute`
   deliberately **preserves the live `spec.replicas`** on update (`k8s.go:176+`). The gateway is the
   sole writer of per-app replica counts. A `minWarm` actuator is therefore either a new replica
   writer fighting the gateway every idle window — the two-writer defect ADR-0030 §Context records
   for ksvc `min-scale` and its addendum re-records one layer down — or it is `warmSchedule` with
   extra steps.
3. **The gateway has no per-app configuration channel at all.** `g.idleMs` is a single
   process-global (`gateway.go:73,142`, `GW_IDLE_MS`), consumed by one per-endpoint timer
   (`scheduleSleep`, `gateway.go:722`). The gateway resolves targets purely from
   `GW_TARGET_TEMPLATE`/`GW_K8S_DEPLOYMENT_TEMPLATE` `{system}` substitution; its entire k8s surface
   is pods-list (peers) + `deployments/scale` (`internal/wake/k8s.go`). It reads **no** CR, **no**
   ConfigMap, **no** per-app config. `spec.idleDelay` is therefore not a field addition — it is a
   new operator→data-plane config channel plus new RBAC on a hot-path proxy, for a value the
   platform already exposes.
4. **The real gap ADR-0045 §Consequences names is a window MISMATCH, and both windows already have
   owners.** App side: `scaleDownDelay`, scaffolded `5m` (ADR-0045). DB side: `GW_IDLE_MS`, a
   fleet-wide platform env — **code default `300000` (`gateway.go:142`), shipped-manifest value
   `60000` (`deploy/81-apps-gateway.yaml:82`)**. The 2.3 s tax inside a warm-pod window is caused by
   that 60 s vs 5 m asymmetry, and the lever for it is one line in a manifest the cluster operator
   owns — not thirty per-app CRs.

## Ruling

**D — extend nothing structurally now.** Concretely, #766 closes with:

- **(a) Delete the workaround, use the feature.** Replace `deploy-spike/pg-keepwarm.yaml` with an
  `AppDatabase.spec.warmSchedule` window. This is the entire product answer to "there is no
  first-class keep-warm knob": there is one.
- **(b) Ship the alignment rule as documentation, in both repos.** State it as an invariant, not
  advice: **the DB idle window must be ≥ the app's `scaleDownDelay`, or the warm-pod window buys
  nothing on the first DB-touching request** — the app answers in 52 ms and then blocks ~2.3 s on a
  compute the gateway already reaped. Belongs in `appdatabase-api.md` and in the knext docs page
  ADR-0045 action-item 3 creates.
- **(c) Surface the `GW_IDLE_MS` 60 s vs 300 s divergence to the scale-zero-pg owner as a costed
  decision, and do not decide it inside #766.** Raising the shipped manifest to `300000` makes the
  two windows symmetric by default, and multiplies idle compute across **every** tenant with no
  per-tenant warm budget to bound it (#389 is still deferred). That is a founder/platform-owner
  call, the same class ADR-0045 refused to make silently as a field default.

### If (c) proves insufficient — the shape is pre-ruled so it is not relitigated

A per-app override ships **only** on a measured case that (b)+(c) cannot serve — an app needing a
window *different from* the fleet's. Its shape, fixed now:

| | |
|---|---|
| **Field** | `AppDatabase.spec.idleDelay` |
| **Type** | `string`, Go `metav1.Duration` grammar (`"5m"`, `"90s"`) |
| **Default** | **UNSET** |
| **Unset semantics** | the gateway's `GW_IDLE_MS` applies unchanged — **byte-identical** to before the field existed; no annotation written, no reconcile diff, schedule-less CRs untouched |
| **Range** | `0s`–`1h`; `0s` is rejected (means "never sleep" = say `warmSchedule`), values above the wake-budget horizon rejected with the bound named in the error |
| **Actuator** | the **existing** `scheduleSleep` timer — the per-app value replaces `g.idleMs` at `gateway.go:722`. **No second control loop, no new replica writer.** |
| **Channel** | the appdb operator stamps `apps.scale-zero-pg.dev/idle-ms` as an **annotation on the `compute-<app>` Deployment it already owns and renders** (`ApplyCompute`); the gateway reads it on the object it already addresses. Single writer preserved. **Do NOT** invent a ConfigMap watch, and **do NOT** give the data-plane proxy a CRD read + RBAC grant. |
| **Grammar** | reuse `metav1.Duration`, the grammar knext's `scaleDownDelay` already uses. **Do not** mirror `GW_IDLE_MS`'s millisecond-int env encoding into a user-facing CR field — that would be the second duration grammar the constraint forbids. |
| **Precondition** | it needs its own ADR on the scale-zero-pg side, because the config channel is the decision, not the field. |

### Where the default lives — ADR-0045 precedent, applied

Nowhere new. ADR-0045 chose **scaffolder-visible over field-default** because a field default
silently changes every stored CR on the operator-first upgrade leg, and "approximately always-on"
contradicts the scale-to-zero positioning as a *default*. Both halves bind harder here:
scale-zero-pg's whole product claim is scale-to-zero Postgres, and `AppDatabase` **has no admission
webhook** (ADR-0030 addendum), so a defaulted duration is validated nowhere at write time. The
default therefore stays the fleet value (`GW_IDLE_MS`, one visible manifest line, platform-owner
editable) plus the docs recipe — never a CR field default, and never a scaffolded per-app value.

## Rejected options

| Option | Verdict | One line |
|---|---|---|
| **A. `spec.minWarm: int`** | **REJECTED** | No writer can honour it: the operator holds no `deployments/scale` grant and `ApplyCompute` preserves the live replica count, so it is either the two-writer defect ADR-0030 records or `warmSchedule` renamed — and the measured use (excluding DB wake from a benchmark) is not a product use. |
| **B. `spec.idleDelay: duration`** | **REJECTED FOR NOW** | Correct *shape*, premature: the gateway has no per-app config channel at all, so this is an operator→data-plane contract + hot-path RBAC, to override a fleet value that is already one editable manifest line and is already mis-set. Fix the mis-set value first; ship the field only if a measured case survives that. |
| **C. Both** | **REJECTED** | Two knobs for one effect, permanently (ADR-0017 additive-only), one of which cannot be actuated. |
| **D. Extend `warmSchedule` semantics** | **ACCEPTED, in the weak form** | Nothing to extend: cron windows already cover always-on and benchmark windows. Adding a traffic-triggered duration *to a WarmWindow* is rejected too — clock-triggered and traffic-triggered are different mechanisms and overloading one struct with both hides which is active in the `WarmHold` condition. |

## What the knext side owes

**One godoc paragraph and one docs sentence. Nothing else — no `NextApp` field, no operator change.**

- `packages/kn-next-operator/api/v1alpha1/nextapp_types.go`, on `ScaleDownDelay`, mirroring the
  `warmSchedule` "warm the database too" paragraph already there: the delay keeps the **pod**
  routable; it does **not** keep a scale-to-zero database compute awake. Inside the window a
  DB-touching request can still pay the DB wake (**measured: 290 ms warm vs ~2.3 s cold**). The two
  windows are **independent by design** (ADR-0030 addendum shape: declared per resource, each
  operator evaluating its own, divergence accepted and unreconciled). Point at
  `AppDatabase.spec.warmSchedule` and the ≥-alignment rule.
- The ADR-0045 action-item-3 docs page states the same in user words, and states the DB idle window
  is a **platform** setting the cluster operator owns.
- **Do not** add a `NextApp` field, a cross-resource consistency check, or any knext-side read of
  `AppDatabase`. Either would make knext's operator reason about another operator's domain — the
  ADR-0001 violation the boundary ruling already refused.

## Two as-built defects this gate surfaced — file them, do not fix them inside #766

1. **`spec.tier: warm` is inert after first use.** `desiredReplicas()` returns 1 for `tier: warm`,
   but `ApplyCompute` **preserves the live replica count on update** and the gateway sleeps the
   compute to 0 once its first connection ends and `GW_IDLE_MS` elapses. Nothing restores it. So a
   `warm` tier silently degrades to `cold` permanently, while `status` keeps reporting warm-tier
   readiness semantics. This is the honest-status class, and it is also *why* #766 was filed: the
   knob that looks like the answer does not work.
2. **The docs assert what the mechanism does not keep.** `appdatabase-api.md:42` documents
   `tier: warm` as "one hot replica" and §2 documents warm-tier readiness. Either re-document
   `tier: warm` as *initial replicas only*, or reimplement it on `warmhold` (a permanent hold =
   a 24/7 window) — the second is the honest one and costs almost nothing, since the actuator
   already exists.

Fixing (1) on `warmhold` would also make `minWarm` redundant a second time over, which is further
reason not to add it.

## ADR follow-up

- **scale-zero-pg:** no new ADR for the accepted outcome — it is docs + a manifest value. An ADR is
  required **only** if the owner takes the `spec.idleDelay` path, and it must be about the
  **operator→gateway per-app config channel**, not about the field.
- **knext:** amend **ADR-0030's addendum** (not ADR-0045) with a short "on-demand sibling" note: the
  addendum already owns the two-windows-declared-twice shape; #766's outcome is that the on-demand
  half is a platform window, not a second declaration. ADR-0045 §Consequences' forward reference to
  #766 gets its answer as a one-line edit, not a new ADR.
