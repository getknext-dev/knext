APPROVE (round 2 — round 1 was ISSUES_FOUND; see the round-1 section below for history)

# Spec review — PR #791 vs issue #787 (`feat/warm-hold-budget-alert`, diff `origin/main...HEAD`)

Read-only review. Independent re-runs of the implementer's mutations were done in a throwaway
`.mutproof/` copy of the two manifests + the committed test (scratch dir removed; tree clean).

## Criterion checklist

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1a | The alert **exists** | **met** | `packages/scale-zero-pg/deploy/60-prometheus.yaml:200-206` — `- alert: WarmHoldBudgetPressure`, `expr: sum(appdb_warm_hold_active) > 0.5 * 90`, `for: 15m`, `labels {severity: warning, plane: apps}`. Guarded by `tests/warm-hold-budget-alert.test.ts` "declares WarmHoldBudgetPressure as a warning in the gateway group" (7/7 pass locally). |
| 1b | Rule is **valid / would actually load** (my own parse, not the guard's) | **met** | Strict re-parse of the ConfigMap: 1 ConfigMap with `rules.yml`, 28 alerting rules, **no duplicate alert names, no duplicate group names, no unknown rule fields, `for` matches Prometheus duration grammar**; the rule lands in group `ks-pg-gateway` (not mis-nested). `expr` is well-formed PromQL (instant vector vs scalar `0.5*90`). Reload path is real: `./_validate.sh prom-config-hash` recomputes **`d3c5b73…a8386`**, exactly the annotation now committed at `60-prometheus.yaml:642` → `kubectl apply` rolls the pod (contract 27, #155). |
| 1c | Threshold **documents its coupling to `GW_MAX_CONNS`** in **both** files | **met** | `60-prometheus.yaml:176-182` ("HAND-COPIED FRACTION OF GW_MAX_CONNS (90, in 81-apps-gateway.yaml) … CHANGE BOTH") and `81-apps-gateway.yaml:118-121` ("PAIRED WITH THE WarmHoldBudgetPressure ALERT … CHANGE BOTH"). Both halves are **non-vacuous**: `origin/main` has 0 occurrences of `81-apps-gateway.yaml` in 60-prometheus.yaml and 0 of `WarmHoldBudgetPressure` in 81-apps-gateway.yaml; HEAD has 1 each. |
| 1d | "**is loaded by the deployed Prometheus**" | **partial — honestly deferred** | PR body: "**Known-unproven half of AC1**: … needs `_verify-alerting.sh` on OKE — deliberately not run from the implementation worktree". The deferral is stated. It is also *scan*-covered, not enumerate-covered, so no follow-up edit is needed to include this alert: `_verify-drift.sh:248` derives `SHIPPED_ALERTS` by grepping `- alert:` and diffs against `/api/v1/rules` (`RULEUNLOADED`, :259-267). Closing #787 therefore depends on the lead's standing OKE stage, nothing else. |
| 2 | Runbook entry says **what to do**: audit warm apps + **ADR-0003 per-app slot cap as the fast-follow** | **partial — one step is not executable** | Section exists: `docs/operations.md:1883-1920` `### Warm-hold budget pressure (knext #787)` + alert-table row at `:69`. Names the fast-follow correctly and truthfully — `adr-0003-multi-tenancy.md:232-234,275` does record "a per-`{system}` gateway slot cap is a fast-follow". Steps 1, 3, 4 are executable: `appdb_warm_hold_active{app=…}` is per-app (`gateway/cmd/appdb-operator/main.go:167`), `pggw_rejected_connections_total` exists (`gateway/internal/metrics/metrics.go:198`), compute `max_connections=100` is real (`54-compute-files.yaml:70-71`). **Defect:** step 2 (`operations.md:1910`) says withdraw warmth via **`spec.tier: standard`** — the CRD enum is `enum: [cold, warm]`, `default: cold` (`deploy/82-appdb-crd.yaml:62-71`), so that patch is **rejected by the apiserver**. `tier: standard` appears nowhere else in the repo; the drill's own release step uses `-p '{"spec":{"tier":"cold"}}'` (`docs/drills/tier-warm-drill.md` §3). The primary 3am remediation, as written, fails. |
| 3 | Drill doc **§4 fleet-pressure** cross-references the alert | **met** | `docs/drills/tier-warm-drill.md:132-140`, inside `## 4. Fleet pressure …` (heading at :122): names the alert, its expr, the two-file pairing, the guard, and links `../operations.md#warm-hold-budget-pressure-knext-787` — anchor matches the `### Warm-hold budget pressure (knext #787)` heading slug. Also added to §"See also" (:149-154). |

## Mutations I re-ran myself (scratch copies, anchor-asserting mutator, abort-on-≠1)

1. **Knob drift `GW_MAX_CONNS` 90→60** → RED: *"the alert is written against GW_MAX_CONNS=90 but the apps-gateway deploys 60"* (1 failed / 6 passed).
2. **Rename `WarmHoldBudgetPressure` → `…Renamed`** → RED, 5 failed / 2 passed (identity, expr, `for`, runbook-pointer, threshold-join all collapse).
3. **Re-add `or vector(0)`** → RED: *"or vector(0) is wrong here — an empty sum means zero warm holds, which must not page"*.
4. **Delete the pairing note from 60-prometheus.yaml** (`(90, in # 81-apps-gateway.yaml)` → `(90)`) → RED: *"the prometheus rule must name the file its threshold is copied from"*. (Confirms the pairing assertion is a live guard, not decoration.)

Baseline on the unmutated scratch copy: 7/7 green, so every red above is the mutation.

## Sizing rationale, scope, "Closes #787"

- **Sizing honors the issue, does not contradict it.** The issue itself specifies `0.5 * GW_MAX_CONNS` and states the 30-app ceiling makes 45 holds "genuinely anomalous today"; the PR records exactly that reasoning at `60-prometheus.yaml:180-182` and `operations.md:1894-1896`, including that it leaves half the budget as headroom. Consequence worth stating (accepted by the issue, not a defect): at the demonstrated 30-app ceiling the alert cannot fire until the plane grows past it — it is a pre-wall tripwire for a fleet that does not exist yet.
- **No scope drift.** 5 files: the 3 the issue names, the `GW_MAX_CONNS` knob comment (the issue explicitly asks for "the pairing in both files"), and the new guard. The `prometheus-config-sha256` bump is mandatory plumbing (contract 27). Both declined optional alerts are declined *in writing* with reasons (`60-prometheus.yaml:194-198`) rather than silently dropped — that matches the issue's "Optionally".
- **"Closes #787" is honest with one caveat and one fix.** Merging delivers AC1 (offline halves) and AC3 outright; AC1's cluster-load half rides the standing OKE stage and is scan-covered; **AC2 is not fully delivered until `spec.tier: standard` is corrected to `cold`.**

## Required before merge

1. `docs/operations.md:1910` — `spec.tier: standard` → **`spec.tier: cold`** (CRD enum is `[cold, warm]`). One word; blocks AC2's "executable steps".

## Non-blocking notes

- The gauge counts **all** declared holds, including `spec.warmSchedule` window holds (`main.go:164`), but the alert `description` attributes `{{ $value }}` entirely to "permanent warm holds (spec.tier: warm)". A scheduled-window fleet could page with wording that misdirects the responder to `tier: warm` only. The YAML comment's "counts DECLARED holds only" is the accurate framing; consider aligning the annotation.
- Nothing couples the `operations.md` row/anchor to the alert, so the runbook link can rot silently (the test only asserts the annotation mentions `operations.md`, not the anchor). Cheap follow-up, not this PR's AC.
- Pre-existing, **not this PR**: `60-prometheus.yaml` has a duplicate `fsGroup: 65534` key in the Deployment `securityContext` (:645 and :650, identical on `origin/main`) — strict YAML parsers error on it. Outside the rules block; flag separately rather than fixing here.

**Verdict: ISSUES_FOUND** — one unmet sub-criterion (AC2, non-executable remediation step: `tier: standard`), plus AC1's cluster-load half legitimately deferred to the lead's OKE verification.

---

# Round 2 — APPROVE

Head reviewed: `1cc37a5` (on `26905c3`, on `032e2c2`). Diff `032e2c2..HEAD` touches the same 5 files
(no new files, no new scope). Committed test at HEAD: **10/10, `VITEST_EXIT=0`**; `biome check` on the
test file exit 0.

## 1. My AC2 blocker — **fixed; every step now checks out against the real API surface**

| Runbook step (`docs/operations.md:1918-1949`) | Executable? | Evidence |
|---|---|---|
| 1. `appdb_warm_hold_active` per-`app` series | yes | `gateway/cmd/appdb-operator/main.go:167` emits `appdb_warm_hold_active{app=…} 1` per held app; scrape job `appdb-operator` exists (`60-prometheus.yaml:106`) |
| 1. `kubectl … -o custom-columns=NAME:.metadata.name,TIER:.spec.tier,SCHEDULE:.spec.warmSchedule` | yes (paths verified; array rendering not live-run) | both paths exist in the CRD — `tier` at `82-appdb-crd.yaml:62-72`, `warmSchedule` (`type: array`) at `:121-126`. custom-columns is a JSONPath printer, so the expression is well-formed; the doc itself warns the column "prints the raw window list" and `<none>` when absent, which is exactly kubectl's behaviour for a non-scalar/missing path. I could not execute it offline (`kubectl create --dry-run=client` rejects `custom-columns`, and the CRD is not installed locally) — cheap add-on for the lead's OKE run |
| 2. **`spec.tier: cold`** ← the round-1 blocker | **yes — fixed** | `operations.md:1926-1929` now says `spec.tier: cold` and states the enum inline (`the enum is [cold, warm]`), matching `82-appdb-crd.yaml:71-72` and the drill's own `-p '{"spec":{"tier":"cold"}}'`. `grep -rn "tier: standard" packages/` → **0 hits** (was 1). |
| 2. "or delete the `warmSchedule` window" | yes | `warmSchedule` is optional — the CR's only `required` is `[appName]` (`82-appdb-crd.yaml:52`) |
| 3. scale out `pggw-apps` replicas | yes | `81-apps-gateway.yaml:25` `replicas: 2`, semaphore is per pod |
| 3. paired `GW_MAX_CONNS` + threshold change | yes, and guarded | the drift test is exactly what forces the pairing (mutation A below) |
| 4. `pggw_rejected_connections_total` | yes | `gateway/internal/metrics/metrics.go:198` |

**Bonus correction I did not ask for and should have.** Round 1's step 3 claimed `GW_MAX_CONNS` "must
stay under the compute's `max_connections=100`" — I marked that met, citing `10-gateway.yaml:99`. That
line belongs to the **base** gateway; on the apps plane it is wrong, because connections fan out to N
per-app computes that each carry their own `max_connections`. Round 2 removes the claim and replaces it
with the correct ADR-0003 reasoning, which the ADR states verbatim: "The apps-gateway `GW_MAX_CONNS=90`
… is a **process-wide** goroutine ceiling on `pggw-apps` shared across *all* apps (a 128Mi-gateway OOM
guard), **not** a per-app cap" (`adr-0003-multi-tenancy.md:272-276`). A round-1 finding of mine was
therefore wrong in the lenient direction, and the implementer caught it.

## 2. Annotation misattribution — **fixed and guarded**

`60-prometheus.yaml:223` now reads "`{{ $value }}` declared warm holds (AppDatabase spec.tier: warm,
plus any active spec.warmSchedule window — both hold a connection)", which matches what the exporter
actually counts (`main.go:164` HELP text names both forms). Triage step 1 and the alert-table row (`:69`)
both say "check `spec.tier` **and** `spec.warmSchedule`". The new guard is anchored to the `{{ $value }}`
clause within 200 chars rather than to the description at large — i.e. it survives the exact loose-match
hole the implementer discloses (mutation D below proves it).

