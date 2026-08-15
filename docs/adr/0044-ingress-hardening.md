# ADR-0044: Ingress hardening — rate limiting, payload caps, malformed-request handling

- Status: Proposed (v2 — rewritten after a double design-gate BLOCK; both verdicts in
  `knext-plan-out/{arch,sysdes}-gate-adr44.md`)
- Date: 2026-08-15
- Deciders: architect gate, system-designer gate, maintainer
- Context: security sprint 2026-08-15, task S3 (trigger-class by construction)

## Context

`security.md` ("Runtime hardening") requires a reverse proxy in front of knext apps for rate
limiting, payload-size limits, and malformed-request handling — and marks security invariants
as every-phase work. `CLAUDE.md` §6 places rate limiting/WAF/edge in **Tier C**, after Tier-A
correctness, which is not exited. This ADR resolves that tension explicitly: what lands now,
what waits, and on what clock.

### Threat scope, named first

Two ingress paths reach a knext app. The first draft of this ADR claimed both were
concurrency-bounded; the architect gate proved that false in the tree, so the corrected picture
is the foundation here:

1. **External**: LoadBalancer → Kourier (Envoy) → activator/queue-proxy → app container.
   Three HTTP parsers, `containerConcurrency` enforced.
2. **In-cluster**: the operator's default NetworkPolicy ingress rule carries **no `Ports`
   restriction and an empty same-namespace `PodSelector`** (`nextapp_controller.go:1301-1314`),
   so any co-resident pod can dial the app container's `$PORT` **directly — bypassing
   queue-proxy entirely**. No concurrency bound, one HTTP parser (Node's llhttp). This path is
   **unbounded**, not "bounded by cc" as the first draft claimed.

### What the payload gap actually costs (corrected: vertical, not economic)

`containerConcurrency` bounds concurrent *requests*, never *bytes per request*. With the
operator's defaults (cc=20, maxScale=10, memory limit **1Gi**, `nextapp_controller.go:866`):

- **One** request whose body an App Router route handler buffers (`await req.json()`) can OOM
  a pod. Scale-out does not help — the attack is vertical. The blast is up to **19 co-resident
  in-flight requests killed** with it.
- **OOMKill is SIGKILL**: it bypasses `node-server.ts`'s SIGTERM path entirely — in-flight
  drain, Next `after()`, and `registerDbPoolDrain` all skipped. Leaked connections then eat
  into the ADR-0028 `maxScale × poolMax ≤ 80` connection budget while the restarted pod opens
  a fresh pool, and every restart pays a full cold start. Repeated OOM therefore converts a
  payload bug into an **availability + connection-wall failure**, not a billing line.
- Aggregate slow-body flooding is bounded by `maxScale × 1Gi` of memory and the connection
  budget — a worked ceiling, not an abstraction: 10 pods × 1Gi with defaults.

### What is already bounded (corrected)

- External-path concurrency (queue-proxy) and scaling overload (ADR-0028/0032/0033) — on the
  external path only.
- Server Action bodies: Next caps them at **1 MB by default** (`serverActions.bodySizeLimit`).
  This covers *only* Server Actions — **not route handlers**, which are the open surface.
- Malformed HTTP on the external path (three parsers); Node's 16 KB header cap on both.
- Knative's per-revision `timeoutSeconds` exists as a bound on slow requests.
  **Evaluated during S4-op (2026-08-16), as this ADR required, and the finding is: it is
  already wired and already applied.** `spec.timeoutSeconds` flows into
  `ksvc.Spec.Template.Spec.TimeoutSeconds` with a default of **300s**
  (`nextapp_controller.go`), so every knext app already caps how long a single request may
  occupy a concurrency slot — including a slow-body request, on **both** ingress paths, since
  the setting is enforced by the queue-proxy inside the pod. **No change is made here**, for
  two reasons: 300s matches the platform default users expect from the framework, and lowering
  it globally would silently break long-running streaming responses. Operators who want a
  tighter slow-request bound set `spec.timeoutSeconds` per app — that is the documented knob,
  and it is a per-app decision, not a platform-wide one. Recorded rather than actioned so the
  ADR's action item is closed by evidence instead of left ambiguous.

### A structural fact that constrains every option

`node-server.ts` does not proxy traffic. The standalone `server.js` listens on `$PORT` itself;
knext's runtime entry spawns it and serves metrics on :9091. There is **no knext-owned
in-process request path today** — an "adapter-level cap" is a new hop, not a config line.
(`RuntimeContract` itself exists only in ADRs-0036/0042 today, not as code.)

## Options considered

| | Option | Binds path 2 (in-cluster)? | Per-app? | Cost | Verdict |
|---|---|---|---|---|---|
| A | Kourier/Envoy cluster config | No — path 2 never reaches Kourier | No — cluster-shared config cannot express per-app policy | none | **Rejected**: not per-app and misses the actual threat path |
| B | Per-app Envoy/nginx sidecar, operator-injected | Yes | Yes | Extra container on the cold-start path; every request pays the hop | **Rejected** for the fame phase; re-open only with Tier-C evidence |
| C | knext-owned in-process front socket (owns `$PORT`, counted-bytes caps + read deadlines, loopback-forward to `server.js`) | **Yes** — inside the pod, behind whatever got through | Yes | New hop; touches the runtime; real design surface (see pre-constraints) | **Deferred with a clock** (below) |
| D | Documented recipe + framework defaults (front proxy for external; explicit body validation in app code) | No | n/a | none | **Accepted now**, with honest caveats |
| E | **Tighten the NetworkPolicy**: restrict `Ports` to the queue-proxy port and scope the same-namespace peer's `PodSelector`; set revision `timeoutSeconds` | **Partially, and it is the only zero-runtime option that binds it at all**: forces path 2 through queue-proxy, restoring the cc bound + the Go parser; does not cap bytes | Yes (operator-owned, per-app) | Operator change + tests; no runtime, no new hop, no cold-start cost | **Accepted now — this is S4's implementable slice** |

## Decision

**Options D + E now; Option C deferred on a named contract condition with a review date —
and the interim recorded as a bounded, dated exception to `security.md`, not as compliance.**

1. **Option E (operator, this sprint = S4):** the default NetworkPolicy gains a `Ports`
   restriction (queue-proxy port only) and a scoped same-namespace peer. Evaluate
   per-revision `timeoutSeconds` in the same change. Zones motivation, named: the current
   empty `PodSelector` lets **co-resident zones call each other's app pods synchronously**,
   outside the SCS "browser or async events only" contract (`scs-zones.md`) — not a
   sovereignty breach, but a contract leak this closes. Exit criteria: contract test
   red-before/green-after proving a direct `podIP:$PORT` dial from a same-namespace pod is
   refused while queue-proxy traffic flows — **run on a policy-capable CNI (kind + Calico or
   Cilium)**, because flannel ships no NetworkPolicy controller and both OKE GA and OrbStack
   run flannel (the repo already records this at `scale-zero-pg/deploy/70-networkpolicy.yaml`):
   on those clusters the object is **declarative-only and enforces nothing**, so a refusal
   test there would read green on an unenforced object, and the docs/threat model must state
   that Option E's enforcement is CNI-conditional. `timeoutSeconds` bounds slow *requests*,
   not bytes — named as partial.
2. **Option D (docs, this sprint = S4):** the hardening recipe, written so it cannot mislead:
   - it binds the **external path only** — the recipe says so in its first paragraph;
   - `serverActions.bodySizeLimit` defaults to 1 MB and covers **Server Actions only** — there
     is **no global body cap**, and route handlers must validate size in app code (worked
     example: counted-bytes read, not `Content-Length` — chunked encoding carries no length);
   - front-proxy caveats stated: rate-limit counters are **per-proxy-replica** (N replicas =
     N× the limit unless the proxy shares state); chunked bodies force the proxy to buffer;
     cloud-LB payload policies are **verify-per-cloud**, not assumed.
3. **Residual risk into `threat-model.md`** (S4), stated in the corrected vertical framing:
   one oversized buffered body = one pod OOMKilled (SIGKILL — drain, `after()`, and DB-pool
   drain all bypassed; connection budget damaged; cold start paid), until Option C.
   Also recorded: **no test today exercises the OOM/SIGKILL path** — the drain gate only
   proves SIGTERM; the connection-leak consequence is currently unobservable.
4. **Option C, deferred with a clock and pre-constraints** (the first draft gated it on the
   vinext go/no-go; the architect gate corrected this — ADR-0042 is *Accepted*, so that gate
   had no clock):
   - **Condition**: the shared `RuntimeContract` (to be written as code, not prose) names the
     `$PORT` owner — specifiable now, independent of which runtime wins;
   - **Clock**: re-reviewed at every sprint close, with a **hard expiry**: the exception
     closes at Tier-A exit or v1.0, whichever comes first — a renewable clock with no
     backstop renews forever by default. DATED (opened 2026-08-15) per the ADR-0015
     bounded-exception precedent;
   - Pre-recorded design constraints: lives in `RuntimeContract`, both build targets, never
     one ("don't rewrite the runtime twice"); **counted-bytes** enforcement, never
     `Content-Length` alone; pass-through for `Upgrade`/101 and unbuffered RSC/SSE streams;
     h2c behavior decided explicitly; **readiness gates on the child's listen** (else
     scale-from-zero returns loopback ECONNREFUSED while reporting ready); two-stage drain
     (stop accepting → drain → forward SIGTERM) inside the existing hard cap; red-on-fail
     compat gating per ADR-0007 — never skip; a named cold-start budget per ADR-0035/0037;
     any `spec.security.ingress.*` CRD knob records its ADR-0017 (v1alpha1) and #548
     upgrade-order consequences at design time.

