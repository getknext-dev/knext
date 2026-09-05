# Delivery workflow (knext)

The standing pipeline for any non-trivial change. Complements `security.md` (what is never
acceptable) and `scs-zones.md` (where the boundaries are).

**Amends `architecture.md` §1.** That rule says "do not implement until the plan is approved",
framed per-change. Under the sprint model below, plan approval is **per-sprint**, granted once via
the task graph, with the escalation triggers pulling the design gates back mid-sprint. Stated here
because two rules files giving different answers to the same question means whichever is read first
wins.

Until now this lived only in session context, which is why its last step kept being skipped.

## Sprint model — the architect and system designer meet ONCE per sprint

Running both design gates on every PR does not scale: a single one-file change here consumed six
Opus gate runs. They found real defects every time, so the answer is not to drop them — it is to
**move them from per-PR to per-sprint, and keep a trigger that pulls them back in.**

**A sprint** is the unit this trades against, so it needs a size: **roughly two weeks of delivery**,
opened by the planning meeting below and closed by the review at the end. The lead opens and closes
it. That bound is what makes the trade legible — "a mistake can live for a sprint" means about two
weeks, not indefinitely. Some work sets its own clock and the sprint must accommodate it rather than
the reverse: the compat gate needs 14 consecutive nightly runs, so it spans sprints by construction.

**Sprint planning (once, both gates, Opus).** Produces one artifact: a **task graph** — the sprint's
scope, each task's exit criteria, and the **dependency edges** between them. This is where the
expensive judgement is spent, and spending it here is what buys the parallelism below. The plan
must also name, explicitly, which tasks are expected to touch the escalation triggers.

**During the sprint, teams do not re-summon the design gates** — except on a trigger. A team hitting
one stops and escalates rather than deciding for itself:

- a change that contradicts, or would require amending, **an ADR *or* a hard rule in
  `architecture.md` / `scs-zones.md`**. Not every hard rule has an ADR number, and the gap is live:
  landing a capability behind a compat check that **skips rather than fails** contradicts "gate
  every feature on the official compatibility suite" while tripping no other trigger — and four
  capability rows are in exactly that state today. Same hole covers "don't rewrite the runtime
  twice" and "never make anything but the official-adapter target the default";
- a **security invariant** (`security.md`) — auth, secrets, supply chain, cluster-write surface;
- **the core-vs-app boundary or zone data sovereignty** (`scs-zones.md`) — moving Service Worker /
  Module-Federation / PWA code into `packages/kn-next` or the operator, or a zone reading another
  zone's database. Both have dedicated hooks, which is this repo's own signal that they are
  trigger-class; neither is reachable through the other triggers;
- the **public API**, `kn-next.config.ts` schema, CLI surface, or the **CRD**;
- a **discovered fact that invalidates the sprint plan** — the most important trigger and the one
  most likely to be rationalised away. Measuring something that contradicts the plan's premise is
  not a reason to quietly adjust; it is a reason to stop. Two precedents, both from one day: a
  measurement collapsed a planned preflight subsystem into a single flag, and a sprint plan's
  highest-value hypothesis died on contact with the cluster because it had been derived from
  operator *source* that was not deployed there.

**Three of these are mechanically detectable, so detect them** rather than relying on someone to
self-report against their own interest. A `git diff --name-only` against the merge base catching
`docs/adr/`, `api/v1alpha1/nextapp_types.go`, `packages/kn-next/src/config.ts`,
`packages/kn-next/src/cli/`, or the public subpaths in `packages/kn-next/package.json` covers the
ADR, config/CLI/CRD and public-API triggers. The remaining two — a discovered fact, and a hard-rule
contradiction that touches no tracked path — are judgement, and cannot be automated.

**Sprint close (once, both gates).** Review the sprint's aggregate, not each PR: did the task graph
hold, what did the escalations reveal, which exit criteria are actually met.

### Per-PR, always — this is what is NOT reduced

Code review and spec review run on **every** PR. They are cheap, parallelisable, and they are what
caught the defects here. **Reviewers hold the escalation power**: a reviewer who believes a change
crosses a trigger says so, and the design gate is summoned for that PR. The saving comes from not
running design gates by default — never from running fewer reviews.

### Be honest about what this trades

Per-sprint design review means an architectural mistake can live for a sprint instead of a PR.

Do not dress that up. Three of the five triggers are mechanically detectable; **the other two are
documented practice, not enforcement** — self-reported by the team that would have to escalate
against its own interest. This file says elsewhere that a guard which stays green when its subject
is removed is decoration, and `security.md` says a documented expectation degrades and its efficacy
is unobservable until it has already failed. Both apply here, to this model.

**The strongest argument against this model is in this file.** Six per-PR gate runs on one change
found a real defect every time; the only reason given for reducing them is price. And on one PR,
three consecutive rounds each fixed the previous round's defect and introduced the next — a
successive-round regression class that trips **none** of the triggers, so it is exactly what
per-sprint gating stops catching. Nothing in this model covers it; reviewer escalation is the only
backstop, and reviewers are not design gates. That is the accepted risk, stated rather than
suppressed.

