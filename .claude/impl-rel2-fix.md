# Fix round — compat-gate honesty (review-rel2 ISSUES_FOUND)

Read `.claude/review-rel2.md` in the main repo IN FULL, then fix all five findings in your
worktree `/Users/banna/alpheya/pocs/knext-wt/rel2` (branch fix/compat-gate-honesty).
**If you hit a Fable 5 usage limit: /model opus and continue.**

Good news first: the reviewer re-derived the evidence from raw artifacts independently and the
HEADLINE CLAIM SURVIVES (28 node nights, 778/0/0 except 08-03, runAttempt:1 on all — zero
re-runs; longest fingerprint-stable streak 7). The defects are in the supporting machinery, and
they matter because this row is the evidence for a public-release blocker.

1. **`fetchLedgers` silently drops runs, and a dropped night MERGES two streaks** — a dropped
   run must be a hard failure or an explicitly-recorded gap, never silently bridged (a merged
   streak overstates stability, the exact direction that flatters us).
2. **"byte-identical" is falsified by the table three lines above it** — fix the claim to match
   the data.
3. **The restart arithmetic does not match the script it says produced it** — make the numbers
   the script's output, not hand arithmetic (the ledger rule: medians/counts come from the
   instrument verbatim).
4. **The prescribed remedy is narrower than the measured cause** — widen it to what the evidence
   actually shows, or state the gap explicitly.
5. **`met` reads `longest` while `shortfall` reads `current`** (compat-window-audit.mjs:257-258).

Mutation-prove each guard you touch (a dropped-run must red; a merged-streak must red). Re-run
the audit script end-to-end and paste its real output into the report. Commit --no-gpg-sign, push.
Append the fixes + mutation results to `.claude/impl-rel2-report.md`.
