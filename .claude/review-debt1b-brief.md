# Review — validator aggregate + fsGroup fix (#797/#793), adversarial

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/validate-aggregate, branch
fix/validate-aggregate vs origin/main. Report: <worktree>/.claude/impl-debt1b-report.md.
Attack: (1) run _validate.sh yourself — all contracts must execute even with early failures;
MUTATE both halves (break an early file AND a late file → ONE run reports BOTH, exit non-zero;
then all-clean → exit 0); (2) set -e semantics — a command failing INSIDE a check must not
abort the loop silently (try one); (3) the fsGroup YAML fix — strict-parse the manifest
(python yaml.safe_load or yq) and verify the Prometheus Deployment's securityContext is what
the values intend (not just de-duplicated arbitrarily); (4) exit codes CI-faithful (the CI
lane consuming this script still gates); (5) no check weakened to make aggregation pass.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt1b.md, stop.
