# ADR-0001: The Go operator is the single source of truth for cluster state

Status: Accepted (codifying existing intent) · Date: 2026-06

## Context
knext has two paths that write Kubernetes state: the **operator** (`packages/kn-next-operator`,
Go/Kubebuilder) reconciling a `NextApp` CR into a Knative Service + ServiceAccount +
bytecode-cache PVC + (optional) KafkaSource + image cache; and the **TS deploy CLI**
(`packages/kn-next/src/cli/deploy.ts`) which shells `kubectl apply` directly. Two writers of the
same cluster state causes drift, race conditions, and an unclear reconciliation owner.

## Decision
The **operator is the sole authority for cluster state.** All desired state is expressed as a
`NextApp` (and future `BackendService`) custom resource; the operator reconciles it. The CLI's
job ends at **build → push image → apply/patch the CR**. No tool other than the operator
creates or mutates Knative Services, PVCs, ServiceAccounts, KafkaSources, etc.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Operator-only writer (chosen)** | One reconciler, GitOps-friendly, drift-correcting, clear ownership | Requires CLI refactor; operator must cover every field |
| B. CLI-only (`kubectl apply`) | Simple, no operator | No reconciliation/self-heal; imperative; no GitOps; current drift |
| C. Both (status quo) | — | Two writers, races, ambiguous truth — actively harmful |

## Consequences
- `deploy.ts` must be refactored: drop direct `kubectl apply` of Knative/infra manifests;
  instead render a `NextApp` CR and `kubectl apply` **only the CR** (or use server-side apply).
- The operator's `NextAppSpec` must be a superset of what the CLI previously templated
  (scaling, cache, storage, secrets, revalidation, observability already present).
- Enables Phase-2 control-plane consolidation in the maturity plan.

## Action items
- [ ] Audit every cluster mutation in `deploy.ts`/`shared.ts`; map each to a `NextApp` field.
- [ ] Add any missing fields to `NextAppSpec`; regenerate CRD.
- [ ] Refactor CLI to emit + apply the CR only. Add a `--dry-run` that prints the CR.
- [ ] Remove/clarify the Go `packages/cli` vs TS CLI overlap (separate cleanup).
