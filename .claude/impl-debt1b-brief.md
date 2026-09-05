# Debt iteration 1b — #797 validator early-death + #793 dup fsGroup

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/validate-aggregate` from origin/main, isolated
worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when green, no PR.

Read issues #797 and #793 (gh issue view). #797: scale-zero-pg's _validate.sh dies on the first
failing file (88-loadsoak-k6.yaml) so every later contract is silently unenforced — the repo's
named decorative-guard class. Fix: run ALL contracts, aggregate failures, fail at the end with a
per-file report (mind set -e semantics); mutation-prove BOTH halves (a failure in an early file
AND one in a late file must each red the script, and both must be REPORTED in one run). Fix the
88-loadsoak-k6.yaml problem itself (#793's duplicate fsGroup key in the Prometheus Deployment
securityContext is likely the very failure — fix the YAML, strict-parse it to prove). Keep the
script's exit codes CI-faithful. Report → worktree .claude/impl-debt1b-report.md.
