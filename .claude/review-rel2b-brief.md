# Review round 2 — compat-gate honesty fixes (release blocker 3)

Worktree /Users/banna/alpheya/pocs/knext-wt/rel2, branch fix/compat-gate-honesty. Round-1 review
is .claude/review-rel2.md (ISSUES_FOUND, five findings); the fix commits are 28607dd + 6574d5a on
top. Implementer report: <worktree>/.claude/impl-rel2-report.md (§8.x covers this round).
**If you hit a Fable 5 usage limit: /model opus and continue.**

Verify each round-1 finding is genuinely fixed, by execution not by reading:
1. **fetchLedgers silent drop / streak merge** — the important one. Mutation-prove BOTH: a dropped
   run must hard-fail or record an explicit gap, and it must NOT bridge two streaks into one
   (inject a missing run; the streak must not lengthen). This flatters us if wrong.
2. **byte-identical claim** corrected to match the table.
3. **restart arithmetic** now emitted BY the script, not hand-computed — re-run the audit and
   diff its real output against the doc.
4. **remedy widened** to the measured cause.
5. **met/shortfall** reading the same field (compat-window-audit.mjs ~257-258).
Also: the report claims NO quarantine entry was added/removed/edited and no workflow/manifest
change — verify from the diff. And confirm the headline numbers are unchanged (longest streak 7,
current 2/14, 26 of 27 nights 778/0/0, zero re-runs) — the fixes should change trustworthiness,
not the values.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-rel2.md as a '# Round 2' section
(first line APPROVE or ISSUES_FOUND), then stop.
