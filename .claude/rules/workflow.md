# Delivery workflow (knext)

The standing pipeline for any non-trivial change. Complements `architecture.md` (how to design),
`security.md` (what is never acceptable), and `scs-zones.md` (where the boundaries are).

Until now this lived only in session context, which is why its last step kept being skipped.

## The pipeline

1. **Plan** — architect + system designer, *before* implementing. Both pinned to Opus; subagents
   otherwise inherit the session model and silently downgrade on a task where judgement is the
   product. Skip only for changes with no design content (a generated version bump, a Dependabot
   PR, a typo).
2. **Implement — TDD.** Failing test first, for the reason you expect it to fail. Then make it pass.
3. **Verify on OKE** for any feature or critical update. Standing requirement, not optional.
4. **Review** — code review *and* spec review, in parallel.
5. **Sign off** — architect *and* system designer, both Opus-pinned. A gate returning `BLOCK` or
   `ISSUES_FOUND` means another round, not a judgement call about whether it matters.
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