### Why this is admissible under `security.md` — stated as an exception, not compliance

The first draft called the recipe "satisfiable by deployment topology"; the architect gate
called that a rationalization, and it was. The honest form: knext does not yet ship in-process
payload/rate protection; Options D+E close the paths that can be closed without touching the
runtime; the remainder is a **bounded, dated exception** (this ADR, 2026-08-15, re-reviewed
each sprint close) with its blast radius quantified above — the same shape as ADR-0015's
bounded ingest exception.

## Consequences

- S4 becomes two tasks: **S4-op** (Option E operator change, full pipeline: TDD, kind, OKE)
  and **S4-docs** (recipe + threat-model entry).
- The byte-cap gap on path 2 narrows (queue-proxy restored) but stays open until Option C;
  its cost is stated in pods-killed and connections-leaked, not dollars.
- A later Option C implementer inherits a complete constraint set from Decision 4.

## Action items

- [ ] S4-op: NetworkPolicy `Ports` + scoped same-namespace peer + `timeoutSeconds`
      evaluation (operator; contract test proves the direct-dial refusal). Architect-gate
      residuals bound into the task: the `Ports` restriction **must still admit :9091**
      (the operator stamps `prometheus.io/port=9091`, `nextapp_controller.go:820` — a
      queue-proxy-only rule kills scraping; the contract test asserts BOTH halves: app-port
      refused AND metrics-port scrapable); tightening a default-on policy is a **behavior
      break** for existing in-namespace callers, so it ships with a
      `spec.security.networkPolicy` escape hatch and a release note.
- [ ] S4-docs: hardening recipe (external-only framing, no-global-cap warning, per-replica
      rate-limit caveat) + threat-model.md residual entry incl. the untested OOM/SIGKILL path.
- [ ] Ticket: Option C design brief per Decision 4 (RuntimeContract-as-code prerequisite).
- [ ] Sprint-close standing item: re-review the dated exception until Option C lands.
