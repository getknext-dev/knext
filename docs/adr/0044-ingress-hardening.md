# ADR-0044: Ingress hardening — rate limiting, payload caps, malformed-request handling

- Status: **Accepted** (2026-08-16, on merge of the Option E implementation). v2 — rewritten
  after a double design-gate BLOCK; both verdicts in
  `knext-plan-out/{arch,sysdes}-gate-adr44.md`. Option E shipped in PR #734 with both
  sign-off gates cleared; Options D (docs) and C (deferred, dated clock) stand as written.
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

## Amendment 1 (2026-08-16): a third ingress rule for cross-namespace scraping

**Status of this amendment: ACCEPTED** (2026-08-16). Summoned by a spec-reviewer escalation rather than a mechanical trigger; both design gates BLOCKed once and then signed off — the architect on a false mitigation repeated in five places, the system designer on a residual that was wrong in both directions and on revocation never being tested.

Option E as accepted specified two ingress rules — serving+metrics from the system namespaces, and
metrics-only from the same namespace. Implementing it surfaced a gap **both design gates predicted
in their sign-off**: the operator ships its own `PodMonitor` with `namespaceSelector: any`, so its
scrape of `:9091` is cross-namespace and was denied on every policy-enforcing CNI. Filed as #735,
fixed by a **third rule** admitting namespaces labelled `knext.dev/metrics-scrape=true` on the
**app metrics port only** (`9091` — narrower than the same-namespace rule, since the PodMonitor
targets nothing else).

**Why this is recorded here rather than left in the PR.** The change widens the peer set of a
default-on security policy cluster-wide and alters the policy shape this ADR fixed. The
implementing team judged it in-scope because it adds no CRD field and therefore trips no
mechanically-detected trigger; **the spec reviewer escalated, correctly** — avoiding the
public-API trigger does not clear the security-invariant trigger or the ADR-amendment trigger, and
`workflow.md` gives reviewers exactly that escalation power. The un-automated half of the trigger
list is the half that needed a human judgement, and it got one.

**What the amendment does NOT claim.** Rule 3 is namespace RBAC, not a per-app privilege boundary:
the label sits on a cluster-scoped Namespace, so the grantor is whoever holds `update namespaces`;
once labelled, every pod in that namespace can scrape `9091` on every knext app; and there is no
`PodSelector` because the operator cannot know a user's Prometheus labels. Recorded as a residual in
`docs/security/threat-model.md` §6 rather than presented as isolation.

An earlier draft of this amendment said operators needing tighter identity "should add their own
policy alongside". That is **false**, and the architect gate blocked on it: NetworkPolicies are
**additive**, so a second policy unions its allow-rules with knext's and cannot narrow this grant.
The only narrowing lever is `spec.security.networkPolicy: false` — disable knext's policy and bring
your own.

## Consequences

- S4 becomes two tasks: **S4-op** (Option E operator change, full pipeline: TDD, kind, OKE)
  and **S4-docs** (recipe + threat-model entry).
- The byte-cap gap on path 2 narrows (queue-proxy restored) but stays open until Option C;
  its cost is stated in pods-killed and connections-leaked, not dollars.
- A later Option C implementer inherits a complete constraint set from Decision 4.

## Action items

- [x] **DONE (#734, #739).** S4-op: NetworkPolicy `Ports` + scoped same-namespace peer + `timeoutSeconds`
      evaluation (operator; contract test proves the direct-dial refusal). Architect-gate
      residuals bound into the task: the `Ports` restriction **must still admit the app
      metrics port** (:9091 as accepted; **:9464 since Amendment 5**)
      (the operator stamps `prometheus.io/port` with the same number — a
      queue-proxy-only rule kills scraping; the contract test asserts BOTH halves: app-port
      refused AND metrics-port scrapable); tightening a default-on policy is a **behavior
      break** for existing in-namespace callers, so it ships with a
      `spec.security.networkPolicy` escape hatch and a release note.
- [x] **DONE (#736).** S4-docs: hardening recipe (external-only framing, no-global-cap warning, per-replica
      rate-limit caveat) + threat-model.md residual entry incl. the untested OOM/SIGKILL path.
- [x] **DONE — filed as #743** (it had NOT been filed; the architect gate caught that at sprint
      close, which is why an action item that says "file a ticket" needs the ticket number written
      back into it). Option C design brief per Decision 4 (RuntimeContract-as-code prerequisite).
