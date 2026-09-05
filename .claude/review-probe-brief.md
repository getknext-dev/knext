# Review brief — operator aggressive-readiness-probe fix (adversarial)

Defeat this change. Worktree: /Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-a14d312aac5ba53f4
Branch fix/operator-aggressive-readiness-probe (commits e15d715 red + 843f2bc green) vs origin/main:
`git diff origin/main...HEAD`. Implementer report: <worktree>/.claude/impl-probe-report.md.

Context: measured on OKE (n=6/arm, same image/env): the operator's stamped ReadinessProbe
{InitialDelaySeconds:2, PeriodSeconds:3} costs ~1.2s median per cold start vs Knative's aggressive
default (5723ms vs 4562ms; probed arm's container→Ready lands ONLY on grid values 2000/3000/5000ms).
Fix: readiness probe = HTTPGet(healthPath, port) with ALL timing fields omitted (Knative treats
periodSeconds==0 as its aggressive mode); liveness kept as-is with rationale.

Attack:
1. The Knative validation claims — the report cites serving v0.48.0 k8s_validation.go L828-842
   (periodSeconds==0 special mode; non-zero failureThreshold/timeoutSeconds REJECTED when period=0)
   and revision_defaults.go:179-184. Verify against the module in the worktree's go.mod cache
   yourself. Confirm the test really runs Knative's own SetDefaults + ValidateUserContainer over the
   stamped container (not a copy of it).
2. Drift/upgrade hazards: what happens on a cluster running OLDER Knative where the aggressive-mode
   contract differs? Is there any path where the operator's ksvc apply now gets REJECTED by the
   webhook (that would break every deploy, not slow it)?
3. The liveness probe reasoning — is keeping initialDelay:5/period:10 sound, and does the comment
   distinguish the two correctly?
4. Mutation-prove the guards yourself: restore period:3 ⇒ red? httpGet→tcpSocket ⇒ red? zero the
   liveness timing ⇒ red? (Report claims all three; verify at least two, exit-code-branched.)
5. Any OTHER probe-stamping site in the operator or CLI the fix missed (scan for ReadinessProbe/
   readinessProbe across the repo — a second stamping site that still writes period:3 would undo
   the win for some path).
6. go test ./... green in packages/kn-next-operator (KUBEBUILDER_ASSETS may be needed — the report
   says envtest ran; find the assets path it used).

Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-probe.md (main repo). First line APPROVE
or ISSUES_FOUND. Then stop.
