# Sprint-3 plan — ARCHITECT's half of the task graph

Convened per `.claude/rules/workflow.md` "Sprint planning (once, both gates, Opus) — produces one
artifact: a task graph". This is the architect's half; the system designer's half is the companion
file. Inputs: `.claude/sprint2-close-architect.md` (CLOSE-WITH-CONDITIONS, C1–C5),
`.claude/sprint2-close-sysdesign.md` (CLOSE-WITH-CONDITIONS, C1–C6),
`.claude/sprint2-close-brief.md`, `.claude/rules/workflow.md`, `.claude/rules/architecture.md`,
`CLAUDE.md`.

Everything load-bearing below was re-verified against `gh`/`git` on 2026-09-05, not taken from the
close reports. Where reality has moved since the close, reality is recorded (§0).

---

## 0. State re-verified at planning time — two facts have moved

| close-report claim | verified 2026-09-05 | consequence |
|---|---|---|
| 9 PRs green, unmerged | `main` still at `28e4842c`; #914/#915/#917/#919/#920/#927/#935/#938 all open, all `mergeStateStatus: CLEAN` | **M3 still has not happened.** The whole Phase-1 half of this graph is gated on a founder action nobody on the team controls. Phase 0 is built so the sprint does not idle on it. |
| #915 is a DRAFT and will stall the queue at position two | `isDraft: false` | architect-close's closing note and sysdesign C1's draft clause are **resolved**. Merge order unchanged. |
| "Escalation triggers acknowledged" is **not** a required status check (architect-close §4.3) | `gh api …/branches/main/protection` returns **12** required contexts, and `Escalation triggers acknowledged` **is** one of them | **Half of architect-close candidate #4 is already done** — by the maintainer, after the close was written. What remains is not "make it required" but "prove it reds", which is a different and much smaller task (A11). Do not re-file the original. |
| compat-vinext has published nothing | one run, `33883692192`, `failure`, 2026-09-04 | unchanged; still the sprint's root credential problem. |
| #906 (ISR under vinext) | **CLOSED** — the fix landed. What is open is its *prover*, carried as one of #928's four dated exemptions | C3's wording ("#906's prover") is right; the issue number to work is **#928**, item `cache-handler-isr-staleness`. |

Two of the five sprint-2 conditions are therefore already partly discharged before the sprint
opens. That is worth recording because the alternative — carrying them forward verbatim — is how a
task graph accumulates work that no longer exists.

---

## 1. What kind of sprint this is

**A verification-and-debt sprint, not a feature sprint.** This is not a preference; it falls out of
the close:

- Three exit criteria from sprint 2 are **source-level claims only**. Nothing the sprint built has
  been observed running.
- 73% of sprint 2's added lines were scanner/prover code whose measured defect rate exceeded that
  of the code it guards.
- The only path to users (npm publish) is **doubly blocked** (#926 install failure, #853 dead
  token), so "we can ship a fix" is currently false.
- The north-star credential (official compat suite) currently certifies a target **users cannot
  select** (ADR-0048 removed node-standalone from selection; the vinext axis has published zero
  runs).

Opening new capability work on top of that would be building a fifth storey on an unsurveyed
foundation. **No new user-facing feature enters this sprint.** The exit condition the sprint is
actually chasing is: *the things sprint 2 claims are true become observed to be true, and the two
structural defects that make guards expensive get retired.*

### The C1 discipline constraint (maintainer-owned, planned around)

Architect-close C1 — amending `architecture.md` §4's "never make anything but the node/
official-adapter target the default" against ADR-0048 — is **maintainer-owned**. `.claude/rules/`
is not an agent's file. This plan does **not** schedule it and no task depends on it.

But architect-close C1 also says: *"Sprint 3 must not add a fourth PR's worth of vinext-only
investment against an unamended rule."* That is binding on this graph, and here is how it is
honoured — the rule for every implementer brief this sprint:

> **Vinext-target work in sprint 3 is limited to (i) proving or observing behaviour that already
> shipped, and (ii) deleting duplication or debt on that target. No task may add a NEW vinext-only
> capability.** A task that finds itself adding one has hit the hard-rule-contradiction escalation
> trigger and stops.

Check A1, A5, A9 against that test: A1 observes what shipped, A5 proves a guard over what shipped,
A9 deletes duplication. None adds capability. The constraint holds without needing C1 to land
first — which is the point, since we cannot make it land.

