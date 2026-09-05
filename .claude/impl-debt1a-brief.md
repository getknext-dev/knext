# Debt iteration 1a — #804: apps/file-manager under a typecheck gate

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/fm-typecheck-gate` from origin/main, isolated
worktree (git worktree add ../knext-wt/fm-typecheck-gate fix/fm-typecheck-gate — create under
/Users/banna/alpheya/pocs/knext-wt/). Commit --no-gpg-sign, push when green, no PR.

Read issue #804 (gh issue view 804) — apps/file-manager is in NO typecheck gate, real TS errors
ship invisibly. The repo's contract test packages/kn-next/src/__tests__/ci-typecheck-contract.test.ts
enforces: every TS workspace member is COVERED (typecheck script + its own ci.yml step) or
DOCUMENTED-EXCLUDED. fm is presumably documented-excluded or a gap — read the test to see which,
then CONVERT it to covered: add a typecheck script to apps/file-manager (tsc --noEmit against its
tsconfig — fm is a Next app; you may need a tsconfig.typecheck.json excluding .next/ and handling
next-env.d.ts), fix EVERY TS error that surfaces (the issue exists because there likely are some
— fix them properly, no ts-ignore carpet), add the ci.yml step, update the contract test's
records. TDD where fixes are behavioral. Suite + biome green; the new fm typecheck itself green.
Report → worktree .claude/impl-debt1a-report.md (DONE/BLOCKED, list every TS error found+fixed).
