# Review brief — placeholder preflight + validate routing (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/feat-placeholder-preflight, branch
feat/placeholder-preflight, commit 0b31428 vs origin/main (rebased; diff origin/main...HEAD).
Spec: ergonomics ledger row 4 (on main). Implementer report: <worktree>/.claude/impl-ux6-report.md
— read its "judgment calls" section and judge each call.

Attack:
1. The generic placeholder scan: is it truly generic (walks the config object) or enumerated?
   Dodge attempts: a placeholder in a NESTED array; in a numeric-ish field; `<...>` appearing
   LEGITIMATELY in a value (a URL with <>-encoded chars? a regex in config?) — false-positive
   risk is as real as false-negative here; the storage-absent case (valid post-#825) must not
   trip it.
2. `validate` verb: run it in scratch — no config, placeholder config, valid config, and a
   CLUSTER-off environment (must not need kubectl). Help lists it? Allowlist accepts it?
   did-you-mean for `validat`? The dist-bin tests cover it?
3. The base-branch guards: dispatcher-scan, inverted error guard, no-storage announcements —
   all still green? Run the package suite yourself.
4. The deps-missing error (4c): trigger it for real (no node_modules) — both streams, no stack.
5. Mutation-prove at least: disable the preflight ⇒ red; remove validate from COMMAND_GROUPS ⇒
   red (help AND allowlist halves); your own adversarial mutation of the scan.
6. cli.mdx + ADR-0046 Amendment 1: claims vs tree (the repo's recurring defect).

Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-ux6.md, first line APPROVE or
ISSUES_FOUND, then stop.
