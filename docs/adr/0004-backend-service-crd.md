# ADR-0004: `BackendService` CRD for polyglot backends

Status: Proposed · Date: 2026-06 · Depends on: ADR-0001, ADR-0002 · Amended 2026-10-09 (see the amendment at the end)

> **Amended by ADR-0065 (Proposed, 2026-10-07):** adds a `flavour: model` `BackendService`
> (HTTP/1.1, loopback-bound model server behind an auth sidecar) and an `external` variant of
> `NextApp.spec.backends[]`. A binding to a `model`-flavour backend gets `KNEXT_AI_<NAME>_*` env
> **instead of** `<NAME>_SERVICE_URL`; the default `grpc` flavour below is unchanged.

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

## Amendment (2026-10-09) — same-zone bindings, identity token, retention and wake-ahead

**Status of this amendment: Accepted.** It encodes founder decisions of 2026-10-09 (v2 plan Q10,
Q13, Q15, Q16, Q17; jev scores in the plan) that the architect and system-designer gates signed off
as part of the plan. The base ADR's own status line is left as written. Trigger-class (ADR, CRD,
security, core-vs-app boundary); per the 2026-09-22 workflow amendment it is reviewed at sprint
close, not as a merge gate. **The build it unlocks does not start until the founder's `CLAUDE.md`
sections 4, 5 and 6 edits are merged** — that is the exit criterion of the task that carries this
amendment.

### Context

The Security section above chose a Phase 1 shared bearer token with a NetworkPolicy, and left mTLS
to a follow-up. Zone functions need more than that: a function must belong to one zone, a token
must prove *which* zone and *which* function it is for, and the network cannot be the control —
at zero replicas traffic arrives through the activator, so a NetworkPolicy's peer is the activator,
and flannel (OKE, OrbStack) does not enforce NetworkPolicy at all.

### Decision

**Ownership and bindings**

1. **A `BackendService` belongs to exactly one zone: a required, single `ownerReference` to a
   `NextApp` in the same namespace.** Bindings are **same-zone only**; the operator **rejects
   cross-zone bindings**. The NetworkPolicy admitting only the owning zone stays as
   defense-in-depth.
2. **Data sovereignty is an allowlist.** The **only** Secret a function may reference is its owning
   zone's `db-bind` Secret, from any source — `secretKeyRef`, `envFrom`, a Secret volume or a
   projected volume. Everything else is rejected, as is any environment value naming another zone's
   database `-rw` or `-ro` host (`scs-zones.md`). Each rule has its own test, mutation-proved.
3. **Retention:** a bound function's scale-down retention is longer than its zone's, so a warm zone
   does not outlive the function it depends on. Retention keeps a function alive only after it was
   called; it does not warm an uncalled one.
4. **Wake-ahead:** on zone start the generated client makes a non-blocking Connect GET health call
   to **each bound function**, with a **per-function opt-out**. Per-route targeting is later work.
5. **Transport is switchable** between h2c and HTTP/1.1, chosen by the cold-start spike; the
   default is not fixed by this ADR.
6. **Status** reports the served proto version (ADR-0052 D7). Honest status goes through
   `computeStatusVerdict`, with a finalizer. The CRD stays `apps.kn-next.dev/v1alpha1`, additive, and
   ships in an **operator minor** (ADR-0020 amendment).
7. **The CLI may emit the `BackendService` CR** — via `@getknext/grpc`, lazily dispatched from core
   `deploy`, with `--validate=strict` after the schema preflight (ADR-0052 D3 amendment). The
   operator remains the only reconciler.

**Identity (replaces the Phase 1 shared bearer token)**

8. **Token:** a JWT signed with **Ed25519**, **60 s TTL**, carrying `iss` (the zone identity), `aud`
   (the one function), a `method` claim (the fully qualified RPC), `sub` (the verified user) and
   `exp`, with a `kid` header. Q16: JWT/Ed25519/60 s 0.97 against HMAC 0.03.
9. **One signing keypair per zone.** The private key lives in an operator-created Secret mounted
   into that zone only. The operator publishes **one JWKS ConfigMap per zone** (public keys only),
   with an `ownerReference` to that zone's `NextApp`. A function's verifier mounts **only its owning
   zone's JWKS**, as a **volume — never through env or `subPath`**, so updates propagate. Fetching
   the JWKS from the zone was rejected because it would wake the zone. Function pods mount no private
   key.
10. **Verification** checks signature, `kid`, `exp`, `aud` = this function, `iss` = the owning zone,
    and `method` = the RPC being called. Verifiers accept the **current and previous** key. **Only
    the health RPC is exempt.** A user id in a request body is never trusted. There is **no `jti`
    cache** (it would be pod-local under scale-out), so a token can be replayed inside its 60 s
    life; that window is documented to users rather than hidden.
11. **Rotation order (load-bearing):** (1) publish the new public key to the JWKS; (2) **wait at
    least the ConfigMap volume propagation time** (kubelet sync bound, about 60 to 90 s by default);
    (3) only then switch signing to the new key; (4) retire the old key after a **1 h overlap**
    (longer than the TTL plus a rollout; 1 h scored 0.75 against 10 min 0.25). Switching before
    propagation is expected to fail, and a warm-pod rotation test proves it.
12. **The `authorize()` hook** is a required, user-supplied function in the app: it maps a request
    to a verified user identity or rejects it. Generation **fails closed** without it. Each RPC
    carries an auth option: `USER` (default), `PUBLIC` (only on `NO_SIDE_EFFECTS` methods), or
    `PUBLIC_MUTATION` (no user token, but the service credential is still sent). The generator
    refuses `PUBLIC` on a mutating RPC.
13. **The token is the authoritative control; the NetworkPolicy is defense-in-depth.** A drill with
    Calico on the activator path proves a foreign request with no valid token is rejected by the
    function's interceptor even with the policy in place, and accepted if the interceptor is
    removed. Anything said about network isolation carries the CNI caveat (flannel does not enforce
    it).

### Consequences

- The operator gains a key and JWKS lifecycle, a Secret-reference allowlist and an ownership
  contract: more reconcile surface, all in new files plus two shared ones, serialised with other
  operator work.
- Cross-zone negative tests (a token from zone B replayed to zone A's function) are required in Go
  and Rust and are mutation-proved.
- mTLS through a mesh remains a possible later layer; it is not needed for this design.

### Action items

- [ ] Types and reconciler: ownerRef, same-zone rejection, allowlist, retention, served version.
- [ ] Per-zone key Secret and JWKS ConfigMap; rotation in the order above.
- [ ] Interceptors in the Go and Rust templates, fail-closed, mutation-proved.
- [ ] kind + Calico activator-path drill.