---

## 2. The task graph — IN

Phase 0 runs **today**, on branches, with zero dependency on the founder merge queue. This is
deliberate and it is the single most important structural choice in the plan: sprint 2's one
recorded deviation was Phase 2 opening without its M3 gate, absorbed rather than escalated. Sprint 3
does not repeat that by pretending — it *designs* the first phase to not need M3.

### Phase 0 — runnable now (no merge dependency)

---

#### **A1 — Cluster verification of the sprint-2 aggregate (kind → OKE), on `agent/s2-tail`**

Discharges: architect-close **C2**, sysdesign **C2**, sysdesign candidate #1. The sprint's highest-
value task and the sprint's **entry gate**.

The close settled the framing and it must not be re-litigated: the "merge-gated" description was
**confirmed as a scheduling choice and refuted as a technical necessity**. `origin/agent/s2-tail`
carries all nine PRs' content and is buildable today; workflow.md puts kind (step 3) and OKE (step
4) *before* review, sign-off and merge. Tooling exists: `scripts/e2e-deploy-vinext.sh`,
`scripts/e2e-preflight.mjs`, `scripts/e2e-cleanup.sh`.

**Exit criteria (testable).** Execute the system designer's (a)–(h) script verbatim
(`sprint2-close-sysdesign.md` §1) and write results to
`.claude/sprint3-cluster-verification.md`. Specifically:

1. The subject is an app produced by `kn-next create`, **not** `apps/docs` or `file-manager` — a
   repo app proves nothing about the templates.
2. (c) revision `Ready=True`, `/api/health` → 200, **and the negative**: `restartCount == 0` after
   ≥5 min.
3. (d) `/_next/image` → 200, `content-type: image/webp|avif`, transferred < source, with evidence
   the transform *ran* (sharp in the log) — not a pass-through 200.
4. (e) ISR: `MISS` → `HIT` → past-`revalidate` `STALE` → `HIT` with **new content**, and the key
   asserted present in **Redis** (`cache-handler.js` is the ISR store; GCS is not).
5. (f) skew guard aborts on mismatched `NEXT_DEPLOYMENT_ID` with the cluster untouched; plus the
   positive GC case.
6. (g) byte cap on the wire: honest 9 MiB → 413, **chunked no-Content-Length** 9 MiB → 413, 1 MiB
   → 200, `:9091` scrape 200 while 65 KiB POST to `:9091` → 413, boot log shows the cap line.
7. (h) `/api/health` still 200 with the database scaled to **zero**.
8. On OKE, the **deployed operator image digest is confirmed and recorded before** any behaviour is
   attributed to code. CLAUDE.md warns about source-vs-deployed twice; this sprint's plan lost a
   hypothesis to it once already.
9. A green terminal is not evidence — the file is the artifact.

