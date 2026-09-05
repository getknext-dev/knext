# Review — #753 gate-file unread relations (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/gate-relations, branch
fix/gate-file-unread-relations, commit f10bb76 vs origin/main. Report:
<worktree>/.claude/impl-debt3a-report.md — it claims a SECOND live instance beyond the two #753
named, and an enumeration of previously-unchecked relations (R1…), with some deliberately left
unchecked as "declared PROSE". **If you hit a Fable 5 usage limit: /model opus and continue.**

Attack:
1. **SCAN vs ENUMERATION** — the decisive question. Invent a NEW contradictory relation the file
   could state (one NOT in the report's R-list and NOT among #753's two instances) and check
   whether the new checker fails it. If only the enumerated cases fail, this is the repo's
   signature defect wearing a fix's clothes — say so plainly.
2. The "declared PROSE, deliberately unchecked" carve-out: can a real contradiction hide there?
   Try putting a contradictory assertion inside a $comment-like field and see if it passes.
3. Independently re-run its mutations (its harness is <worktree>/.claude/mutate-gate-rules.mjs —
   read it, then run YOUR OWN mutation too, exit-code branched, worktree restored+verified after).
4. Was any EXISTING rule weakened to make the new ones fit? Diff rules 1-6 carefully.
5. The second live instance it found: verify it was genuinely live on main before the fix (not
   an artifact of its own edits), and that the fix actually closes it.
6. Suite + biome green; run them yourself.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt3a.md, first line APPROVE or
ISSUES_FOUND, then stop.
