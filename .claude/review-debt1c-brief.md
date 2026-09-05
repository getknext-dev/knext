# Review — fs.watch flake fix (#805), adversarial

Defeat it. Worktree: the knext-wt dir holding branch fix/image-cache-sync-watch-flake (find via
git worktree list from /Users/banna/alpheya/pocs/knext). Diff vs origin/main. Report:
<worktree>/.claude/impl-debt1c-report.md — READ its root-cause verdict (test bug (a) vs impl
bug (b)) and judge whether the EVIDENCE supports the verdict, not just the fix.
Attack: (1) re-reproduce the ORIGINAL flake on origin/main (loop the test 20x, count failures —
if you cannot reproduce at all, say so and weigh what that does to the fix's evidence); (2) run
the FIXED test 50x by exit code — zero failures required; (3) if verdict was (b) impl-bug: the
red-first deterministic test — mutation-prove it (revert the impl fix ⇒ red); if (a) test-bug:
verify the fix is a real readiness handshake, not a lengthened sleep (a sleep just moves the
race); (4) the watch impl's behavior unchanged for the non-race path (package suite green);
(5) any OTHER test in the repo using the same racy pattern (grep fs.watch across tests — same
class elsewhere?). Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt1c.md, stop.