**Dependency edges.** None inbound. Outbound: A7 (post-merge re-run) reuses this script; A4's
interpretation of a red compat lane depends on knowing whether the app runs at all.
**Escalation triggers expected.** None by path. **The expected trigger is the discovered-fact one**:
a red on (c), (d) or (e) invalidates two of the sprint-2 exit criteria and this plan's premise —
that stops the sprint and returns both gates. Name it up front so it is not rationalised as "a flaky
cluster".
**Owner shape.** **Lead-owned.** Cluster work is a queue of one (workflow.md: "two benchmark runs
against the same cluster silently invalidate each other"). No parallel implementer may touch the
cluster while A1 runs.

---

#### **A2 — The lockfile guard, split out of #926 and landed independently**

Discharges: architect-close candidate #2 (the decision-free half). Architect-close §5.2 is explicit:
*"Split that out and land it now… it should not be held hostage to a founder decision."*

The general rule to enforce: **a workflow that invokes a package manager whose lockfile the repo
does not carry → red.** This is the guard that stops the *next* toolchain move from doing what
`fe28ad9c` did.

**Exit criteria.**
1. The guard **scans** `.github/workflows/` — it does not enumerate the three known jobs. (Repo
   rule: "prefer scanning to enumerating; an enumerated list of call sites is how the second one
   gets missed.") A new workflow added tomorrow with the same defect must red without anyone
   editing the guard.
2. It asserts **both halves**: a workflow whose lockfile *is* present must pass, and one whose
   lockfile is absent must fail. (`knext-guard-both-halves` — the repo's most common PR defect.)
3. A committed **mutation prover** that branches on **exit code, never on output grep**, and that
   is first proved able to see red.
4. It reds on `main` today (three jobs in `release.yml`), so it lands **with** either #926's fix or
   a dated, justified exemption naming #926 — never by weakening the guard.
5. It does **not** touch which action holds `NODE_AUTH_TOKEN`. That half is out (§3).

**Dependency edges.** None inbound. Outbound: none — deliberately decoupled from #926's founder
decision.
**Escalation triggers expected.** **None.** It adds no CLI/config/CRD/public surface and moves no
credential. If an implementer finds themselves editing `tests/release-action-pins.test.ts`'s
allowlist, they have crossed into the security trigger and must stop.
**Owner shape.** Implementer + 2 reviewers (code + spec).

---

#### **A3 — The compat-window ledger measurement (and nothing else)**

Discharges: architect-close candidate #3, first step only. **This task produces numbers, not an
ADR.**

Measure, over the compat run ledger: the restart **rate** of the 14-night window and the **cause
distribution** of those restarts (which fingerprint input moved, per restart).

**Exit criteria.**
1. `.claude/sprint3-compat-ledger-measurement.md` exists and contains the actual counts, the
   observation period, and the per-cause breakdown — not estimates.
2. It states, from the data, whether 14 consecutive green nights is **reachable** at the measured
   rate. That single sentence is what sub-decision 3 in A6 turns on.
3. **No ADR text is written in this task.** #850's own AC says the numbers are the starting point;
   workflow.md names writing-before-measuring as a failure mode, and *sprint 2 was already bitten
   by it on this exact issue*.

**Dependency edges.** None inbound. **Outbound: hard edge into A6.** A6 may not start sub-decision
3 until A3's file exists.
**Escalation triggers expected.** Discovered-fact, plausibly: if the measurement shows the window
unreachable, that is an ADR-0007/ADR-0044-anchor problem larger than #850 and it returns to the
gates rather than being absorbed into a restart-rule tweak.
**Owner shape.** Implementer (measurement only) + 1 reviewer. Cheap.

---

#### **A5 — The `cache-handler-isr-staleness` mutation prover (#928's top item)**

Discharges: sysdesign **C3**, sysdesign candidate #2. Written **first** among the guard work, per
#928's own priority order and because it is the unproven half of exit criterion 2 — ISR on the
shipped path.

The subject guard is on the stack (`agent/s2-tail`), so this is branch-runnable now; it does **not**
wait for M3. That is a correction to the close's implicit sequencing.

**Exit criteria.**
1. A committed prover that mutates the ISR-staleness behaviour and observes the guard go **red**;
   pass/fail branched on **exit code**, never on grepping vitest output (ANSI once certified 14
   decorative mutations all-green).
2. The mutation harness is first proved **able to see red** before any mutation is credited.
3. The prover's subject path is asserted to **exist** — the `anchors=0 && bindings=0` shape that let
   a prover point at a deleted file and stay green is exactly what #912 was.
4. `cache-handler-isr-staleness` is **removed** from `GUARD_PROVER_EXEMPTIONS` in
   `scripts/lib/prover-lane.mjs` in the same PR. An exemption that survives its prover is worse than
   either alone.
5. Orphaned node processes from the prover run are reaped (`ppid=1` check) — the known hazard.

**Dependency edges.** None inbound. Outbound: A1's (e) result and this prover are the two independent
legs of exit criterion 2's ISR clause; **neither substitutes for the other** and the sprint close
must score them separately.
**Escalation triggers expected.** None.
**Owner shape.** Implementer + 2 reviewers.

---

#### **A11 — Prove the escalation gate actually reds** *(small; the residual of architect candidate #4)*

The maintainer made `Escalation triggers acknowledged` a required context (§0). Required is not the
same as *effective*: the check must fail on a PR that touches a trigger path without the
`design-gate:cleared` label.

**Exit criteria.** A mutation-style demonstration recorded in `.claude/sprint3-escalation-gate-proof.md`:
a scratch branch touching one trigger path (e.g. `docs/adr/`) with no label produces a **failing**
check run; adding the label re-runs it green. Both halves. If it does not red, that is a live gap in
the per-sprint model's only automated half and it escalates immediately.
**Dependency edges.** None. **Escalation triggers expected.** The proof branch fires one by design;
that is the test, and it is closed without merging.
**Owner shape.** Lead-owned, ~1 hour.

---

### Phase 1 — opens on M3 (the founder merge queue)

Merge order is fixed and stacked: **#914 → #915 → #917 → {#919, #920, #927} → #935 → #938**, CI
re-run at each new head, verifying each subsequent diff shrinks as expected (sysdesign C1). #917 and
#927 have a *security* reason to go early: #917 unblocks the credentialed nightly lane, and the
mutation prover over the publish lane is inert until #927 lands.

---

#### **A4 — Get the vinext-axis compat lane to publish a number** *(C3 from architect-close)*

Discharges: architect-close **C3** and candidate #1. Architect-close is unambiguous that this is
"the sole gate on ADR-0048 item 6, the compat-matrix ❌ row, ADR-0044 Amendment 2's anchor, and the
verified-adapter north star — everything else is downstream of this one."

**Exit criteria.** *One of these two, recorded — never neither:*
1. **Success path.** After #917 is on `main`, re-run `compat-vinext.yml`; the per-shard ledger job
   publishes a number; that number is recorded in `docs/compat-matrix.md` in its honest scope, and
   the 14-night window's **first night** is dated in the ledger.
2. **Failure path.** The lane still fails; the failing step and cause are recorded, **and ADR-0044
   gains a note stating that Amendment 2's anchor is still unfired.** Amendment 4's honesty on this
   point ("nothing here should be read as the anchor having fired") is preserved explicitly, not
   quietly overtaken by the passage of time.

**Dependency edges.** **Inbound, hard: #917 merged to `main`.** Outbound: feeds A6 sub-decision 2
(per-axis scope) — the amendment cannot state what the vinext axis certifies until the axis has
either run or been recorded as still dark.
**Escalation triggers expected.** ADR path (`docs/adr/0044-*`) on the failure branch — mechanical,
acknowledge up front.
**Owner shape.** Lead-owned (workflow dispatch + ledger).

**Honest sizing note:** A4 *starts* the 14-night clock at best. **It cannot finish it.** The compat
window spans sprints by construction and sprint 3 must not be scored against closing it.

---

#### **A6 — ADR-0007 Amendment N: what the 14-night window measures, restarts on, and which axis it certifies**

Discharges: architect-close candidate #3. The skeleton is already drafted in
`sprint2-close-architect.md` §5.1 and should be used as the starting text.

Three sub-decisions, deliberately separable:
1. *(landable now)* the fingerprint **stays content-anchored** — recorded as a rule rather than left
   as emergent script behaviour;
2. *(landable now)* the window's claim is **scoped per axis** — a node-axis window may not back a
   v1.0 or compat-matrix claim about the shipped compiled path;
3. *(blocked)* the restart rule — narrow / reshape / keep-and-accept.

**Exit criteria.**
1. Sub-decisions 1 and 2 land with a trade-off table and a recommendation, per architecture.md §3.
2. **Sub-decision 3's line is not written until `.claude/sprint3-compat-ledger-measurement.md`
   exists** (A3). A reviewer must check the file's existence and its numbers against the ADR text.
3. Whatever sub-decision 3 chooses becomes a **guard**, and the guard is **mutation-proved** —
   #850's AC: "a window rule that can be edited to produce green is the failure this repo has spent
   several rounds avoiding."
4. `docs/compat-matrix.md`'s v1.0 row states the rule in the **enforced** form, and the per-axis
   scope statement lands in the official-suite row.
5. #850 closes, or its residual is restated in one line.

**Dependency edges.** **Inbound hard: A3** (numbers before text). **Inbound soft: A4** (sub-decision
2's wording depends on whether the vinext axis has published).
**Escalation triggers expected.** **ADR trigger, mechanically** (`docs/adr/`) — the design gate
returns for this PR by construction. Acknowledge in the PR body up front; do not let the label be a
surprise at merge time.
**Owner shape.** Architect drafts the ADR; implementer + 2 reviewers land the guard, prover and
matrix rows.

---

#### **A8 — Replace the scratch-space scanner with a runtime snapshot control; burn down #939**

Discharges: sysdesign **C5** (which says *replaced, not extended*) and sysdesign candidate #3. This
is the sprint's highest-yield debt task by the close's own numbers: a 487-line three-rule source
scanner + 67-line ratchet that cost **4 guard-defects across 5 review rounds**, where every one of
the four same-class fixes was a defect in the guard rather than in its subject.

The replacement: a **runtime** global test-setup hook that snapshots repo-root + `tmpdir()` before
and after the suite and fails on delta. ~20 lines, no static blind spot — it catches computed
destinations, `node -e` writes and dynamic imports that a regex over blanked source structurally
cannot see.

**Exit criteria.**
1. The runtime control exists, is wired into the suite's global setup, and **fails on a planted
   leak** — proved, both halves.
2. It demonstrably catches at least one leak class the static scanner **could not** see (a computed
   path). That single demonstration is the whole argument for the swap; without it this is a
   sideways move.
3. The static scanner is **deleted**, or reduced to a named residual with the reason written down —
   not kept "for belt and braces". Two overlapping controls is how the expensive one survives.
4. #939's ratchet moves materially (161 sites / 48 files is the recorded baseline); the remaining
   count is re-recorded honestly rather than the ratchet being re-dated.
5. Net line count goes **down**.

**Dependency edges.** **Inbound hard: #938 merged** (the scanner it replaces lives there). Cannot
start in Phase 0.
**Escalation triggers expected.** None. Explicitly satisfies C5's "no new *scanning* guard without a
simpler alternative rejected on the record" — this is the simpler alternative being *adopted*.
**Owner shape.** Implementer + 2 reviewers.

---

#### **A9 — Generate the runtime-entry copies from the template; delete the parity scan**

Discharges: sysdesign candidate #5 — "the one structural fix in the list." Ten copies of
`knext-bun-entry.mjs` are currently pinned by a scan (`scripts/lib/runtime-entry-copies.mjs`).
Generating them from the template at build time makes drift **impossible** rather than **detected**,
and deletes a guard instead of maintaining one.

**Exit criteria.**
1. The copies are generated at build time from the single template; the committed duplicates are
   removed from the tree.
2. The parity scanner and its prover are **deleted** in the same PR. If they survive, the
   duplication survived too.
3. The byte-cap serve-site scan — which sysdesign explicitly scores "keep as-is: small, security,
   high value" — is **not** removed by this task. It asserts a different property.
4. A build from a clean checkout produces byte-identical entries to the ones deleted (proved, not
   asserted), so this is provably a refactor and not a behaviour change.
5. Passes the §1 vinext-discipline test: it deletes duplication, it adds no capability.

**Dependency edges.** **Inbound hard: #914 and #915 merged** — both own the template files and the
copy list; overlapping them is the disjoint-blast-radius violation the rules forbid.
**Escalation triggers expected.** **CLI/build surface**, plausibly (`src/cli/build.ts`,
`vinext-build.ts`) — name it in the PR body up front; #919 and #920 both fired this trigger in
sprint 2 and both cleared it cleanly.
**Owner shape.** Implementer + 2 reviewers.

---

#### **A10 — One dated-exception registry with staggered expiries**

Discharges: sysdesign **C6**. Six dated exceptions are currently clocked to roughly the same window
(#928's four at 2026-11-01, #939's ratchet, the write licence, the coverage drop, native-integrity,
seam-relocation #936). If they lapse as a bloc, CI reds on six fronts at once and the cheap response
is to re-date all six — which is precisely how a dated exception becomes permanent.

**Exit criteria.**
1. One registry, one test, each entry carrying subject / owner / issue / expiry / justification.
2. Expiries are **staggered** — no two within the same week — and the stagger is enforced by the
   test, not by convention.
3. An entry past expiry **reds** (proved) and an entry with no issue number **reds** (proved).
4. Every one of the six existing exceptions is migrated; none is dropped or silently re-dated during
   migration. A count assertion, not a reviewer's eyeball.

**Dependency edges.** **Inbound: all six exceptions on `main`** (i.e. the full merge queue). Last
task in the graph.
**Escalation triggers expected.** None.
**Owner shape.** Implementer + 1 reviewer. Small.

---

#### **A7 — Post-merge re-verification on `main`**

After the queue lands, re-run A1's kind subset — (c), (e), (g) — against `main` and append to the
same results file. Merge order changed the tree eight times; A1 verified a tail branch, not the
merge result.

**Exit criteria.** The three checks green on `main`, appended to
`.claude/sprint3-cluster-verification.md` with the `main` SHA recorded. A divergence from A1's
result is a **discovered fact** and returns to the gates.
**Dependency edges.** Inbound hard: M3 complete, and A1 complete.
**Owner shape.** Lead-owned.

---

## 3. Explicitly OUT — and why

| item | why it is out |
|---|---|
| **C1 — amend `architecture.md` §4** | **Maintainer-owned.** `.claude/rules/` is not an agent's file (architecture.md). Planned *around* via the §1 discipline constraint; no task depends on it. Surface it to the founder every week it stays open — it is now two sprints overdue. |
| **#926's credential move** (`NODE_AUTH_TOKEN` from `pnpm/action-setup` to `oven-sh/setup-bun`, or option 3) | Founder/security-gate decision. Architect-close §5.2 frames three options and declines to decide; it changes the credential-bearing allowlist in `tests/release-action-pins.test.ts`, a `security.md` supply-chain invariant. **Only the decision-free guard splits out (A2).** |
| **#853 npm token rotation** | Secret rotation is a human action. It also *cannot be tested* until #926 clears — the lane has never reached the token. Do not schedule work that depends on a publish succeeding. |
| **#891 — delete the legacy standalone machinery** | Its own trigger is "a green vinext-axis compat suite lane", which A4 has not produced. Deleting the node path while the vinext axis holds **zero** compat runs would leave the project with no suite-verified target at all — the north-star credential would go to zero. Revisit when A4's clock has actually run. |
| **#872 — re-measure compiled-vs-uncompiled** | No sprint-3 decision hangs on it; ADR-0048 is founder-accepted. Cluster time this sprint is spent on A1, and cluster work is a queue of one. |
| **Restoring per-PR design gates** | Architect-close §5.3, on **fit** not price: design gates would have caught **none** of sprint 2's twelve rounds. A `$`-boundary bug in a scanner regex is an implementation defect in a guard, not an architecture defect. Replaced by §4's standing practice. |
| **Promoting the byte cap to a CRD field / status condition / `doctor` check** | ADR-0044 chose env-only *deliberately* to avoid the #548 upgrade-skew hazard. It is a real gap (a security control outside ADR-0001's single-source-of-truth view) but reopening it needs an ADR, not a sprint task, and it is cheaper before a consumer depends on the env var's shape — i.e. **next** sprint, with a design gate. |
| **Any new *scanning* guard** | Sysdesign C5: not without a simpler alternative rejected **on the record**. Standing for the sprint. |
| **Follow-ups #921–#925, #929–#933, #937** | Not in the graph. Available as filler for a team that finishes early — one PR each, and none of them may be a new scanner. |
| **Any new user-facing capability** (image opt extensions, previews, rollback, RUM) | §1. The previous sprint's output is neither merged nor observed running. Building on it now is building on an unsurveyed foundation. |

---

## 4. Standing practice for every implementer brief this sprint

Architect-close **C5** requires mitigations 1 and 2 be adopted in this plan. They are written here as
a rule, to be pasted verbatim into every implementer brief:

> **Prover-first, not prover-last.** If your change adds or modifies a guard, the mutation prover is
> **your** first green signal, not the reviewer's finding. Run it before you open the PR, and paste
> its output in the PR body. Every decorative guard found in sprint 2 was found by a prover that ran
> *after* a review round had already been spent — four on #935's branch alone. This collapses round
> N to round N−1 at zero new cost: the provers already exist and already run.
>
> **Same-class sweep obligation.** When a reviewer finds a defect in a scanner or guard, your fix
> round must include a **scan for that defect class across the whole file** — not a point fix, and
> not an enumerated list of the other places you remembered to check. #938's five rounds were
> substantially one class, four times (existential pairing, drain double-credit, `$`-boundary,
> non-identifier drains). This is the repo's own "prefer scanning to enumerating" rule, turned on
> its own review loop. State in the fix round's PR comment **what class you swept for and what the
> sweep found**, including "found none" — a sweep with no written result did not happen.
>
> **Both halves, always.** A guard must be proved to pass on the good case *and* red on the bad one.
> This is the repo's single most common PR defect (seven instances in one session).
>
> **Exit codes, never output greps.** Mutation harnesses branch on exit code. ANSI output once
> certified fourteen decorative mutations as all-green.
>
> **Prove the harness can see red first**, before crediting any mutation.

Reviewers hold escalation power (workflow.md). A reviewer who believes a change crosses a trigger
says so and the design gate is summoned for that PR — the sprint plan's prior approval is never an
answer to that.

---

## 5. Sequencing and dependency edges

```
PHASE 0 — today, no merge dependency
  A1 cluster verification (kind → OKE) on agent/s2-tail   [lead]   ← SPRINT ENTRY GATE
  A2 lockfile guard (split from #926)                     [team]
  A3 compat ledger MEASUREMENT (numbers only)             [team]
  A5 cache-handler-isr-staleness prover (#928 top item)   [team]
  A11 prove the escalation gate reds                      [lead]

        ────── M3: founder merges the 9-PR stack ──────
        #914 → #915 → #917 → {#919,#920,#927} → #935 → #938

PHASE 1 — opens on M3
  A4  compat-vinext publishes a number        ← needs #917 on main
  A6  ADR-0007 Amendment N                    ← needs A3 (hard), A4 (soft)
  A8  runtime snapshot replaces the scanner   ← needs #938
  A9  generate the entry copies               ← needs #914, #915
  A10 one exception registry, staggered       ← needs the whole queue
  A7  post-merge re-verification on main      ← needs M3 + A1
```

**The three load-bearing edges** — if only three things are remembered from this plan:

1. **A3 → A6.** The ledger measurement must exist before the amendment's restart-rule line is
   written. Sprint 2 was already bitten by writing-before-measuring on this exact issue, and
   workflow.md names it explicitly. A reviewer checks the file exists.
2. **#917 → A4 → {ADR-0044 anchor, compat-matrix row, ADR-0048 item 6}.** One unmerged PR gates the
   entire north-star credential chain. It is also the reason #917 should go early in the queue — it
   protects a credentialed nightly lane.
3. **M3 → {A8, A9, A10}.** All three structural debt tasks need merged content. If M3 slips past
   day 7, that is the plan's discovered-fact trigger and both gates return — this time as an
   *escalation*, not a deviation absorbed in silence as in sprint 2.

**Parallelism.** Phase 0's four team tasks have disjoint blast radii: A2 owns `.github/workflows` +
its guard script, A3 owns a measurement file only, A5 owns one prover + `prover-lane.mjs`'s
exemption list, A11 owns a scratch branch. `isolation: "worktree"` is mandatory for all concurrent
implementers. **Nobody but A1 touches a cluster.** In Phase 1, A8 (scratch-space scanner) and A9
(entry copies) are disjoint; A5 and A10 both touch `prover-lane.mjs`'s exemption data — **A5 owns
that file and A10 consumes the result**, so A10 is sequenced after A5.

---

## 6. Honest sizing

- **Duration: roughly two weeks**, per workflow.md's stated sprint bound.
- **Phase 0 is ~3–4 days of team time** and is the part the sprint controls. A1 is the long pole
  within it (cluster serialisation, kind then OKE).
- **Phase 1 is gated on an action nobody on the team can take.** If M3 never happens, sprint 3
  delivers Phase 0 and stops — and that outcome must be reported as *blocked*, not padded with
  substitute work. Sprint 2's lesson was that stacking further work above an unmerged stack keeps
  everyone busy while the verification debt compounds.
- **The 14-night compat window spans sprints by construction.** A4 at best starts the clock. Sprint
  3 must not be scored against closing it, and the sprint-close report must say so in those words.
- **What "done" looks like:** exit criteria 2 and 3 are **observed**, not claimed; the ISR half has
  both a prover and a cluster observation; the two most expensive guards are retired in favour of
  cheaper controls; the compat lane has either published a number or has its darkness recorded in
  ADR-0044; and the publish path's decision-free guard exists regardless of what the founder decides
  about the credential.

---

## 7. What this plan does not cover, stated rather than suppressed

- **The successive-round regression class trips none of the five escalation triggers.** §4's
  practice is a mitigation, not a gate. Nothing in this plan converts it into one, and workflow.md's
  own standard says a documented expectation degrades. It is the accepted risk, restated.
- **A1's honesty depends on the operator digest check being actually performed**, not just listed as
  a step. It has been skipped before, twice, at a cost of a sprint each time.
- **The §1 vinext-discipline constraint is self-policed.** It is the "team decides for itself that a
  trigger doesn't really apply" surface, and it exists only because C1 is out of the team's hands.
  A fourth sprint of vinext-only investment against an unamended rule would be the point at which
  the per-sprint model stops being acceptable — say so to the founder now, not at sprint close.

---

*Architect's half of the sprint-3 task graph. No code edited, nothing merged.*
