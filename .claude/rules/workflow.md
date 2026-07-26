# Delivery workflow (knext)

The standing pipeline for any non-trivial change. Complements `architecture.md` (how to design),
`security.md` (what is never acceptable), and `scs-zones.md` (where the boundaries are).

Until now this lived only in session context, which is why its last step kept being skipped.

## Sprint model — the architect and system designer meet ONCE per sprint

Running both design gates on every PR does not scale: a single one-file change here consumed six
Opus gate runs. They found real defects every time, so the answer is not to drop them — it is to
**move them from per-PR to per-sprint, and keep a trigger that pulls them back in.**

**Sprint planning (once, both gates, Opus).** Produces one artifact: a **task graph** — the sprint's
scope, each task's exit criteria, and the **dependency edges** between them. This is where the
expensive judgement is spent, and spending it here is what buys the parallelism below. The plan
must also name, explicitly, which tasks are expected to touch the escalation triggers.

**During the sprint, teams do not re-summon the design gates** — except on a trigger. A team hitting
one stops and escalates rather than deciding for itself:

- a change that contradicts, or would require amending, an **ADR**;
- a **security invariant** (`security.md`) — auth, secrets, supply chain, cluster-write surface;
- the **public API**, `kn-next.config.ts` schema, CLI surface, or the **CRD**;
- a **discovered fact that invalidates the sprint plan** — the most important trigger and the one
  most likely to be rationalised away. Measuring something that contradicts the plan's premise is
  not a reason to quietly adjust; it is a reason to stop. (A measurement this project ran collapsed
  a planned subsystem into a single flag — worth far more than the plan it broke.)

**Sprint close (once, both gates).** Review the sprint's aggregate, not each PR: did the task graph
hold, what did the escalations reveal, which exit criteria are actually met.

### Per-PR, always — this is what is NOT reduced

Code review and spec review run on **every** PR. They are cheap, parallelisable, and they are what
caught the defects here. **Reviewers hold the escalation power**: a reviewer who believes a change
crosses a trigger says so, and the design gate is summoned for that PR. The saving comes from not
running design gates by default — never from running fewer reviews.

### Be honest about what this trades

Per-sprint design review means an architectural mistake can live for a sprint instead of a PR. That
is acceptable **only** because the triggers above are enforced and because the task graph was
designed up front. It stops being acceptable the moment teams start deciding for themselves that a
trigger "doesn't really apply" — which is the failure mode to watch for, not gate latency.

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
3. **Verify on OKE** for any feature or critical update. Standing requirement, not optional.
4. **Review** — code review *and* spec review, in parallel.
5. **Sign off** — normally the two reviews above are the gate. Summon architect and/or system
   designer **only** when a trigger fired or a reviewer escalated; the sprint-close review covers
   the rest. Whatever gates ran, a `BLOCK` or `ISSUES_FOUND` means another round — never a
   judgement call about whether it matters, and never "the sprint plan already approved this".
6. **Merge** on clearance.
7. **Clean up** — see below. This step is part of the workflow, not housekeeping after it.

## Step 7 — clean up after every successful merge

Do all four. Each has bitten this project.

- **Stop finished agents.** `TaskStop` every gate/implementer agent whose verdict you have already
  collected. An idle agent holds a pane and its context, and a stale one can be re-read later as if
  it were current.
- **Close the multiplexer panes** those agents occupied (`herdr pane close <id>`). Never close a
  pane you did not create — other sessions and editor panes are not yours to reap.
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

A blocked compound command can leave you on the wrong branch, because the parts before the block
never ran. **Re-establish state after any blocked command rather than re-running the pieces**, and
put the guard in the command itself:

```
test "$(git branch --show-current)" != "main" && git commit … && git push …
```

A direct push to `main` bypasses CI, not just review. One docs-only push left `main` red across
three commits, so every open PR showed an inherited failure unrelated to its own changes.

## Reviewing: ask the gate to attack, not to confirm

A gate asked "is this correct?" tends to agree. A gate asked "defeat this" finds the hole. On one
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
