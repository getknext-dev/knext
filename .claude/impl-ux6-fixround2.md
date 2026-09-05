# Design-gate fix round — env carve-out (architect BLOCK, one narrow issue)

Read the `## The block` section of `.claude/architect-signoff-ux6.md` and implement exactly its
smallest change:

1. Exclude `config.env` (the free-text `Record<string,string>`) from the placeholder scan's
   HARD-FAIL path — either skip it entirely or downgrade env hits to a non-fatal warning line
   listed under the findings. Pick one and justify the choice in a code comment (the gate's
   principle: a confidently wrong hint is worse than none; a schema-valid env value like
   `ALLOWED_TAGS: "<b><i>"` must not make a deploy refusable with no escape).
2. Keep the generic walk everywhere else — one type-level carve-out of a free-text map is not a
   return to enumeration; the existing dodge tests and mutation M2 must stay meaningful.
3. Add the matching dodge test: an `env` value containing angle-bracket markup → deploy proceeds
   past preflight (and, if you chose warn-tier, the warning appears on the right stream).

Logistics: your worktree HEAD is already the rebased-onto-main state (`0b31428` — verify with
`git log --oneline -1`); apply the fix on top. Suite + package tsc + biome green, commit
`--no-gpg-sign`, then push the branch. Append the outcome to `.claude/impl-ux6-report.md`
(worktree), including the new mutation/dodge runs.
