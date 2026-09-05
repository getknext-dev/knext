# Sprint 2 plan — architect half (post-stability)

> Per `.claude/rules/workflow.md`, sprint planning produces ONE artifact: a task graph with scope,
> exit criteria, and dependency edges. This is the architect half. Inputs, binding:
> `.claude/sprint-close-architect.md`, `.claude/sprint-close-sysdesign.md`,
> `.claude/sprint-stability-taskgraph.md`, `CLAUDE.md`, `.claude/rules/*`.
>
> Verified at plan time (not re-derived from reports): the stack is **14 PRs** —
> `main ← #883 ← #890 ← #896 ← #897 ← #898 ← #899 ← #900 ← #901 ← #903 ← #905 ← #906 ← #907 ← #908
> ← #909` — all draft, all `MERGEABLE`. On #909 round-2 (run 33868060826) **both `knext adapter
> smoke` legs PASS**: the sharp-shim chunk error that reddened four checks all last sprint is
> gone, and the publishable artifact compiles in CI for the first time in this stack's life.
> `Escalation triggers acknowledged` is green. The rest is pending, not failing.

---

## 0. The shape of this sprint, stated before the tasks

Last sprint's failure was not lane execution — thirteen of fifteen lane items shipped, on disjoint
radii, and the judgement inside them was sound. The failure was **structural**: a 564-file stack
grew by 54 files and merged nothing, so every proof the sprint built became a claim about a path
CI could not reach.

This sprint's plan must therefore encode a constraint no previous plan did:

> **The stack is not allowed to grow while it waits to merge.**

And it must encode the hard fact that **merging is a founder action.** No agent merges. So the plan
cannot say "merge the stack" as a task — it can only make the stack *merge-ready*, hand the founder
a single decision, and then be explicit about what proceeds while waiting versus what genuinely
cannot.

Hence the sprint is split into two phases with a dated re-open trigger between them.

### Phase 1 — pre-merge (stack frozen except blockers)

**Hard cap: at most THREE new PRs land on the stack, and only if they clear a merge blocker.**
Everything else in this plan is implemented in worktrees branched off `#909`'s tip, held as local
branches with green CI on a *draft PR against the stack tip that is not merged into it*, and
**rebased onto `main` after the merge**. This is deliberately more expensive than stacking. It is
the price of not repeating the exact failure the close review named, and it is cheaper than a
second sprint that ends with a 700-file stack.

### Phase 2 — post-merge (on `main`, full parallelism)

Opens the moment the founder merges. Every lane below that is marked `POST` starts here.

### The re-open trigger (dated, mechanical)

**If the stack has not merged by sprint day 7**, that is a `workflow.md` discovered-fact trigger —
the plan's premise ("this sprint is the merge sprint") has failed twice — and both design gates are
re-summoned mid-sprint. It is not a reason to quietly start stacking again. Owner: the lead.

---

## 1. Standing exit criteria — every task, no exceptions

These are conditions on *each* task, not lane items. A task that meets its own criteria but fails
one of these is not done.