- [ ] **BLOCKED on #742 — and this is the exception's load-bearing defect.** The stated hard expiry
      is "Tier-A exit or v1.0". **Tier A has contents but no exit criteria**, which is the precise
      form of the problem: `CLAUDE.md` §6 *does* enumerate what Tier A contains (image
      optimization, graceful shutdown, control-plane consolidation, compat-suite gate) and then
      says "see `ROADMAP.md` for detail **+ exit criteria**" — and `docs/ROADMAP.md`
      **does not exist**. `docs/MATURITY_PLAN.md` uses Phases 0–6 with no Tier A;
      `docs/V1_ROADMAP.md` contains no such string. So the doc points at exit criteria in a file
      that was never written. An expiry anchored to an undefined event cannot
      fire, so as written this exception renews forever — the architect gate's verdict was that it
      "is a way to ship without the control". Re-anchor once #742 defines the term, and replace this
      prose re-review with a mechanical one.

## Amendment 2: the expiry is re-anchored — its old anchor became unreachable

**Status of this amendment: ACCEPTED (founder-approved, stability-sprint planning).**

Decision 4's hard expiry — "the exception closes at Tier-A exit or v1.0, whichever comes first" —
was already flagged above as anchored to an undefined event (#742). It has since gotten worse, not
better: ADR-0048 made the official compat suite unable to cover the shipped path, and Tier-A exit
was defined in terms of compat-suite green. **The expiry's anchor is now unreachable by
construction, not merely undefined.** A live security exception whose deadline can never fire is a
decision to ship without the control, made as a side effect of a performance decision — the exact
shape this ADR's own architect gate objected to.

**Re-anchor:** the exception now expires at the **first sprint close after the vinext-axis compat
lane publishes its first run** (the lane is this sprint's centerpiece, task B1 of
`.claude/sprint-stability-taskgraph.md`). That event is scheduled work with an owner, not an
aspiration: if B1 lands this sprint, the Option C byte cap becomes next sprint's obligation, and
this exception may not be renewed past it without a further founder-approved amendment recorded
here. The v1.0 backstop stays: whichever comes first.

Unchanged: every pre-recorded design constraint in Decision 4 (counted-bytes, Upgrade/101
pass-through, readiness-gates-on-listen, two-stage drain, red-on-fail compat gating). The
constraint set transfers to the single-exec runtime as-is — the compiled binary's entry
(`knext-bun-entry.mjs`) is now the one place the cap lives, which simplifies the "both build
targets, never one" clause to a single target by ADR-0048.

## Amendment 3: flannel clusters are formally unsupported-for-isolation (records #744's criterion 5)

**Status of this amendment: ACCEPTED (stability sprint, C4 verification pass).**

Issue #744's last acceptance criterion asked for a decision that the shipped code and docs had
already taken de facto but nothing recorded: what knext does about clusters whose CNI enforces no
NetworkPolicy (flannel — which OKE GA and OrbStack, the reference clusters, both run).

**Decision: flannel-class clusters are formally documented as unsupported for network isolation;
the reference cluster is NOT moved to a policy-capable CNI.** The operator still writes its
default-on NetworkPolicy (harmless, and correct the moment a policy controller appears), and the
inertness is OBSERVABLE on both halves — the `NetworkPolicyEnforced` condition computed in
`computeStatusVerdict` (`status_verdict.go:484-552`, envtest-covered including the flannel case)
and the `kn-next doctor` CNI check (`doctor.ts:1178-1268`, fail-honest: "cannot determine" is
never folded into "enforced"). Users who need enforced isolation install Calico or Cilium; the
docs say exactly that (`security.mdx`, `hardening.mdx`).

Why not move the reference cluster: the enforcement contract is already proved by the kind+Calico
drill this ADR requires, and moving OKE's CNI buys no user-facing guarantee — any user's flannel
cluster would be in the same observable, documented state regardless of what our cluster runs.


## Amendment 4: Option C is implemented in-process — the dated exception CLOSES

**Status of this amendment: ACCEPTED (sprint-2 task T1).**

### The measurement that collapsed Option C from a subsystem to a flag

Decision 4 described Option C as a knext-owned front socket that owns `$PORT` and loopback-forwards
to a child. That shape was correct for the world it was written in: `node-server.ts` spawned a
separate `server.js` and there was **no knext-owned request path**. ADR-0048 removed that premise —
vinext is now the only available builder, the compiled binary's entry (`knext-bun-entry.mjs`) *is*
the request path, and it already serves through srvx.

srvx exposes `maxRequestBodySize` and, on Bun, forwards it straight to `Bun.serve`
(`dist/adapters/bun.mjs`). Its own portable fallback (`_body-limit.mjs`) is **counted bytes** —
`size += value.byteLength`, never `Content-Length`. So the whole of Option C is one option key at
each of the two listeners. **Measured before any code was written**, on Bun 1.4.0, cap 1000 bytes:

| case | result |
|---|---|
| honest 500-byte body | `200`, handler sees 500 |
| honest 5000-byte body, `Content-Length: 5000` | `413` |
| **chunked 5000 bytes, NO `Content-Length`** | **`413` — the cap counts bytes** |
| lying `Content-Length: 100`, 5000 bytes sent | handler sees exactly 100; the excess never arrives |

Decision 4's counted-bytes constraint is therefore met by the flag, and the "counting
`TransformStream` in srvx middleware" fallback the design named is not needed. (It could not have
been built as described anyway: srvx's `callMiddleware` passes the **original** request to `next()`
and discards whatever a middleware returns, so a middleware cannot substitute a limited request.)