## 3. Per-pod reframing vs the issue's sizing rationale — **no contradiction; it moves toward the issue's own words**

- The **expression is unchanged**: `sum(appdb_warm_hold_active) > 0.5 * 90`, `for: 15m`, warning. Nothing
  the issue asked for was renegotiated.
- The issue's own Context paragraph already says: "`GW_MAX_CONNS` (90) is **one semaphore per
  apps-gateway pod**, shared with all tenant client traffic". Round 1's prose ("half **the
  apps-gateway's** budget") was the version that drifted from the issue; round 2's per-pod framing
  restores the issue's framing and adds the fleet denominator (`replicas × 90` = 180, 45 holds ≈ 22/pod
  ≈ 25% — arithmetic checks out against `81-apps-gateway.yaml:25` `replicas: 2`, and `pggw-apps` is a
  normal ClusterIP Service with no `clusterIP: None` (`:173-187`), so holds do spread across pods).
- The issue's sizing sentence **survives verbatim in substance**: "0.5 is sized against the demonstrated
  plane ceiling of 30 apps (ADR-0003 scale-ceiling drill): 45 permanent holds is genuinely anomalous
  today" (`60-prometheus.yaml:186-188`, `operations.md:1906-1908`).
- The new cost disclosure ("pages early on a larger fleet, by design") plus the rejected
  `kube_deployment_spec_replicas` join is honest engineering, not scope drift: it is comment + prose +
  guard, zero behaviour change, and the runbook names the only two exits (fewer holds, or a deliberate
  paired knob+threshold change) instead of leaving "silence it" as the implicit third.

