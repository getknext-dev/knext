# Sprint-2 close — ARCHITECT gate

**Verdict: CLOSE-WITH-CONDITIONS** (5 conditions, §6). Not BLOCK, not a clean close.

Convened per `.claude/rules/workflow.md` "Sprint close (once, both gates) — review the sprint's
aggregate, not each PR". Inputs read: `.claude/sprint2-close-brief.md`,
`.claude/sprint2-taskgraph.md`, `.claude/rules/architecture.md`, `CLAUDE.md` §3/§7/§9/§10,
ADR-0044 (all 4 amendments), ADR-0007 (all addenda), ADR-0048 (all 3 amendments),
`docs/compat-matrix.md`, `scripts/check-escalation-triggers.mjs`,
`.github/workflows/escalation-triggers.yml`.

The brief is the lead's summary; everything load-bearing below was re-verified against `gh` /
`git` / the tree. Where the brief and reality differ, reality is recorded.

---

## 1. Verification method, and what it changed

I did not take the brief's "green, ready" at face value. Six claims were checked mechanically;
**two came back different from the brief**, one materially.

| brief claim | verified | verdict |
|---|---|---|
| 9 PRs green | `statusCheckRollup` per PR | **partly refuted** — #919 carries 2 FAILURE rows, #927 carries 1 (see §5.4) |
| V1 fired → a published number | `gh run list --workflow=compat-vinext.yml` | **refuted** — the one run FAILED, no number (§3.1) |
| stack is CLEAN/mergeable | `mergeStateStatus` per PR | confirmed — all 9 CLEAN |
| triggers acknowledged | PR labels + escalation-check runs | confirmed for all 4 that fired (§4.3) |
| V4/#850 premise moot | #850 comment + `compat-window-fingerprint.mjs:184-202` | confirmed (§5.1) |
| T6b deferral is dated + guarded | #936 + `SEAM_RELOCATION_EXEMPTIONS` | confirmed (§4.5) |

One hypothesis I formed and then **refuted against the code**, recorded because a sprint close
that only reports confirmations is not a review: I suspected
`scripts/check-escalation-triggers.mjs` implemented only 4 of workflow.md's 5 detectable trigger
paths, omitting the public-API/`package.json`-exports one — which would have made #936's deferral
undetectable. It does implement it (`PUBLIC_MANIFEST_KEYS`, `publicSurfaceChanged`, line 152-157),
and it does so *by content, not by path*, which is strictly better than the rules file specifies.
The detector is sound.

---

## 2. Did the task graph hold?

**Substantially, yes — with one structural deviation and one unmet gate.**