It stops being acceptable the moment a team decides for itself that a trigger "doesn't really
apply" — that, not gate latency, is the failure mode to watch.

## Parallel teams

Work the task graph, not the backlog order.

- **Independent tasks run concurrently**, one team each. A team is an implementer plus its two
  reviewers, running the per-PR half of the pipeline.
- **Dependent tasks wait.** If B's exit criteria depend on A's behaviour, B does not start on a
  guess about A.
- **Disjoint blast radius is a hard requirement, not a preference.** Two teams must not hold the
  same file, and preferably not the same package. Overlap on a shared module (`_prom/query.ts`
  here) means one team owns it and the other consumes the result.
- **`isolation: "worktree"` is mandatory for concurrent implementers.** Without it they `git switch`
  in a shared tree and corrupt each other's state — this has happened here.
- **One branch, one worktree.** Two worktrees on a branch forces `--ignore-other-worktrees` and
  leaves a stale copy that later reads as authoritative.
- **Serialise anything that mutates shared external state.** Two benchmark runs against the same
  cluster silently invalidate each other — concurrent traffic keeps pods warm, so a "cold" start is
  not cold. Cluster work is a queue of one regardless of how many teams are running.

## The pipeline (per task)

1. **Plan** — from the sprint task graph. Design gates only at sprint boundaries or on a trigger
   above. Both pinned to Opus when summoned; subagents otherwise inherit the session model and
   silently downgrade on a task where judgement is the product.
2. **Implement — TDD.** Failing test first, for the reason you expect it to fail. Then make it pass.
3. **Integration test on kind** — the k8s integration gate. Lead-owned, gates the PR.
4. **Verify on OKE** for any feature or critical update. Standing requirement, not optional.
   Remember the distinction the cluster has already taught us twice: this verifies the **running
   system**, which is not the same as the source. Confirm what is actually deployed before
   attributing behaviour to code you read.
5. **Update the docs** for anything user-visible — the docs site is dogfooded, so it is part of
   delivery, not a follow-up. A feature whose docs land "later" ships undocumented.
   **Enforced, not aspirational (founder-directed, 2026-09-05):** every PR either carries its docs
   change or states "no user-visible surface changed" in the PR body — and the spec reviewer
   verifies whichever claim was made, the same way acceptance criteria are verified. A PR that
   changes CLI flags, config schema, env vars, endpoints, error messages users act on, or default
   behaviour, with no docs delta and no explicit no-impact claim, is `ISSUES_FOUND` on that ground
   alone. Docs are user-facing: no issue/PR/ADR numbers or internal codenames in them
   (`apps/docs/content-hygiene.test.ts` enforces the mechanical half). At **sprint close**, the
   gates check the aggregate the same way: any user-visible change that shipped in the sprint
   without its docs is a named condition, not a follow-up.
6. **Review** — code review *and* spec review, in parallel. The spec reviewer owns the step-5
   docs check above.
7. **Sign off** — normally the two reviews above are the gate. Summon architect and/or system
   designer **only** when a trigger fired or a reviewer escalated; the sprint-close review covers
   the rest. Whatever gates ran, a `BLOCK` or `ISSUES_FOUND` means another round — never a
   judgement call about whether it matters, and never "the sprint plan already approved this".
8. **Merge** on clearance.
9. **Refresh the knowledge graph** — AST only, per merge. See the cadence rule below.
10. **Clean up** — see below. This step is part of the workflow, not housekeeping after it.

## Step 9 — graph refresh cadence (AST per merge, semantic per sprint)

The graph in `graphify-out/` is a planning input, so it has to track `main`. But the two halves
of a rebuild have wildly different costs, and conflating them is what makes "update it after
every merge" unaffordable:

- **AST extraction is deterministic and free** — no LLM, seconds to run. Do this after every
  merge. It keeps code structure, call graphs, and file membership current.
- **Semantic extraction costs a fan-out of subagents** — the 2026-07-27 incremental rebuild
  needed eight of them for 458 changed files. Do this **once per sprint**, on the same boundary
  where the design gates already meet.

So: `graphify --update` in full belongs to sprint close; the per-merge step is the AST pass only.

Two things the graph does not do, recorded so nobody re-derives them
(`docs/GRAPH_PLANNING_NOTES.md` has the evidence):

- It **cannot** answer what the compat gate depends on. Those guards assert on workflow YAML as
  text, so no edge ever connects the runtime to the gate protecting it. Read the workflow.
- It **cannot** answer which decisions still stand. Extraction is pinned to a fixed relation
  vocabulary; `supersedes`/`amends`/`reverses` are collapsed into `references`. ADR supersession
  comes from the ADR front-matter, not from traversal.

