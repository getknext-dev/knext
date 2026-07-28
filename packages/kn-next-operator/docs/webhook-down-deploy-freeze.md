# Webhook down = deploys frozen (and how to tell it from version skew)

The `NextApp` validating webhook runs `failurePolicy: Fail`. That is deliberate: an unvalidated
`NextApp` must never reach etcd. The consequence is equally deliberate and less obvious —

> **while the operator's validating webhook is unreachable, every `NextApp` CREATE and UPDATE on
> the cluster is rejected. Deploys are frozen.**

Nothing is lost and nothing is half-applied; the apiserver rejects the write before it persists.
But the cluster stays frozen until the webhook answers again.

## The misdiagnosis this page exists to prevent

A webhook outage and a **CLI/operator version skew** present identically at the CLI: `kn-next deploy`
fails on the apply. The failure modes are unrelated, and the wrong guess is expensive — someone who
reads an outage as skew downgrades their CLI, waits for a release, and changes nothing, while the
controller is still down.

They are cleanly separable, because the apiserver decides them at **different stages**. It decodes
and field-validates a request *before* it calls any admission webhook. So:

| what you see | diagnosis | what actually fixes it |
|---|---|---|
| `failed calling webhook "vnextapp-v1alpha1.kb.io" … no endpoints available` / `connection refused` / `i/o timeout` / `x509: certificate signed by unknown authority` | **webhook down** — deploys frozen, fail-closed | restore the controller-manager (see below). No CLI version changes this. |
| `strict decoding error: unknown field "spec.…"`, `unknown field …`, `no matches for kind "NextApp" in version …` | **schema skew** — the CRD does not know what the CLI emitted | upgrade the **operator and its CRD first, then the CLI**. The webhook is not involved. |
| `admission webhook … denied the request: …` / `… is invalid: …` | **rejected on the merits** — the control plane answered | fix the field it named. |
| bare `connection refused` with no webhook named | the **apiserver** is unreachable | check kubeconfig/context/cluster. |

A skew-shaped payload still fails as skew **while the webhook is down**, and its error never mentions
the webhook at all — that is the property that makes the two distinguishable from a single failed
apply, and it is asserted against a real cluster in
`test/e2e/webhook_down_freeze_test.go` (`make test-e2e-webhook-down`). The classification itself is
`utils.DiagnoseApplyFailure` (`test/utils/diagnose.go`), unit-tested and mutation-proved by
`hack/mutation-prove-webhook-down.sh`.

**knext defaults nothing at admission.** There is no mutating/defaulting webhook and no CRD
`default:`, so there is no third case where a field silently goes missing during an outage and reads
like a pruned unknown field. `internal/webhook/v1alpha1/admission_surface_test.go` fails if that ever
changes, because the diagnosis above would then need a fourth class.

## Confirming an outage

```bash
# 1. is the controller running?
kubectl get deploy kn-next-operator-controller-manager -n kn-next-operator-system

# 2. does its webhook Service have ready endpoints? (empty output = down)
kubectl get endpoints kn-next-operator-webhook-service -n kn-next-operator-system \
  -o jsonpath='{.subsets[*].addresses[*].ip}'

# 3. behavioural proof — persists nothing, traverses the whole admission chain
kubectl apply --dry-run=server --validate=strict -f your-nextapp.yaml
```

Step 2 alone is not conclusive: what matters is whether the **apiserver** can reach it, which is what
step 3 tests. A serving-certificate problem shows a healthy Deployment with endpoints and still fails
step 3 with `x509: certificate signed by unknown authority`.

## Restoring

Usually the Deployment: `kubectl -n kn-next-operator-system rollout status deploy/kn-next-operator-controller-manager`,
then its pod events/logs. If the Deployment is Available but step 3 still fails, look at the
serving certificate (cert-manager `Certificate`/`Issuer` in the operator namespace) and the
`caBundle` injected into the `ValidatingWebhookConfiguration`.

Note that `Deployment: Available` does **not** imply the webhook is serving — the cert mount, the
TLS bind, and `caBundle` injection all lag it (#233). Step 3 is the only reliable readiness signal.

## What is *not* frozen

`DELETE` is not gated: the webhook's rules cover `CREATE` and `UPDATE` only, so an existing `NextApp`
can still be deleted during an outage. Reconciliation is also frozen for a different reason — the
controller is the thing that is down — so a deleted `NextApp` with a finalizer will not finish
terminating until the operator is back. Restore the operator before deleting namespaces.

## Deliberately not mitigated

The webhook is **not** scoped by a `namespaceSelector`. Narrowing it would shrink the outage's blast
radius, and it would equally shrink the blast radius of the security control — unvalidated `NextApp`
writes would be admitted in every namespace outside the selector. Fail-closed cluster-wide is the
intended trade.
