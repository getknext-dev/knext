ISSUES_FOUND

# Adversarial code review — PR #791 (WarmHoldBudgetPressure alert)

Branch `feat/warm-hold-budget-alert`, commit 032e2c2, reviewed in worktree
`agent-ad86c7a8cce5c3713` against `origin/main`.

## What I verified as GOOD (attacked, held up)

- **The metric IS scraped.** `job_name: appdb-operator` (60-prometheus.yaml:106-121) keeps
  pod label `appdb-operator` + container port `9092`; the operator serves
  `appdb_warm_hold_active{app=...} 1` per held app on `:9092/metrics`
  (`cmd/appdb-operator/main.go:155-169`, `APPDB_HEALTH_ADDR=":9092"`, 83-appdb-operator.yaml:142).
  The alert is not blind — the worst outcome for an alerting PR is avoided.
- **Absent-series reasoning is correct.** The exporter emits only held apps, so `sum()` over an
  absent series is empty and the rule does not fire. `or vector(0)` would be wrong here, and the
  asymmetry with `ComputePhantomKeepalive`'s subtraction is stated accurately.
- **`for: 15m` vs operator restart is sane.** 83-appdb-operator.yaml:79 is `strategy: Recreate`,
  so no two operators overlap (no double-count); a restart drops the series (resolve/re-arm), it
  cannot false-fire. Worst case is a delayed page, not a spurious one.
- **The regenerated hash is correct.** `deploy/_validate.sh prom-config-hash` recomputed to
  `d3c5b7326a774c12c958719bab5acf237f46d5d035645ddab6c00cf3f51a8386` — exactly the annotation at
  60-prometheus.yaml:642. Contract 27 will pass; auto-reload is not broken.
- **The guard is mutation-proved (8/8 red).** I ran an anchor-asserting mutation harness against an
  in-tree copy: rename alert → RED; `0.5`→`0.9` → RED; `GW_MAX_CONNS` 90→100 → RED; add
  `or vector(0)` → RED; `for: 15m`→`30m` → RED; `severity: warning`→`critical` → RED; rule commented
  out → RED; rule relocated to group `ks-pg-platform` → RED. It parses the ConfigMap's nested
  `rules.yml` block (not a text grep), and `deployedMaxConns()` reads the **deployed env value** in
  81-apps-gateway.yaml, not a comment. Baseline is green, biome-clean, and it is collected by the
  root `pnpm exec vitest run --coverage` job (ci.yml:182).
- **Cited metrics/numbers exist:** `pggw_rejected_connections_total` (metrics.go:198), SQLSTATE
  `53300` (gateway.go:267), the 30-app ceiling (adr-0003:252), the fast-follow slot cap
  (adr-0003:234,275). Labels `{severity, plane: apps}` match sibling rules; the runbook anchor
  `#warm-hold-budget-pressure-knext-787` resolves.

## Issues

1. **`deploy/60-prometheus.yaml:202,207` (and `docs/operations.md:69,1893-1899`,
   `docs/drills/tier-warm-drill.md:124-126`) — the threshold is replica-blind, and the "over half
   the budget" claim is false on the deployed plane.**
   `pggw-apps` runs `replicas: 2` (81-apps-gateway.yaml:25) and the semaphore is **per pod**; warm
   holds dial the ClusterIP Service (`APPDB_GATEWAY_HOST=pggw-apps.scale-zero-pg.svc`,
   83-appdb-operator.yaml:133), so they load-balance across both pods. Fleet budget is 2×90=180 and
   45 holds is ~25% of it (~22/90 per pod) — not "over **half** the apps-gateway connection budget"
   as the summary, the description, the ops table and the drill all assert. *Why it matters:* the
   page's one quantitative claim is wrong by the replica factor, and the annotation is what a
   responder reads at 3am to judge urgency. Fix the arithmetic (`0.5 * 90 * <replicas>`, or key the
   signal off per-pod `pggw_active_connections`), or state the per-pod framing honestly.
2. **`docs/operations.md:1913-1915` — runbook step 3's primary remediation can never clear the
   alert.** "Scale out `pggw-apps` replicas (the semaphore is per pod)" raises real capacity while
   the alert compares to a hard-coded `90` with no replica term, so post-remediation the alert keeps
   firing at an ever-smaller true utilisation — precisely the "pages early forever (and gets
   silenced)" failure mode the test's own docstring names as the reason it exists. The guard is
   one-sided for the same reason: it joins the threshold to `GW_MAX_CONNS` but **not** to
   `replicas:`, so `replicas: 2`→`4` silently doubles the budget with no red test.