### The dependency that measurement also exposed: the Bun floor is now load-bearing

The same experiment on **Bun 1.3.5** gives a different answer: honest oversize → `413`, but the
**chunked** body of the same size reaches the handler with a `200`. The counted-bytes guarantee
arrives in Bun 1.4.0. `packages/kn-next/src/cli/vinext-build.ts` already refuses to build under
1.4.0 — a floor put there for compile correctness — so every shipped binary carries a compliant
runtime. That floor is now a **security** dependency as well, and lowering it would silently
downgrade this control, so `scripts/lib/request-byte-cap.mjs` fails if `MIN_BUN_MINOR` drops.

### What shipped

- **Default `8388608` (8 MiB).** This ADR's own arithmetic: 1Gi limit ÷ `containerConcurrency` 20.
  Deliberately **above** Next's 1 MB `serverActions.bodySizeLimit` so two layers never answer at one
  threshold.
- **`:9091` capped at 64 KiB, FIXED.** That listener ran at Bun's 128 MB default on the exact
  co-resident-pod path this ADR's threat scope names as unbounded. It is not a function of the env
  knob, so the app-side escape hatch cannot re-open it.
- **Config surface: env only — `KNEXT_MAX_REQUEST_BYTES`.** Deliberately **not** a CRD field: that
  would trip both the CRD/public-API trigger and ADR-0017/#548's operator-then-CLI upgrade order for
  a value `spec.env` already delivers. A CRD field remains available as follow-up, with that
  upgrade-order consequence written down here at design time as Decision 4 requires.
  `0` uncaps explicitly and is logged loudly; any invalid value falls back to the default with a
  warning — a manifest typo must never remove a control.
- **Cold-start cost: one integer parse at module scope.** No new import, nothing per request.

### The one constraint that could NOT be met, stated rather than quietly dropped

Decision 4 asked that the `413` name which cap fired. **It cannot, in-process.** Bun synthesizes the
rejection before any user code: the body is empty, there is no `content-type`, and the `error` hook
does not fire (measured). The only ways to attach a message would be to widen the cap so oversize
declared-length requests reach a knext handler — weakening the control — or to rebuild the `Request`
and drop srvx's expando augmentation (the #460 bug-2 class). Both were rejected. The cap is made
discoverable at **boot** instead (`REQUEST_BYTE_CAP:<bytes> METRICS_BYTE_CAP:<bytes> (<source>)` on
stdout, every start) and in `hardening.mdx`, which now documents the platform cap as shipped rather
than the reverse-proxy recipe as the only payload control.

