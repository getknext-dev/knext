# knext troubleshooting guide (failure playbooks)

A consolidated **symptom → cause → fix** catalog for the failure modes that keep
a `NextApp` from deploying, scaling, or serving. It is the day-2 companion to the
[incident runbook](./incident.md) (the 3am alert-driven playbook): start here
when a deploy is broken or an app is misbehaving and you want to identify *which*
failure mode you are in.

Two facts shape every entry (both from ADR-0001):

1. **The operator is the single source of truth.** You change desired state by
   editing the `NextApp` CR (or via `kn-next`, which only patches the CR) — never
   by `kubectl edit` on the Knative Service, Deployment, or NetworkPolicy the
   operator owns. Hand-edits are reconciled away.
2. **The operator narrates itself.** Every reconcile writes status **Conditions**
   (`Ready`, `Degraded`, `Reconciling`) and emits Kubernetes **Events** with
   stable `reason` codes. Those two surfaces — plus the
   [SLO alerts](../observability/slos.md) — are how you tell these failure modes
   apart. This guide links each mode to the exact condition/event/alert that
   surfaces it.

## First move: run the diagnostic

Before anything else, run the audited preflight — it is **read-only** (every
call is a `kubectl get`; ADR-0001) and catches the majority of "won't deploy"
causes in one shot:

```sh
kn-next doctor            # human table
kn-next doctor --json     # machine-readable, exit 1 on any FAIL/ERROR
```