3. **`deploy/60-prometheus.yaml:207` + `docs/operations.md:69,1905-1908` — the annotation attributes
   `{{ $value }}` entirely to `spec.tier: warm`, but the gauge also counts active `spec.warmSchedule`
   window holds** (`main.go:164` HELP text, knext #388). The rule's own comment gets this right
   ("DECLARED holds only"); the annotation and runbook do not. *Why it matters:* triage step 1's
   `kubectl ... TIER:.spec.tier` will not find scheduled holders, so a responder paged during a
   large scheduled window concludes the metric is lying. Say "declared warm holds (`tier: warm`
   **and** active `warmSchedule` windows)".
4. **`docs/operations.md:1914-1915` — "raise `GW_MAX_CONNS` … must stay under the compute's
   `max_connections=100`" is the single-DB plane's constraint, transplanted onto the apps plane.**
   ADR-0003:270-278 corrects exactly this: on `pggw-apps` connections fan out to N per-app computes
   each with its own `max_connections` (default 100), so no single compute bounds the process-wide
   semaphore; the real ceiling is the 128Mi gateway's connection-storm OOM guard
   (operations.md:1836-1846, which recommends *more replicas* — see issue 2). *Why it matters:* the
   runbook tells the on-call the capacity knob is bounded at ~90 for a reason that does not apply,
   steering them away from the remedy the ADR actually records. (The generic table row at
   operations.md:21 already carries this conflation — pre-existing, but this PR is new prose
   asserting it for the apps plane specifically.)
5. **Nit — `docs/drills/tier-warm-drill.md:124` drops the "per gateway pod" qualifier** that the
   pre-existing §4 two paragraphs above carries ("90 per gateway pod"). The new text is strictly
   less accurate than the text it sits under.

Nothing here touches the security invariants (no endpoint, no secret, no image tag, no shell
interpolation). Issues 1/2 are the blocking pair: they are arithmetic and remediation-logic defects
in the only two artifacts this PR ships for the responder.

## Test quality

Genuinely strong: it parses the ConfigMap's nested `rules.yml` (not a grep), asserts identity,
group ownership, expression shape, debounce, annotation content and the cross-file `GW_MAX_CONNS`
join against the *deployed* env value, has a non-vacuity check, and survived all eight mutations I
threw at it — its one real gap is that it pins the threshold to `GW_MAX_CONNS` while ignoring
`replicas:`, so the drift it cannot see is the one issues 1-2 describe.

---

# Round 2 — verification of 26905c3 + 1cc37a5 (diff 032e2c2..1cc37a5)

**APPROVE.**

## The five findings, re-attacked

1. **Arithmetic corrected in all five places.** `60-prometheus.yaml:223` summary now says "over half
   of a single gateway pod's connection budget"; the description carries "the process-wide semaphore
   of ONE gateway pod … the fleet budget is replicas x 90 and holds load-balance across pods";
   the rule comment states 45 holds ≈ 22/pod ≈ 25% of a 180 fleet (arithmetic checks out for
   `replicas: 2`); `operations.md:69` table, `operations.md:1893-1896` ("**`GW_MAX_CONNS=90` is ONE
   POD's budget, not the fleet's**") and `tier-warm-drill.md:133-139` all match. A repo-wide grep for
   `half the apps-gateway` / `leaves half the budget` returns **nothing** — the false claim is gone
   everywhere, not just where I named it.
2. **Runbook step 3 is split, and both exits are named.** `operations.md:1930-1943`: scale-out is
   labelled "Real capacity" (defers the `53300` wall) and explicitly does **not** clear the page
   ("the signal counts holds, not utilisation"); the two legitimate exits are fewer declared holds
   (step 2) or a deliberate paired `GW_MAX_CONNS` + threshold change in one PR. The alert description
   itself now carries "Adding replicas raises real capacity but does NOT clear this alert", so the
   responder learns it from the page, not only from the runbook. `81-apps-gateway.yaml:121-125`
   states the same from the knob's side.
3. **Attribution fixed at the `{{ $value }}` clause**, not merely appended later:
   "{{ $value }} declared warm holds (AppDatabase spec.tier: warm, plus any active spec.warmSchedule
   window — both hold a connection)". Triage step 1 gained the `SCHEDULE:.spec.warmSchedule` column
   and says a `TIER` column alone will not explain a page from a scheduled window. Verified against
   the CRD: `warmSchedule` is `type: array` (82-appdb-crd.yaml:121-122) so the raw-window-list note
   is accurate, and the withdraw instruction now says `spec.tier: cold` — which matches
   `enum: [cold, warm]` (82-appdb-crd.yaml:71). Round 1 said `standard`, which is not in the enum;
   that latent error is fixed as a byproduct.
