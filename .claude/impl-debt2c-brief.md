# Debt 2c — #750: pin guards don't check that the inputs we pass still exist

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/pin-guard-inputs-exist` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR.

Read #750 (gh issue view 750). The gap: action pins are verified for form/scope/SHA↔tag, but
nothing checks that the `with:` inputs we pass still EXIST in the pinned action's action.yml —
a renamed/removed input is silently ignored by GitHub, so a security-relevant input (e.g.
fail-on-severity) could evaporate on a bump. Fix per the issue's own framing: extend
scripts/verify-action-pins.mjs (the nightly resolver — it already fetches from the canonical
repo) to ALSO fetch the pinned commit's action.yml and diff our passed inputs against its
declared inputs; unknown-passed-input = FAIL. Same rules as the nightly: unreachable API is a
FAILURE never a pass; annotated tags dereferenced (already handled). Mutation-prove: a
deliberately wrong input name in a scratch workflow copy reds the checker; the real workflows
pass. Keep the PR-time form test unchanged (division of labour is deliberate). vitest for any
new logic; node the script end-to-end. Report → worktree .claude/impl-debt2c-report.md.