`kn-next doctor` checks: NextApp CRD present + served, operator Deployment Ready,
cert-manager webhook prereq, Knative ingress-class vs the reconciler that serves
it (#208), operator-image anonymous pullability (#198), and Knative Serving
installed. A FAIL prints a one-line repair hint. If `doctor` is green and you
still have a problem, work through the per-app sections below.

Then read the app's own narration:

```sh
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.conditions}' | jq
kubectl describe nextapp <app> -n <ns>          # Events, at the bottom
kubectl get events -n <ns> --field-selector involvedObject.name=<app> \
  --sort-by=.lastTimestamp
```

The `Ready`, `Degraded`, and `Reconciling` conditions carry a `reason` and
`message`; the same reasons appear as Event `reason` codes. The table below maps
every reason to a section.

## Reason / condition → section map

| Surfaced by | reason / condition | Section |
| --- | --- | --- |
| Event + `Degraded=True` (`InvalidSpec`) | `InvalidImage` | [1](#1--image-rejected-latex-or-tag-only-not-digest-pinned) |
| Event + `Degraded=True` | `ReconcileFailed` | [2](#2--reconcile-failing-degradedtrue) |
| `Ready=Unknown/False` | `IngressNotProgrammed` | [3](#3--route-never-programs-ingressnotprogrammed) |
| `Ready=False` + Event | `PinnedRevisionNotFound` | [4](#4--pinned-rollback-revision-missing-pinnedrevisionnotfound) |
| Event (Warning) | `EnvVarIgnored` | [5](#5--databaseurl-binding--envmap-collision-envvarignored) |
| Pod status | `ImagePullBackOff` | [6](#6--imagepullbackoff-on-fresh-nodes) |
| Pod status | `CreateContainerConfigError` | [7](#7--secretdatabaseurl-missing-or-mis-keyed) |
| Alert `KnextColdStartLatencyHigh` | — | [8](#8--cold-start-latency-timeouts) |
| App logs / DB connect | — | [9](#9--database-scale-zero-pg-wake-timeout) |
| Unreachable pod / activator 503 | — | [10](#10--networkpolicy-blocks-the-activator) |
| Webhook rejects every apply | `failurePolicy: Fail` | [11](#11--apply-rejected-admission-webhook-not-ready) |

---

## 1 — Image rejected (`:latest` or tag-only, not digest-pinned)

**Symptom.** `kn-next deploy` or `kubectl apply` is accepted but the app never
rolls out; `kubectl describe nextapp <app>` shows a Warning Event with
`reason: InvalidImage` and the status carries `Degraded=True`
(`reason: InvalidSpec`). The Event message reads, verbatim from the validator:

```
image "myapp:latest" uses the :latest tag which is forbidden:
use a digest-pinned ref (e.g. myapp:v1@sha256:<hash>)
```

**Cause.** The operator (and its admission webhook — same shared
`internal/validation`) enforces **digest pinning** (ADR-0001). A mutable ref
would break the rollback guarantee (a pinned revision could silently change),
so the operator rejects:

- `…:latest` — the mutable `:latest` tag;
- any tag-only ref with no `@sha256:` digest (implicitly mutable);
- a ref with no tag or digest at all (resolves to `:latest`).

Only refs containing `@sha256:` are accepted.

**Fix.** Pin the image to its digest and re-apply:

```sh
# resolve the digest of the tag you built
docker buildx imagetools inspect ghcr.io/you/myapp:v1 --format '{{json .Manifest.Digest}}'
# then set image: ghcr.io/you/myapp:v1@sha256:<hash>  in the NextApp / kn-next.config
```

`kn-next deploy` resolves the digest for you; if you author the CR by hand, the
`@sha256:` suffix is mandatory. Note the rejection happens **twice** — once at
admission (webhook, synchronous) and again in the reconciler — so a webhook that
is down (§11) does not let a bad image slip through the operator.

## 2 — Reconcile failing (`Degraded=True`)

**Symptom.** `Degraded=True` with `reason: ReconcileFailed`; a Warning Event
with the same reason names the failing step (e.g. "Failed to reconcile child
Service", "Failed to reconcile NetworkPolicy"). The alert
`KnextOperatorReconcileErrors` fires when `knext_nextapp_reconcile_errors_total`
increases, and `KnextNextAppDegraded` fires while the condition holds.

**Cause.** A child-object create/update or an apiserver call failed inside the
reconcile loop — a transient apiserver/Knative-CRD hiccup, an RBAC gap, a
webhook conversion error, or a genuinely invalid child spec. The operator
requeues with backoff, so a transient cause self-heals; a persistent one keeps
`Degraded=True`.

**Fix.**
1. Read the message: `kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.conditions}' | jq`.
2. Read operator logs for the stack:
   ```sh
   kubectl logs -n kn-next-operator-system deploy/kn-next-operator-controller-manager
   ```
3. If transient (apiserver flake), it clears on requeue — watch
   `knext_nextapp_reconcile_errors_total` stop climbing.
4. If persistent, fix the root cause (RBAC, CRD version skew, invalid spec) and
   **re-apply the `NextApp` CR** to force reconvergence. Do **not** hand-edit the
   child ksvc — the operator will reconcile it away (ADR-0001).

## 3 — Route never programs (`IngressNotProgrammed`)

**Symptom.** The app deploys and the ksvc exists, but requests never reach it
(DNS resolves, connection hangs or 404s). `Ready` sits at `Unknown`/`False` with
`reason: IngressNotProgrammed`; a Warning Event with that reason fires once the
stall window elapses. `kn-next doctor`'s ingress check WARNs.

**Cause (#208, the silent one).** Knative's Route created a `KIngress`, but **no
ingress reconciler serves the configured class**, so it is never programmed — no
error, only an `Unknown` `IngressNotConfigured` condition on the ksvc. The
classic trigger: `config-network`'s `ingress-class` is set to the short form
`kourier.knative.dev` while net-kourier only serves
`kourier.ingress.networking.knative.dev`. Every `KIngress` is silently skipped.

**Fix.**
```sh
kubectl get configmap config-network -n knative-serving -o jsonpath='{.data.ingress-class}'
kubectl get deploy net-kourier-controller -n knative-serving   # or kourier-system
```
Set the class to `kourier.ingress.networking.knative.dev` **where it is
authored** — if a `KnativeServing` CR manages the cluster, edit it there;
editing the ConfigMap directly gets clobbered by the KnativeServing operator.
Confirm a Ready `net-kourier-controller` exists. `kn-next doctor` fails/ warns
this exact mismatch.

## 4 — Pinned rollback revision missing (`PinnedRevisionNotFound`)

**Symptom.** After a rollback (`kn-next rollback <app> --to <rev>`, ADR-0014),
`Ready=False` with `reason: PinnedRevisionNotFound`; a Warning Event names the
revision.

**Cause.** `spec.traffic.revisionName` points at a Knative revision that no
longer exists — it was garbage-collected (Knative's revision GC), or the name
was mistyped. The operator will not invent traffic to a phantom revision, so it
degrades rather than serve nothing. (A transient GET error does **not** trip
this — only a real `NotFound` after the race-guard window, so the condition
doesn't flap on API hiccups.)

**Fix.** List the revisions that actually exist and pin to a real one:
```sh
kubectl get revision -n <ns> -l serving.knative.dev/service=<app> \
  --sort-by=.metadata.creationTimestamp
kn-next rollback <app> --to <app>-00007 -n <ns>     # a revision that exists
kn-next rollback <app> -n <ns>                       # or clear the pin -> latest-ready
```

## 5 — DATABASE_URL binding / envMap collision (`EnvVarIgnored`)

**Symptom.** A Warning Event with `reason: EnvVarIgnored`: a
`spec.secrets.envMap[DATABASE_URL]` entry was dropped. The DSN in effect is the
one from `spec.database.secretRef`, not the envMap one you expected.

**Cause.** ADR-0019 made `spec.database.secretRef` the typed way to bind a
Postgres DSN (it injects `DATABASE_URL`, and `roSecretRef` injects
`DATABASE_URL_RO`). If you *also* hand-wire `DATABASE_URL` in
`spec.secrets.envMap`, the two collide; the operator keeps the typed
`spec.database` binding and ignores the envMap duplicate (surfacing it as an
Event so it is not silent). Admission also rejects a CR that defines
`DATABASE_URL` in both places.

**Fix.** Pick **one** source. Prefer the typed binding:
```yaml
spec:
  database:
    secretRef:   { name: shop-db }     # -> DATABASE_URL  (key defaults to DATABASE_URL)
    roSecretRef: { name: shop-db }     # -> DATABASE_URL_RO (optional)
```
Remove the duplicate `spec.secrets.envMap[DATABASE_URL]`. See
[the postgres-binding guide](../guides/postgres-binding.md) and ADR-0019 for the
pool-idle / connect-timeout contract (pool idle < gateway 60s idle window;
connect timeout ≥ 10s to survive a ~2.5s cold DB wake).

## 6 — `ImagePullBackOff` on fresh nodes

**Symptom.** The app (or the operator itself) is stuck `ImagePullBackOff` /
`ErrImagePull`, often only on newly-added nodes while existing pods run fine.
`kn-next doctor`'s image check WARNs ("NOT anonymously pullable") or FAILs
("does not exist on the registry").

**Cause (#198).** The image is in a **private** registry package (e.g. a private
ghcr package) with no `imagePullSecret` on the node, or the digest no longer
exists on the registry and the running pods only survive on a cached copy that
new nodes cannot pull.

**Fix.**
```sh
kubectl describe pod -n <ns> <pod>        # confirm the pull error + which image
kn-next doctor                             # image check names the exact ref
```
Either make the registry package **public**, or attach an `imagePullSecret`
(namespace default service account / `spec.imagePullSecrets`). If the digest is
gone, re-push and re-pin (§1).

## 7 — Secret/DATABASE_URL missing or mis-keyed

**Symptom.** The pod never becomes Ready; `kubectl get pod` shows
`CreateContainerConfigError`. The app's deep `/api/health` (once it does start)
returns 503 and `KnextHighErrorRate` fires (the dedicated `KnextCacheUnreachable`
alert is retired — its per-route label was unbounded).

**Cause.** `spec.database.secretRef` / `spec.secrets.envMap` names a Secret (or
key) that does not exist in the app's namespace. The binding is pure envMap
sugar (ADR-0019) — a missing Secret/key is not caught by the operator; it
surfaces on the **pod** as `CreateContainerConfigError` (standard envMap
semantics). A rotated or deleted Secret produces the same symptom on the next
revision roll.

**Fix.**
```sh
kubectl get secret -n <ns>                                   # is it present?
kubectl get secret shop-db -n <ns> -o jsonpath='{.data}' | jq 'keys'   # right key?
```
Create/repair the Secret with the expected key (`DATABASE_URL` /
`DATABASE_URL_RO` by default), then re-apply the `NextApp` CR to force a fresh
revision that picks up the env. For a live-dependency outage (Secret is fine but
Postgres/Redis is down), see [incident runbook Scenario 3](./incident.md#scenario-3-rediscache-down)
and the [health dependency taxonomy](../adr/0023-health-dependency-taxonomy.md):
Postgres is a **hard** dependency (readiness fails closed), Redis-as-cache is
**soft** (fails open, degraded-but-Ready).

## 8 — Cold-start latency / timeouts

**Symptom.** The first request after idle is slow or times out at the client.
`KnextColdStartLatencyHigh` fires (cold-start p95 > 3s):
```promql
histogram_quantile(0.95,
  sum(rate(kn_next_startup_duration_seconds_bucket{cache_status="cold"}[15m])) by (le, app))
```

**Cause.** A scale-to-zero app pays a cold start on the first request. A cold
**bytecode cache** (`kn_next_bytecode_cache_warm_start{app}` == 0) after a fresh
deploy is the usual regression — a new `BUILD_ID` means a new `NODE_COMPILE_CACHE`
dir that must repopulate. A missing/unbound bytecode-cache PVC, or a genuine app
init regression, also shows here.

**Fix.** See [incident runbook Scenario 2](./incident.md#scenario-2-cold-start-latency-spike)
and [scaling & cold-start tuning](../operator/scaling-cold-start.md). In short:
confirm the `<app>-bytecode-cache` PVC is bound (`kubectl get pvc -n <ns>`),
let the cache re-warm after a deploy, and if warm-start p95 is also slow, it is a
code regression — **roll back** (§4). Raise `minScale` above 0 only as a
deliberate always-warm trade-off.

### Which dependency stalled the first request? {#which-dependency-stalled-the-first-request}

A cold start that is slow because a *dependency* was slow looks identical, from
the outside, whichever dependency it was: the page renders, nothing errors,
nothing fails open. The app names it instead of leaving it to inference — when a
dependency operation on a request path takes longer than `SLOW_DEP_LOG_MS`
(default **500 ms**) it emits exactly one structured line:

```
kubectl logs <pod> -c user-container | grep '\[slow-dep\]'
```

| line | reading |
|---|---|
| `[slow-dep] {"dep":"pg","op":"pool.query"…,"cold":true}` | the Postgres pool's **first** acquisition on this pod was slow (DB wake / connect). `"cold":false` means the pool was already woken — a different story |
| `[slow-dep] {"dep":"pg","op":"pool.connect"…}` | as above, for an explicit `connect()` (transaction path) |
| `[slow-dep] {"dep":"redis-connect","op":"client.connect"…}` | the cache's **TCP handshake** was slow — a connect-phase problem (SYN retransmit, kube-proxy programming, a loaded node) |
| `[slow-dep] {"dep":"redis-ready","op":"ready-check"…}` | the handshake was fast and the cache's **ready-check** was slow — post-handshake Redis responsiveness, not the network |

Each line carries `durationMs`, `thresholdMs` and, for Postgres, `role`
(`writer` for `DATABASE_URL`, `reader` for the `DATABASE_URL_RO` gateway — both
pools are instrumented) and `outcome`. `cold` appears on **writer** lines only:
it is the writer pool's own wake latch, and the reader has none, so a reader line
omits the field rather than borrowing the writer's answer. No line carries the
target: the dependency **class** is logged, never a DSN, host credentials or SQL
text.

The threshold is a plain env var, so it can be lowered on a suspect deployment
without a rebuild — **through the `NextApp` CR, never the Knative Service**
(`spec.env`, fields from
[`api/v1alpha1/nextapp_types.go`](../../packages/kn-next-operator/api/v1alpha1/nextapp_types.go)):

```sh
kubectl patch nextapp <app> -n <ns> --type merge -p \
  '{"spec":{"env":{"SLOW_DEP_LOG_MS":"100"}}}'
```

Do **not** reach for `kubectl set env ksvc/<app>`. The operator is the single
source of truth for cluster state (ADR-0001): the reconciler reverts an
out-of-band ksvc edit, so the knob silently disappears mid-incident — and worse,
a merge patch on a ksvc container **drops env, resources and probes** that were
not restated in the patch, while the revision still goes `Ready`. That produces a
mis-configured pod that looks healthy and is then measured, which is the opposite
of what this section is for.

The patch rolls a new revision, so it applies to pods created **after** it — a
cold cycle already in flight is not retro-instrumented, and the threshold change
itself costs a cold start.

Two things this does **not** change: no timeout, budget or fail-open behaviour
moves, and readiness still never gates on a dependency — a waking database or an
unreachable cache must not flap a scale-to-zero pod.

**If you see nothing at all**, the stall was not in the app's Postgres pools
(writer or reader) or its ISR cache connection: look at the cold-start terms in
§8 above (image pull, bytecode cache, app init). The instrument covers the
dependencies knext itself wires — an app's own direct clients to some other
service are not on this seam and are not ruled out by the silence.

**Related noise, now silenced.** A pod whose Redis is unreachable used to print
repeated `[ioredis] Unhandled error event` stacks from background clients. Those
clients now log one classed line per error class —
`[redis:cache-events] connection error (ETIMEDOUT): … — further ETIMEDOUT errors
suppressed` — and stop retrying after a bounded number of attempts, re-dialling
only when a request actually needs them. A repeat of the same class is expected
to be silent; a **new** class still prints.

## 9 — Database (scale-zero-pg) wake timeout

**Symptom.** The first DB query after the app *and* its database have both been
idle fails or is very slow; app logs show a connect timeout / `connection
refused` to the Postgres host, and `KnextHighErrorRate` may fire (the deep
`/api/health` probes Postgres).

**Cause.** knext binds Postgres via a Secret DSN (ADR-0019); it builds **no** DB
machinery. When the DSN points at scale-zero-pg's wake-on-connect gateway, a cold
DB takes ~2.5s to wake. Two client-side footguns (measured, documented in
ADR-0019) cause the timeout:

- the app's Postgres **pool idle timeout is ≥ the gateway's 60s idle window** →
  the pool holds dead sockets the gateway already closed, and the first query
  after idle fails;
- the client **connect timeout is < 10s** → it gives up before the ~2.5s cold
  wake completes (with margin).

**Fix.** Set the pool idle timeout **below** 60s and the connect timeout **≥
10s**. See [the postgres-binding guide](../guides/postgres-binding.md) and
[postgres scale-to-zero](../operator/postgres-scale-to-zero.md). This is a client
configuration fix, not a cluster change.

### Deep-health stuck WAKING (permanent DB outage) {#deep-health-stuck-waking-permanent-db-outage}

**Symptom.** `KnextDeepHealthStuckWaking` fires (severity: critical). The
deep-health state gauge `knext_deep_health_state{dependency="overall",
state="waking"}` has been `1` for over 2 minutes.

**Normal vs stuck.** The deep health check (`checkDeepHealth`, ADR-0026/#338)
classifies a **connection-level** failure to Postgres — `ECONNREFUSED`, a
connect timeout, dead DNS — as `waking`, NOT `down`. That is deliberate: a
scale-to-zero database asleep behind the scale-zero-pg gateway shows exactly
that signature while it wakes, and a legitimate wake is **brief (~2-6s)**. So a
short blip of `waking` is normal and does **not** page.

A **genuinely-down** DB (host gone, dead DNS, a bad/rotated `DATABASE_URL`)
presents the *same* connection-level errors — so it sits at `waking`
**forever** and never becomes `down` (only a *reachable-but-erroring* query
yields `down`). An alert keyed on `down`/503 alone would therefore **never
page** on a permanent connection-level outage. This alert closes that gap by
paging on `waking` **sustained past the wake budget** (`for: 2m`).

**What it means.** The app cannot reach its database at the connection level for
minutes — this is a real outage, not a wake.

**Act.**

1. Confirm it is not a legitimate very-slow wake: check the scale-zero-pg
   gateway + `compute-<app>` — is the compute scaling up, or stuck at 0 /
   crash-looping? See [postgres scale-to-zero](../operator/postgres-scale-to-zero.md).
2. Verify the app's `DATABASE_URL` Secret resolves to a live host/port (dead DNS
   or a rotated DSN is the common cause — cross-check §5 / §7 above).
3. If the gateway is healthy but the app still can't connect, check the
   NetworkPolicy to the DB host (§10) and the client connect timeout (§9 above).

The alert resolves automatically once a scrape observes the DB reachable again
(the gauge flips `waking`→`ok`/`up` on the next scrape).

**Why this doesn't break scale-to-zero.** The gauge is refreshed on the :9091
scrape by running `checkDeepHealth()`, which issues a real `SELECT 1` through
the scale-zero-pg gateway — and that would re-arm the gateway's 60s DB idle
timer on every ~30s scrape, keeping an idle app's DB awake forever. So the
scrape dial is **activity-gated**: it runs the deep DB probe **only when the app
used its writer pool recently** (within `DB_ACTIVITY_BUDGET_MS`, default 45s —
below the 60s gateway idle). An idle app (not querying its DB) is **never**
probed by the scrape, so its DB sleeps normally; the gauge just holds its
last-known value. This is safe for the alert because a stuck-`waking` outage
only matters when the app is actively trying to use the DB — which is exactly
when the gate is open and the probe runs.

## 10 — NetworkPolicy blocks the activator

**Symptom.** The app pod is Running but unreachable; scale-from-zero requests
503 at the Knative activator, or in-namespace callers can reach it but external
paths cannot. Turning `spec.security.networkPolicy` on coincided with the break.

**Cause.** The operator reconciles a default-on, in-cluster-only
`NetworkPolicy` (`<app>-allow-ingress`) as defense-in-depth for the Bearer-authed
mutating cache endpoints. It restricts **ingress** to the app's pods to three
sources: `knative-serving` (the activator/scale-from-zero), `kourier-system`
(the ingress gateway), and the app's **own** namespace. If those namespaces are
not labeled `kubernetes.io/metadata.name=<ns>`, or your CNI enforces policy but
the activator sits elsewhere, legitimate traffic is dropped. It is L3/L4 — it
cannot isolate a single HTTP path, and it is a no-op on a CNI without
NetworkPolicy support.

**Fix.**
```sh
kubectl get networkpolicy <app>-allow-ingress -n <ns> -o yaml
kubectl get ns knative-serving kourier-system \
  -o jsonpath='{range .items[*]}{.metadata.name}={.metadata.labels.kubernetes\.io/metadata\.name}{"\n"}{end}'
```
Ensure the `knative-serving` and `kourier-system` namespaces carry the
`kubernetes.io/metadata.name` label (kube ≥ 1.21 adds it automatically). To opt
out entirely, set `spec.security.networkPolicy: false` on the `NextApp` — the
operator deletes the policy. Do **not** hand-edit the policy; it is
owner-referenced and reconciled.

## 11 — Every cold start of one app is ~1.5s slower than it used to be (activator clusterIP fallback)

**Symptom.** Wakes of a scale-to-zero app got uniformly slower (roughly 1–2s added between the
pod reporting Ready and the response arriving), with no deploy or config change. Warm requests
are unaffected. There is no alert for this today — it is found by decomposing wake latency.

**Diagnose.** Check what the activator's throttler logs for the revision on a cold wake:

```bash
kubectl -n knative-serving logs -l app=activator --since=10m   | grep "Updating Revision Throttler" | grep "<revision>"
```

- Healthy (pod-direct): `clusterIP = <nil>, trackers = 1, backends = 1`
- Degraded (fallback): `clusterIP = <ip>:80, trackers = 0, backends = 1`, preceded during the
  wake by a `connection refused` retry loop against that clusterIP (`…/healthz: dial tcp …`).

**Cause.** The activator's per-revision watcher permanently falls back from probing pod IPs to
probing the revision's private-Service clusterIP after a streak of pod-probe failures (for
example a transient CNI/conntrack fault). The fallback never retries pod-direct, so a healed
network still pays the clusterIP path — which waits on kube-proxy dataplane programming on
every wake — indefinitely.

**Fix.**

```bash
kubectl -n knative-serving rollout restart deploy/activator
```

A fresh activator re-evaluates pod addressability and returns to pod-direct tracking. Measured
on OKE 2026-08-21: Ready→routable gap 1.64–1.93s before the restart, 0.14–0.86s after, same
revision and hour. In-flight traffic to running pods is not interrupted (the activator is only
on the scale-from-zero path at default target-burst-capacity), but wakes racing the restart may
see one retry.

**Durable state.** An upstream report (the fallback's stickiness and its invisibility) is
drafted in `docs/upstream/knative-activator-sticky-clusterip-fallback.md`. Until that lands
there is no metric to alert on — `config-observability` ships no exporter here, and the watcher
mode is not exported regardless — so this section is the detection story.

## 12 — Apply rejected (admission webhook not ready)

**Symptom.** `kn-next deploy` / `kubectl apply` of a `NextApp` fails with a
webhook error like `failed calling webhook … connection refused` or
`x509 … certificate`. **Nothing** deploys, even a valid CR.

**Cause.** The operator ships a `ValidatingWebhookConfiguration` with
`failurePolicy: Fail` (fail-closed — so a bad image can never slip past while the
webhook is down, §1). If the operator/webhook pod is not Ready, or cert-manager
has not issued the webhook serving cert, the apiserver cannot reach the webhook
and **rejects every mutating request** to `NextApp`.

**Fix.**
```sh
kubectl get deploy -n kn-next-operator-system            # controller-manager Ready?
kubectl get validatingwebhookconfiguration | grep kn-next
kubectl get deploy cert-manager-webhook -n cert-manager  # cert-manager up?
kn-next doctor                                            # checks both prereqs
```
Bring the operator Deployment and cert-manager back to Ready (they serve the
webhook + issue its cert). `kn-next doctor` verifies the operator readiness and
cert-manager webhook prereq directly. Once the webhook endpoint answers, re-apply.

---

## When none of these match

- Re-run `kn-next doctor --json` and attach the output.
- Capture the app's narration:
  `kubectl get nextapp <app> -n <ns> -o yaml` (status.conditions + events) and
  `kubectl logs -n kn-next-operator-system deploy/kn-next-operator-controller-manager`.
- Cross-reference the firing alert against the [incident runbook](./incident.md)
  and [SLO definitions](../observability/slos.md).
- The reconcile flow itself is documented in
  [operator/reconciler.md](../operator/reconciler.md).

## Related

- [Incident runbook](./incident.md) — alert-driven 3am playbook.
- [SLOs / SLIs](../observability/slos.md) — metric & alert definitions.
- [Reconciler](../operator/reconciler.md) — how status conditions are computed.
- ADR-0001 (operator = single source of truth), ADR-0014 (rollback traffic
  split), ADR-0019 (database binding), ADR-0023 (health dependency taxonomy).
