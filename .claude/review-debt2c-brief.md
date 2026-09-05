# Review — #750 pin-guard input-existence (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/pin-guard-inputs-exist, branch
fix/pin-guard-inputs-exist vs origin/main. Report: <worktree>/.claude/impl-debt2c-report.md.
Attack: (1) run scripts/verify-action-pins.mjs end-to-end yourself (it hits the real GitHub API
— fine); real workflows must PASS; (2) the mutation: a wrong input name in a scratch copy reds
— reproduce the implementer's proof AND design one dodge of your own (an input passed via
matrix/env indirection? a composite action's nested inputs? an action with NO inputs block —
absent-inputs semantics must fail-closed or be explicitly allowlisted, not silently pass);
(3) unreachable-API-is-failure preserved for the NEW fetch path (action.yml fetch failing must
FAIL, not pass — mutation-prove by pointing at a bogus ref); (4) the division of labour intact
(PR-time form test unchanged — diff check); (5) annotated-tag dereference still correct on the
new path. Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt2c.md, stop.
