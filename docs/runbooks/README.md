# knext runbooks (day-2 operations)

Operational playbooks for a knext-deployed platform. Each page is
**detect/act → copy-pasteable steps**, grounded in this repo's real manifests,
CLI verbs, and ADRs.

> Two invariants shape every procedure here:
> 1. **The operator is the single source of truth (ADR-0001).** You change
>    desired state by editing the `NextApp` CR (or via `kn-next`, which only
>    patches the CR) — never by `kubectl edit` on the Knative Service directly.
> 2. **When an app is scaled to zero it exports no app metrics** and its Grafana
>    panels are blank — that is normal, not an outage.

## Index

| Runbook | Use when |
| --- | --- |
| [incident.md](./incident.md) | 3am: scale-to-zero stuck, cold-start spike, cache down, bad app revision. |
| [upgrade.md](./upgrade.md) | Rolling a new operator image / CRD version; version-skew policy. |
| [rollback.md](./rollback.md) | Reverting a bad **app** release (traffic split) or a bad **operator** upgrade. |
| [backup-restore.md](./backup-restore.md) | Backup/restore of `scale-zero-pg` data and Redis/object-store cache state. |

## Related

- **App rollback mechanics** live in both [rollback.md](./rollback.md) and
  [incident.md § Scenario 4](./incident.md#scenario-4-rollback--bad-revision)
  (ADR-0014, traffic split).
- **Maintainer release process** (npm packages + operator image):
  [`../RELEASING.md`](../RELEASING.md).
- **Authoritative database disaster-recovery runbook** (scale-zero-pg restore
  into a fresh cluster):
  [`../../packages/scale-zero-pg/docs/runbook-dr.md`](../../packages/scale-zero-pg/docs/runbook-dr.md).
- **Cache/DB durability model** (RPO/RTO, Redis HA recipes, object store):
  [`../operator/data-plane-durability.md`](../operator/data-plane-durability.md).

## Conventions in these pages

- `<app>` — the `NextApp` name; `<ns>` — its namespace.
- The operator runs in namespace **`kn-next-operator-system`**, Deployment
  **`kn-next-operator-controller-manager`**.
- The CRD is **`nextapps.apps.kn-next.dev`**, served at
  **`apps.kn-next.dev/v1alpha1`** (single version — ADR-0017).
