# Mutating-endpoint audit (E4-2)

> Invariant (security.md, CLAUDE.md §7): **no unauthenticated mutating endpoint.** Any
> route/handler/webhook that changes state must require auth — a signed token and/or an
> internal-only `NetworkPolicy`. This doc is the audit of record; keep it current when adding
> any state-changing handler.

Last audited: 2026-06-22.

## Method
Enumerated every state-changing HTTP handler and admission webhook:

```bash
# App Router route handlers that mutate (POST/PUT/DELETE/PATCH, plus mutating GETs)
grep -rln 'export async function \(POST\|PUT\|DELETE\|PATCH\)' apps/*/src/app/api
# Operator admission webhooks
grep -rln 'webhook\|Mutate\|Validate.*admission' packages/kn-next-operator/internal
```

## Endpoints

| Endpoint | Method | Mutates | Auth | Status |
|---|---|---|---|---|
| `/api/cache/invalidate` | POST | Next.js cache (`revalidateTag`) | Bearer token `CACHE_INVALIDATE_TOKEN`, fail-closed (`isAuthorized`) | ✅ authed |
| `/api/cache/events` | DELETE | clears all cache events (Redis / in-memory) | same Bearer token (reuses the single `isAuthorized` helper) | ✅ authed (E4-2) |

There is intentionally **no `GET /api/cache/invalidate`** handler (#78): invalidation mutates state,
and a mutating GET is prefetchable/link-triggerable and leaks the Bearer token into URLs and logs.
App Router returns 405 for the unexported GET method; POST is the only invalidation entrypoint.

Read-only handlers (no auth required, by design): `GET /api/cache/events`, `GET /api/health`,
`GET /api/metrics`, `GET /api/audit`, `GET /api/cache-stats`. These disclose operational data only —
if any later exposes sensitive data, gate it too.

**Operator admission webhooks:** none yet. When validating/defaulting webhooks land (E3-4), add them
here; admission is the operator's mutating surface.

## Auth mechanism
- One helper: `apps/file-manager/src/app/api/cache/invalidate/auth.ts` → `isAuthorized(authHeader, expectedToken)`.
- **Fail-closed:** unauthorized when the token is unset/empty; constant-time compare (`timingSafeEqual`).
- Token is provisioned as a K8s Secret → `CACHE_INVALIDATE_TOKEN` env var; never in config/image/URL.
- Tests: `invalidate/auth.test.ts` (helper) + `events/route.test.ts` (the DELETE guard, 4 cases).

## Network isolation (defense-in-depth) — #90

Auth is one factor; the second is **network isolation**. The operator reconciles a Kubernetes
`NetworkPolicy` from the `NextApp` CR (per ADR-0001, the operator is the single cluster writer — this
is **not** a hand-applied or CLI-generated manifest).

- **Object:** `NetworkPolicy` named `<app>-allow-ingress`, owner-referenced to the `NextApp`
  (garbage-collected on delete). Reconciled in `internal/controller/nextapp_controller.go`
  (`reconcileNetworkPolicy`), modeled on the operator's existing
  `config/network-policy/allow-metrics-traffic.yaml`.
- **podSelector:** `serving.knative.dev/service: <app>` — the label Knative stamps on every revision
  pod, equal to the NextApp name. The policy therefore targets the app's serving pods.
- **policyTypes:** `Ingress`.
- **Ingress rule (from):**
  1. `namespaceSelector` matching `kubernetes.io/metadata.name in (knative-serving, kourier-system)`
     — the Knative serving system (the activator handles scale-from-zero) and the Kourier ingress
     gateway. This keeps scale-from-zero traffic flowing.
  2. an empty `podSelector` (`{}`) — same-namespace pods (a `NamespaceSelector`-nil peer matches the
     policy's own namespace).

  Everything else — arbitrary cross-namespace pods and external pod-direct traffic — is denied.

- **Spec flag (default-on, toggleable):** `spec.security.networkPolicy` (`*bool`).
  - `nil` (unset) or `true` ⇒ the policy is reconciled (**default-on**).
  - `false` ⇒ the policy is **not** reconciled, and any previously-created one is **deleted** on the
    next reconcile.

### Honest scope: L3/L4, not L7
A `NetworkPolicy` filters by **source pod / namespace at the network layer (L3/L4)** — it **cannot**
target a specific HTTP path (L7). So this does **not** isolate `/api/cache/invalidate` per se; it
makes the whole **pod** unreachable for direct traffic from outside the cluster / disallowed
namespaces. That is the defense-in-depth the security rule asks for (a leaked Bearer token is useless
to an attacker who cannot route to the pod), but it is **not** per-route isolation. True per-path
isolation would require a separate internal-only route.

### CNI prerequisite
A `NetworkPolicy` is only enforced if the cluster CNI supports it (Calico, Cilium, etc.). On a
non-enforcing CNI the policy is a **no-op** (it is still correct to ship). Document the CNI as a
deployment prerequisite where this guarantee matters.

**kubelet health probes:** the queue-proxy readiness/liveness probes originate from the **node IP**
(not a pod), so they are not matched by any ingress peer in this policy. Most CNIs exempt kubelet
probe traffic from default-deny (Calico failsafe ports, Cilium host traffic), so serving survives —
but on a CNI with strict host-policy enforcement you may need to additionally allow the node/host
network, or readiness probes can fail.

### Verification
- **envtest (automated, PR CI):** `internal/controller/networkpolicy_test.go` asserts that
  reconciling a `NextApp` (default + explicit-true) creates the policy with the expected podSelector,
  ingress peers, and an ownerReference to the `NextApp`; and that `networkPolicy: false` creates no
  policy / removes an existing one.
- **out-of-cluster blocked (manual check, requires an enforcing CNI):** on a kind/real cluster with a
  NetworkPolicy-enforcing CNI, from a pod in an unlabeled namespace:

  ```bash
  # In an allowed in-cluster client (same namespace) — succeeds:
  kubectl run probe-in --rm -it --image=curlimages/curl --restart=Never -n <app-ns> -- \
    curl -so /dev/null -w '%{http_code}\n' http://<app>.<app-ns>.svc.cluster.local/api/health
  # From a disallowed namespace, pod-direct to the app pod IP — blocked (connection times out):
  kubectl run probe-out --rm -it --image=curlimages/curl --restart=Never -n other-ns -- \
    curl --max-time 5 -so /dev/null -w '%{http_code}\n' http://<app-pod-ip>:3000/api/cache/invalidate
  ```

  This is not stood up in PR CI (no kind cluster in CI for this check); it is the documented manual
  verification the issue allows.

## Remaining (defense-in-depth)
- **CI guard** so a new open mutating handler fails the build. Ready-to-wire check: every file under
  `apps/*/src/app/api` that exports `POST|PUT|DELETE|PATCH` must contain `isAuthorized` (or be listed
  here as an explicit, justified exception).
