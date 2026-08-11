# The knext operator: architecture and features

How `packages/kn-next-operator` works, what it owns, and — just as important — what it
deliberately refuses to do.

This is the **overview**. It links to the existing detail docs rather than restating them:

- [`crd-nextapp.md`](./crd-nextapp.md) — field-by-field `NextApp` reference
- [`scaling-cold-start.md`](./scaling-cold-start.md) — the scaling/cold-start knobs in depth
- [`kafka-eventing.md`](./kafka-eventing.md) — ISR revalidation scope boundary
- [`data-plane-durability.md`](./data-plane-durability.md), [`gitops-preview.md`](./gitops-preview.md),
  [`multi-cloud-portability.md`](./multi-cloud-portability.md), [`postgres-scale-to-zero.md`](./postgres-scale-to-zero.md)

---

## 1. What it is, in one paragraph

The operator is a Go controller (kubebuilder/controller-runtime) that turns one custom
resource — **`NextApp`** (`apps.kn-next.dev/v1alpha1`) — into a running, scale-to-zero
Next.js application on Knative. It is **the single source of truth for cluster state**
(ADR-0001): the `kn-next` CLI builds and pushes an image and then writes a `NextApp`; it
never creates Knative objects itself. Every CLI cluster write targets the CR and nothing
else.

That constraint is the whole architecture. It means there is exactly one writer per
resource, one place where drift is corrected, and one object a GitOps tool can own.

---

## 2. The control loop

`Reconcile` is deliberately shaped as **fetch → reconcile children → compute (pure) →
apply status**. The phases, in source order:

| # | Phase | Produces |
|---|---|---|
| 0 | **Database binding** (ADR-0019) | Injects `DATABASE_URL` / `DATABASE_URL_RO` into the in-memory env map |
| 1 | **ServiceAccount** | The app's identity |
| 2 | **Bytecode-cache PVC** | Only when `spec.cache.enableBytecodeCache` — see §6.2 |
| 3 | **Image prewarm DaemonSet** | Only when `spec.scaling.imagePrewarm` — see §6.1 |
| 4 | **Knative Service** | The app itself, plus traffic split |
| 5 | **KafkaSource** | ISR revalidation — currently deferred, see §6.4 |
| 6 | **Status** | URL, conditions, traffic, scale state |

Before any of it, `validation.ValidateNextAppSpec` runs. Invalid spec never reaches a
child object.

### Owned and watched

```go
For(&NextApp{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
  Owns(&servingv1.Service{}).
  Owns(&corev1.PersistentVolumeClaim{}).
  Owns(&corev1.ServiceAccount{}).
  Owns(&networkingv1.NetworkPolicy{}).
  Owns(&appsv1.DaemonSet{}).
  Watches(&servingv1.Revision{}, handler.EnqueueRequestsFromMapFunc(r.revisionToNextAppRequests))
```

Two subtleties worth knowing, both load-bearing:

- **`GenerationChangedPredicate` is on the primary watch only.** Status-only writes do not
  bump `metadata.generation`, so they no longer re-enqueue — that plus a no-op-status guard
  is what killed an idle reconcile hot-loop (#98). The **accepted trade-off**: annotation-
  or label-only edits to a `NextApp` do *not* trigger a reconcile. It is not filtered on the
  `Owns(...)` watches, because drift in an owned child must always be corrected.
- **Revisions are `Watches`, not `Owns`.** A Knative Revision is owned by its Configuration,
  not by the `NextApp`, so there is no owner-ref to follow. The label-mapped watch is what
  lets a pure scale-to-zero/wake flip converge `.status.scaledToZero` in bounded time (#365).

---

## 3. Honest status: the verdict engine

This is the operator's most distinctive piece, and it carries a hard rule:

> **New conditions, events, and requeues go in `computeStatusVerdict` (`status_verdict.go`),
> never as new branches in `Reconcile`.**

`computeStatusVerdict` is a **pure function**. Given the `NextApp` (spec + prior status), the
child ksvc's status, the database-phase outcome, the pinned-revision check and a clock, it
returns everything the reconciler must apply: conditions in append order, condition
*removals*, transition-gated events, and the requeue. No I/O. That makes the entire status
surface unit-testable without envtest.

The reason it exists is a real defect class: a rolled-up "Ready" that is **true while the app
is broken**. Splitting the verdict out forced every status transition through one auditable
place.

**Status surface** (`.status`): `url`, `conditions`, `currentTraffic`, `databaseSecretName`,
`observedRevision`, `scaledToZero`, `lastSuccessfulDeployTime`.

`kubectl get nextapp` prints URL / Ready / Age, with Revision, ScaledToZero, Degraded and
LastDeploy available at `-o wide` priority.

Scale state is itself a pure derivation (`deriveDeployState`): `observedRevision` comes from
the ksvc's `latestReadyRevisionName`, and `scaledToZero` from the observed activeness of that
revision — with **unknown preserved as `nil`** rather than collapsed to `false`. No replica
bookkeeping is invented.

---

## 4. Admission: one validator, two call sites

A validating webhook (`failurePolicy: fail`, create + update) rejects bad specs at admission
time. Critically, the webhook and the reconciler **share one implementation** in
`internal/validation` — they cannot drift.

What it enforces includes:

- **Digest pinning.** `:latest` is rejected as mutable and rollback-hostile; so is a tagless
  image (implicitly `:latest`). This is the operator-side half of the digest-pinning rule.
- **Cron syntax** for warm-schedule windows.
- **Bounded quantities** — `ParseQuantityBounded` exists because `MustParse` on unvalidated CR
  input would panic the entire controller (#431). Sizes are validated upstream and never
  parsed unguarded in the reconcile path.
- **Database/env collisions** — a bound `DATABASE_URL` colliding with an explicit `envMap`
  entry is surfaced rather than silently resolved.
- **Create vs update rules** are separate functions (`…SpecCreate` / `…SpecUpdate`), so
  immutability constraints are expressible.

---

## 5. Lifecycle and deletion

In-cluster children (ksvc, ServiceAccount, PVC, NetworkPolicy, DaemonSet) are removed by
**ownerRef garbage collection** and need no finalizer.

The finalizer exists for exactly one thing: **state that lives outside the cluster** and
therefore has no owner reference — the app's object-store prefix and its Redis keyspace
(ADR-0008).

Its safety properties are worth stating because deletion code is where blast radius lives:

- **Bounded.** External stores may be unreachable; the whole attempt is time-bounded so a CR
  can never wedge in `Terminating`. On timeout it records a Warning, gives up, and releases
  the finalizer — best-effort by design.
- **App-scoped only.** Storage deletion is an S3-compatible delete restricted to the app's
  prefix; cache deletion is `SCAN MATCH "<keyPrefix>:*"` plus batched `DEL` — **never
  `FLUSHDB`**. There is no bucket-wide or wildcard delete path in the type at all.
- **Honest about coverage.** Non-S3-compatible providers (Azure, GCS via native APIs) **no-op
  with a logged warning** rather than guess at credentials or endpoints.

---

## 6. Features

### 6.1 Image prewarm DaemonSet (ADR-0037)

With `spec.scaling.imagePrewarm: true`, the operator reconciles a `<app>-imgcache` DaemonSet
that pulls **and pins** the app's digest-pinned image on every schedulable node, so
scale-from-zero never waits on the image pull.

The implementation detail here is a genuine constraint, not incidental: knext runtime images
are distroless/Alpine and **may have no `/bin/sh`**, so the usual `sleep infinity` trick would
CrashLoopBackOff. Instead an initContainer (a helper image guaranteed to ship a static
busybox) copies that static binary into a shared `emptyDir`, and the main container runs the
**app image** with `command` pointed at the copied binary. The app image is pulled and held
against containerd GC without ever executing the app or depending on its binaries.

### 6.2 Bytecode cache PVC — **deprecated, still functional, and runtime-dependent**

`spec.cache.enableBytecodeCache` provisions a PVC (default **512Mi**) for the runtime code
cache. It is **deprecated** (ADR-0035, #457) in favour of the compile cache **baked into the
image at build time**, which is now the default cold-start mechanism. The path still works
exactly as before; the operator only surfaces a migration signal. A runtime shadow-warning
(#450) fires when an operator-injected `NODE_COMPILE_CACHE` would bypass the baked layer.

**What the PVC actually buys depends on the runtime, and the flag alone does not know that.**
The operator sets `NODE_COMPILE_CACHE=/cache/bytecode/latest` unconditionally when the flag is
on, and adds `BUN_RUNTIME_TRANSPILER_CACHE_PATH` (a sibling dir on the same PVC, so the two
runtimes' artifacts cannot collide) only when `spec.runtime == "bun"`:

| target | `NODE_COMPILE_CACHE` | `BUN_RUNTIME_TRANSPILER_CACHE_PATH` | Does the PVC earn its keep? |
|---|---|---|---|
| `runtime: node` | active | not set | **Yes** — this is the V8 compile cache |
| `runtime: bun` (Next standalone server under Bun) | **inert** | set | **Yes** — Bun has no runtime *bytecode* cache (`bun build --bytecode` hard-fails on the standalone server), but its *transpiler* cache persists transpiled modules ≳50KB. Measured ≈ **−20%** time-to-first-response on next@16.2.4 / Bun 1.3.5; an unwritable dir is fail-open |
| **compiled `bun-exec`** (`bun build --compile --bytecode`, ADR-0036/0042) | **inert** | **inert** | **No** — bytecode is embedded in the executable at build time and nothing transpiles at runtime, so both variables point at a cache nothing writes |

The third row is the one to watch. There is **no live defect today**, because the compiled
target is not reachable through the CRD: `spec.runtime` is `+kubebuilder:validation:Enum=bun;node`,
there is no `spec.build` field, and the bun-exec benchmark arms are raw Knative Services rather
than `NextApp`s. See §11.

### 6.3 Network policy — **default-on**

`spec.security.networkPolicy` reconciles an internal-only NetworkPolicy. Semantics:
**unset or `true` ⇒ reconciled** (default-on); `false` ⇒ not reconciled *and any previously
created policy is deleted*.

It is defense-in-depth for the already-Bearer-authed mutating cache endpoints. It is **not**
per-route isolation, and the type comment says so — a guard that overstates its coverage is
worse than none.

### 6.4 Kafka ISR revalidation — **built, deferred, and honest about it**

`spec.revalidation.queue: "kafka"` is intended to reconcile a Knative `KafkaSource` for the
app's ISR-revalidation topic (built unstructured, to keep Knative Eventing's proto
dependencies out of the controller binary).

**No caller reaches it today.** `revalidationDeferred` is true for every `queue: kafka` app,
because the sink — a Knative Service named `{app}-revalidator` — is not built by knext, and
its contract (which CloudEvents it consumes, how it authenticates, how it calls
`revalidateTag`) was never specified or tested (#475). Shipping that consumer is the open
ADR-0016 action item and is what re-opens the call site.

The builder is kept as a **pure function** precisely so the retained shape stays covered by a
unit test rather than rotting behind a dead branch.

Scope boundary: `spec.revalidation.kafka` is **ISR-revalidation wiring only** — it is not a
cross-zone domain-event bus. See [`kafka-eventing.md`](./kafka-eventing.md).

### 6.5 Database binding (ADR-0019) — BYO only

`spec.database.secretRef` / `roSecretRef` map an **existing, same-namespace** Secret onto
`DATABASE_URL` / `DATABASE_URL_RO`. Defaults are chosen so a single Secret carrying both keys
binds with zero key configuration.

This is typed sugar over `spec.secrets.envMap`: the binding mutates the **in-memory** env map,
so the existing envMap → `SecretKeyRef` wiring stays the single env mechanism, with its
precedence and dedupe rules intact.

Deliberately **no provisioning, no hard gate, no finalizer**. The operator does not own the
Secret's lifecycle, and a missing Secret fails exactly like a missing envMap Secret
(`CreateContainerConfigError` on the pod). Managed provisioning was removed in ADR-0025 —
knext stays engine-agnostic and builds no database scale-to-zero machinery.

### 6.6 Traffic, scaling, warm windows

The operator maps CR fields onto Knative autoscaling annotations: `min-scale`, `max-scale`,
`target-burst-capacity`, `panic-window-percentage`, `panic-threshold-percentage`,
`scale-to-zero-pod-retention-period`.

`spec.traffic` drives revision traffic split (rollback / canary), reflected back in
`.status.currentTraffic`. `spec.scaling.warmSchedule` holds a floor between two **5-field cron
expressions**, syntax-validated at admission. `spec.scaling.poolMax` bounds database fan-out
(the connection-wall guard, ADR-0028).

---

## 7. Security posture

- **Digest pinning enforced**; `:latest` and tagless images rejected at admission and in the
  reconciler.
- **Secrets by reference only** — the operator wires `SecretKeyRef`s; secret *values* never
  enter the CR, the image, or a URL.
- **RBAC is enumerated, not wildcard.** The operator holds only what it reconciles: Knative
  Services (full), Knative **Revisions read-only**, `caching.internal.knative.dev` Images,
  KafkaSources, ServiceAccounts, PVCs, NetworkPolicies, DaemonSets, Secrets, and Events.
- **NetworkPolicy default-on** (§6.3).
- **Deletion is app-scoped by construction** (§5).

One known placeholder: `config/manager/manager.yaml` still carries `controller:latest` — the
very thing the operator rejects for user images. It should be digest-pinned.

---

## 8. Observability

Controller metrics are **deliberately low-cardinality**: labelled by reconcile
result/reason only, **never by object name**, to avoid metric explosion —
`reconcile_total{result}`, `reconcile_duration`, `reconcile_errors`.

Ships with Grafana dashboards (`config/grafana/dashboards`), Prometheus wiring
(`config/prometheus`), and an observability overlay (`config/observability`). Manager flags
cover leader election, secure metrics with certs, webhook cert paths, and HTTP/2 (off by
default).

---

## 9. The install bundle is guarded by tests

`internal/install` contains **no production code** — it is ten Go test files asserting
properties of the shipped install bundle: published digest and **re-pinned** digest, cosign
verification, HA layout, ingress-class handling and override, PVC feature flags, and the CI
workflow itself.

This is the pattern the repo prefers: an invariant that would otherwise be documented
expectation becomes a test that fails when violated.

---

## 10. What the operator deliberately does not do

Stated so nobody re-proposes them:

- **It does not provision databases.** BYO Secret only (ADR-0025).
- **It does not run a Kafka consumer.** The revalidator sink is unspecified and therefore
  deferred (#475).
- **It does not manage cross-zone domain events.** That is an application concern —
  bring your own broker and clients.
- **It does not let anything else write cluster state.** The CLI emits a CR; it does not
  create Knative objects.
- **It is not a general PaaS.** knext is a narrow Next.js-on-Knative adapter, and the CRD
  surface is scoped to that.

---

## 11. Known gaps

- **No CRD version negotiation.** `cr-builder.ts` hardcodes `apps.kn-next.dev/v1alpha1` and
  nothing negotiates the version against the cluster, so a newer CLI can emit a field an older
  operator's CRD does not know. Mitigated (#547) by every CLI apply passing `--validate=strict`,
  which makes the apiserver **reject** an unknown field rather than silently prune it. Still
  open: GitOps controllers do not assert strict validation, a `kubectl` shim can append
  `--validate=ignore` and win, and `doctor` checks only that the CRD *exists*, not that its
  schema covers what the CLI emits. The schema-diff preflight (#314) is the complete fix.
  **Upgrade order is therefore load-bearing: operator/CRD first, then CLI** (#548).
- **API is still `v1alpha1`.**
- **`config/manager/manager.yaml` uses `controller:latest`** (§7).
- **`enableBytecodeCache` will become meaningless for the compiled `bun-exec` target, and
  nothing currently stops it.** The flag gates the PVC, the volume mount and the env vars on
  *itself alone* — it never consults the build target. That is correct today only because the
  compiled target has no CRD representation (§6.2). **ADR-0042 Phase 4 ships `build: vinext`
  as a deployable opt-in**, and at that moment `enableBytecodeCache: true` on a compiled image
  provisions and mounts a 512Mi PVC that nothing ever writes to, while both cache env vars
  point into it inertly.

  This is precisely the defect class #431 already fixed once: the env block used to be nested
  under the data-cache `Provider` branch, so an app with no provider "got the PVC provisioned
  AND mounted while `NODE_COMPILE_CACHE` stayed unset — 512Mi of storage buying nothing." The
  same sentence will be true again for a different reason unless Phase 4 either **rejects**
  `enableBytecodeCache` with `build: vinext` at admission (`ValidateNextAppSpec`, where the
  ADR already plans a spec precondition) or **skips** the PVC/mount/env for that target and
  says so in an event. Rejecting is preferable: silently ignoring a storage request is how the
  512Mi came back the first time.