4. **The apps-plane `max_connections=100` bound is gone.** The only surviving mention in the section
   is the corrected one — "connections fan out to N per-app computes each with its own
   `max_connections`, so no single compute bounds this semaphore — the ceiling is the 128Mi gateway's
   own memory/connection-storm guard", which matches ADR-0003:270-278 and operations.md:1836-1846.
   The 128Mi figure is real (`81-apps-gateway.yaml:167 limits: { memory: 128Mi … }`).
5. **Drill qualifier restored** — `tier-warm-drill.md:133` "half of a **single gateway pod's**
   `GW_MAX_CONNS` budget", plus the fleet arithmetic and the rejected-join rationale.

**Framing decision (static expr) accepted, and it is defended in the artifact itself.** The
rejected-alternative block (60-prometheus.yaml:191-200) states the failure mode concretely —
`scalar()` over an absent/relabelled ksm series ⇒ comparison never holds ⇒ silently unable to fire.
`#792` exists and is exactly that blindness class ("live Prometheus ran a 5-week-stale config …
rule edits were dark, undetected"); its mechanism is stale config rather than an absent join series,
so the citation is a generalisation, but a fair one. The cost of the choice is disclosed rather than
hidden ("it pages *early*, by design"), and the exit is named.

**Hash re-verified.** `_validate.sh prom-config-hash` recomputes
`70d0c529c6ac10f51a479e4bf70681cca0986cc560fbfc435ebd5d2ba9496a14` — exactly the annotation at
60-prometheus.yaml:659. Contract 27 passes; auto-reload is not broken by the round-2 edit either.

## The implementer's disclosure, independently re-tested

I did **not** reuse their harness. Mine branches on the vitest **exit code** (stdout/stderr to
`DEVNULL`, so ANSI cannot matter), asserts each anchor occurs exactly once and aborts otherwise, and
restores both files after every case. It was proved able to see both colours before any verdict was
trusted: unmutated baseline `exit=0`, and control mutation H0 (rename the alert) `exit=1`.

| mutation | result |
|---|---|
| H0 rename alert (harness control) | **RED** |
| **A — description drops "of ONE gateway pod", summary keeps it** (decoration hole #1) | **RED** |
| A2 — mirror: summary drops it, description keeps it | **RED** |
| **B — `{{ $value }}` re-attributed to `tier: warm` only, later audit line kept** (hole #2) | **RED** |
| C — `replicas x 90` fleet arithmetic removed from the annotation | **RED** |
| D — "half the apps-gateway" claim reinstated | **RED** |
| E — rejected replica-join rationale deleted from the rule comment | **RED** |
| F — `81-apps-gateway.yaml` pointer removed from *this rule's* comment (still elsewhere in file) | **RED** |
| G — gateway-side comment stops naming `WarmHoldBudgetPressure` | **RED** |

Both previously-decorative assertions are now genuinely load-bearing: the per-pod qualifier is
asserted on the summary and the description **separately** (A and A2 both red, which a concatenated
match could not do), and the `warmSchedule` attribution is anchored by a 200-char proximity window to
`{{ $value }}` (B red with the distant audit line still present). F confirms the comment-scoped
`ruleComment()` helper is real scoping, not cosmetics.

**Residual limits of prose guards — characterised, not blocking.** Two adversarial constructions
stay green: an attribution clause that names `warmSchedule` *in order to negate it* ("tier: warm
only; ignore spec.warmSchedule"), and a description whose qualifier reads "a per pod goroutine
ceiling" instead of "ONE gateway pod". The first is only reachable by someone writing a deliberately
false sentence; the second is arguably still correct prose. Regex over prose cannot close these, and
the guards catch every realistic regression — including the verbatim round-1 defects.

## One cleanup item (not in the diff, does not block)

The worktree carries **untracked** residue at `.mutproof2/` (`mutate.mjs`, `run.sh`, and a *mutated*
copy of `60-prometheus.yaml` + the test). `git ls-files .mutproof2` is empty, so it cannot reach the
PR — but vitest collects it (`vitest.config.ts` excludes only `**/.claude/**`), so a plain
`npx vitest run` in this worktree reds on the mutated copy: I hit exactly that (`1 failed | 19
passed`) before isolating it. Filtered to the tracked path the guard is **green (exit 0)** and the
tracked YAML has no residue (`git status` shows no modified files). Delete `.mutproof2/` per workflow
step 10, and make sure it is never `git add -A`'d — committed, it would red CI.

Guard is biome-clean; no security-invariant contact.

## Test quality (round 2)

Materially stronger than round 1: the two prose assertions that were decorative are now
mutation-proved from both directions, the file-wide `81-apps-gateway.yaml` match was correctly
narrowed to this rule's own comment block, and each new assertion carries the mutation that
justified its shape. Nine of nine mutations red under an exit-code harness that was proved able to
see red first.
