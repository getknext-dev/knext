# Mutating-endpoint audit (E4-2)

> Invariant (security.md, CLAUDE.md §7): **no unauthenticated mutating endpoint.** Any
> route/handler/webhook that changes state must require auth — a signed token and/or an
> internal-only `NetworkPolicy`. This doc is the audit of record; keep it current when adding
> any state-changing handler.

Last audited: 2026-10-17 (Server Actions added; `/api/audit` now gated).

## Method
Enumerated every state-changing HTTP handler and admission webhook:

```bash
# App Router route handlers that mutate (POST/PUT/DELETE/PATCH, plus mutating GETs)
grep -rln 'export async function \(POST\|PUT\|DELETE\|PATCH\)' apps/*/src/app/api
# Operator admission webhooks
grep -rln 'webhook\|Mutate\|Validate.*admission' packages/kn-next-operator/internal
# Server Actions: every export of a 'use server' module is a public POST endpoint
grep -rln "use server" apps packages/kn-next/templates/app
```

The last step is no longer manual: `tests/server-action-auth-scan.test.ts` runs that scan on every PR
(see "Server Actions" below).

## Endpoints

| Endpoint | Method | Mutates | Auth | Status |
|---|---|---|---|---|
| `/api/cache/invalidate` | POST | Next.js cache (`revalidateTag`) | Bearer token `CACHE_INVALIDATE_TOKEN`, fail-closed (`isAuthorized`) | ✅ authed |
| `/api/cache/events` | DELETE | clears all cache events (Redis / in-memory) | same Bearer token (reuses the single `isAuthorized` helper) | ✅ authed (E4-2) |
| `/api/audit` | GET | nothing (reads `audit_logs` rows) | same Bearer token; answers `private, no-store`, never publicly cacheable | ✅ authed (read gated because the rows are not public) |
| `/api/rum` | POST | `observe()` into pre-declared Web Vitals histograms (no storage/cache/state write) | **bounded-aggregator exception** — see "RUM ingest" below (#94) | ✅ justified |

There is intentionally **no `GET /api/cache/invalidate`** handler (#78): invalidation mutates state,
and a mutating GET is prefetchable/link-triggerable and leaks the Bearer token into URLs and logs.
App Router returns 405 for the unexported GET method; POST is the only invalidation entrypoint.

Read-only handlers (no auth required, by design): `GET /api/cache/events`, `GET /api/health`,
`GET /api/metrics`, `GET /api/cache-stats`. These disclose operational data only —
if any later exposes sensitive data, gate it too (as `GET /api/audit` now is; the scan holds a short
list of such reads to the same gate as a mutation).

**Operator admission webhooks:** none yet. When validating/defaulting webhooks land (E3-4), add them
here; admission is the operator's mutating surface.

## Auth mechanism
- One helper: `apps/file-manager/src/app/api/cache/invalidate/auth.ts` → `isAuthorized(authHeader, expectedToken)`.
- **Fail-closed:** unauthorized when the token is unset/empty; constant-time compare (`timingSafeEqual`).
- Token is provisioned as a K8s Secret → `CACHE_INVALIDATE_TOKEN` env var; never in config/image/URL.
- Tests: `invalidate/auth.test.ts` (helper) + `events/route.test.ts` (the DELETE guard, 4 cases).

## Server Actions

A `'use server'` export is a **public POST endpoint**: anyone who can reach the app can invoke it,
with or without the page that renders its form. The original audit enumerated only route handlers, so
the file-manager `uploadFile` action wrote object storage and Postgres with no authentication while
this document said there were no such endpoints. Server Actions are therefore a category of their own.

**The pattern (copy it).** The first statement of every exported action is the auth check, and nothing
that calls anything may run before it:

```ts
export async function myAction(formData: FormData) {
  if (!(await authorizeMutation(formData))) return { error: 'Unauthorized' }; // or: throw
  // ... writes ...
}
```

- `authorizeMutation` (`apps/file-manager/src/app/_auth/mutation-auth.ts`) reuses `isAuthorized`:
  the app's one admin Bearer token, `CACHE_INVALIDATE_TOKEN` (a K8s Secret), **fail-closed** when unset
  or empty, constant-time compare. The credential arrives as `Authorization: Bearer <token>` (scripts,
  tests) or as a `token` form field (the browser, since a plain `<form>` cannot set headers).
- One token for every mutating surface keeps the reference app simple. A real product that needs
  per-user or per-role authorization replaces `authorizeMutation` with its session check; the position
  rule (first statement, refuse by return or throw) is the part to keep.

**Inventory** (every `'use server'` function under `apps/` and the app templates; the scan fails if
this list and the tree disagree):

| Action | Mutates | Auth | Status |
|---|---|---|---|
| `apps/file-manager/src/app/actions.ts::uploadFile` | object storage (`assets` bucket), `files` table, `files` cache tag | `authorizeMutation`, first statement | ✅ authed. Object key and row name are `<random id>-<validated filename>`, never the raw client name, and the row is an insert, never an upsert: two uploads of one filename never overwrite each other. A name with a path separator, a control character or only dots is refused. |
| `apps/file-manager/src/app/users/page.tsx::addUser` | `users` table | `authorizeMutation` | ✅ authed |
| `apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateProducts` | cache tag `products` | `authorizeMutation` | ✅ authed |
| `apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateOrders` | cache tag `orders` | `authorizeMutation` | ✅ authed |
| `apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidatePath` | path cache for the page | `authorizeMutation` | ✅ authed |
| `apps/file-manager/src/app/cache-tests/on-demand/page.tsx::invalidateAll` | cache tags `products` and `orders` | `authorizeMutation` | ✅ authed |
| `apps/file-manager/src/app/knext-smoke/stream/page.tsx::echoAction` | one cookie on the caller's own response; no server-side state | none | ✅ justified exception: compat-smoke fixture, nothing shared is written |
| `apps/file-manager/src/app/setup/actions.ts::runSetup` | creates the demo tables and seeds them when empty (idempotent DDL + inserts) | `authorizeMutation`, first statement | ✅ authed (#2534). This used to run on every `GET /setup`; the page now only renders a form and the work is this Server Action, a POST, so a crawler, a prefetch or a cross-site GET cannot trigger it. |
| `apps/db-demo/src/app/actions.ts::postMessage` | `messages` table | its own `authorizeMutation` (`apps/db-demo/src/lib/mutation-auth.ts`), token `DB_DEMO_WRITE_TOKEN`, fail-closed when unset | ✅ authed (#2533) |

The scaffold templates (`packages/kn-next/templates/app`) emit no Server Action and one `GET` route
(`/api/health`), so a freshly scaffolded app starts clean. Generated gRPC glue actions (`*_knext_actions.ts`)
run `authorize()` first by construction and refuse an RPC that does not declare it.

**Database bootstrap.** Nothing in the platform needs `/setup` at boot: the platform e2e calls it explicitly
(`POST` of the form with the token), and a real app should create its schema in a migration step
(for example a one-shot Job) rather than from a web route. A `GET /setup` now renders the form and writes nothing.

**The scan** (`scripts/lib/server-action-auth-scan.mjs`, spec `tests/server-action-auth-scan.test.ts`,
mutation-proved by `scripts/mutation-prove-2532-server-action-auth.mjs`) parses every source file under
`apps/` and `packages/kn-next/templates/app`. Every exported `'use server'` function, every inline
`'use server'` function, and every exported `POST|PUT|PATCH|DELETE` handler of a `route.*` file (plus the
`GET` of `api/audit`) must open with `if (!(await authorizeMutation(...)))` or `if (!isAuthorized(...))` that
returns or throws, preceded by nothing that calls, awaits or assigns. It **fails rather than passes** on
anything it cannot read: a file that does not parse, a method re-exported from another module,
`export *`, an expression-bodied action, a `pages/api` route. The allowlist is counted (the spec pins
two entries: `/api/rum` and `echoAction`), each entry needs a reason, and an entry that
matches nothing, or that matches a surface which is in fact gated, fails too.

It checks that the auth call is present, imported and first. That the call is *correct* is the job of
`mutation-auth.test.ts` and `auth.test.ts`.

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
- **Ingress rules (three, each port-scoped since ADR-0044):**
  1. **Serving + metrics ports** (`8012`, `8013`, `8112`, `9090`, `9464`) from a
     `namespaceSelector` matching `kubernetes.io/metadata.name in (knative-serving, kourier-system)`
     — the Knative serving system (the activator handles scale-from-zero) and the Kourier ingress
     gateway. This keeps scale-from-zero traffic flowing.
  2. **Metrics ports only** (`9090`, `9464`) from an empty `podSelector` (`{}`) — same-namespace pods
     (a `NamespaceSelector`-nil peer matches the policy's own namespace). Narrowed from "all ports"
     by ADR-0044: a co-resident pod reaching the app's container port would bypass the queue-proxy,
     and a co-resident *zone* calling another zone's pods synchronously breaks the SCS contract.
  3. **The app metrics port only** (`9464`) from any namespace **labelled**
     `knext.dev/metrics-scrape=true` (#735). Without this, the operator's own shipped `PodMonitor` —
     which scrapes with `namespaceSelector: any` — was denied on every policy-enforcing CNI.

  Everything else is denied: the app's own container port from **any** source (the queue-proxy
  reaches it over pod-local loopback, which no NetworkPolicy governs), arbitrary cross-namespace
  pods on **any** port unless their namespace carries the scrape label, and external pod-direct
  traffic.

  **Honest scope of rule 3.** It is namespace RBAC, not a per-app privilege boundary: the label is on
  a cluster-scoped Namespace, so the grantor is whoever holds `update namespaces`, and once labelled
  *every* pod in that namespace — not only Prometheus — can scrape `9464` on *every* knext app. There
  is no `PodSelector` because the operator cannot know a user's Prometheus labels. **A second
  NetworkPolicy cannot narrow this** — policies are additive, so they union allow-rules; the only
  narrowing lever is `spec.security.networkPolicy: false` plus a bring-your-own policy. See
  `threat-model.md` §6 for the residual.

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
- **enforcement drill (kind + Calico, CI):**
  `packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh` proves REFUSAL rather than
  object shape — envtest has no CNI and no dataplane, so it can only assert what was written. The
  drill asserts: a same-namespace pod is refused on the app's container port, admitted on metrics; an
  **unlabelled** namespace is refused cross-namespace (asserted *first*, so the label demonstrably
  grants something); the same namespace **labelled** is admitted on `9464` but still refused on the
  container port; and — the mutation — deleting the policy makes the container port reachable again,
  proving the refusal was the policy's doing.
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

## RUM ingest `/api/rum` — justified exception (#94)

`POST /api/rum` receives Web Vitals beacons **from the user's browser**, which cannot carry the
Bearer secret (it would be exposed in the client bundle / network tab). It is nonetheless **not** an
"open mutating endpoint" in the sense the invariant forbids: it is a **fixed-schema, lossy metrics
aggregator**, neutered by four independent layers. It does not write storage, cache, or any
revalidation — its *only* possible effect is `observe()` on a pre-declared histogram.

1. **Same-origin / cluster-local, no new surface.** The beacon is sent from the already-served page
   to the same origin. The endpoint is reachable only as broadly as the app already is — the
   default-on internal-only `NetworkPolicy` above (#90) governs it too. No new external attack
   surface is introduced.
2. **Fixed-schema lossy aggregator.** The handler can ONLY call
   `observeWebVital()` → `histogram.observe()` on one of a **closed set** of pre-declared histograms
   (`apps/file-manager/src/app/api/_metrics/registry.ts`). It cannot create series, set arbitrary
   gauge/counter values, write to Redis/GCS, or trigger cache revalidation. The worst an attacker can
   do is skew aggregate latency percentiles — never read data, mutate state, or exhaust storage.
3. **Server-enforced bounded label cardinality.** Three labels, each from a **closed allow-list**,
   enforced server-side in `api/rum/validate.ts` (the client is never trusted for a label):
   - `metric` ∈ {LCP, INP, CLS, FCP, TTFB};
   - `route` = a **route template** the server maps the reported pathname to via a closed known-route
     table; unmatched paths collapse to a single `other` bucket — raw IDs/UUIDs/query strings can
     **never** become a label;
   - `rating` ∈ {good, needs-improvement, poor}.
   `app` comes from `KN_APP_NAME` (server env), never the client. No user/session/IP/raw-URL is ever
   a label, so Prometheus cardinality stays bounded regardless of input.
4. **Rate-limit + size cap + strict shape.** An in-process token-bucket limiter (bounded key map,
   `api/rum/rate-limit.ts`) caps the ingest rate → `429` on flood; a payload-size cap → `413`;
   strict shape/allow-list validation → `400`. There is intentionally **no GET handler**.

Responses: `204` recorded · `400` malformed/disallowed · `413` oversized · `429` rate-limited.

**Opt-in / default-off.** RUM is off unless `observability.rum.enabled` is set
(`packages/kn-next/src/config.ts`); the operator then sets `NEXT_PUBLIC_RUM_ENABLED` (and optional
`NEXT_PUBLIC_RUM_SAMPLE_RATE`) so the client `WebVitalsReporter` activates. With RUM disabled the
client sends nothing — the endpoint exists but is never exercised.

**Tests:** `api/rum/validate.test.ts`, `api/rum/rate-limit.test.ts`, `api/rum/route.test.ts`
(records, 400/413/429, `other`-bucket cardinality), and the operator env-propagation envtest
(`reconcile_output_test.go` → "RUM env propagation").

## Remaining (defense-in-depth)
- ~~**CI guard** so a new open mutating handler fails the build.~~ **Done**: `tests/server-action-auth-scan.test.ts`
  (see "Server Actions"). `/api/rum` is on its allowlist, with the bounded-aggregator rationale above.
- ~~Gate `GET /setup` (#2534) and `db-demo`'s `postMessage` (#2533)~~ **Done**; the allowlist is down to two.
- Service-to-service and per-user authorization for the reference app: today one shared admin token.
