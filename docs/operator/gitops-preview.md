# GitOps Preview Environments

The `kn-next-operator` includes native support for handling ephemeral CI/CD environments out of the box. 

When pushing a Pull Request, teams frequently deploy fully isolated versions of their application to test features before merging to `main`. However, standard Kubernetes environments require extensive memory and CPU overhead to keep dozens of ephemeral branches active.

## Dynamic Scale-To-Zero

The `NextApp` CRD introduces the `Preview` specification for exactly this issue:

```yaml
spec:
  preview:
    enabled: true
    branch: "feat/new-ui"
    prId: "123"
```

When the Reconciler observes that `Preview.Enabled == true`, it proactively intercepts the generation of the Knative Service and injects forceful resource-saving overrides regardless of the standard `scaling` configuration:

1. **Max Scale Cap**: Overrides `autoscaling.knative.dev/max-scale: "1"`. A preview environment is meant for a single developer or QA reviewer and does not need burst autoscaling capabilities. Capping it at 1 pod prevents cluster resource exhaustion.
2. **Min Scale Zero**: Overrides `autoscaling.knative.dev/min-scale: "0"`. Previews must always be able to spin down when not actively tested.
3. **Aggressive Retention**: Overrides `autoscaling.knative.dev/scale-to-zero-pod-retention-period: "30s"`. Standard Knative applications might linger for minutes hoping for incoming traffic. For preview environments, the operator drops the retention window to mere seconds, aggressively killing the pod immediately after the PR reviewer stops interacting with it.

## Identification

The operator also tags the underlying Knative Service with explicit labels:
- `environment: preview`
- `pr-id: "123"`

This allows cluster administrators and observing tools (like Prometheus or Grafana dashboards) to split metrics gracefully between production traffic and ephemeral testing environments.