## Mutations re-run on the new head — **exit-code only, never output-grepped**

Harness: throwaway `.mutproof2/` copy (test + both manifests), mutator aborts unless the anchor occurs
exactly once, verdict read from `$?` after `npx vitest run` with output redirected to a file.

| | Mutation | `$?` |
|---|---|---|
| sanity | rename the subject away (`- alert: ZZZ`) — proves the harness can see red | **1** |
| baseline | unmutated copies | **0** |
| **A** | **knob drift `GW_MAX_CONNS` 90 → 60** (requested) | **1** |
| **B** | **re-add `or vector(0)`** (requested) | **1** |
| C | drop "of ONE gateway pod" from the **description only**, leaving the summary intact | **1** |
| D | strip `warmSchedule` from the `{{ $value }}` attribution clause, keeping the later "check spec.warmSchedule" line | **1** |
| E | delete the rejected replica-join rationale from the rule comment | **1** |
| F | remove `81-apps-gateway.yaml` from the **rule comment** while adding a mention elsewhere in the same 700-line file (the round-1 decoration hole) | **1** |

C, D and F are the three holes the round-2 test commit claims to close; each reds for the right reason
(assertion messages in the logs name the per-pod qualifier, the `$value` attribution and the copied-from
file respectively). F is the important one: the file still contains one `81-apps-gateway.yaml` occurrence
and the guard still fails, so the scoping fix is real.

