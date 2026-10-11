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

## End-to-end flow (issue #91 / ADR-0013)

A preview is a **separate `NextApp` named `<app>-pr-<n>`** — never a mutation of the production app.
Because every per-app scope in knext is keyed by the `NextApp` name (asset prefix, ksvc URL, and the
external-cleanup finalizer; see ADR-0008), a preview is isolated automatically: it uploads/serves
assets under `<app>-pr-<n>/`, gets a distinct ksvc URL, and on delete the finalizer reaps exactly
that prefix + Redis keyspace. A preview is **ephemeral and shares nothing stateful with production —
no database, by default.**

### CLI

```bash
# Deploy / update a preview for PR #123 from branch feat/new-ui.
# Builds + pushes a digest-pinned image, applies a NextApp CR named <app>-pr-123
# carrying spec.preview, then prints the preview URL (status.url) to stdout.
knext preview deploy --pr 123 --branch feat/new-ui -n previews

# Tear the preview down on PR close. Deletes ONLY the <app>-pr-123 NextApp CR
# (--ignore-not-found); the operator finalizer reaps the name-scoped assets.
knext preview destroy --pr 123 -n previews
```

The CLI obeys ADR-0001: it writes ONLY the `nextapp` resource (apply on deploy, delete on destroy)
and never touches the Knative Service / Route / `kn` directly. It does **not** emit `spec.traffic` on
a preview (single revision at `max-scale=1`), and a preview carries its own build-id + asset prefix,
so production's deploy-time retention GC (#93) never touches it and a preview cannot skew production.

The derived name must be a valid DNS-1123 label of ≤63 chars; an over-long app name aborts **before**
any cluster write.

### CI

`.github/workflows/preview.yml` runs `preview deploy` on PR `opened`/`synchronize`/`reopened` and
`preview destroy` on `closed`, then upserts a sticky PR comment with the URL.

The workflow is **committed but gated** — INERT until a cluster is wired up. Every job is guarded by
a `vars.PREVIEW_ENABLED` repository variable AND a `preview` PR label. It deliberately uses
`pull_request` (not `pull_request_target`), so **fork PRs run with a read-only token and cannot read
cluster/registry secrets** — previews only deploy for trusted, same-repo, maintainer-labeled
branches. To activate the live loop: provision a `PREVIEW_KUBECONFIG` secret + registry creds and set
`PREVIEW_ENABLED`.

### Teardown authority

The **PR-close event is the single teardown authority** — there is intentionally no operator-side TTL
or reaper timer (a second authority would race the event; see ADR-0013 for the rejected alternative).
A separate scheduled CI sweep that calls `preview destroy` for already-closed PRs is acceptable as
belt-and-suspenders, since it shares the one authority (deleting the CR).
