DONE

# Issue #787 — WarmHoldBudgetPressure alert (branch `feat/warm-hold-budget-alert`, commit 032e2c2)

## Approach

Guard-first: no test in the repo parsed `60-prometheus.yaml`, so I wrote one in the style of
`tests/loadsoak-slo-guard.test.ts` (the existing scale-zero-pg manifest-drift guard) — it parses the
ConfigMap's `rules.yml` block (not raw text: a rule under the wrong key would never load but would
still grep) and asserts identity, expr, debounce, annotations, **and** that the `0.5 * 90` factor
equals the `GW_MAX_CONNS` the apps-gateway actually deploys. Then the rule, then the docs.

## Acceptance criteria

1. **Alert.** `WarmHoldBudgetPressure`, warning, `plane: apps`, in the `ks-pg-gateway` group:
   `sum(appdb_warm_hold_active) > 0.5 * 90`, `for: 15m`. The `GW_MAX_CONNS` coupling is documented
   in **both** files (the rule comment names `81-apps-gateway.yaml`; the knob comment names the
   alert and says CHANGE BOTH) and the pairing is now a **gate**, not a note — the test reds on
   drift in either direction.
2. **Runbook.** New `### Warm-hold budget pressure (knext #787)` section in `docs/operations.md`
   (placed after the scale-ceiling section — it is capacity, not isolation) with a 4-step 3am
   action: list holders → audit which apps need `tier: warm` and withdraw the rest → if legitimate,
   scale out `pggw-apps` / raise `GW_MAX_CONNS` (bounded by compute `max_connections=100`) and file
   **ADR-0003's per-app gateway slot cap** as the recorded fast-follow → cross-check
   `pggw_rejected_connections_total` (rising = already an incident). Plus a row in the alert table,
   linking to that anchor (which the alert's own `description` also cites).
3. **Drill.** `docs/drills/tier-warm-drill.md` §4 now cross-references the alert, its threshold's
   coupling, the runbook anchor, and the `or vector(0)` asymmetry with §3. The "See also" entry was
   updated too.

## Judgement calls

- **Absent series.** No `or vector(0)`. The gauge exists only for held apps, so with none held the
  sum is empty and the rule does not fire — correct, not a bug. Both the rule comment and the drill
  say why, and the test *asserts its absence* so nobody adds it back "as a fix". (The comment also
  contrasts with `ComputePhantomKeepalive`, where the fallback is required because an absent operand
  would void a *subtraction*.)
- **Optional extras: declined, deliberately.** No critical tier — a second threshold would carry the
  same 3am action (audit warm apps) with no new decision attached. No rejected-connections companion
  — `pggw_rejected_connections_total` rising *is* the wall, not a prediction of it, so it belongs in
  the runbook's step 4 (where I put it) rather than as a second page for the same incident. Both
  choices are recorded in the YAML comment so they are not silently re-litigated.

## Mutation proof (all four red, restored, re-verified green)

| mutation | result |
|---|---|
| rename the alert away | 5 of 7 red |
| `0.5 * 90` → `0.5 * 900` (alert-side drift) | red, names both numbers |
| `GW_MAX_CONNS: 90` → `60` (knob-side drift) | red, names both numbers |
| add `or vector(0)` + `for: 5m` | 2 red |

Mutations used an anchor-asserting Python script (aborts unless the anchor occurs exactly once), not
`perl`; commit was made green **before** mutating, so the `git checkout` restores could not lose work.

## Not-in-the-issue thing I had to fix

`deploy/_validate.sh` contract 27 pins a **sha256 of the ConfigMap data** in the pod-template
annotation `ks-pg.dev/prometheus-config-sha256` (the auto-reload trigger, #155). Editing the rules
invalidated it, so I regenerated it via `./_validate.sh prom-config-hash` →
`d3c5b73…f51a8386`. Worth the lead's attention: **that contract only runs inside `_validate.sh`,
which needs a live cluster** (it `fail`s on missing kubectl before reaching contract 27), so a stale
hash is not caught by any offline gate. I did **not** re-implement the hash canonicalisation in the
vitest guard — a second implementation of it in another language is precisely the drift shape I was
asked to close, so this is a reported observation, not a silent fix.

## Test status

- `tests/warm-hold-budget-alert.test.ts` — 7 passing.
- Full `vitest run tests/` — 1709 passing; **2 files fail for worktree-infrastructure reasons,
  pre-existing and unrelated**: `root-typecheck-gate.test.ts` (`Cannot find module
  .../node_modules/typescript/bin/tsc` — this worktree has no local `node_modules`) and
  `bun-exec-example-suite-collection.test.ts` (`vitest list` transform failure from the same cause).
  Neither touches anything in this diff; workflow.md documents this exact worktree failure mode.
- `packages/scale-zero-pg/deploy`: `test_skctl.py` 19 OK, `test_provision-app.sh` 28 cases PASSED.
- Go untouched, so `go test ./...` not run.
- `biome check` clean on the new file.

## Deferred

- **No cluster verification** (instructed not to touch the cluster). The claim "the alert is loaded
  by the deployed Prometheus" — acceptance criterion 1's middle clause — is therefore **unproven**;
  it needs `_verify-alerting.sh` on OKE, whose §1c already checks that gateway rules are loaded.
  TODO(#787) marker not added to source, because the gap is procedural (a drill run), not a code
  hole.
- Not pushed, no PR opened, per instructions.

Files: `packages/scale-zero-pg/deploy/60-prometheus.yaml`,
`packages/scale-zero-pg/deploy/81-apps-gateway.yaml`,
`packages/scale-zero-pg/docs/operations.md`,
`packages/scale-zero-pg/docs/drills/tier-warm-drill.md`,
`tests/warm-hold-budget-alert.test.ts`.

---

# Review round 2 — PR #791 (commits 26905c3, 1cc37a5, pushed)

Both reviews returned ISSUES_FOUND; all 6 fixes landed. Per the lead's framing decision the expr
stays **static** (`sum(appdb_warm_hold_active) > 0.5 * 90`) and the prose was made honest about
what that is.

| # | Fix | Where |
|---|---|---|
| 1 | Arithmetic corrected in all 5 places — never "over half the apps-gateway budget"; now "over half of a **single gateway pod's** budget (`GW_MAX_CONNS=90` per pod; fleet = `replicas × 90`)" | alert summary + description, 60-prometheus comment, operations.md row + section, drill §4 |
| 2 | Runbook step 3 split: replicas raise **real capacity** but do **not** clear the page (the signal counts holds, not utilisation). Clearing = fewer declared holds, or a **deliberate paired** threshold+knob change. "Pages early" is now a documented property with a documented exit | operations.md step 3, echoed in the row, the YAML comment and the knob comment |
| 3 | `spec.tier: standard` → **`cold`** (CRD enum `[cold, warm]`) — the primary 3am remediation was rejected by the apiserver as written | operations.md step 2 |
| 4 | Gauge attributed to **declared** holds (`tier: warm` **and** active `warmSchedule` windows); triage step 1 now surfaces both (added a `SCHEDULE:.spec.warmSchedule` column, with an honest note that it renders the raw array) | annotation + operations.md |
| 5 | Dropped the `max_connections=100` bound — that is the single-DB plane's constraint; per ADR-0003:270-278 the apps plane fans out to per-app computes, so the ceiling is the gateway's own storm guard, and more replicas is the recorded lever | operations.md step 3 |
| 6 | "per gateway pod" qualifier restored | drill §4 |

**Rejected alternative recorded** (so it is not re-proposed): joining
`kube_deployment_spec_replicas` needs `scalar()` over a kube-state-metrics series; if ksm is down,
unscraped, or relabelled, the comparison never holds and the alert becomes **silently unable to
fire** — the blindness class #792 documents, on the rule whose job is to precede an outage. In the
rule comment, the runbook and the drill.

## Guard changes (red first)

Three new assertions, all red before the prose landed: the **description** must carry the per-pod
framing *and* the `replicas × 90` arithmetic, must **not** reassert the false claim, must name
`warmSchedule` in the `{{ $value }}` clause, and **this rule's own comment** must record the
rejected join. The comment assertions are scoped to the contiguous comment block above the rule —
the first version asserted against the whole file and **passed vacuously**, because
`ComputeRoPoolStuck` already uses `kube_deployment_spec_replicas` further down. The pre-existing
pairing assertion was re-scoped the same way (strictly stronger).

## Mutation sweep — 14/14 RED, baseline green, no residue

Mine (4): rename alert · threshold 90→900 · knob 90→60 · re-add `or vector(0)`.
Code reviewer's (4): `0.5`→`0.9` · `for` 15m→30m · severity warning→critical · alert leaves
`ks-pg-gateway`. Spec reviewer's (1): delete the pairing note.
This round's prose guards (5): drop per-pod framing · drop `replicas × 90` · reassert the false
claim · drop the warmSchedule attribution · delete the rejected-join note.

**Three findings from the sweep itself, worth recording:**
1. My first harness reported **all 14 as GREEN** — the pass/fail grep never matched, because vitest
   writes ANSI codes between "Tests" and the count. A mutation harness that cannot detect red is
   worse than none: it certifies decoration. Switched to the process **exit code**.
2. Two of the new assertions were genuinely green under mutation, and both are now fixed (commit
   1cc37a5): the per-pod check matched summary+description concatenated, so the description could
   lose the qualifier while the summary held the guard up; the warmSchedule check matched a later
   audit line, so the `$value` attribution — the actual review finding — could stay wrong.
3. My first attempt at the proximity anchor used `[^.]*`, which can never match because `spec.tier`
   contains a period. It **reddened the baseline**, which is how it was caught instead of shipping
   as an assertion that only passes on the mutation.

One mutation (8) was my error, not a guard hole: it renamed an unrelated group. Replaced with a
real relocation surrogate (rename the group that owns the alert) — RED.

## Suites

`tests/warm-hold-budget-alert.test.ts` 10/10 · full `vitest run tests/` 1712 passing, the **same 2
files / 8 tests** failing as before this PR (`root-typecheck-gate`, `bun-exec-example-suite-collection`
— this worktree has no local `node_modules/typescript`; unrelated to the diff) · `test_skctl.py`
19 OK · `test_provision-app.sh` 28 PASSED · biome clean · `prometheus-config-sha256` regenerated to
`70d0c529…9496a14` and re-verified after the mutation restores. No Go touched.

## Left alone, deliberately

- `operations.md:21` still says `GW_MAX_CONNS` "MUST stay under compute `max_connections=100`" —
  pre-existing, and the code reviewer scoped it out ("pre-existing, but this PR is new prose"). It
  is *true* for the single-DB plane that row primarily describes. Fixing it means rewording a
  shared row for both planes; flagging rather than widening this PR.
- AC1's "loaded by the deployed Prometheus" still needs `_verify-alerting.sh` on OKE (no cluster
  from here). Scan-covered by `_verify-drift.sh:248` per the spec review, so no follow-up edit.
