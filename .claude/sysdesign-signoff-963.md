# System-Designer gate — PR #963 (metrics port 9091 → 9464, closes #951)

Scope: the operator's reconciled default NetworkPolicy only. Read-only review of
`gh pr diff 963` (operator portions), ADR-0044 + Amendments 1/4, `.claude/rules/security.md`,
S3-V Finding C-2.

## VERDICT: SIGN-OFF, with 2 blocking-on-merge conditions (both non-code).

## 1. Is it port-number-only? — YES, verified.

`desiredIngressRules()` diff is a literal swap of `appMetricsPort`
(`int32(knativenetworking.UserQueueMetricsPort)` → `int32(9464)`). Unchanged:
- rule count (3): knative-system/ingress peers, same-namespace, label-gated cross-namespace;
- all `From` peers — no selector widened, no new rule;
- the cross-namespace grant is still `NamespaceSelector: knext.dev/metrics-scrape` explicit
  (test still asserts a non-empty selector), still **`ConsistOf(9464)` only** — queue-proxy's
  9090 still deliberately excluded, still narrower than the same-namespace rule;
- same-namespace rule still `ConsistOf(9090, 9464)` — 2 ports, not 3;
- `:3000` still asserted ABSENT; `EndPort` still asserted nil (no port ranges);
- the "and nothing else" closed-allowlist assertion is intact.

No new grants. Both halves of every guard still asserted.

## 2. Threat model — strictly narrower, in one direction only.

9091 *is* queue-proxy's `UserQueueMetricsPort`, bound on a stock serving install
(`metrics.request-metrics-backend-destination` default) — that is bug #951 itself. So the OLD
policy's 9091 grant did in fact cover **queue-proxy's own user-metrics server**, cross-namespace
to any labelled namespace, unintentionally. That grant is now gone. 9464 (OTel Prometheus
exporter convention) is bound by no queue-proxy listener — verified against the enumerated
queue-proxy port set (8012/8013/8022/8112/9090/9091), which the widened lockstep guard now
encodes as `QUEUE_PROXY_OWNED_PORTS` and asserts the shared port is not a member of.

Direction: **narrowing.** Cost: a same-namespace Prometheus loses Knative *request* metrics on
9091 on a policy-enforcing CNI. That is a visibility loss, not an access gain — acceptable, but
it is a real consequence and belongs in the ADR amendment (condition 1).

## 3. Upgrade order (#548) — fails closed in both skew directions.

- new runtime + old operator: app binds 9464, policy admits 9091 → scrape denied. Closed.
- old runtime + new operator: app binds 9091 (pre-existing collision), policy admits 9464 →
  9464 unbound, nothing reachable. Closed.

Neither skew makes the policy target a port that grants *more* than today: the only "wrong port"
a skewed policy can admit is 9091, which is exactly the pre-PR state. **No fail-open window.**
A mid-upgrade window where metrics are unscrapable is acceptable — metrics-dark is the documented
`KnextAppMetricsTargetDown` shape, and the operator-first order (#548) keeps it short.

## Conditions

1. **ADR-0044 must be amended.** Amendment 1 names `9091` as *the* app metrics port and states
   the Ports restriction "**must still admit :9091**"; Amendment 4 describes the ":9091 cap".
   This PR contradicts that text while leaving it unedited — a hard-rule/ADR trigger under
   `.claude/rules/workflow.md`. Add an amendment recording the swap, the queue-proxy collision
   that forced it, and the deliberate loss of the incidental 9091 grant.

2. **`packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh` is now broken and was
   not touched by this PR.** It hardcodes `METRICS_PORT=9091` (line 38) and asserts
   `grep -q "port: 9091"` against the live policy (line 87). Post-merge it fails at that line —
   fail-loud, not silently vacuous, which is correct — but the ADR-0044 Amendment 1 kind+Calico
   enforcement evidence is invalidated until the drill is repointed to 9464 and re-run. Repoint
   + re-run; do not merge claiming the drill still backs the policy.

Neither condition is a security widening; both are "the evidence and the record must track the
code". Everything the gate exists to protect — no new peers, no widened selectors, closed
allowlist, fail-closed skew — holds.
