# Spec review — optional storage vs the design gate + ergonomics row 3b

Read-only + scratch runs. Does feat/optional-storage (worktree
/Users/banna/alpheya/pocs/knext-wt/feat-optional-storage, diff vs merge-base with origin/main)
deliver what the design gate PROCEEDed (/Users/banna/alpheya/pocs/knext/.claude/architect-design-storage.md)
and what ergonomics-ledger row 3b measured as the wall?

Judge EMPIRICALLY as the zero-k8s persona: in a scratch dir, run the worktree's create (bun or
node the entry), read the scaffolded kn-next.config.ts — is storage commented-out with a plain
growth path? Is the parting line the persona's real next steps? Then the config wall itself:
with the scaffold UNTOUCHED except a registry, does validate/deploy --dry-run accept it (no
storage)? Is the announced mode's wording honest about the trade (no CDN, no cross-deploy asset
retention) in words the persona understands? ADR-0047: does its decision text match what the
code does (the repo's recurring claims-ahead-of-code defect — verify each Consequence against
the tree)? Scope honesty: anything in the diff beyond the six conditions?

Verdict → /Users/banna/alpheya/pocs/knext/.claude/spec-review-ux5.md, first line APPROVE or
ISSUES_FOUND, then stop.
