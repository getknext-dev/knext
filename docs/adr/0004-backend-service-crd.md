# ADR-0004: `BackendService` CRD for polyglot backends

Status: Proposed · Date: 2026-06 · Depends on: ADR-0001, ADR-0002

## Context
Each polyglot backend must deploy as its own **scale-to-zero Knative service** (gRPC over
**h2c**) and be discoverable by the `NextApp` gateway. Per ADR-0001 the operator is the only
cluster writer, so deployment must be expressed as a CR. Question: extend `NextApp` or add a new
kind?

## Decision
Add a **new `BackendService` CRD** (group `apps.kn-next.dev`), reconciled by the same operator.
`NextApp` (the gateway) gains an optional `backends: [{name, service}]` list; the operator
injects each backend's cluster URL into the gateway as env (`<NAME>_SERVICE_URL`), mirroring how
it already injects `REDIS_URL`/`DATABASE_URL`.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. New `BackendService` CRD (chosen)** | Clean separation; backends version/scale/deploy independently of the gateway; gateway stays focused; reusable by multiple NextApps | One more CRD + controller |
| B. Extend `NextApp` with embedded backends | Single CR | Couples backend lifecycle to the gateway; bloats `NextAppSpec`; can't share a backend across apps; redeploys gateway on backend change |

## Design
`BackendServiceSpec`: `image`, `language` (metadata), `port` (h2c), `scaling` (reuse
`ScalingSpec`), `resources`, `secrets`/`env`. The controller creates:
- a **Knative Service** with the container port named `h2c` (`appProtocol: h2c`) so Knative
  routes gRPC and supports scale-to-zero;
- label **`networking.knative.dev/visibility: cluster-local`** → **not publicly exposed**
  (satisfies the no-unauthenticated-endpoint rule — only in-cluster callers reach it);
- a least-privilege ServiceAccount (mirrors current `NextApp` reconcile);
- owner references for GC.

Discovery: gateway env `<NAME>_SERVICE_URL = http://<name>.<ns>.svc.cluster.local` (h2c). The
generated server-only Connect client reads this env var (same pattern as `getDbPool`).

## Security (no-unauth-endpoint)
- Backends are **cluster-local** by default — no public ingress.
- Gateway→backend auth: **Phase 1** a shared bearer token (operator-provisioned secret, injected
  into both) checked by a Connect interceptor; **Phase 2** mTLS via a mesh (e.g. Istio) — record
  as a follow-up ADR. NetworkPolicy restricts ingress to the gateway's ServiceAccount/namespace.

## Consequences
- New `api/v1alpha1/backendservice_types.go` + controller; CRD manifests + RBAC.
- `NextAppSpec.backends` field + env-injection in the existing reconciler.
- h2c verified on the target Knative/networking layer (tie to the Phase-4 ingress ADR).

## Action items
- [ ] `BackendService` types + controller (cluster-local h2c Knative service).
- [ ] `NextApp.backends` + `<NAME>_SERVICE_URL` env injection.
- [ ] Token-auth interceptor (gen) + NetworkPolicy; mTLS follow-up ADR.
