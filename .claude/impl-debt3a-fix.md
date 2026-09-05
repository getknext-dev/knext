# Fix round — #753 gate relations (review-debt3a ISSUES_FOUND)

Read `.claude/review-debt3a.md` IN FULL in the main repo. Your worktree:
/Users/banna/alpheya/pocs/knext-wt/gate-relations (branch fix/gate-file-unread-relations, pushed).
**If you hit a Fable 5 usage limit: /model opus and continue.**

The reviewer ran everything rather than reading it, and the verdict is precise: rule 6's
closed-world scan over UNDECLARED keys is genuine and generative — keep it. The relational layer
built on top (7/8/8b/8c/9a/9c/9d/10/11) is ENUMERATION and it was defeated with two new
contradictions built entirely from REGISTERED keys. Worse: rule 6's headline guarantee has a
one-line bypass THE SHIPPED TREE ALREADY EXERCISES (`read('<any label>')` is a third door), and
rule 6b — the guard meant to close that bypass — is DECORATION: all three of its halves were
deleted and the suite stayed green.

Fix, in the reviewer's own priority order (B1 first):
1. Close the `read('<label>')` third door so rule 6's stated guarantee is TRUE, and make rule 6b
   load-bearing — delete each half and watch it red, individually.
2. Convert the relational layer from enumeration to a genuine scan wherever possible: the test is
   the reviewer's — a NEW contradiction built from registered keys that nobody enumerated must
   FAIL. If some relation genuinely cannot be scanned, say so explicitly in the code comment AND
   the report, and narrow the claim rather than overstating it (this repo's rule: a guard that
   states more than it checks is worse than one that states less).
3. Every remaining reviewer finding (see its Blocking / Should-fix sections).

Mutation-prove EVERY guard you touch, each half independently, exit-code branched, worktree
restored and verified clean after each. Re-run the reviewer's own two contradictions and show them
failing. Suite + biome green. Commit --no-gpg-sign, push. Append results to
.claude/impl-debt3a-report.md including an honest statement of what is scanned vs enumerated.
