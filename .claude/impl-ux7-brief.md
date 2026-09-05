# Iteration-7 brief — "Your first cluster" docs page (ergonomics row 5)

Repo /Users/banna/alpheya/pocs/knext. Branch `docs/first-cluster-onramp` FROM
`feat/optional-storage` (stacked — PR #825 pending; getting-started.mdx collides otherwise).
Isolated worktree, commit --no-gpg-sign, push when green, no PR.

Spec: docs/ux/ergonomics-ledger.md row 5 (on main). Persona: zero cloud/k8s knowledge. The docs
site is USER-FACING: no ADR numbers, no issue/PR numbers, no internal jargon (house rule).

1. New page `apps/docs/content/docs/first-cluster.mdx` (check meta.json ordering conventions and
   add it near getting-started): local-first — a laptop cluster via kind (the path the repo's own
   integration scripts use — READ scripts/e2e-*.sh or the kind setup the integration gate runs to
   get the REAL steps: kind create, Knative Serving install incl. the net layer, the knext
   operator install command from install.mdx) — each step one command + one plain sentence of
   what it does. Then "when you outgrow the laptop": handoff links to gke/eks/aks/oke/openshift
   pages. Honest scoping: local clusters sleep with the laptop; NetworkPolicy is declarative-only
   on kind's default CNI (hardening.mdx phrasing precedent).
2. getting-started.mdx prerequisite line: "A Kubernetes cluster with Knative Serving installed
   (**don't have one? [Your first cluster](/docs/first-cluster)**)" — mind the base branch's F2
   edits to the same region; integrate, don't clobber.
3. VERIFY the commands: run the kind + Knative + operator install sequence LOCALLY (kind is
   available; OrbStack k8s as fallback) far enough to prove the commands are copy-paste correct
   — a docs page whose commands were never run is the docs-guard's cardinal sin. Capture doctor
   green (or its honest state) at the end. If full verification is impossible, mark exactly which
   steps ran and which did not in your report — never imply verification that didn't happen.
4. The docs build (apps/docs) must pass; any docs-link checker in CI must pass.
Report → worktree .claude/impl-ux7-report.md, first line DONE or BLOCKED, with the verification
transcript summary.
