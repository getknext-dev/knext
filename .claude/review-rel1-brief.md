# Review — #798 rotate-cred gateway host + hold re-dial (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/rel1, branch fix/rotate-cred-gateway-host,
commit 707f547 vs origin/main. Report: <worktree>/.claude/impl-rel1-report.md.
**If you hit a Fable 5 usage limit: /model opus and continue.**

This is a data-plane-outage bug: a routine credential rotation could rewrite a working DSN to an
unresolvable host on any cluster with a custom gateway service name.
Attack: (1) BOTH writers in provision-app.sh AND gen-secrets.sh honour APPDB_GATEWAY_HOST —
mutation-prove EACH independently (revert one writer ⇒ red; revert the other ⇒ red; a
one-writer-only fix passing is the repo's classic half-fix and the exact thing to hunt);
(2) precedence matches the OPERATOR's resolution exactly — read the operator's code and compare
(divergence between the two IS the bug class); (3) the rooted-FQDN discipline survives (trailing
dot on the default; a custom override must not be silently re-rooted or double-rooted — try
values with and without the trailing dot); (4) empty-string and whitespace override values —
fail-closed or documented, never a silent fallback to a wrong host; (5) the hold re-dial
coverage: does the new test actually exercise a rotation under a held session, and does it red
when re-dial is broken? Mutation-prove it; (6) _validate.sh's contracts still pass (it aggregates
now — run it).
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-rel1.md, first line APPROVE or
ISSUES_FOUND, then stop.