### Held
- **The stack discipline held.** Eight branches, eight disjoint blast radii, one branch per
  worktree, correct base chain (`main` ← #914 ← #915 ← {#919,#920,#927} ← #935 ← #938). No two
  teams held the same file; the one genuine overlap the plan predicted (T1 and T4a both own
  `knext-bun-entry.mjs.hbs`) was **serialised as designed** — the plan's own line "T1 WAITS on
  agent/s2-scaffold-parity landing (same template file)" was obeyed, and the merge commit
  `aa4aa379` is the evidence.
- **Measure-first held twice, and both times the measurement changed the work.** T1's Bun 1.4
  experiment ran *before* any code and collapsed a planned subsystem to a flag. V4's measurement
  ran and killed its own task's premise. That is the discovered-fact trigger working as designed —
  the most-likely-to-be-rationalised-away trigger, self-reported against the team's own interest,
  twice.
- **Scope discipline held.** Every OUT item stayed out. No new public surface was added while the
  stack waited, except the one (`--skip-smoke`, #919) that is an escape hatch for a
  fail-never-skip control — additive, defaulted safe, and acknowledged through the gate.

### Deviated
- **Phase 2 was supposed to open on M3 (founder merge). M3 never happened.** The plan says
  "day-7 unmerged = discovered-fact, gates return". Phase-2 work (T2, T3b, G1-G5, T6, V4, D9) ran
  anyway, on branches, stacked above an unmerged Phase 1. This was the right call — the
  alternative was an idle sprint — but it should be recorded as a deviation the plan anticipated
  and the team absorbed rather than escalated. The cost is deferred and named in §3.2: everything
  that needed a cluster is still unverified.

### Did not hold
- **V1's exit criterion is unmet** (§3.1). It is the only exit criterion in the plan that the
  sprint had full control over and did not reach.

---

## 3. Exit criteria — actually met vs claimed

### Standing criteria (SE-1..SE-5)
SE-1 ✅ · SE-2 ✅ (red-first evidenced per PR) · **SE-3 ✅ with dated exemptions** — #927 delivered
5 of 9 provers, 4 carry exemptions expiring 2026-11-01, tracked in #928 and enforced by
`GUARD_PROVER_EXEMPTIONS` in `scripts/lib/prover-lane.mjs`. That is exactly what SE-3 permits
("a committed prover **or** a dated exemption"). · SE-4 ✅ except the T6b residual, dated (§4.5) ·
SE-5 ✅ (`apps/docs/content/docs/{hardening,cli}.mdx` land in the same PRs as their features).

### V1 — "fire compat-vinext.yml once → a published number": **NOT MET**

Verified: **one** run exists — `33883692192`, `main`, `workflow_dispatch`, 2026-09-04T14:25:59Z,
**conclusion `failure`**. Job `Prepare prebuilt next + harness (vinext axis)` died at step
**"Install knext deps"**; `Per-shard ledger (the published number)` died at "Download the
compat-window fingerprint"; all 16 shard jobs and the weekly alert **skipped**.

The lane published nothing. And the failure is the exact defect #917 fixes (compat lanes still
installing with pnpm against a repo with no pnpm-lock — the same root cause as #926). So V1 is not
"fired and awaiting results"; it is **blocked behind the same unmerged queue as everything else**,
and its fix is sitting in the queue as PR #917.

Three consequences, none of which the brief states:

1. **ADR-0044 Amendment 2's re-anchored expiry clock has not started.** Amendment 2 re-anchored
   the Option C exception to "the first sprint close after the vinext-axis compat lane publishes
   its first run". No run has published. **ADR-0044 Amendment 4 is scrupulously honest about
   this** — "This did not wait for that anchor… Nothing here should be read as the anchor having
   fired — it is a decision not to need it." I endorse that disposition without reservation: it
   retires a live security exception four lines early rather than renewing it a third time, which
   is the correct direction of travel. But the sprint must not record V1 as met on the strength of
   V2 having been delivered anyway. Those are different facts.
2. **ADR-0048 action item 6 stays open** — `docs/compat-matrix.md`'s vinext single-executable axis
   row is ❌ and the docs say "measured-per-feature, not suite-verified". That is honest and the
   `tests/compat-matrix.test.ts` guard enforces it. But note what it means: the hard rule "gate
   every parity claim on the official compatibility suite" is currently satisfied **only by not
   claiming**. The shipped path (compiled binary) has never been suite-tested; the 778-passing
   credential belongs to the node-standalone target which the validator **no longer lets a user
   select**. The compat-matrix row states this correctly, in a SCOPE preamble. Nobody is
   over-claiming. But the north-star credibility lever is, in strict terms, currently **detached
   from the shipped artifact**, and it has been since ADR-0048 was accepted.
3. Sprint 3's single highest-value item is therefore mechanically determined (§7.1).

### Refuse-to-close-without #1 — byte cap on the binary, chunked proved: **MET**

Delivered in #915. Verified in the diff: `scripts/lib/request-byte-cap.mjs`,
`examples/bun-exec/test/request-byte-cap.test.ts`, `tests/request-byte-cap.test.ts`,
`scripts/mutation-prove-bytecap.mjs`, wired into all four `knext-bun-entry.mjs` copies plus both
templates (`packages/kn-next/templates/app/`, `turbo/generators/templates/zone/`) and pinned by
`scripts/lib/runtime-entry-copies.mjs`. ADR-0044 Amendment 4 lands in the same PR. Chunked-body
413 proved on Bun 1.4. **This one is unambiguous and it is the sprint's best work.**

### Refuse-to-close-without #2 and #3 — cluster verification: **NOT MET**

The brief asks me to confirm or refute the "merge-gated" framing. **Confirmed as a scheduling
reality; refuted as a technical necessity.** The distinction is load-bearing.

- *Confirmed*: the criteria genuinely are not met, and the brief says so plainly rather than
  scoring them met at CR level. That honesty is correct and I am not marking it down.
- *Refuted*: **nothing about kind or OKE requires `main`.** This repo's own pipeline puts them at
  steps 3 and 4 — *before* review, sign-off and merge — and calls OKE "a standing requirement, not
  optional". `origin/agent/s2-tail` contains all nine PRs' content and is buildable today; the
  scaffolded app, the image, and the CR can all be produced from it. The reason this did not run
  is that the lead judged cluster time not worth spending on a stack that may still change under a
  founder merge — a defensible call, and the serialisation rule ("cluster work is a queue of one")
  supports it. But it is a *choice*, and calling it "merge-gated" reads as "we could not", which
  is not true.

Recording it accurately matters because CLAUDE.md §9 already warns twice that the running system
is not the source, and both prior lessons cost a sprint. Two criteria whose only evidence is
CR-level and test-level are exactly the state those warnings describe.

---

## 4. ADR / hard-rule compliance of the aggregate

**No change in the nine PRs contradicts an ADR or a hard rule in a way that is unrecorded.** That
is the finding. Detail, including the two places I looked hardest:

### 4.1 The byte cap vs ADR-0044 — compliant, and better than the plan

Amendment 4 **closes** the dated exception rather than renewing it a third time. It preserves every
pre-recorded Decision-4 constraint, names the one constraint it could **not** meet rather than
quietly dropping it, and explicitly keeps **rate limiting open** ("must not be claimed as
closed"). No over-claim anywhere.

Two design choices I want to endorse on the record because they are the kind that get reversed by
a later well-meaning PR:

- **`KNEXT_MAX_REQUEST_BYTES` is env-only, with NO CRD field.** This is correct and deliberate: a
  new CR field would fire the #548 upgrade-skew hazard (newer CLI emitting a field an older
  operator's CRD does not know) for a control that needs none. Do not "improve" this later by
  promoting it to `spec.security`.
- **The cap is wired at both `:150` (app) and `:196` (the `:9091` metrics `Bun.serve`).** The
  second is the one that mattered — ADR-0044 named the co-resident path as unbounded, and it was
  open at Bun's 128 MB default. A front proxy never saw that path. Covering it is what makes
  Amendment 4's claim ("a platform control on **every** path") true rather than rhetorical.

**One residual, not a violation:** the cap is invisible to the control plane. Because it is env-only
and absent from the CR, the operator cannot assert it, no status condition reports the effective
value, and `doctor` does not check it. ADR-0044 Decision 4 never required that, so this is not
non-compliance — but "operator = single source of truth" (ADR-0001) now has a security control
sitting outside its view. Sprint-3 candidate, not a condition.

### 4.2 The standing contradiction the sprint deepened — ADR-0048 action item 7

`.claude/rules/architecture.md` still reads *"never make anything but the node/official-adapter
target the default."* ADR-0048 (Accepted, founder decision) sets that target aside **entirely**,
and its own header says so out loud: *"the maintainer must amend that rule or this ADR contradicts
it."* Action item 7: **STILL OPEN.**

Sprint 2 did not create this. But it is the aggregate finding, because sprint 2 **materially
deepened the investment in the contradicted path**:

- #915's byte cap lives **only** in `knext-bun-entry.mjs` — the compiled binary's entry.
- #919's post-compile smoke boots **only** the compiled executable.
- #914's parity work reconciles **only** the vinext runtime-entry copies.

Every one of those is correct *given* ADR-0048 and wrong *given* the unamended rule. Three PRs'
worth of load-bearing security and correctness work now sits on a target a hard rule forbids as
default. Per architecture.md, `.claude/rules/` is not an agent's file to edit — this is a
maintainer action, and it is now **two sprints overdue**. It becomes condition C1.

I do not BLOCK on it: the ADR is founder-accepted, the contradiction is recorded in the ADR itself
rather than hidden, and blocking would punish the team for a maintainer's outstanding item. But a
third sprint of vinext-only investment against an unamended rule stops being an oversight and
starts being the "team decides for itself that a trigger doesn't really apply" failure mode
workflow.md names as the point where the model stops being acceptable.

### 4.3 The escalation triggers — all four fired, all four acknowledged

Verified per-PR (labels + check runs):

| PR | trigger | label | latest escalation check |
|---|---|---|---|
| #915 | ADR (modifies `docs/adr/0044-*`) | `design-gate:cleared` | SUCCESS |
| #919 | CLI surface (`src/cli/build.ts`, `postcompile-smoke.ts`, `vinext-build.ts`) | `design-gate:cleared` | SUCCESS 17:02:53Z |
| #920 | CLI surface (T2, predicted in the plan: "fires the CLI trigger mechanically — acknowledged up front") | `design-gate:cleared` | SUCCESS |
| #927 | CLI surface (`src/cli/validate.ts`, §4.2 residual) | `design-gate:cleared` | SUCCESS 19:29:50Z |
| #914 / #917 / #935 / #934 / #938 | none fired | — | SUCCESS |

**The mechanism worked.** Nothing was merged past an unacknowledged trigger; the label was added
after the gate, and the workflow's `labeled` re-run recorded it. This is the sprint model's
automated half doing exactly its job, and it is worth saying because the last time this was
measured (2026-08-11) a breaking CRD+CLI change merged with no gate at all "because nothing was
looking".

**But it is advisory at the merge button.** Verified against `main`'s branch protection: 11
required contexts, and **"Escalation triggers acknowledged" is not one of them**. The single
mechanism this repo built to stop the per-sprint model's stated failure mode can be merged past
with a green-enough-looking rollup. It held this sprint because people looked. workflow.md's own
standard — "a documented expectation degrades, and its efficacy is unobservable until it has
already failed" — applies to it. Cheapest high-value fix in the list (§7.4).

### 4.4 #920's "verify-the-claim, not discovery" — endorsed

The `_vinext_fonts` lesson correctly applied. A discovery-shaped guard ("find the id and check
it") goes green when the id is absent; a verify-the-claim guard fails. #920 puts the marker **at
the write site**, so marker key ≡ protection key by construction rather than by a second lookup
that can silently return nothing. This is the "prefer scanning to enumerating / make an
unparseable construct FAIL rather than pass" rule, correctly instantiated. No ADR implication; it
is the right pattern and should be the default for the id/skew family.

### 4.5 T6b's deferral vs `security.md` — correctly classed, and the dangerous half closed in-sprint

The half that was deferred (#936) is the **public-API** move: getting `__`-prefixed mutating
cache-handler seams off `@getknext/core/adapters/cache-handler`. It is a genuine public-API
trigger (removes exports from a published subpath, needs a semver-aware plan for three in-repo
callers), it carries a dated exemption in `scripts/lib/published-seam-policy.mjs` that reds CI when
it lapses, and it is tracked.

More important, and the reason this is not a `security.md` problem: **#935 shipped the runtime
mitigation in the same sprint** — `KNEXT_TEST_SEAMS` now throws unconditionally under
`NODE_ENV=production`. So the exposure (a consumer importing a mutating seam in production) is
**neutralised at runtime** while the export cosmetically remains. Dangerous half closed now,
cosmetic half dated. That is defense-in-depth done in the right order, and it is the opposite of
the pattern security.md warns about. **Endorsed, not a finding.**

For the record: `security.md`'s actual hard line is "no unauthenticated **mutating endpoints**".
These are test seams on an import path, not endpoints. Classing them as a security deferral would
have been the wrong frame; classing them as a public-API deferral, which is what #936 does, is
right.

### 4.6 `--skip-smoke` (#919) vs "official adapter default"

New CLI surface. Design is sound: **fail-never-skip is the default**, the flag is loud when used
("the binary will be UNVERIFIED"), the argv parser has a `KNOWN` allowlist so a typo'd flag fails
rather than silently no-ops, and the error paths name the flag as the escape hatch rather than
leaving the user stuck. It does not contradict the official-adapter-default rule **any more than
ADR-0048 already does** (§4.2) — it is a flag on a target whose defaultness is the open question,
not a new default. No ADR needed.

---

## 5. The escalations, judged

### 5.1 V4 / #850 — is an ADR-0007 amendment the right disposition? **Yes.**

The discovered fact is verified and correct: `scripts/compat-window-fingerprint.mjs:184-202`
already digests packed *content* + mode (deliberately, since gzip embeds an mtime), so the window
was **already** content-anchored. Two independent packs plus a third after a full rebuild produced
identical `sha256:fb964074…`. A no-op merge does not restart the window, and the five `packed`-only
restarts #850 cites were nights where shipped bytes genuinely differed.

So the *remedy* #850 proposed is moot. The *question* is not, and an amendment is the right
vehicle because **the window rule is a decision recorded nowhere**: ADR-0007 defines the compat
gate, `docs/V1_ROADMAP.md` §3 makes it a v1.0 blocker, and neither states the window rule in the
form actually enforced. Undocumented enforced behaviour is precisely what an ADR amendment is for.

**But the amendment is bigger than #850 frames it,** and the sprint close is where that gets said.
#850 treats this as a restart-rate problem. It is now also an **axis-scope** problem: ADR-0048 made
the node-standalone target un-selectable, so a green 14-night window on the node axis is a
credential for a path **no user can choose**, while the vinext axis has never published a run
(§3.1). Amending the restart rule without stating the per-axis scope would produce a correct
document that certifies the wrong artifact.

**One sequencing warning.** The amendment must **not** be written before the ledger measurement.
#850's own AC puts the measurement first ("the numbers above are a starting point, not the
finished measurement"), and workflow.md names this exact failure — "a PR written before a
measurement can land a claim that measurement has since disproven". Sprint 2 has already been
bitten by it once, on this very issue.

#### Draft skeleton — ADR-0007 Amendment N

> **Amendment N: the 14-night window — what it measures, what restarts it, and which axis it
> certifies.**
> Status: DRAFT, pending the ledger measurement (do not accept before it).
>
> **Context.**
> (i) *Measured, 2026-09, on `agent/s2-tail`*: the fingerprint is already anchored on packed
> **content** + file mode, not tarball bytes (`compat-window-fingerprint.mjs:184-202`) — three
> independent packs, including one after a full rebuild, yielded the identical digest
> `sha256:fb964074…`. A no-op merge does not restart the window; #850's five `packed`-only restarts
> were nights where shipped bytes genuinely differed. **The re-anchoring remedy #850 proposed is
> therefore moot**, and this amendment exists to record the behaviour as a rule rather than to
> change it. #938 landed the decision-free half: a both-halves durable test
> (`tests/compat-window-fingerprint.test.ts` — two byte-different tarballs, one digest) plus a
> 3-mutation prover.
> (ii) *Not yet measured*: the restart **rate** and its cause distribution over the run ledger.
> This is the input the restart-rule decision depends on and it does not exist yet.
> (iii) *Changed underneath the window*: ADR-0048 removed the node-standalone target from user
> selection. The window currently runs on an axis that certifies an artifact nobody can deploy,
> and the vinext axis lane has published **zero** runs (run 33883692192 failed at "Install knext
> deps", 2026-09-04).
>
> **Decision** — three sub-decisions, deliberately separated so the measured ones can land without
> waiting on the unmeasured one:
> 1. *(landable now)* The fingerprint **stays content-anchored**, and that is hereby the recorded
>    rule rather than emergent behaviour of the script.
> 2. *(landable now)* The window's claim is **scoped per axis**. A node-axis window may not back a
>    v1.0 or compat-matrix claim about the shipped compiled path. The official-suite row already
>    carries an ADR-0048 SCOPE preamble; this makes that scoping a rule of the window, not a
>    caveat on one table cell.
> 3. *(blocked on the ledger measurement)* The restart rule is **[narrow / reshape / keep-and-
>    accept]**. Do not write this line before the numbers exist.
>
> **Options considered** (for sub-decision 3):
> | option | for | against |
> |---|---|---|
> | Narrow the fingerprint | fewer restarts; window becomes reachable | a real shipped-byte change stops restarting the clock — the credential drifts from the artifact it certifies |
> | Reshape the window (14-consecutive → 14-of-N, or rolling) | tolerant of legitimate shipping activity | a weaker claim; "14 consecutive green nights" is a stronger sentence than what replaces it |
> | Keep both, accept in writing | maximally honest; no guard weakening | if the measured rate makes 14 consecutive nights unreachable, this is an **unreachable anchor** — the exact defect ADR-0044 Amendment 2 had to be written to fix |
>
> **Consequences.** Whatever is chosen becomes a **guard**, and the guard is **mutation-proved**
> (#850 AC — "a window rule that can be edited to produce green is the failure this repo has spent
> several rounds avoiding"). `docs/compat-matrix.md`'s v1.0 row states the rule in the enforced
> form. The per-axis scope statement lands in the official-suite row.
>
> **Action items.** ledger measurement (sprint 3) → sub-decisions 1+2 land immediately → sub-
> decision 3 → guard + prover → matrix row → close #850.

### 5.2 #926 — release lane. Options framed for the founder; **I do not decide this.**

**The facts, restated so the decision is made on them.** `.github/workflows/release.yml` runs
`pnpm install --frozen-lockfile` in three jobs (`:114`, `:166`, `:277`); `fe28ad9c` deleted
`pnpm-lock.yaml` and `pnpm-workspace.yaml`; both are absent from `origin/main`. Every job dies at
install. **#853's dead npm token was never the only blocker and cannot even be validated until
this is fixed** — the lane has never reached the token. Same root cause as V1's failure (§3.1), so
this is one defect wearing two hats.

The reason it is a founder call and not an implementer's: the fix moves which action holds
`NODE_AUTH_TOKEN`, which is a `security.md` supply-chain invariant and an allowlist entry in
`tests/release-action-pins.test.ts`.

| option | what it does | for | against |
|---|---|---|---|
| **1 — switch the lane to bun** | `pnpm/action-setup` → `oven-sh/setup-bun`, matching `ci.yml` | one package manager, one lockfile — restores the invariant `fe28ad9c` was enforcing | expands the credential-bearing allowlist to a new third-party action whose blast radius is a live npm publish token; needs a SHA pin + resolvable `# vX.Y.Z` comment for the nightly checker |
| **2 — restore a pnpm lockfile for the release lane only** | keeps the lane as-is | the audited allowlist is untouched; no action holds a new token | reintroduces the two-package-manager state the repo deliberately removed; a second lockfile drifts silently, and the failure mode of that drift **is this bug**, one toolchain move later |
| **3 — publish from a job that installs nothing** | pack in a bun job, upload tarballs, publish from a minimal token-holding job | **shrinks** the credential's blast radius rather than moving it; the token-bearing job runs no third-party setup action at all | most work; changesets' `version-script` / `publish` wiring must be split |

**Architect note, not a decision:** options 1 and 3 both satisfy #926's acceptance criteria.
**3 reduces standing risk; 1 reduces standing complexity.** Given `security.md` already treats the
publish path as the highest-value credential in the repo (it is the only path with a nightly pin
resolver), 3 is the one that matches how this repo has historically reasoned about that token —
but the cost is real and the call is the founder's.

**Independently of which option wins:** #926's AC also asks for the *general* guard — "a workflow
invokes a package manager whose lockfile the repo does not carry → red". **Split that out and land
it now.** It is decision-free, it is what stops the next toolchain move from doing this again, and
it should not be held hostage to a founder decision. Sprint-3 item §7.2.

### 5.3 The successive-round data — does the model's stated risk need a sprint-3 mitigation? **Yes, but not the obvious one.**

The data: 5 rounds on #938, 4 on #927, 3 on #935, 2 each on #919/#920. Every round found a real
defect. The scratch-space scan alone needed **four same-class fixes** (existential pairing, drain
double-credit, `$`-boundary, non-identifier drains). Provers caught 4 decorative guards on #935's
branch and 2 spurious kills on #927.

workflow.md already names this class and calls it the accepted risk. **Sprint 2's data does not
just confirm it — it corrects the framing in one important way.** All of these rounds happened
*inside the per-PR review loop*, which the sprint model **did not reduce**. Per-PR review caught
every one. The model held. What the data actually shows is not a gating gap; it is that **the
defect density of guard/scanner code is high**, and that **provers are the highest-yield control
in the repo** — they are what found the decorative guards, and a decorative guard is worse than no
guard because it reports safety it does not provide.

**I therefore recommend against restoring per-PR design gates.** Not on price — on fit. Design
gates would have caught **none** of these. A `$`-boundary bug in a scanner regex is not an
architecture defect; it is an implementation defect in a guard. Summoning Opus architecture review
for it is the wrong instrument, and the rules file's own worry ("a gate that is expensive to
satisfy gets routed around instead of obeyed") applies.

Three mitigations that fit the measured failure, in yield order:

1. **Prover-first, not prover-last.** Every decorative guard this sprint was found by a prover, and
   in each case the prover ran *after* a review round had already been spent. Make the prover the
   **implementer's** first green signal rather than the **reviewer's** finding. This collapses
   rounds N→N−1 by construction, at zero new cost — the provers already exist and already run.
2. **Same-class sweep obligation.** #938's five rounds were substantially *one class, four times*.
   Require: when a reviewer finds a defect in a scanner, the fix round must include a **scan for
   that class across the whole file**, not a point fix. This is just the repo's own "prefer
   scanning to enumerating" rule applied to its own review loop, and it is the single change that
   would most plausibly have made #938 a two-round PR.
3. **Make the escalation check required** (§4.3). Converts the model's only automated half from
   documented practice into a gate — the thing workflow.md says, repeatedly, is the only form that
   does not decay.

---

## 6. Verdict — **CLOSE-WITH-CONDITIONS**

**Why not BLOCK.** No change in the nine PRs contradicts an ADR or a hard rule in a way that is
unrecorded. Every mechanically-detectable trigger that fired was acknowledged through the gate.
The one live security exception in scope (ADR-0044 Decision 4) was **closed**, not renewed a third
time. The one public-API deferral (#936) is dated, guarded by a lapsing CI check, and had its
dangerous half neutralised in the same sprint. The sprint's honesty discipline held under pressure
— including twice reporting measurements that killed its own tasks.

**Why not a clean CLOSE.** Two of the system designer's three refuse-to-close criteria are unmet
(§3.3). The sprint's own V1 exit criterion is unmet and the brief scores it as fired (§3.1). And a
founder/maintainer-owed hard-rule amendment is two sprints overdue while this sprint added three
PRs' worth of load-bearing work to the path that rule forbids (§4.2).

### Conditions

| # | condition | owner |
|---|---|---|
| **C1** | Amend `.claude/rules/architecture.md`'s official-adapter-default rule, or record a dated exception in ADR-0048 (action item 7). **Sprint 3 must not add a fourth PR's worth of vinext-only investment against an unamended rule.** | maintainer |
| **C2** | Run kind + OKE verification of exit criteria 2 and 3 on the merged stack, and record the result. The merge-gated framing is accepted as a *scheduling* choice and **refuted as a technical necessity** — workflow.md steps 3–4 are branch-run, pre-merge stages. Sprint 3 does not open until this runs or the founder explicitly re-defers it. | lead |
| **C3** | After #917 lands, re-run `compat-vinext.yml` and publish the number — or record in ADR-0044 that Amendment 2's anchor is still unfired. Amendment 4's honesty on this point must be preserved, not quietly overtaken. | lead |
| **C4** | Before the merge queue runs, hand the founder the **stale** FAILURE run IDs on #919 (33894955802, 33898433110) and #927 (33911350365) alongside their superseding SUCCESS runs (33898443712, 33911436100), so a red rollup row is not read as a red gate — and is not *trained away* either. | lead |
| **C5** | Adopt §5.3's mitigations 1 and 2 in the sprint-3 plan, and make "Escalation triggers acknowledged" a required status check. **Do not restore per-PR design gates.** | sprint-3 planning |

Note on **#915**: it is still marked **draft**. Undraft it before the queue runs, or it will stall
the chain at position two.

---

## 7. Top-5 sprint-3 candidates (architect's seat)

1. **Get the vinext-axis compat lane to publish a number** (#917 → re-run → ledger). It is the sole
   gate on ADR-0048 item 6, on the compat-matrix ❌ row, on ADR-0044 Amendment 2's anchor, and on
   the verified-adapter north star — the credential currently certifies a target users cannot
   select. Everything else is downstream of this one.
2. **#926 release lane, plus the general lockfile guard split out and landed independently.** The
   publish path cannot install; #853's token was never the only blocker and cannot be tested until
   this clears. The guard is decision-free — do not let it wait on the founder's option choice.
3. **ADR-0007 window amendment (#850): ledger measurement FIRST, then sub-decisions 1+2, then 3.**
   Its real content is per-axis scope, which is larger than #850 states, and writing it before the
   numbers is the failure mode this repo has already hit on this exact issue.
4. **Make the escalation check required + adopt prover-first review.** The cheapest structural fix
   available: it converts the per-sprint model's only automated half from advisory to a gate, and
   prover-first is the measured highest-yield answer to the successive-round class.
5. **#928's four exemptions, `cache-handler-isr-staleness` first.** Clock expires 2026-11-01, and
   it guards ISR on the *shipped* path — leaving it unproved is the same shape as a decorative
   guard, on the one capability the compat lane cannot yet certify (see 1).

*Honourable mention, deliberately not top-5:* the byte cap is invisible to the control plane
(env-only, no CR field, no status condition, no `doctor` check). Not a violation — ADR-0044 never
required it — but ADR-0001's "operator = single source of truth" now has a security control
sitting outside its view, and that gap will be easier to close now than after a consumer depends
on the env var's shape.

---

*Architect gate, sprint-2 close. No code edited, nothing merged.*
