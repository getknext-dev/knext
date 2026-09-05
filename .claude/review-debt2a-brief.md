# Review — #835 bun-bytecode test flake (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/fix-bun-bytecode-test-flake, branch
fix/bun-bytecode-test-flake vs origin/main. Report: <worktree>/.claude/impl-debt2a-report.md —
verdict claimed (a) test bug ("the implementation does not leak"), 2/3 reproduction under load.
Attack: (1) the verdict itself — the #805 trail taught that (a)-vs-(b) is exactly where a real
production bug hides behind "just a test bug"; independently establish the count-based failure's
mechanism (what increments the counter, who else can, is it genuinely test-local isolation or a
shared-state leak in the implementation that only tests observe?); (2) reproduce the ORIGINAL on
origin/main under the load profile the report used — confirm the 2/3 rate or correct it; (3) run
the FIXED test 30x+ in the same load profile, exit-code-branched — zero failures; (4) the fix
shape: no sleeps, no retries-until-pass, no test weakened (diff the assertions — a lowered
expectation is a red flag); (5) any sibling test using the same pattern (grep the counter/tmpdir
idiom) — same class elsewhere? (6) suite + tsc + biome green, run yourself.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt2a.md, stop.