Also re-verified at the new head: `./_validate.sh prom-config-hash` = **`70d0c529…496a14`** = the
committed annotation (`60-prometheus.yaml:659`), so the ConfigMap edit still rolls the pod; strict
re-parse of `rules.yml` still yields 28 alerts, no duplicate names/groups, no unknown fields, rule still
in group `ks-pg-gateway`.

## Non-blocking notes (unchanged from round 1 or new)

- **#792 is cited a little loosely.** #792 is "live Prometheus ran a 5-week-stale config — rule edits
  were dark, undetected"; the comment invokes it as "the blindness class". The *class* (a signal that
  looks present and cannot fire) transfers; the *mechanism* (stale ConfigMap vs `scalar()` over an
  absent ksm series) does not. Fine as written, but do not let it harden into "#792 says don't join ksm".
- **#792 also raises the bar on the deferred half of AC1.** A matching config hash is necessary, not
  sufficient — #792 is the proof that a live pod ran a stale config for five weeks. So the OKE step is
  not a formality: `_verify-drift.sh` §E (`SHIPPED_ALERTS` is a `grep '- alert:'` **scan**, `:248-267`)
  should show `WarmHoldBudgetPressure` LOADED before #787 is closed.
- No guard couples the `operations.md` anchor/row to the alert; the drill's
  `#warm-hold-budget-pressure-knext-787` link matches today's heading.
- Pre-existing, not this PR: duplicate `fsGroup: 65534` key in `60-prometheus.yaml`'s Deployment
  `securityContext` (identical on `origin/main`).
- Process note for whoever runs mutations next: a mutated scratch copy left in the tree gets collected by
  `vitest run <path>` (the CLI arg is a substring filter, so `tests/x.test.ts` also matched
  `.mutproof2/tests/x.test.ts`) and produced a red "20 tests" run for a green tree. Scratch removed; tree
  clean (`git status` shows only the untracked `.claude/impl-787-report.md`).

**Round-2 verdict: APPROVE.** AC1 (offline halves) and AC3 met; AC2 now fully met with executable steps;
the sole remaining gap is AC1's "loaded by the deployed Prometheus", which the PR body still discloses
and which the lead's OKE run closes via an existing scanning gate. "Closes #787" is honest once that run
is green.