### The clock, honestly

Amendment 2 re-anchored the expiry to "the first sprint close after the vinext-axis compat lane
publishes its first run", with a v1.0 backstop. **This did not wait for that anchor.** The control
is roughly four lines; landing it early retires a live security exception, which is strictly better
than renewing it a third time and strictly better than making a security fix wait on a CI lane.
Nothing here should be read as the anchor having fired — it is a decision not to need it.

**The dated exception recorded in Decision 4 and §"Why this is admissible under `security.md`" is
CLOSED as of this amendment.** `security.md`'s "reverse proxy in front for rate/payload limits" is
now satisfied for **payload** by a platform control on every path, including the co-resident one a
front proxy never saw. **Rate limiting remains a documented recipe, not a platform feature** — that
half of the runtime-hardening invariant is still open and must not be claimed as closed.

### Guards

`tests/request-byte-cap.test.ts` (wiring, over a SCAN of every file that serves through `srvx/bun`
— the five entry copies plus the e2e harness, so a cap wired into two of five reds) and
`examples/bun-exec/test/request-byte-cap.test.ts` (behavioural, real sockets: honest-413,
**chunked-413**, under-limit pass-through, bodyless `Upgrade` pass-through, a streaming SSE response
still streaming, the metrics-listener cap (`:9091` then, `:9464` since Amendment 5) with a working
scrape, the env override, and `0` uncapping with its boot log). Mutation-proved by
`scripts/mutation-prove-bytecap.mjs`, 7/7.

## Amendment 5 (2026-09-05, #951): the app metrics port moves 9091 → 9464

Every `:9091` in this ADR — Amendment 1's grant, the Action-item residual that the `Ports`
restriction "must still admit :9091", Amendment 4's metrics-listener cap — described the app
metrics port **as it was when those sections were accepted**. That port is now **9464**, and the
reason is a defect this ADR's own threat modelling missed:

**The collision.** knext's `appMetricsPort` was literally
`knativenetworking.UserQueueMetricsPort` (9091) — but that constant names the port **queue-proxy
itself binds** for its user-metrics server whenever serving's request-metrics protocol is
`prometheus`. On such a cluster (the pre-OTel serving default; still one `config-observability`
key away on v0.48+), app and sidecar raced for :9091 inside the shared pod netns, the app lost
with `EADDRINUSE`, and every scaffolded app crash-looped (S3-V Finding C-2, reproduced on fresh
kind, Serving v1.16.0). The port this ADR hardened was one the platform could never safely own.

**The swap.** 9464 (the conventional OpenTelemetry Prometheus-exporter port; queue-proxy binds
nothing there under any protocol) on every contract surface in one change: the entries'
`METRICS_PORT` default (all five copy-pinned homes + the bun-exec Dockerfile), the operator's
`prometheus.io/port` annotation, this policy's `appMetricsPort` in all three ingress rules, and
the shipped PodMonitor. Locksteped by `metrics-port-lockstep.test.ts`, which also asserts the
shared port is outside the queue-proxy-owned set `{8012, 8013, 8022, 8112, 9090, 9091}`.

**A grant is deliberately LOST, not migrated.** The old rules' 9091 entries incidentally admitted
scrapes of **queue-proxy's user-metrics server** (same port, same pod) from the same namespace
and from `knext.dev/metrics-scrape`-labelled namespaces. After the swap, :9091 is not admitted by
any rule: on a policy-enforcing CNI, queue-proxy user metrics are no longer scrapable through the
default policy. That loss is intentional — the grant existed only as a side effect of the port
collision, no shipped scrape config targets it (the PodMonitor never did), and re-adding 9091 to
keep it would re-widen the policy for a consumer that does not exist. A cluster that wants
queue-proxy user metrics brings its own policy (`spec.security.networkPolicy: false` + BYO, per
Amendment 1's additivity note).

**Rule structure is unchanged**: same three ingress rules, same peers, same policy shape — only
the app-metrics port number moved. The Amendment-1 kind+Calico enforcement drill
(`test/networkpolicy-enforcement-drill.sh`) is repointed to 9464 and must be re-run to remain the
enforcement evidence; a drill run recorded against 9091 no longer proves the shipped policy.
