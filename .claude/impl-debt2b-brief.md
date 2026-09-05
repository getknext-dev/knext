# Debt 2b — #744: the default-on NetworkPolicy is unobservably inert on flannel

Repo /Users/banna/alpheya/pocs/knext. Branch `feat/netpol-inert-observability` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR.

Read #744 (gh issue view 744) and the context: the operator reconciles a default-on NetworkPolicy
(spec.security.networkPolicy, #90; ADR-0044 port-restricted), but flannel (OKE GA, OrbStack)
ships NO NetworkPolicy controller — the policy is declarative-only and NOTHING observes that. A
security posture that silently doesn't hold. Build the observability BOTH places the issue names:
(1) `kn-next doctor`: a check that detects whether the cluster's CNI enforces NetworkPolicy —
    detection strategy is yours to research (calico/cilium/weave presence signals; the honest
    fallback is 'cannot determine — treat as unenforced'); output in the persona-friendly doctor
    style with the flannel caveat. NO active probe pods from doctor (read-only contract).
(2) The operator: a status condition on the NextApp (computeStatusVerdict in status_verdict.go
    per the hard rule — NEVER new branches in Reconcile) that reports NetworkPolicyEnforcement
    unknown/likely-unenforced/enforced based on the same signals, honest about its confidence.
CAUTION — gates: if you touch the CRD (new condition TYPE is status-only, no schema change; do
NOT add spec fields) note it in your report; the mechanical trigger fires on api/ paths and the
lead summons the design gate at PR time. TDD both halves; mutation-prove; envtest for the
condition; go test + vitest + tsc + biome green.
Report → worktree .claude/impl-debt2b-report.md.
