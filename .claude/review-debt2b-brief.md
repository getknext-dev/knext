# Review — #744 netpol-inert observability (adversarial)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/netpol-inert, branch
feat/netpol-inert-observability vs origin/main. Report: <worktree>/.claude/impl-debt2b-report.md.
Attack BOTH halves + the contract:
(1) doctor's CNI-enforcement detection: what signals does it read? Attack each — a cluster with
    Calico installed but crashed; Cilium in a nonstandard namespace; NO recognizable CNI (must be
    'cannot determine — treat as unenforced', never a false 'enforced'). The read-only contract:
    prove doctor creates NOTHING (no probe pods) — scan the diff for kubectl create/apply/run.
(2) the operator condition: in status_verdict.go per the hard rule (NEVER new Reconcile branches
    — verify by diff); envtest covers unknown/likely-unenforced/enforced transitions; the
    condition TYPE is status-only (no spec/CRD schema change — check api/ diff; if any spec field
    was added, that is a BLOCK-and-summon-gate finding, flag loudly).
(3) honest-confidence wording: does 'enforced' ever claim more than the signals support? (A CNI
    present ≠ policies enforced for THIS namespace.) The flannel caveat in doctor's output.
(4) Mutation-prove: inert the detection (always-enforced stub) ⇒ which tests red? Both halves?
(5) go test + envtest + vitest + tsc + biome green, run yourself.
Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-debt2b.md, stop.
