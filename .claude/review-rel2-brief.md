# Review — compat-gate honesty (#545/#710), release blocker 3 (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/rel2, branch fix/compat-gate-honesty
(commits 27d62c7 + d17abd6) vs origin/main. Report: <worktree>/.claude/impl-rel2-report.md.
**If you hit a Fable 5 usage limit: /model opus and continue.**

This is a RELEASE BLOCKER's diagnosis and it makes a strong claim — that blocker 3 is
"two-thirds wrong on the evidence": #545's shard-flakiness is FALSE for the credential lane (27
fingerprinted node nights, zero lost to test failure, zero re-runs), #710's bun red is TRUE and
honestly so (deterministic Bun ≤1.3.14 gaps, matrix already ❌), and the real obstruction is
HARNESS-FINGERPRINT CHURN (9 restarts in 27 nights, longest streak 7/14).

Attack: (1) the ledger reconstruction — re-derive the night table from the compat-run-ledger
artifacts YOURSELF for a sample of runs and check the lane attribution really comes from the
ledger's `lane` key, not cron timing; (2) the "zero lost to test failure" claim — is a night
that lost a shard to infrastructure being counted as passing anywhere? (the report says a
harness fix now grades it as failed — verify that fix and mutation-prove it); (3) the
DO-NOT-QUARANTINE calls (items 1-3) — is refusing to quarantine a permanent gap the right
reading of ADR-0007 §c.2, and does the matrix now state the bun gaps honestly (check the
'canary-only pre-release noise' correction landed)? (4) the fingerprint-churn claim — what
actually restarts the streak, and is the 14-night gate's definition itself the problem? (5) any
change that makes the gate LOOK better without being better (the cardinal sin here); (6) run
the new script and the affected tests yourself.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-rel2.md, first line APPROVE or
ISSUES_FOUND, then stop.
