# Debt 2a — #835: the reproducible cli-build-bun-bytecode flake (2/3 full-suite)

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/bun-bytecode-test-flake` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR.

Read #835 (gh issue view 835) and packages/kn-next/src/__tests__/cli-build-bun-bytecode.test.ts:248
('expected +0 to be 1'). Discipline exactly as the #805 trail: (a)/(b) verdict — test bug vs real
impl bug. REPRODUCE FIRST: full-suite context flakes 2/3 but solo may be green — find the
INTERACTION (parallel workers sharing a tmpdir? env leakage? a counter reset by another file?).
Then root-cause, fix properly (a real handshake/isolation, never a sleep or retry-loop), prove
with 20+ full-suite-context runs by exit code, mutation-prove any new guard. If it is (b) — a
real bytecode-build bug — TDD red-first. Suite + tsc + biome green.
Report → worktree .claude/impl-debt2a-report.md with the verdict and both loop counts.