| # | criterion | how it is checked |
|---|---|---|
| **SE-1** | **The artifact compiles in CI.** `knext adapter smoke (bun)` and `(node)` reach and pass `Compile the single executable` on the task's own branch head. | check-run status on the task's PR. Adopted from sysdesign close §6.1 — a sprint does not close on a branch whose publishable artifact has never compiled. It compiles today; this criterion keeps it that way. |
| **SE-2** | **Tested after the task, red-first.** A failing test written for the reason you expect it to fail, then made to pass. | the PR shows the red-first commit or cites the run. |
| **SE-3** | **Every new guard ships a committed prover**, via `scripts/mutate-prove.sh`, discovered by the `scripts/mutation-prove-*.mjs` glob — **or** a dated exemption naming an owner and a re-raise condition. | G2 makes this mechanical mid-sprint; until G2 lands it is reviewer-enforced. |
| **SE-4** | **No new `__`-prefixed or otherwise test-only identifier on a published subpath.** | `cache-handler-seam-gate.test.ts` (landed on #909) already scans; do not regress it. |
| **SE-5** | **Docs land with the change**, not after. Any user-visible surface touches `apps/docs/` in the same PR. | `workflow.md` step 5. |

---

## 2. Lane M — merge readiness (Phase 1, blocking everything)

One team. This lane is the whole of Phase 1's stack-mutating budget.

| id | task | exit criteria | edges | blast radius |
|---|---|---|---|---|
| **M1** | **Resolve the merge SHAPE** (architect close BLOCK 3). #890 is red in its own right (8 FAILURE at its own head) and every fix sits *above* it. Produce the founder-actionable form: **one integration PR against `main`**, squashing the chain, whose own checks are green — or, if the founder prefers the chain, move each fix *down* so every base is green in its own right. **Recommend the single integration PR**: fourteen bases each needing independent green is fourteen chances to land a red parent, and this repo has already been burned by exactly that. | a PR against `main` exists with all non-skipped checks SUCCESS at its own head; the ADR/CRD/config/CLI escalation acknowledgement carries forward with its citation trail; a written merge order in the PR body. **Nothing is merged.** | none — Phase 1 entry | git topology only; no source edits |
| **M2** | **Name a continuous green owner** (sysdesign close §6, "someone has to own 'is the stack green'"). Not a task with a deliverable — a **role held for the sprint**, checking the integration PR's head daily and owning `ci.yml` singly. | a named owner recorded here; a daily check recorded; zero days where the tip is red for >24h unattributed | none | `ci.yml` (sole owner) |
| **M3** | **FOUNDER ACTION — merge.** Not an agent task. | the integration PR is merged to `main` | M1 | — |

**M3 is the sprint's single external dependency.** Everything marked `POST` below waits on it.

---

## 3. Lane V — the vinext number and the byte-cap clock

This lane contains the sprint's one genuinely hard sequencing decision, so it is stated in full.

### The sequencing problem

ADR-0044 Amendment 2 (ACCEPTED) anchors the in-process byte-cap exception's expiry to *"the first
sprint close after the vinext-axis compat lane publishes its first run."* `compat-vinext.yml` has
never run — `gh run list --workflow=compat-vinext.yml` 404s, because the workflow is not on the
default branch, which also blocks `workflow_dispatch`.

So there are two orderings, and they are not equivalent:

- **(a) Wait for merge.** The lane fires in Phase 2 → the clock starts → the byte cap is **next**
  sprint's obligation. Risk: if the merge slips again, Amendment 2 has bought a date, not a
  deadline — precisely the failure the architect close flagged in its §4.
- **(b) Fire it early.** Give `compat-vinext.yml` a `pull_request` trigger scoped to the
  integration PR so it fires from the branch. The clock starts **this** sprint → the byte cap is
  **due at this sprint's close**.

**Recommendation: (b), and take the byte cap into this sprint as lane V2.** The exception is a live
security exception on a shipping product. An expiry that keeps sliding one merge to the right is
the control being deferred by procedure rather than by decision, and this repo's own
`security.md` says a documented expectation degrades unobservably. Firing early costs one workflow
trigger and buys a deadline that does not depend on a human action outside the team's control.

### Tasks

| id | task | exit criteria | edges | trips a trigger? |
|---|---|---|---|---|
| **V1** | **Fire `compat-vinext.yml` once, red or green.** Path (b): add a `pull_request` trigger scoped to the integration PR and remove it after the run, or keep it path-filtered — the choice is the implementer's, the *number* is the deliverable. Publish it in `docs/compat-matrix.md`'s vinext single-executable row whatever it is. | a run id exists; the pass-count is committed to the matrix row with the run link; the row's evidence contract (set by #898) is what flips it, and it does not flip on this run | none (path b) / M3 (path a) | **yes** — compat hard rule ("gate every parity claim on the official compatibility suite"): publishing a low number against a ❌ row is *compliance*, but the matrix is the credibility asset and the gate should see it |
| **V2** | **ADR-0044 Option C — the in-process counted-bytes cap**, in `knext-bun-entry.mjs` (Amendment 2 already collapsed "both build targets" to this one place). Decision 4's pre-recorded constraints are binding and are NOT re-litigated: counted bytes, `Upgrade`/101 pass-through, readiness-gates-on-listen, two-stage drain, red-on-fail compat gating. | cap enforced and mutation-proved by a committed prover; the constraint set asserted by test, one assertion per constraint; ADR-0044 gets an amendment recording the exception **closed**, not renewed | V1 (starts the clock; build in parallel, land at close) | **yes** — security invariant (runtime hardening) + ADR. Design gate at implementation start, not at close |
| **V3** | **FOUNDER DECISION — Amendment 3 time-boxed backstop.** Architect close §4 recommends *"or the second sprint close from 2026-09-04, whichever comes first."* Under recommendation (b) this becomes **belt-and-braces rather than load-bearing** — take it anyway; it costs one paragraph and it is the difference between a deadline and a date. **I will not re-date a live security exception on my own signature.** | amendment recorded with founder approval, or an explicit founder decision to rely on V1 alone | — | founder |
| **V4** | **#850 — the 14-night compat window is unreachable by construction** (any merge that moves the packed tarballs restarts it), and this sprint *is* a merge. Re-anchor the window to a **content hash of the packed closure** rather than the merge event, so the clock survives a no-op merge. | the window's definition names a hash; a test asserts a merge that does not change the packed bytes does not restart it | POST (needs the merge to have happened to be honest about it) | **yes** — same class as ADR-0044: an anchor that cannot fire. See lane G |

---

## 4. Lane G — close the "control that reports success while inert" class

Architect close item 3. Seven instances across two sprints, four of them in the project's own
machinery. This is the sprint's second-highest-value lane and it has an internal dependency the
close review did not state: **the prover lane cannot prove `bun:test` specs today (#902)**, and most
of last sprint's nine guards are `bun:test`. Writing provers before fixing #902 produces provers
that cannot run — a green-while-inert prover, which would be funny if it were not this exact class.

| id | task | exit criteria | edges |
|---|---|---|---|
| **G0** | **#902 — the prover lane resolves test runners as vitest.** Teach it `bun:test`. | a `bun:test`-only spec is provable end to end; **the harness is proved able to see red first** (memory: branch on exit code, never output-grep); ANSI/exit-code discipline asserted | — |
| **G1** | **Commit provers for last sprint's nine guards** (#896 #897 #899 #901 #903 #906 #907 #908, plus #909's own). Prose mutation claims in PR bodies do not count. | ≥1 committed `scripts/mutation-prove-*.mjs` per guard, discovered by glob, each proved to redden its subject and restore byte-identically | **G0** |
| **G2** | **Make SE-3 mechanical.** A check that a PR adding a guard-class test either adds a prover or records a dated exemption. **Scan, not enumeration** — make the unparseable construct fail. | the check reds on a fabricated guard-without-prover PR; mutation-proved | **G1** (needs a populated prover set to scan against) |
| **G3** | **Fix the three found inert guards.** `troubleshooting-doc.test.ts:76` (asserts a token in `slos.md` while five runbook pages rot), `coverage-gate.test.ts:211-214` (permits a silent 77→70 and 78→77 drop), and the runbook staleness no guard covers. | each reds when its real subject regresses; provers committed | — (parallel-safe) |
| **G4** | **The coverage branch/statement loss as a dated exception** (#901 close finding). Verified at plan time: `docs/benchmarks/coverage-baseline.md:21-27` documents the loss honestly but it is **prose, not an exception** — no date, no named owner, no re-raise condition. Record it in ADR-0044 Decision-4 style. Pin the current values so the ratchet cannot silently unwind. | a dated exception with owner + re-raise condition ("when the bun runner emits `BRDA`, or the vitest leg is restored for branch data only"); `coverage-gate.test.ts` asserts the *current* numbers | — |
| **G5** | **§4.2 residual stale-shape guards.** Verified at plan time: `node-compile-cache.test.ts` and `bun-portability.test.ts` are at `apps/file-manager/`, both still self-skipping on the dead `.next/standalone` path; `compat-smoke.mjs:53-54` default + its `pnpm --filter` error message (a package manager the repo deleted); `validate.ts:56` ("with only `turbopack` available today", contradicted by `:71`); `apps/docs/DEPLOY.md:29-36` on `warm-compile-cache.sh`. | each either retired with #899's evidence standard or made to assert its real subject; **no self-skipping guard survives the sprint** | — |

`.claude/rules/security.md:34-35`'s stale `warm-compile-cache.sh` line is **maintainer-only**
(`.claude/rules/` is not an agent's to edit) — bundle it into the §4 draft application (lane X).

---

## 5. Lane R — one proved drain gate per shipping runtime, and the artifact under test

Sysdesign close item 2. The repo ships two runtimes (`node-server.ts` is still exported and built,
and is the back-compat runtime for stored `build=turbopack` CRs) and last sprint left one gate green
and one red.

| id | task | exit criteria | edges |
|---|---|---|---|
| **R1** | **Both drain gates green and scripted-mutation-proved.** The legacy SIGTERM gate now runs green (exercised locally on bun 1.4 via `bun pm pack` + `npm install` on #909) — **make CI say so**, and add the hardcap exit-1 case to the alpine binary e2e, which is still covered only by harnesses under plain `bun`. Both mutations (`s.stop()`→`s.stop(true)`, delete the hardcap `setTimeout`) committed as scripts. | both gates green in CI; two committed provers; neither proof is a commit message | G0 |
| **R2** | **Pin the three checked-in app copies** (`apps/docs/`, `apps/file-manager/`, `examples/bun-exec/`) of `runtime-contract.mjs` / `knext-bun-entry.mjs` to the templates byte-identically, the way `create-scaffold-parity.test.ts:47-56` already pins the two template trees. Today the file the SIGTERM e2e compiles is identical **by diligence, not by construction**. | a parity assertion covering all three copies; mutation-proved by perturbing one copy | — |
| **R3** | **#894 — post-compile RuntimeContract smoke.** The compiled entry registers **no health route** at all. Add it, then smoke health/metrics/drain against the compiled binary. | the binary answers a health route; the smoke runs per-PR, red-on-fail, no `skip()` path | **R2** (pin first, or the smoke tests an unpinned copy) |

**Escalation:** R3 adds a route to the shipped runtime contract — that is the public runtime surface.
Design gate at start.

---

## 6. Lane D — the data plane, in the order the dependency edge requires (POST)

Sysdesign close item 3. **The ordering is a hard edge, not a preference**: D6's absence is what
currently masks D8 — nothing is reaped, so an old client's content-hashed chunk URLs still resolve.
Fixing GC first removes the accidental safety and turns a latent skew bug into a live one.

| id | task | exit criteria | edges |
|---|---|---|---|
| **D9** | **Temp-dir leak** — `asset-upload.ts:619` `mkdtempSync` with no `rmSync`/`finally` anywhere; one full copy of `.output/public` per deploy, forever, on every build host. And `tests/temp-dirs-outside-the-repo.test.ts` asserts **location, never lifetime** — a guard asserting one half of its subject, this repo's #639 class, produced last sprint. | the dir is removed on both success and failure paths; the guard asserts lifetime; prover committed | — (cheapest on the board, start first) |
| **D8** | **Skew protection first.** Set `deploymentId` in both templates and inject `NEXT_DEPLOYMENT_ID` into the **CR container env** — `deploy.ts:399` sets it in the CLI's own process only, where it never reaches the pod. Correct or make true `deploy.ts:390-397`'s comment, which claims a `next.config` behaviour neither template implements. | a deployed pod carries the id; the BUILD_ID lock-step stops ENOENT-warning; asserted end-to-end | POST |
| **D6** | **#892 — GC learns the vinext static namespace.** `stageNitroPublicAssets` writes no `BUILD_MARKER_FILENAME`, so `pruneOldBuilds` buckets every vinext prefix as `keptUnmarked` and returns before `classifyBuilds` ever runs. | marker written; vinext ids reach live-traffic protection; the every-deploy warning at `asset-upload.ts:622-626` goes away (a warning on every run is how a warning stops being read) | **D8** — hard edge |
| **D7** | **Reclaim the right prefix.** `reclaimBuildPrefix` deletes `<app>/_next/static/<deployTag>/`, a prefix vinext never writes, and logs success. | reclaim targets the vinext namespace; a test asserts a real object is removed | **D6** |

**Escalation:** D8 touches `cr-builder.ts` (CR shape) and both templates' `next.config` — two
mechanically-detected triggers. Expect the gate.

---

## 7. Lane S — carried debt, sequenced by ambush risk

| id | task | exit criteria | edges |
|---|---|---|---|
| **S1** | **#904 — the undici grype ambush.** `examples/bun-exec`'s closure gate will red on the next grype DB refresh (undici@7.28.0 HIGH, fixed in 7.29.0). This is a **scheduled failure with a known fix** — take it in week 1, not when it reds the publish path unattended. | bumped; the gate green; if the bump is blocked, a dated allowlist entry per `security/npm-audit-allowlist.json` convention | — |
| **S2** | **Native-integrity absence exception gets an expiry and an override.** `sharp-addon-dlopen.mjs:140-149` warns-and-loads on an absent `.integrity.json`. Bounded by construction today (both Dockerfiles fail without it), but it has no expiry and no fail-closed switch — this repo's ADR-0044 shape exactly. | dated expiry + `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` fail-closed override, tested both ways | — |
| **S3** | **#893 — stale-binary stamp** (build↔binary identity). **`--arch`/arm64 is explicitly CUT again** — it is a second-cloud concern, not a stability one, and the stamp is the half that catches a real defect. | the binary carries a stamp tied to the build that produced it; a mismatched stamp reds | POST |
| **S4** | **#895's residual — SET/HIT for a SCAFFOLDED app.** Today check (k) proves ISR against `apps/file-manager`, whose config uses `path.resolve(import.meta.dirname, …)` while both templates use `new URL(…).pathname` — equivalent on POSIX, `/C:/…` on a Windows dev host. The generated form is asserted by grep and never executed. | a scaffolded app is built and exercised for SET then HIT; the divergence is resolved in one direction | POST |
| **S5** | **Metric-rename docs residual.** #909 swept runbooks/metric names; verify what remains — `apps/docs/content/docs/observability.mdx` (**published, user-facing**, still presents `kn_next_*` as *the* contract and advertises two deleted dashboards), `docs/security/threat-model.md:238-253` (**security-relevant**: misdescribes the `:9091` disclosure surface), `docs/observability/metrics.md:16-40` (self-contradictory within one file). | each corrected; a guard that reds when an emitted metric is renamed **end to end**, not just when the extractor is fed a fabricated name | — |

---

## 8. Lane X — maintainer/founder-only (tracked, not assigned)

Recorded so they are not silently dropped and not silently re-filed as agent work.

- **`architecture.md` §4 draft application** — `docs/adr/drafts/rules-amendment-architecture-s4.md`,
  **with the architect close's E5 wording correction applied first**: "pinned by" overstates the
  class, since the retired guard was build-artifact-level and the replacement asserts template
  source. Also bundle the stale `warm-compile-cache.sh` line at `.claude/rules/security.md:34-35`
  and the `architecture.md:50` citation of the deleted seam file.
- **M3 — merge the stack.**
- **V3 — ADR-0044 Amendment 3.**
- **#853 npm token rotation**; **#198/#707 GHCR visibility**.
- **A4's missing `adr-state-claims` pin** (close E5): `tests/adr-state-claims.test.ts` has no entry
  for ADR-0027 / #885 / the seam. Agent-doable — assign it to whoever holds lane G, it is the same
  class. Listed here only because the exit criterion it discharges was written last sprint.

---

## 9. Explicitly OUT, with reasons

| item | why out |
|---|---|
| **#872** | **CLOSE it.** The premise is dead — Amendment 3 disproved the trade it would re-measure. Carrying an issue whose premise is disproved is how a stale fact re-enters a plan. |
| **#891** (delete legacy standalone machinery) | gated on the vinext lane going **green**, not on it *running*. V1 produces a number, and a first number is not expected to be green. Re-evaluate at close. |
| **#794** | edits `nextapp_types.go`, which the stack holds. Post-merge at the earliest, and not this sprint. |
| **zones / gRPC / PWA (#614-620)**, general-PaaS scope | `CLAUDE.md` §5/§6 sequencing: after correctness. Unchanged. |
| **#605 / #609 / #611** | close #605; fold #609/#611 into a future ADR-0048 Amendment 4. |
| **arm64 / `--arch`** | cut from S3 deliberately; second-cloud concern. |
| **Any new public API, config-schema, or CLI surface not named above** | the stack already trips four trigger classes and is waiting on a human merge. Adding surface while that is true is how the merge gets harder. |
| **Image optimization, DynamoDB cache, "port the CLI to Node", MIT-licence, duplicate-CLI** | all RESOLVED per `CLAUDE.md` §9. Do not re-file. |

---

## 10. Dependency graph

```
                       ┌── M1 ──► [M3 FOUNDER MERGE] ──► Phase 2 opens
Phase 1 ───────────────┤                                    │
  (stack frozen,       └── M2 (role, continuous)             │
   ≤3 blocker PRs)                                           │
                                                             ├──► D8 ──► D6 ──► D7   (hard edge)
  V1 ──► (starts ADR-0044 clock) ──► V2 ──► due at CLOSE     ├──► V4 (#850 re-anchor)
                                                             ├──► S3 (#893 stamp)
  G0 (#902) ──► G1 (provers) ──► G2 (the check)              └──► S4 (#895 scaffolded ISR)
  G3, G4, G5 ── parallel, no edges
  R2 ──► R3 (#894)          R1 ── needs G0
  D9, S1, S2, S5 ── parallel, no edges
```

**Blast-radius ownership (disjoint, hard requirement — `workflow.md` "two teams must not hold the
same file"):**

| owner | files |
|---|---|
| M2 (green owner) | `.github/workflows/ci.yml` — **sole owner**, others hand patches |
| V | `compat-vinext.yml`, `docs/compat-matrix.md`, `knext-bun-entry.mjs` (V2 only), ADR-0044 |
| G | `scripts/mutation-prove-*`, `scripts/run-mutation-provers.mjs`, `coverage-*`, `apps/file-manager/{node-compile-cache,bun-portability}.test.ts`, `compat-smoke.mjs` |
| R | `turbo/generators/templates/zone/*`, `examples/bun-exec/`, the three app runtime-contract copies |
| D | `packages/kn-next/src/utils/asset-upload.ts`, `deploy.ts`, `cr-builder.ts`, both `next.config` templates |
| S | `sharp-addon-dlopen.mjs`, `apps/docs/content/`, `docs/{security,observability,runbooks}/` |

`compat-smoke.mjs` is held by **G** (G5) and read by **V** — V consumes G's result, per the
shared-module rule.

**`isolation: "worktree"` is mandatory** for every concurrent implementer. One branch, one worktree.

---

## 11. Tasks that trip escalation triggers (named up front, as `workflow.md` requires)

| task | trigger | class |
|---|---|---|
| **V2** byte cap | security invariant (runtime hardening) **+** ADR-0044 | judgement + mechanical (`docs/adr/`) |
| **V1** publishing a compat number | hard rule: "gate every parity claim on the official compatibility suite" | judgement — not mechanically detectable |
| **V4** #850 re-anchor | same hard rule + the unreachable-anchor class | judgement |
| **D8** deploymentId → CR env | CRD / CR shape (`cr-builder.ts`) **+** config schema (templates) | mechanical |
| **R3** #894 health route | public runtime-contract surface | judgement |
| **S2** native-integrity override | security invariant + CLI/env surface | judgement |
| **G4** coverage exception | "the gate that guards everything is itself unguarded" — hard-rule-adjacent | judgement |
| **M1** merge shape | carries forward four already-acknowledged mechanical triggers | mechanical (pre-acknowledged) |

Three of the five triggers are mechanically detected by the existing `git diff --name-only` check.
The two that are not — a discovered fact, and a hard-rule contradiction touching no tracked path —
are named above deliberately, because `workflow.md` says the plan must state which tasks are
**expected** to touch them rather than waiting for self-report against the team's own interest.

---

## 12. Founder decisions required (with recommendations)

1. **Merge shape (M1).** *Recommend: one squashed integration PR against `main`.* Fourteen bases
   each needing independent green is fourteen chances to land a red parent, and #890 is red today.
2. **Fire the vinext lane early, pre-merge (V1 path b)?** *Recommend: YES* — and accept that this
   makes the **ADR-0044 byte cap due at this sprint's close (V2)**. The alternative leaves a live
   security exception's expiry dependent on a merge that has already slipped once.
3. **Amendment 3 time-boxed backstop (V3).** *Recommend: take it anyway* — under decision 2 it is
   belt-and-braces, it costs a paragraph, and I will not re-date a live security exception on my own
   signature.
4. **#872 — close it.** *Recommend: yes.* Premise disproved.
5. **Human-only, unchanged:** #853 npm token rotation, GHCR visibility, the `architecture.md` §4
   draft application (with E5's wording correction applied first).

---

## 13. Sprint exit criteria (what "this sprint closed" means)

1. The stack is **merged to `main`** (founder action M3), or the day-7 re-open trigger fired and
   both design gates re-planned.
2. `compat-vinext.yml` has **run at least once** and its number is in `docs/compat-matrix.md`.
3. **Every guard added last sprint has a committed prover**, and G2 makes that mechanical.
4. **Both shipping runtimes have a green, scripted-mutation-proved drain gate**, and the three app
   copies of the runtime contract are pinned to the templates by construction.
5. **No self-skipping guard survives** (G5).
6. The byte cap is **shipped (V2)** or its exception is **closed by a founder-recorded amendment** —
   not renewed by default.
7. **SE-1 held every day**: the artifact compiled in CI on every task's branch head.
8. Post-merge only, and honestly reported as blocked until then: the **kind integration gate**
   (`workflow.md` step 3) and **OKE verification** (step 4) ran for at least the data-plane lane.
   Neither has run for any lane item across two sprints; both are structurally downstream of M3, and
   that is the strongest single argument for treating the merge as the sprint's spine.
