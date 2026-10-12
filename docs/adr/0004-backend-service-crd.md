# ADR-0004: `BackendService` CRD for polyglot backends

Status: Accepted (2026-10-12, Z1 design gate — architect and system-designer re-confirmation: [architect](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128826009), [system designer](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128845685)) · previously Proposed · Date: 2026-06 · Depends on: ADR-0001, ADR-0002 · Amended 2026-10-09 (see the amendment at the end; revised 2026-10-12 with the Z1 design gate's required changes before the re-confirmation)

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

**Status of this amendment: Accepted (2026-10-12, Z1 design gate — architect and system-designer
re-confirmation: [architect](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128826009), [system designer](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128845685)).** History: it was first marked
Accepted on 2026-10-09, encoding founder decisions (v2 plan Q10, Q13, Q15, Q16, Q17; jev scores in
the plan) that the architect and system-designer gates signed off as part of the plan. When both
gates reviewed this amendment's text at the Z1 design gate (#2045), both returned
**REQUIRE-CHANGES**, and it was held at Proposed while revised. The changes they required are
applied below, each marked *(Z1 gate)*: Decision 2 widens the Secret allowlist, Decisions 3, 4
and 5 record the cold-start spike's results and a function-agnostic wake seam, and Decision 12
drops the `PUBLIC_MUTATION` auth option. At re-confirmation the architect accepted, and the system
designer accepted on two further additions, marked *(Z1 re-confirmation)*: deny-rule precedence and
the namespace trust boundary in Decision 2, and the bounds on the wake seam in Decision 4. The
non-blocking notes are under *Notes from the Z1 design gate*. Trigger-class (ADR, CRD,
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
2. **Data sovereignty is an allowlist.** A function may reference a Secret, from any source —
   `secretKeyRef`, `envFrom`, a Secret volume or a projected volume — only if it is **(a)** its
   owning zone's `db-bind` Secret, or **(b)** a Secret marked as belonging to the same zone: a
   zone-owner label naming the owning zone, or an `ownerReference` to the same `NextApp`. That lets
   a function hold its own third-party credentials (a payment-provider key, say) through the base
   Design's `secrets`/`env` field. **An unmarked Secret is rejected.** **`imagePullSecrets` are
   exempt**: a private registry (OCIR on OKE) needs them, and they expose no data store. Any
   reference to **another zone's** `db-bind` Secret or to a Secret marked for another zone is
   rejected, as is any environment value naming another zone's database `-rw` or `-ro` host
   (`scs-zones.md`). Each rule has its own test, mutation-proved. *(Z1 gate: the first text allowed
   only the `db-bind` Secret, which broke the base spec's `secrets`/`env` field and private-registry
   pulls without serving data sovereignty.)*
   - **Deny rules win.** A Secret that is another zone's `db-bind` Secret is rejected even if it
     carries this zone's label or `ownerReference`. The allow half and the deny half each get their
     own mutation-proved test. *(Z1 re-confirmation.)*
   - **The namespace is the trust boundary.** The same-zone marks stop only the confused-deputy
     path: a `BackendService` author who cannot read a Secret getting the operator to mount it.
     Anyone who can write Secrets in the namespace can set either mark, a label or an
     `ownerReference`, so neither is stronger than the other. Zones whose owners do not trust each
     other belong in separate namespaces. The host check covers environment literals only, not
     what is inside a Secret. *(Z1 re-confirmation.)*
3. **Retention:** a bound function's scale-down retention is longer than its zone's, counted from
   the function's own last call. So if the zone's last request called the function, the function
   outlasts the zone. That is not a guarantee that a warm zone never meets a cold function: a zone
   whose recent requests did not call the function can outlive it, and an uncalled function is not
   warmed at all (Decision 4 covers that case). *(Z1 gate: softened from "a warm zone does not
   outlive the function it depends on", which held only if every zone request called the
   function.)*
4. **Wake-ahead:** on zone start each **bound function** gets one non-blocking GET to its health
   RPC (the one RPC Decision 10 exempts from the token), with a **per-function opt-out**.
   Per-route targeting is later work. *(Z1 gate: the firing point and the seam below.)*
   - **Measured, Z2 spike** (`docs/benchmarks/zone-functions-coldstart-kind-2026-10-09.md`): fired
     from the generated client in `instrumentation.ts` `register()`, the wake is **too late**. It
     fires only ~0.4 s (Node) or ~0.8 s (Bun) before the request reaches the handler, while a cold
     function needs ~1.4 s to start. On a Node zone it had **no measurable effect**; on a Bun zone
     it cut part of the chain and left 0.2–0.6 s against a warm function.
   - **The core seam is generic; core knows nothing about functions.** Firing earlier means the
     runtime supervisor at process start, and the supervisor is core (`packages/kn-next`), which the
     ADR-0002 amendment's scope fence keeps free of function orchestration. So core gets only a
     function-agnostic seam. The primary shape: the operator injects a list of warm URLs into the
     zone (an env var such as `KNEXT_WARM_URLS`, built from the bound functions' health URLs minus
     the opted-out ones), and the core supervisor sends one non-blocking GET to each at process
     start — never awaited, never failing the boot. The acceptable alternative: a generic preload
     extension point in core that `@getknext/grpc` registers on. Either way core never imports or
     names gRPC, Connect or a function.
   - **Bounds on the seam** *(Z1 re-confirmation)*. `KNEXT_WARM_URLS`, or whatever it ends up
     named, is **operator-owned**: a user-set value in the `NextApp` env is overwritten or rejected.
     It holds **only the bound functions' cluster-local health URLs** (`http` or `https`, host under
     `*.svc.cluster.local`), and the supervisor ignores any entry that is not one. Each GET is
     **plain, with no credentials or auth headers**; the health RPC is the only token-exempt RPC, so
     nothing secret goes in the URL. Each GET has a **short per-request timeout**, because the
     activator can otherwise hold a socket for minutes, and the URL count is **capped**. A failure
     is logged, never thrown, and the warm GETs **never delay boot**. The list is not
     request-triggered, so it is not an SSRF surface.
   - **Where it fires is decided by measurement:** the wake-ahead task (Z9, #2054) measures the
     firing point and picks the seam. Until then `register()` is the measured-too-late baseline,
     not the design.
   - **Untested failure mode, a Z9 test item** *(Z1 re-confirmation)*: a zone cold-starts while a
     bound function never answers the warm GET (for example, the activator queue is full). The test
     proves the supervisor's GET times out, leaves no open sockets, and does not delay boot.
5. **Transport: h2c by default, switchable per binding to HTTP/1.1.** The first text left the
   default to the cold-start spike. The spike measured no unary latency difference, and h2c is the
   default because it carries streaming and multiplexes; the ADR-0003 amendment's Decision 6
   records the result and the server-streaming-over-Bun check still owed before the default is
   final. *(Z1 gate.)*
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
    carries an auth option: `USER` (default) or `PUBLIC` (only on `NO_SIDE_EFFECTS` methods). The
    generator refuses `PUBLIC` on a mutating RPC. **There is no `PUBLIC_MUTATION` option in 2.0.**
    An anonymous write, such as sign-up or a contact form, is a `USER` RPC whose `authorize()`
    returns an **explicit anonymous principal**, and only after the app's own fail-closed check
    (CAPTCHA, rate limit or CSRF) has passed. So every generated mutating action still runs a
    fail-closed end-user check (ADR-0052 D5). *(Z1 gate: the first text also offered
    `PUBLIC_MUTATION`, "no user token, but the service credential is still sent". Because every
    unary RPC without `NO_SIDE_EFFECTS` is generated as a `'use server'` action (ADR-0003 amendment
    Decision 4), that option would have produced a public, state-changing endpoint with no end-user
    check, which ADR-0052 D5 and the no-unauthenticated-mutating-endpoints rule forbid.)*
13. **The token is the authoritative control; the NetworkPolicy is defense-in-depth.** A drill with
    Calico on the activator path proves a foreign request with no valid token is rejected by the
    function's interceptor even with the policy in place, and accepted if the interceptor is
    removed. Anything said about network isolation carries the CNI caveat (flannel does not enforce
    it).

### Notes from the Z1 design gate (non-blocking)

These came from the system designer as tech-debt or test items, not blockers. They bind the build.

- **Re-read the JWKS on an unknown `kid`.** A verifier that sees a `kid` it does not hold re-reads
  the mounted JWKS file before rejecting, instead of trusting a copy cached in memory; otherwise
  step 2 of the rotation order (Decision 11) does nothing on a warm pod. The re-read is
  rate-limited, so a flood of unknown `kid`s cannot become a file-read storm.
- **Mint after the wake; allow small clock skew.** The zone mints the token at call time, after it
  has woken, never ahead of a wake. Verifiers allow a small clock skew (seconds) on `exp`. The 60 s
  life covers the worst cold chain the spike measured (the 13–28 s Node zone re-wake stall,
  #2080), but a call the activator holds longer than 60 s on a saturated cluster fails with
  `UNAUTHENTICATED`.
- **Size the client deadline to cover a cold function.** The Connect deadline (ADR-0003 amendment
  Decision 5) has to cover a function's cold start (~1.4 s measured on kind, more on a loaded
  cluster) and still be shorter than the gateway timeout. The generator writes that budget down
  with its default.
- **Named untested failure mode, owned by the activator-path drill (Z11, #2056).** A JWKS rotation
  where a warm function pod has cached the old key set, combined with one call held in the
  activator for more than 60 s. The planned warm-pod rotation test does not cover it; Z11 must add
  a cold-pod rotation case and a request held beyond 60 s. Until that drill is green, Decision 13's
  claim that the token, not the NetworkPolicy, is the authoritative control is unproven.
- **Filed as #2276 (architect, at re-confirmation).** Make the anonymous principal enforceable in
  generated code: a distinct branded type rather than a user-id string, rejected by a generated
  action unless that RPC opts in through a proto option, mutation-proved. Until then, the rule that
  the app's fail-closed check passes before `authorize()` returns the anonymous principal
  (Decision 12) is documented, not enforced by generated code. The same issue tracks the
  cluster-local-only `KNEXT_WARM_URLS` bound now written into Decision 4.

### Consequences

- The operator gains a key and JWKS lifecycle, a Secret-reference allowlist and an ownership
  contract: more reconcile surface, all in new files plus two shared ones, serialised with other
  operator work.
- Cross-zone negative tests (a token from zone B replayed to zone A's function) are required in Go
  and Rust and are mutation-proved.
- mTLS through a mesh remains a possible later layer; it is not needed for this design.

### Action items

- [ ] Types and reconciler: ownerRef, same-zone rejection, allowlist (owning zone's `db-bind`,
      same-zone-marked Secrets, `imagePullSecrets` exempt), retention, served version.
- [ ] Wake-ahead through a function-agnostic core seam; the firing point and seam chosen by Z9's
      measurement (#2054); the seam's bounds from Decision 4, with the never-answering-GET test.
- [ ] Docs (D3, #2071): the namespace is the trust boundary; zones whose owners do not trust each
      other go in separate namespaces.
- [ ] Per-zone key Secret and JWKS ConfigMap; rotation in the order above.
- [ ] Interceptors in the Go and Rust templates, fail-closed, mutation-proved; JWKS re-read on an
      unknown `kid`; small `exp` clock skew.
- [ ] Generator: auth options `USER` and `PUBLIC` only; a `PUBLIC_MUTATION` option is refused.
- [ ] kind + Calico activator-path drill.
