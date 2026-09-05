# Review brief — "Your first cluster" page (iteration 7), docs review

Judge as BOTH docs-guard and the zero-k8s persona. Worktree
/Users/banna/alpheya/pocs/knext-wt/docs-first-cluster-onramp, branch docs/first-cluster-onramp
(one commit 8ed0c48 vs origin/main). Implementer report (READ IT — its verification transcript
defines what was and wasn't proven): <worktree>/.claude/impl-ux7-report.md.

1. Command truth: every command on the page vs the report's live transcript — anything on the
   page the transcript did NOT run must be flagged or marked in-page. The operator step failed
   live on two pre-existing release-infra gaps (private ghcr package; amd64-only image) — does
   the PAGE handle that honestly for a reader today (does it promise doctor-green it cannot
   deliver until those are fixed)? A page shipping a known-broken step without a caveat fails
   docs-guard; judge what it says.
2. Persona read: plain language, one sentence per step, no unexplained jargon (CRD? ingress?),
   honest local-cluster scoping (sleeps with the laptop; NetworkPolicy declarative-only).
3. House rules: NO ADR/issue/PR numbers anywhere in the page or edited pages.
4. getting-started.mdx integration: the prereq line links the new page without clobbering the
   optional-storage edits (diff context).
5. meta.json ordering + all internal links resolve; docs build green (re-run it).

Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-ux7.md, first line APPROVE or
ISSUES_FOUND, then stop.
