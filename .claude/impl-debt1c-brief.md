# Debt iteration 1c — #805: the fs.watch race flake (~1/3 of full-suite runs)

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/image-cache-sync-watch-flake` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR.

Read issue #805 (gh issue view 805) and the failing test (find image-cache-sync-watch in
packages/kn-next). ROOT-CAUSE the race, don't paper it: is it (a) the TEST racing fs.watch
registration vs the first write (test bug — fix with a readiness handshake/poll, never a bare
sleep), or (b) the WATCH IMPLEMENTATION missing events that land between dir-scan and
watcher-attach (real bug — a user's cache-sync could miss files; fix the impl with a
post-attach rescan or equivalent)? The issue says ~1/3 full-suite failure rate — REPRODUCE
first (loop the test file 20x, count), fix, then prove the fix with 50 consecutive green runs
(exit-code-branched loop, report the count). If it is (b), TDD: a deterministic test that
forces the gap (write between scan and attach) red-first. Mutation-prove any new guard. Suite +
tsc + biome green. Report → worktree .claude/impl-debt1c-report.md with the root-cause verdict
(a) or (b) and both loop counts.
