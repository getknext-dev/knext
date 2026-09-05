# Iteration-6 brief — placeholder preflight + route validate (ergonomics row 4)

Repo /Users/banna/alpheya/pocs/knext. Branch `feat/placeholder-preflight` FROM
`feat/optional-storage` (stacked — it is open as PR #825 and will squash-merge; the lead rebases
your branch onto main afterward). Isolated worktree (git worktree add), commit --no-gpg-sign,
push when green, do NOT open a PR.

Spec: docs/ux/ergonomics-ledger.md row 4 (on main). Persona: zero cloud/k8s knowledge.

1. **Fail-fast placeholder preflight (4b).** Before ANY build step, deploy detects
   `<...>`-shaped placeholder values in config fields (registry, storage.* when present, any
   string field — scan the config object generically rather than enumerating fields; the repo
   rule is scan-over-enumerate) and exits 1 with a per-field plain-English message: what the
   field is in one sentence, what to put there, docs link. Uses the friendly write-and-exit
   path (UsageError family), never FATAL. Mind the base branch: storage may be ABSENT (that is
   valid post-#825) — absent storage is NOT a placeholder error.
2. **Route `validate` (4a).** Add it to the dispatch contract (COMMAND_GROUPS — one list drives
   help AND allowlist; note ADR-0046) under a sensible group; validate runs config load +
   placeholder preflight + the schema checks WITHOUT cluster access, plain output, exit 0/1.
   Check src/cli/validate.ts's current shape — reuse, don't rewrite; if its behavior diverges
   from this description, reconcile deliberately and say so.
3. **4c if cheap:** the `next: command not found` build failure becomes a plain message
   ("dependencies not installed — run npm install first"), no stack.

TDD; both output streams asserted; mutation-prove new guards (incl. one adversarial dodge of
your own design against the generic placeholder scan); the dispatcher-scan and inverted
error-guard tests from the base branch must still pass — work WITH them. cli.mdx + ADR-0046
touch-ups where the surface changes (this fires the CLI-surface trigger — the lead summons the
gate at PR time; note it in your report). Suite + tsc + biome green.
Report → worktree .claude/impl-ux6-report.md, first line DONE or BLOCKED.
