# Review brief — iteration 3 (doctor no-cluster guidance), adversarial

You are the adversarial code reviewer for knext ergonomics-loop iteration 3. **Defeat this change,
don't confirm it.** Read-only on sources; you may build/run in the worktree and use scratch dirs.

- Worktree: `/Users/banna/alpheya/pocs/knext/.claude/worktrees/ux3-doctor-no-cluster`
- Branch `feat/ux-doctor-no-cluster`, commit `df9bbd2`, stacked on `feat/ux-guided-first-contact`
  (diff it as `git diff 33de434..df9bbd2` — review ONLY df9bbd2's changes).
- Implementer report: `<worktree>/.claude/impl-ux3-report.md` (verify its claims, don't trust them).
- Spec: finding **1c** in `docs/ux/ergonomics-ledger.md` (branch `measure/ux-ergonomics-ledger-row1`,
  also merged to main via PR #809). Persona: zero cloud/k8s knowledge.

## Attack surfaces
1. **State classification.** Three no-cluster states (no kubeconfig file; empty config/no
   current-context; connection-refused to a LOCAL apiserver) vs a genuine remote flake. Attack the
   boundaries: KUBECONFIG pointing at a directory; a config whose current-context names a context
   that doesn't exist; refused on a non-standard loopback spelling (`[::1]`, `127.0.0.2`,
   `localhost:8080`); a DNS-failing remote host (must stay flake, NOT "no cluster"); a proxied/
   in-cluster setup. Any misclassification that tells a REAL cluster owner "you have no cluster"
   is worse than the original bug — weigh it accordingly.
2. **The iteration-2 conventions on the base branch.** Friendly write-and-exit only, both output
   streams (pino FATAL goes to STDOUT), no bare `throw new Error(` (the inverted scan guard —
   check the implementer worked WITH it, not via allowlist abuse).
3. **Docs URL.** The pointer must be a real URL the repo/docs actually use — verify, don't assume.
4. **Mutation-prove the new tests yourself**: disable the classification (make everything a flake
   again) and confirm the suite reds; try one guard-dodge of your own design.
5. **Run the real CLI** for all four states in the report's Before/After section and compare with
   its claimed outputs verbatim.

## Verdict
Write to `/Users/banna/alpheya/pocs/knext/.claude/review-ux3.md` (main repo, NOT the worktree).
First line: `APPROVE` or `ISSUES_FOUND`. Then stop — do not fix anything yourself.
