# ADR-0004: `BackendService` CRD for polyglot backends

Status: Accepted (2026-10-12, Z1 design gate — architect and system-designer re-confirmation: [architect](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128826009), [system designer](https://github.com/getknext-dev/knext/issues/2045#issuecomment-6128845685)) · previously Proposed · Date: 2026-06 · Depends on: ADR-0001, ADR-0002 · Amended 2026-10-09 (see the amendment at the end; revised 2026-10-12 with the Z1 design gate's required changes before the re-confirmation) · Amendment 2 (2026-10-15) **Proposed**: `spec.zone`, two-sided binding, rendered binding env, operator-owned ServiceAccount, the activator as a NetworkPolicy peer, explicit RPC auth options (see the end)

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
    carries an auth option: `USER` (default) or `PUBLIC` (only on `NO_SIDE_EFFECTS` methods)
    *(Amendment 2 Decision 8, Proposed: there is no default; every unary RPC states it)*. The
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

## Amendment 2 (2026-10-15) — `spec.zone`, two-sided binding, rendered binding env, operator-owned identity

**Status of this amendment: Proposed (2026-10-15).** It is accepted or revised at the Sprint 5
close design review, and #2401 closes on that acceptance, not on this text merging. The amendment
dated 2026-10-09 above is Amendment 1. This one amends its Decisions 1, 2, 12 and 13 and the base
Decision's "injects" wording, and changes nothing else. It records the three binding contracts that
the Sprint 5 planning gates (architect and system designer) found implicit in ADR-0004 and ADR-0052.
It also records three Z8 (#2052) constraints from the same review (#2402, #2403 and the wording of the
CNPG host check), and two decisions the lead took for Z6 (#2050). Trigger class: ADR, CRD, security,
zone data sovereignty. Under the 2026-09-22 workflow amendment it is reviewed at sprint close and
is not a merge gate, but Z8's PRs are built to it and cite it.

### Context

Z8 is the first v2 component in which the operator mounts Secrets into pods that a user defines and
publishes a call path into a zone. The earlier text leaves eight points open, and each one would
turn into a defect in Z8 or Z6 if it were settled in review instead of here:

1. **How a function names its zone.** Amendment 1 Decision 1 requires "a single `ownerReference` to
   a `NextApp`". A GitOps manifest (Argo CD, Flux) cannot carry one, because an `ownerReference`
   needs the owner's UID and that UID does not exist when the manifest is written. The CLI could
   supply it only by reading the `NextApp` back after applying it, which is a race.
2. **Who may bind.** If the function alone declares the binding, anyone with RBAC to create a
   `BackendService` in the namespace can get the operator to mount the zone's `db-bind` Secret into
   a pod they control, without being able to read that Secret themselves. That is a confused deputy.
   The Secret allowlist does not stop it, because the zone's `db-bind` Secret is on the allowlist.
3. **Where the binding env lives.** The base Decision says the operator "injects"
   `<NAME>_SERVICE_URL` into the gateway, and #2052's text says "into the owning `NextApp`". If a
   reconciler writes that value into `NextApp.spec`, the operator becomes a second writer of the
   user's CR. The CLI or the GitOps controller then re-applies the user's spec, the operator writes
   the value back, and the two fight (ADR-0001).
4. **Which identity the function pod runs as.** If the user chooses `serviceAccountName` and that
   ServiceAccount has RBAC to read Secrets, the pod can fetch any Secret in the namespace through the
   API. That bypasses the allowlist completely.
5. **Who the network peer is.** At zero replicas a call reaches the function through the Knative
   activator. When the function is warm, the call arrives through the networking layer, not directly
   from the zone's pod. A policy that admits only the zone's pods drops cold calls on a CNI that
   enforces policy (Calico). Every test on flannel still passes, because flannel enforces no
   NetworkPolicy at all.
6. **What the CNPG host check is.** Amendment 1 Decision 2 rejects an environment value that names
   another zone's `-rw` or `-ro` host. An IP address, an `ExternalName` Service or a URL built at run
   time gets past that string match. So the check cannot be what keeps a function out of another
   zone's database.
7. **How the served proto version reaches the zone.** Z6 (#2050) keys every cached read on the
   function's served proto version (ADR-0066). ADR-0066 left the name of that env var to Z8's PR.
8. **Whether an RPC's auth option has a default.** Amendment 1 Decision 12 calls `USER` the
   "default". The ADR-0003 amendment's Decision 4 says the generator refuses an RPC that has no auth
   option. A default and a refusal cannot both hold: with a default, an RPC that states nothing is
   generated as `USER`, so the refusal never fires.

### Decision

1. **A `BackendService` names its zone with `spec.zone`, and the operator sets the
   `ownerReference`.** `spec.zone` is required. It holds the name of a `NextApp` in the same
   namespace, and it is immutable (a CEL `self == oldSelf` rule). The `BackendService` reconciler
   resolves it and sets the `ownerReference` itself (`controller: true`, `blockOwnerDeletion: true`),
   so garbage collection works as Amendment 1 Decision 1 intends. Users never write the
   `ownerReference`. The CLI emits `spec.zone` and never `ownerReferences` (ADR-0052 D3). Setting
   `blockOwnerDeletion: true` needs operator RBAC to `update` on `nextapps/finalizers`; without it the
   apiserver refuses the `ownerReference`. If the zone
   does not exist, the function's status is `False` with a reason that names the missing zone, and
   nothing is rendered. That condition, and every new condition this amendment adds, goes through
   `computeStatusVerdict` (`architecture.md` §4), never through a new branch in `Reconcile`. A controller `ownerReference` that disagrees with `spec.zone` is treated as a
   violation and is not overwritten. On the `BackendService`, the operator writes only
   `metadata.ownerReferences` and status, never the spec. This implements Amendment 1 Decision 1; it
   does not reverse it.

2. **Binding is two-sided.** A binding exists only when **both** halves agree:
   - the function half: `BackendService.spec.zone` names the zone;
   - the zone half: an entry in the `NextApp`'s `spec.backends[]` (the `{name, service}` list that
     the base Decision already defines) whose `service` names that `BackendService`.

   The planning notes called the zone half `spec.functions[]`. This amendment uses the base ADR's
   `backends[]` instead of adding a second list, because two lists would have to be kept consistent,
   and ADR-0065 (Proposed) already extends `backends[]`. jev: `backends[]` 1.00 / new `functions[]`
   0.00 (confidence 1.00).

   Until both halves agree, the operator **mounts nothing and renders nothing**:
   - no `db-bind` Secret or other zone Secret, no JWKS and no per-zone key;
   - no `<NAME>_SERVICE_URL` or other binding env in the zone;
   - **no function Knative Service**. One that was already rendered is deleted.

   The function's status is `False` with a reason that names the missing half. A zone entry whose
   `service` names a function with a different `spec.zone` is a cross-zone binding. It is rejected,
   as Amendment 1 Decision 1 requires, and reported on the `NextApp`'s status. Both conditions go
   through `computeStatusVerdict` (`architecture.md` §4), not through new branches in `Reconcile`. Withdrawing either
   half revokes the binding in the same way: the function's Knative Service is deleted, and the
   zone's next render drops the binding env. That revocation is deliberate, and the docs say that
   removing the zone's entry takes the function down.

   This closes the confused-deputy path only while RBAC to create a `BackendService` does not also
   grant RBAC to edit the zone's `NextApp`. A subject that holds both is acting as the zone owner. The
   namespace is still the trust boundary (Amendment 1 Decision 2).

   Two-sided consent applies to **every** binding backed by a `BackendService`, whatever its
   flavour: a function binding and an ADR-0065 `model` backend alike, because the operator can mount
   Secrets into any of them. An ADR-0065 `backends[].external` entry names no `BackendService`, so it
   has no function half and is outside this rule; it is governed by ADR-0065's own Secret rules.

   The choice between "no Knative Service" and "a bare Knative Service with nothing mounted" was
   close. jev: no Knative Service 0.69 / bare Knative Service 0.31, **low confidence (0.38)**. "No
   Knative Service" is taken because it matches the fail-closed rule (a violating spec renders no
   Knative Service). A bare function is useless anyway: without a JWKS its interceptor rejects every
   RPC except health. The sprint-close review may revisit this choice.

3. **The binding env is rendered, never written.** The `NextApp` reconciler watches
   `BackendService`s through a field index on `spec.zone`. From the zone's two-sided bindings it
   renders the binding env **into the Knative Service template it already owns**:
   - `<NAME>_SERVICE_URL` for each **function** binding (base Decision);
   - `<NAME>_SERVICE_PROTO_VERSION` for each **function** binding (Decision 7);
   - the wake list that ADR-0066 defines for the process-start primer.

   An ADR-0065 `model`-flavour binding renders the `KNEXT_AI_<NAME>_*` variables that ADR-0065 D3
   defines **instead of** the two `<NAME>_SERVICE_*` variables, not in addition. The rendering rules
   below apply to both sets.

   The reconciler **never writes `NextApp.spec`**, or any other part of the user's CR except its
   status. The `BackendService` reconciler never writes the zone's Knative Service, so each Knative
   Service has exactly one renderer. The rules that follow from that:
   - The rendered env is sorted deterministically, so a reconcile with no change rolls no revision.
   - A zone with no binding renders a template byte-identical to today's, with no new revision.
   - A served-version bump re-renders the template and rolls exactly one revision.
   - If an entry in the zone's own `spec.env` has the same name as a rendered binding variable, it is
     not overwritten. The binding is reported as failed on the `NextApp`'s status, and the report
     names the variable.

   Z8's PR fixes two names, because they are a CRD and public-API trigger: how `<NAME>` is derived
   from a `backends[]` entry's `name` (case and separator), and the name of the wake-list variable.
   The PR adds both to this decision before it is accepted, with the shared fixture that ADR-0066
   requires, tested in Go and in TypeScript.

4. **Each function runs as an operator-owned ServiceAccount.** The `BackendService` reconciler
   creates one ServiceAccount per function, with `automountServiceAccountToken: false` and no Role or
   RoleBinding, and always renders the function's pod with it. **A user-chosen ServiceAccount is
   never honoured**, because `BackendServiceSpec` has no field that could carry one: it has no
   `serviceAccountName` and no pod template. A stray `serviceAccountName` in a manifest is pruned by
   the apiserver on a non-strict apply, or rejected by the CLI's `--validate=strict` apply; either way
   it has no effect on the pod. Without this rule, Amendment 1 Decision 2's allowlist governs only
   what the operator mounts, not what the pod can read through the API. This turns the base Design's
   "least-privilege ServiceAccount" from a default into a rule. Tracked as #2403.

   This holds only while the spec has **no pod-template passthrough**. Any future field that passes
   pod-spec content through to the function must add a CEL rule that forbids `serviceAccountName` in
   it, in the same change.

5. **The function's NetworkPolicy admits the Knative data path, and it is still only
   defense-in-depth.** The policy admits two peers: the Knative serving system, which includes the
   activator that carries scale-from-zero, and the networking layer's gateway namespace. Both are
   admitted on queue-proxy's serving ports, the same peers and port allowlist that the `NextApp`
   policy uses (ADR-0044). The user container port stays out of the allowlist, because queue-proxy
   reaches it over loopback.

   Two questions are measured, not assumed: which peers actually appear, and whether the zone's own
   pods need a peer entry. A Calico scale-from-zero leg in Z8, which extends
   `networkpolicy-enforcement-drill.sh`, shows that the owning zone reaches a cold function and that a
   co-resident pod's direct dial to a warm function's pod is dropped. Tracked as #2402.

   A zone's traffic arrives through shared Knative peers, so the policy **cannot express "only the
   owning zone"**. What it can do is stop direct dials that skip the Knative path. The per-zone
   control is the token (Amendment 1 Decision 13). Enforcement depends on the CNI. flannel (OKE,
   OrbStack) enforces no NetworkPolicy, so on those clusters the object is declarative only, and any
   claim that a function is isolated must carry that caveat.

6. **The CNPG host check is a lint; the credential allowlist is the control.** The operator still
   rejects an environment literal that names another zone's `-rw` or `-ro` host (Amendment 1
   Decision 2), but status messages and docs call that check a **lint**. It catches a mistake, but it
   does not stop an IP address, an `ExternalName` Service or a URL built at run time. The
   data-sovereignty control is that the function holds **no credential for another zone's database**.
   Three decisions together make that hold: the Secret allowlist (Amendment 1 Decision 2), applied
   only through a two-sided binding (Decision 2 here), and enforced against the API by the
   operator-owned ServiceAccount (Decision 4 here).

7. **The served proto version reaches the zone as `<NAME>_SERVICE_PROTO_VERSION`**, for **function**
   bindings only; an ADR-0065 `model`-flavour binding carries no proto version and gets the
   `KNEXT_AI_<NAME>_*` variables instead (Decision 3). The `NextApp`
   reconciler renders it next to `<NAME>_SERVICE_URL`, from the served version recorded in the
   `BackendService`'s status (ADR-0052 D7). The gateway reads it at call time. If it is unset, the
   gateway **fails closed** with `FAILED_PRECONDITION`; it never falls back to a guessed or compiled-in
   version. This fixes the name that ADR-0066 left to Z8's PR. The lead decided it for Z6 (#2050).

8. **Every unary RPC states its auth option explicitly; there is no default.** This replaces
   "`USER` (default)" in Amendment 1 Decision 12 and makes that decision agree with the ADR-0003
   amendment's Decision 4. Every unary RPC must carry `(knext.v1.auth)`, and the generator refuses an
   RPC that has none. `USER` is the value that `knext add function` writes into the scaffold. It is
   not a value the generator assumes when the option is missing. The rest of Decision 12 is
   unchanged: `PUBLIC` is allowed only on `NO_SIDE_EFFECTS` methods, there is no `PUBLIC_MUTATION`,
   and generation fails closed without `authorize()`. The lead decided this for Z6 (#2050).

### Options considered

Each option below is a whole binding contract, because Decisions 1 to 4 only work together.
`spec.zone` without the zone half leaves the confused deputy open, and the zone half without
rendering still needs somewhere to write the env. Decisions 7 and 8 were taken by the lead and are
not re-scored here.

| Option | Pros | Cons |
|---|---|---|
| **A. `spec.zone` with an operator-set `ownerReference`; two-sided binding through `NextApp.spec.backends[]`; env rendered into the zone's Knative Service template; operator-owned ServiceAccount (recommended)** | GitOps can author every field. The zone owner's consent gates every mount. Each object has one writer (ADR-0001) and each Knative Service one renderer. RBAC cannot bypass the allowlist | One more watch and field index on the `NextApp` reconciler. A function stays down until its zone lists it, which changes the function-first rollout order (see Consequences). Removing the zone's entry takes the function down |
| B. Amendment 1 and the base text taken literally: a user-written `ownerReference`, one-sided binding, `<NAME>_SERVICE_URL` patched into `NextApp.spec`, a user-chosen ServiceAccount | Least operator code; matches the original wording | GitOps cannot write the `ownerReference`. The confused deputy stays open. The operator becomes a second writer of `NextApp.spec` and fights the apply. A user ServiceAccount bypasses the allowlist |
| C. `spec.zone` and rendered env, but one-sided binding; the confused deputy handled by docs that tell admins not to grant `BackendService` create to untrusted users | GitOps-friendly and single-writer; no new meaning on a `NextApp` field | The `db-bind` mount rests on a documented expectation that nothing enforces, and a failure is invisible until it has already happened |
| D. Zone side only: the `NextApp` lists its functions, the `BackendService` has no zone field, and the operator infers the owner from whichever zone lists it | One declaration; consent comes from the zone | If two zones list one function, ownership is ambiguous, and resolving it first-come depends on the apply order under GitOps. A function's own Secret references cannot be checked until some zone claims it. A cross-zone claim looks the same as a legitimate one |

**Recommendation: A.** jev (`jev-1.13.0`, 2026-10-15): A 0.94 / D 0.06 / B 0.00 / C 0.00,
confidence 0.92. The two sub-choices are scored in Decision 2: the zone half in `backends[]` 1.00 / a
new `functions[]` 0.00, and for a one-sided binding no Knative Service 0.69 / a bare one 0.31 (low
confidence, 0.38).

The planning gates scored the same calls:
- operator-set `ownerReference`: 1.00 (system designer);
- two-sided opt-in 0.84 against docs-only 0.16, and the confused deputy real at 0.80;
- one renderer per Knative Service: 0.96;
- render 0.54 against patch 0.27 (architect, confidence 0.31; decided on the ADR-0001 analysis);
- the activator-peer blackhole: close to "will happen" (1.54 of 2);
- the host check as a real control: only 0.20.

jev is a gut check here, not the evidence. The evidence is the ADR-0001 single-writer rule, the UID
fact, and the RBAC path described in Context.

### Consequences

- **CRD changes** (operator minor, additive, still `v1alpha1`): `BackendService.spec.zone` is
  required and immutable, and there is no `serviceAccountName` and no pod template. An entry in `NextApp.spec.backends[]`
  now also means the zone's consent. The CLI's schema preflight must know both fields, and Z8b
  (#2053) emits `spec.zone`, never `ownerReferences`.
- **Function-first rollout (ADR-0052 D7) now needs the zone half in place.** A function is not
  rendered until its zone lists it, and listing it renders the binding env into the zone. So
  "function first" now means: apply the `BackendService`, add the zone's `backends[]` entry, and let
  the function come up while the zone's new revision rolls. The skew condition still flags a
  function older than its zone. Under GitOps the controller sets the order, as ADR-0052 D7's note
  already says. Until the operator has recorded a served version, the zone's
  `<NAME>_SERVICE_PROTO_VERSION` is unset, so its calls fail closed (Decision 7) rather than run
  against an unknown version.
- **The `NextApp` reconciler gains a watch on `BackendService`s.** Its render changes only for zones
  with a two-sided binding, which the byte-identical golden test proves. The rendered binding env is
  one more item on the operator minor's expected-churn list (the system designer's issue 5).
- **Revoking consent causes an outage, by design.** Removing a zone's `backends[]` entry deletes the
  function's Knative Service, and the docs say so.
- **A brief loss of the zone half costs a cold start.** If a `NextApp` syncs even briefly without
  its `backends[]` entry (a GitOps sync of a partial manifest, a bad merge reverted a minute later),
  the operator deletes the function's Knative Service, and when the entry returns it re-creates it.
  The function then comes back through a fresh Knative Service and a cold start, not a warm
  revision. For a model backend the cost is far larger: re-creating it also reloads the model
  weights. There is no grace period in this design; the sprint-close review may add one.
- **The NetworkPolicy wording changes.** "Admitting only the owning zone" (Amendment 1 Decision 1 and
  #2052's scope text) becomes "admits the Knative data path and blocks direct dials". The isolation
  claim belongs to the token, and it stays unproven until the activator-path drill (Z11, #2056) is
  green, as Amendment 1's notes already say.
- **Docs and status call the host check a "lint".** No user-facing text calls it isolation.
- **Generator (Z6, Z3):** an RPC without `(knext.v1.auth)` is refused, with a test proving it.
  `knext add function` scaffolds `USER` explicitly.

### Action items

- [ ] Z8 (#2052) types: `spec.zone` required and immutable (CEL), no `serviceAccountName` and no pod
      template.
- [ ] Z8 reconciler: resolve `spec.zone`, set the controller `ownerReference`, refuse a conflicting
      one. Envtests for a missing zone, the operator-set `ownerReference` and a conflicting
      `ownerReference`, each mutation-proved. New conditions go through `computeStatusVerdict`.
- [ ] Z8 RBAC: grant the operator `update` on `nextapps/finalizers` (a kubebuilder RBAC marker), which
      `blockOwnerDeletion: true` requires. An envtest with RBAC enforced proves the `ownerReference` is
      accepted, and is red without the grant.
- [ ] Z8 (#2401): two-sided binding. Envtests for a one-sided binding from each side (refused, nothing
      mounted, no Knative Service, no binding env), a cross-zone `backends[]` entry, and revocation,
      each mutation-proved.
- [ ] Z8: render into the zone's Knative Service template. Envtests prove zero writes to
      `NextApp.spec`, a byte-identical template for a zone with no binding, no revision on a second
      reconcile, exactly one revision on a served-version bump, and a reported env-name collision. The
      same PR adds the `<NAME>` derivation and the wake-list variable's name to Decision 3.
- [ ] Z8 (#2403): operator-owned ServiceAccount, automount off, no RBAC. A test proves the rendered
      pod always uses it and a stray `serviceAccountName` has no effect, mutation-proved.
- [ ] Z8 (#2402): function NetworkPolicy admitting the Knative data path. A Calico scale-from-zero leg
      in `networkpolicy-enforcement-drill.sh`, which Z11 then extends.
- [ ] Z8 docs and status wording: the CNPG host check is a lint, the credential allowlist is the
      control, and removing a zone's entry takes the function down.
- [ ] Z6 (#2050): read `<NAME>_SERVICE_PROTO_VERSION` at call time and fail closed with
      `FAILED_PRECONDITION` when it is unset. The generator refuses an RPC without `(knext.v1.auth)`.
- [ ] Sprint 5 close: accept or revise this amendment, then close #2401.