Automating this as a git `post-commit` hook is a plausible next step, but installing one changes
every future commit in the repo for every contributor — ask before adding it.

**This step is unenforced, and by this file's own standard that means it will decay.** Nothing
blocks a merge whose AST pass never ran, and a stale graph fails silently — it answers, just from
last sprint's tree, which is worse than refusing to answer. That is precisely the "documented
expectation degrades, and its efficacy is unobservable until it has already failed" case argued
above, so it gets stated here rather than left for someone to discover. The mitigation available
today is cheap and belongs to whoever reads the graph, not whoever merged: `graph.json` carries
`built_at_commit`, so **check it against `main` before trusting a traversal**, and treat a
divergence as "re-run the AST pass", not as a reason to distrust the whole graph. The hook above
is what would convert this from an expectation into a gate.

## Step 10 — clean up after every successful merge, and at every review checkpoint

Do all four. Each has bitten this project.

- **Stop finished agents.** `TaskStop` every gate/implementer agent whose verdict you have already
  collected. An idle agent holds a pane and its context, and a stale one can be re-read later as if
  it were current.
- **Close the multiplexer panes** those agents occupied (`herdr pane close <id>`). Never close a
  pane you did not create — other sessions and editor panes are not yours to reap.
- **Reap unused agents mid-sprint, not only at merge time** (founder-directed, 2026-09-04). An
  agent that turned out to be unusable — spawned in a mode that cannot report, superseded by a
  respawn, or whose task was reassigned — is "finished" the moment you stop waiting on it, even
  though it never produced a verdict. Sweep at every review checkpoint: `TaskList` + `herdr pane
  list`, then `TaskStop` and close every pane whose agent nothing is waiting on. The precedent:
  four reviewer agents spawned in a mailbox mode whose tool set could not send results sat idle
  for hours holding panes, while working replacements ran alongside them — the sweep was only
  triggered by a human noticing the pane clutter.
- **Remove the git worktrees.** `git worktree remove <path> --force`, then `git worktree prune`.
  Verify the work is pushed first: compare the worktree's `HEAD` against `origin/<branch>`.
- **Delete the merged local branch.** It will refuse while a worktree still holds it — that refusal
  is the signal you skipped the previous item.

### Why this is a correctness step, not tidiness

- A stale worktree once held the **pre-fix content staged** on a branch whose fix had already
  landed. Committing there would have silently reverted the whole round (−525 lines).
- Two worktrees on the same branch forced `git checkout --ignore-other-worktrees`, leaving one of
  them stale against the tip — and a later read of that copy reports the wrong state confidently.
- Accumulated worktrees mean `vitest` can collect duplicate specs from throwaway copies (why
  `vitest.config.ts` excludes `**/.claude/**`), and a worktree without `node_modules` produces a
  cascade of resolve-error "failures" that look like real regressions.
- Agents left running keep answering. A verdict re-read hours later, out of context, is worse than
  no verdict.

### Verify the cleanup, do not assume it

```
git worktree list          # only the ones you intend to keep
git branch --merged main   # nothing stale
herdr pane list            # only your live panes
```

## Branch discipline (the guard that saved nothing because it was not run)

When a hook blocks a command, **nothing in it ran** — not even the parts before the offending
clause. So the danger is not that the command moved you; it is that you *assumed* the `git switch`
at the front of it succeeded, then re-ran only the tail. You were already wherever you started, and
the commit lands there.

That is the real mechanism, and it is worth stating correctly: the incident that motivated this rule
was a `git switch -c … && git commit && git push` blocked on its message text. Nothing ran, the
branch was never created, and re-running just the commit and push put a docs file straight onto the
trunk.

**Re-establish state after any blocked command rather than re-running its pieces**, and put the
guard in the command itself:

```
test "$(git branch --show-current)" != "main" && git commit … && git push …
```

A direct push to `main` bypasses CI, not just review. One docs-only push left `main` red across
three commits, so every open PR showed an inherited failure unrelated to its own changes.

## Reviewing: ask the gate to attack, not to confirm

A reviewer asked "is this correct?" tends to agree. One asked "defeat this" finds the hole. On one
PR here, three consecutive rounds each *fixed* the previous round's defect and *introduced* the
next one; every one was caught by an adversarial prompt, none by a confirmatory one.

Corollaries that have each caught a real defect:

- **Mutation-prove every new guard.** Delete the behaviour it protects and watch it go red. A guard
  that stays green when its subject is removed is decoration.
- **Never mutate with `perl` for that proof.** A silently-failed substitution yields a green run
  that proves nothing. Use a script that asserts the anchor occurs exactly once and aborts otherwise.
- **Prefer scanning to enumerating.** An enumerated list of call sites is how the second one gets
  missed; make an unparseable construct *fail* rather than pass.
- **Re-read your own claims against the current tree before merging**, not just your diff. A PR
  written before a measurement can land a claim that measurement has since disproven.
