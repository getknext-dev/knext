# ADR-0006 — Unified config: `NextApp.spec.database` auto-provisions + wires the DB (cross-repo)

- **Status: ACCEPTED — ACCEPTED by owner 2026-07-05: build FULL cross-namespace directly (not phased).** Design record only. No code is
  written against this ADR until the owner ratifies it (issue #119).
- **Date:** 2026-07-05
- **Deciders:** owner (to ratify); design by the scale-zero-pg + knext lanes.
- **Scope:** a **cross-repo contract**. It is authored here (scale-zero-pg, the
  provider of the `AppDatabase` API) but the primary implementation lands in **knext**
  (`getknext-dev/knext`, the consumer). See *Open decisions* for long-term ownership.
- **Relates to:** #119 (this issue); ADR-0003 (branch-per-app multi-tenancy);
  ADR-0004 (BUILD the AppDatabase CRD operator); `docs/connecting.md` (the
  `DATABASE_URL` contract); knext ADR-0001 (operator = single source of truth),
  knext ADR-0008 (NextApp deletion finalizer + app-scoped teardown).

---

## Context

Today the unified-platform vision (one app + its database, both scale-to-zero, joined
by a single `DATABASE_URL` Secret) is **assembled by hand**. An app author must:

1. Provision a database — `kubectl apply` an `AppDatabase` CR (or run
   `provision-app.sh create <app>`) in the **`scale-zero-pg`** namespace.
2. Find the minted Secret `app-db-<app>` (also in `scale-zero-pg`).
3. Hand-copy / re-key that Secret into the **app's own** namespace.
4. Reference it in `NextApp.spec.secrets.envMap.DATABASE_URL`.

This is four manual steps across two namespaces, with **no lifecycle coupling**:
deleting the `NextApp` leaks the `AppDatabase` (and its Neon timeline + safekeeper
WAL). #119 asks for **unified config**: a `NextApp` declares its database **inline**,
and the platform provisions + wires + tears down both.

The design constraint from the owner is explicit and load-bearing: **delegation, not
merged operators.** knext scales *apps*; scale-zero-pg scales *databases*. Keep the
two operators and two planes separate; unify only the **config surface** the author
touches.

### What exists today (verified against both repos)

**`AppDatabase` CRD** (`deploy/82-appdb-crd.yaml`, `gateway/internal/appdb/`):

- **API:** `apps.scale-zero-pg.dev/v1alpha1`, `kind: AppDatabase`, **Namespaced**,
  shortName `appdb`. In practice every `AppDatabase` lives in the `scale-zero-pg`
  namespace alongside the shared storage plane and the per-app computes.
- **`spec`:** `appName` (required; RFC1123 DNS label; **immutable**; is the DSN
  database name and the `compute-<app>` suffix; reserved `tmpl`/`warm`/`ro` rejected),
  `tier` (`cold`|`warm`, default `cold`), `quotas{cpu, cpuRequest, mem, memRequest,
  maxConnections}`, `roPool{enabled, minReplicas, maxReplicas}` (declarative surface;
  RO compute provisioning is still owned by the read-scaling lane, `deploy/26/27`),
  `keepTimelineOnDelete` (default `false` = safe two-sided timeline reclaim on delete).
- **`status`:** `phase` (`Provisioning`|`Ready`|`Failed`|`Deleting`), `timelineId`,
  `computeReady`, `message`, `observedGeneration`, `conditions[]` (types `Provisioned`,
  `Ready`).
- **Finalizer:** `apps.scale-zero-pg.dev/deprovision` — runs the safe two-sided Neon
  timeline delete before the object is removed.
- **Output Secret:** `app-db-<appName>` in the **`scale-zero-pg`** namespace, keys:
  `PGUSER`, `PGPASSWORD`, `APP_ROLE_VERIFIER` (SCRAM verifier, #117; was `APP_ROLE_MD5`), `DATABASE_URL`
  (`postgres://app_<app>:<pw>@pggw-apps.scale-zero-pg.svc:55432/<app>?sslmode=disable`).
  ⚠️ **There is no `DATABASE_URL_RO` key today** — the read-only pool is a separate,
  documented **two-DSN** pattern (gateway port `55434`, `docs/connecting.md`) and is
  **not** emitted into `app-db-<app>`. #119 asks knext to inject `DATABASE_URL_RO`, so
  this is a required **scale-zero-pg API-hardening item** (see *Open decisions*).
- **Operator RBAC:** a namespace-scoped `Role` in `scale-zero-pg` (not a ClusterRole)
  — `deploy/83-appdb-operator.yaml`.

**`NextApp` CRD** (`apps.kn-next.dev/v1alpha1`, `packages/kn-next-operator/`):

- **Namespaced.** A `NextApp` lives in the app author's own namespace (samples use
  `default`; each app can have its own namespace).
- **DB wiring seam:** `spec.secrets.envMap` — a `map[ENV_VAR → {secretName, secretKey}]`.
  The operator resolves it into container env via a **`SecretKeyRef`**
  (`LocalObjectReference`), i.e. **the referenced Secret MUST live in the `NextApp`'s
  own namespace** (`nextapp_controller.go`). This is the crux of the cross-namespace
  problem: the DB Secret is minted in `scale-zero-pg`, but `envMap` can only see
  Secrets co-located with the `NextApp`.
- knext's operator is the **single source of truth** (knext ADR-0001) and already
  owns a **deletion finalizer** pattern (`apps.kn-next.dev/external-cleanup`, knext
  ADR-0008) that runs app-scoped teardown before the object is removed. The reconcile
  watch carries a `GenerationChangedPredicate`.

---

## Decision (proposed)

**knext delegates database lifecycle to the `AppDatabase` operator via a new
`NextApp.spec.database` block. The knext operator creates/owns an `AppDatabase` CR in
the `scale-zero-pg` namespace, waits for it to go `Ready`, mirrors the resulting
`DATABASE_URL(+_RO)` Secret into the app namespace, injects it into the app env, and
drives cross-namespace teardown through its own finalizer.** scale-zero-pg publishes
the `AppDatabase` Secret/status contract as a **stable external-driver API**.

### 1. The API — `NextApp.spec.database`

A new optional sub-schema on `NextAppSpec`. It surfaces the **small, author-relevant**
subset of `AppDatabase.spec` and sensibly defaults the rest (the operator fills in
`appName`, credentials, plane wiring).

```go
// NextAppSpec (knext) — new field
//   // Database declares an inline scale-zero-pg database that the operator
//   // provisions (via an AppDatabase CR) and wires into DATABASE_URL(+_RO).
//   // +optional
//   Database *DatabaseSpec `json:"database,omitempty"`

type DatabaseSpec struct {
    // Enabled turns on inline provisioning. false/nil => no DB is provisioned
    // (bring-your-own via spec.secrets.envMap stays the escape hatch).
    Enabled bool `json:"enabled,omitempty"`

    // Tier maps 1:1 to AppDatabase.spec.tier. cold = scale-to-zero (default);
    // warm = one parked replica for ~0.4s wake.
    // +kubebuilder:validation:Enum=cold;warm
    Tier string `json:"tier,omitempty"`

    // ReadReplicas requests the read-only pool. Maps to AppDatabase.spec.roPool.enabled;
    // when true the operator also injects DATABASE_URL_RO. Default false.
    ReadReplicas bool `json:"readReplicas,omitempty"`

    // Quotas maps 1:1 to AppDatabase.spec.quotas (per-app noisy-neighbour bound).
    // Empty fields inherit AppDatabase defaults (1000m/250m CPU, 1Gi/256Mi mem, 100 conns).
    // +optional
    Quotas *DatabaseQuotas `json:"quotas,omitempty"`

    // KeepOnDelete maps to AppDatabase.spec.keepTimelineOnDelete. Default false
    // (deleting the NextApp reclaims the Neon timeline). true retains it for PITR.
    // +optional
    KeepOnDelete bool `json:"keepOnDelete,omitempty"`
}

type DatabaseQuotas struct {
    CPU            string `json:"cpu,omitempty"`
    CPURequest     string `json:"cpuRequest,omitempty"`
    Mem            string `json:"mem,omitempty"`
    MemRequest     string `json:"memRequest,omitempty"`
    MaxConnections int    `json:"maxConnections,omitempty"`
}
```

**What is surfaced vs defaulted:**

| `AppDatabase.spec` field | `NextApp.spec.database` | Rationale |
|---|---|---|
| `appName` | **not surfaced** — derived | Must be plane-globally-unique + immutable; author must not set it (collision + rename hazard). Derived deterministically (below). |
| `tier` | `tier` | Author-relevant latency/cost knob. |
| `quotas.*` | `quotas.*` | Author-relevant sizing. |
| `roPool.enabled` | `readReplicas` (bool) | Simplified to on/off; min/max default. |
| `roPool.min/maxReplicas` | **not surfaced (v1)** | Pool sizing is an ops concern; default. Surface later if asked. |
| `keepTimelineOnDelete` | `keepOnDelete` | Data-retention decision belongs to the author. |

**`appName` derivation (load-bearing).** `appName` must be **unique across the entire
shared plane** (it is the Neon branch handle and `compute-<app>` name) and RFC1123 (≤63
chars). `NextApp` names are only unique **within** a namespace, so the operator derives:

```
appName = sanitize("<namespace>-<name>")            # RFC1123, lowercased
if len > 63 or collision-risk:
    appName = "<truncated-prefix>-<short-hash(namespace/name)>"   # deterministic
```

The derivation is **stable** (same NextApp identity → same `appName`) and stored on the
`NextApp` status so it is auditable. Reserved names (`tmpl`/`warm`/`ro`) are avoided by
the prefix. This also closes a security hole (see *Failure modes §4*): a `NextApp` can
only ever provision/bind the `AppDatabase` named for **its own** identity — it cannot
name an arbitrary existing DB.

**Unified `NextApp` YAML (the author's whole world, one file, one namespace):**

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: shop
  namespace: team-acme            # the app's own namespace
spec:
  image: registry.example.com/shop@sha256:abc123…
  scaling: { minScale: 0, maxScale: 10 }
  database:                       # ← NEW: inline DB, auto-provisioned + wired
    enabled: true
    tier: cold                    # cold (scale-to-zero) | warm
    readReplicas: true            # also injects DATABASE_URL_RO
    quotas:
      cpu: "1000m"
      mem: "1Gi"
      maxConnections: 100
  # No secrets.envMap for the DB needed — the operator injects
  # DATABASE_URL and DATABASE_URL_RO automatically.
```

The operator injects, equivalent to the author having written by hand:

```yaml
  secrets:
    envMap:
      DATABASE_URL:    { secretName: shop-db, secretKey: DATABASE_URL }
      DATABASE_URL_RO: { secretName: shop-db, secretKey: DATABASE_URL_RO }   # if readReplicas
```

(`shop-db` = the **mirrored** Secret in `team-acme`; see §3.)

### 2. The delegation flow

```
author            knext operator                 scale-zero-pg ns
  │  apply NextApp    │                                  │
  │  (spec.database)  │                                  │
  │──────────────────>│                                  │
  │                   │ 1. add finalizer                 │
  │                   │    apps.kn-next.dev/db-cleanup    │
  │                   │ 2. derive appName = team-acme-shop│
  │                   │ 3. create AppDatabase ───────────>│  AppDatabase/team-acme-shop
  │                   │    (in scale-zero-pg ns)          │   phase: Provisioning
  │                   │                                   │   appdb-operator:
  │                   │                                   │    - mint app-db-…  Secret
  │                   │                                   │    - branch timeline
  │                   │                                   │    - render compute (replicas 0)
  │                   │ 4. watch AppDatabase.status ─────<│   phase: Ready (cold ⇒ ~4s)
  │                   │                                   │
  │                   │ 5. read Secret app-db-team-acme-shop
  │                   │    from scale-zero-pg ns ────────<│
  │                   │ 6. MIRROR it → Secret shop-db     │
  │                   │    in team-acme ns (ownerRef=NextApp)
  │                   │ 7. inject envMap DATABASE_URL(_RO)│
  │                   │ 8. reconcile Knative Service      │
  │                   │    (app pods get the DSN)         │
  │                   │ 9. status: DatabaseReady=True     │
  │<──────────────────│                                  │
  │  app + DB now sleep and wake together on one request │
```

**Teardown (delete `NextApp`):**

```
  │  delete NextApp   │                                  │
  │──────────────────>│ finalizer db-cleanup runs:       │
  │                   │  a. delete AppDatabase/team-acme-shop ───>│ appdb finalizer:
  │                   │  b. (mirrored Secret shop-db is           │  two-sided timeline
  │                   │     GC'd by same-ns ownerRef)             │  reclaim, delete
  │                   │  c. wait AppDatabase gone (or timeout)    │  compute+Secret
  │                   │  d. remove db-cleanup finalizer  │        │
  │                   │  NextApp object deleted          │        │
```

### 3. The cross-namespace model (the crux)

Three cross-namespace hops, each with an explicit mechanism:

**(a) Who creates the `AppDatabase` CR + RBAC.** The **knext operator** creates and
owns the `AppDatabase` in the `scale-zero-pg` namespace. Because `AppDatabase`'s
operator RBAC is a namespace-scoped `Role` (not cluster-wide), we grant the knext
operator a **new, scoped `Role` + `RoleBinding` in `scale-zero-pg`** (shipped by
scale-zero-pg as part of the contract, bound to the knext operator's ServiceAccount):

```yaml
# scale-zero-pg ns — grants the knext operator exactly the DB-driver surface
kind: Role
metadata: { name: knext-appdb-driver, namespace: scale-zero-pg }
rules:
  - apiGroups: ["apps.scale-zero-pg.dev"]
    resources: ["appdatabases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: []          # scoped to app-db-* by admission/naming convention
    verbs: ["get", "list", "watch"]   # READ the minted Secret to mirror it
```

The knext operator gets **no** power over the storage plane, computes, or any Secret
other than the `app-db-*` DSNs — least privilege, and the two operators stay decoupled.

**(b) How `DATABASE_URL` reaches the app namespace — RECOMMENDED: knext-operator
mirror.** `envMap` resolves via `LocalObjectReference`, so the Secret **must** be in
the app namespace. We recommend the **knext operator natively mirrors** the Secret:
read `app-db-<appName>` from `scale-zero-pg`, write a copy `<name>-db` into the app
namespace with an **ownerReference to the `NextApp`** (same-namespace ownerRef → clean
k8s GC). The operator **watches the source Secret** and re-mirrors on change (rotation,
§4). If `readReplicas`, the operator also synthesizes the `DATABASE_URL_RO` key
(derived from `DATABASE_URL` with host/port `…:55434`, or read from the source Secret
once scale-zero-pg emits it — see *Open decisions*).

Why mirror rather than alternatives:

| Option | Verdict |
|---|---|
| **knext-operator mirror (recommended)** | No new infra; knext stays the single writer of app-ns state (ADR-0001); same-ns ownerRef gives clean GC; rotation handled by a watch the operator already runs. |
| External Secrets Operator / kubernetes-reflector | Works, but adds a **third** controller + a cluster-wide dependency to install/operate; teardown + rotation semantics live outside knext. Keep as a documented fallback, not the default. |
| Cross-namespace `secretKeyRef` | **Not possible** — Kubernetes `SecretKeyRef`/`envFrom` are namespace-local by design. Rejected. |
| Projected/CSI secret from another ns | Also namespace-local; no native cross-ns projection. Rejected. |

**(c) GC / teardown across namespaces.** `ownerReferences` **cannot cross
namespaces** — the `NextApp` (app ns) cannot own the `AppDatabase` (scale-zero-pg ns).
So GC is **finalizer-driven**, not ownerRef-driven:

- The knext operator adds a **`apps.kn-next.dev/db-cleanup` finalizer** to any
  `NextApp` with `spec.database.enabled` (compose with the existing
  `external-cleanup` finalizer).
- On `NextApp` delete, the finalizer **deletes the `AppDatabase` CR** in
  `scale-zero-pg`. The `AppDatabase`'s own `deprovision` finalizer then runs the
  **safe two-sided Neon timeline reclaim** (honoring `keepOnDelete`).
- The **mirrored Secret** in the app ns is GC'd automatically by its **same-ns
  ownerReference** to the `NextApp`.
- The finalizer waits (bounded, e.g. 30s like knext ADR-0008) for the `AppDatabase`
  to disappear, then removes itself. If scale-zero-pg is unreachable it emits a
  `Warning` Event and removes the finalizer anyway (never wedge a `NextApp` in
  `Terminating` on an external dependency — consistent with knext ADR-0008), leaving
  an orphan `AppDatabase` for `provision-app.sh reclaim-orphans` / operator reconcile
  to sweep. **This orphan-on-forced-teardown risk is a named trade-off** (see below).

### 4. Failure modes

1. **DB provisioning fails / is slow → does the app deploy?** **Hard-gate
   (recommended).** The operator does not inject `DATABASE_URL` (and, if the app has
   no other required env, does not create the Knative Service) until
   `AppDatabase.status.phase == Ready`. It surfaces a `NextApp` status condition
   `DatabaseReady=False, reason=Provisioning` and requeues. This prevents booting an
   app that will crash-loop on a missing DSN. **Cost is low:** a `cold` tier reaches
   `Ready` as soon as it is *provisioned* (~4s; the compute wakes lazily on first
   connect — `reconcile.go` sets `Ready` immediately for `desiredReplicas==0`), so the
   gate rarely adds latency. A `Failed` phase (e.g. plane not initialized) is surfaced
   verbatim on the `NextApp` condition and does **not** silently deploy a broken app.
   *(Alternative — soft-deploy the app and let it retry the DB — is rejected: it
   trades a clear operator-surfaced error for an opaque app-level crash-loop.)*

2. **`AppDatabase` / DB deleted out-of-band while the `NextApp` lives.** The knext
   operator's reconcile is declarative: it **re-creates** a deleted `AppDatabase`
   (re-provisions the branch — but a *new* timeline id, so any data in the old branch
   is gone; this is a destructive-recovery event, logged + Evented, not silent). The
   appdb operator independently **heals** a hand-deleted compute/Deployment. On
   re-provision the **password changes**, so the operator re-mirrors the Secret and
   (per §4.3) rolls the app.

3. **Secret rotation propagation.** `provision-app.sh rotate-cred` (or a future
   operator rotation) changes `PGPASSWORD`/`DATABASE_URL` in the source Secret. The
   knext operator **watches the source Secret**, re-mirrors on change, and stamps a
   **checksum annotation** on the Knative Service pod template so a new Revision rolls
   and pods pick up the new DSN (pods read `secretKeyRef` **at start** only — a mirror
   update alone does not restart them). Without the roll, running pods keep the old
   password until their next restart; the annotation makes propagation deterministic.

4. **Namespace isolation / a `NextApp` in ns A must not bind ns B's DB.** Enforced at
   **three** layers: (i) **naming** — `appName` is *derived* from the `NextApp`'s own
   `(namespace, name)`, so a `NextApp` can only ever create/bind the `AppDatabase`
   minted for its own identity; `spec.database` is **create-only**, never
   bring-your-own-name (BYO stays the explicit `spec.secrets.envMap` escape hatch).
   (ii) **credential** — each DB has a per-app role `app_<app>` + random password, and
   the apps-gateway **refuses** any `(user, database)` that is not `app_<app>/<app>`
   *before* waking anything (`docs/connecting.md`, issue #74/#92). (iii) **RBAC** —
   the knext operator's mirror step only reads `app-db-*` Secrets and writes into the
   requesting `NextApp`'s own namespace with a same-ns ownerRef. A tenant editing a
   `NextApp` in ns A therefore cannot cause a Secret from ns B's DB to be projected.
   *Residual note:* two `NextApp`s that hash to the same derived `appName` would
   collide on the shared plane — the derivation must include a namespace-qualified hash
   to make that practically impossible (see *Open decisions*).

5. **Forced teardown orphan (named trade-off).** If scale-zero-pg is unreachable at
   `NextApp` delete, the finalizer removes itself after the bounded wait, leaving an
   orphan `AppDatabase` + timeline. This is the deliberate "never wedge on an external
   dependency" choice; the backstop is the existing `reclaim-orphans` /
   appdb-operator reconcile. Alternative (block deletion until the DB is gone) is
   rejected for the same reason knext ADR-0008 rejected it.

### 5. Alternatives considered

- **Merged operators** (one operator reconciles both `NextApp` and `AppDatabase`, or
  knext imports the appdb reconcile package). **Rejected.** It collapses the
  deliberate two-layer platform boundary (knext = apps, scale-zero-pg = databases),
  couples the two release cycles, and forces one controller to hold cluster-wide power
  over both the app namespaces *and* the storage plane. Delegation keeps the layers
  independently ownable, testable, and releasable, and keeps the DB RBAC blast radius
  to a single scoped `Role`.
- **knext builds its own DB machinery.** **Rejected** — violates knext's founding
  rule ("binds databases only via a Secret; builds no DB machinery") and duplicates
  the hardened branch-per-app provisioning ADR-0004 already delivers.
- **Status quo — manual four-step wiring.** **Rejected** — the exact friction #119
  removes; and, critically, it has **no lifecycle coupling**, so deleting a `NextApp`
  silently leaks a database, its timeline, and safekeeper WAL.
- **External projection (ESO / reflector) as the default.** **Rejected as default,
  kept as fallback** — adds a third cluster-wide controller and moves rotation/GC
  semantics out of knext. The native mirror keeps knext the single source of truth.

### 6. Consequences

- **The `AppDatabase` Secret + status is now a public API.** scale-zero-pg must treat
  the Secret name (`app-db-<appName>`), its keys (`DATABASE_URL`, `PGUSER`,
  `PGPASSWORD`, `APP_ROLE_VERIFIER` — SCRAM verifier, #117; was `APP_ROLE_MD5`), and `status.phase`/`conditions[Ready]` as a **stable
  external-driver contract** — documented, and changed only with versioning care. A
  new **"external driver contract"** doc section in scale-zero-pg is an action item.
- **`DATABASE_URL_RO` gap.** For knext to inject `DATABASE_URL_RO`, scale-zero-pg
  should emit it into `app-db-<app>` (today it is a hand-assembled two-DSN pattern).
  Alternatively knext derives it (swap host-port to `…:55434`) — but making it a
  first-class Secret key is cleaner and keeps the contract in one place.
- **Two finalizers on `NextApp`** (external-cleanup + db-cleanup) must compose
  correctly; ordering is independent (different external systems) but both must clear.
- **The MVP can be phased** to de-risk the cross-ns work (see below).

---

## Open decisions (for the owner)

1. **ADR ownership long-term.** This file is the shared design record but the contract
   spans repos. Proposed: **scale-zero-pg owns the `AppDatabase` external-driver
   contract** (it provides the API); **knext owns a companion ADR** for
   `spec.database` + the mirror/finalizer (it provides the implementation), linking
   here. Confirm, or consolidate into one repo.
2. **Does `AppDatabase` need versioning/hardening for external drivers?** Recommended
   before knext depends on it: (a) **add `DATABASE_URL_RO` to the `app-db-<app>`
   Secret**; (b) document the Secret/status **stability contract**; (c) decide whether
   to promote the CRD `v1alpha1 → v1beta1` to signal external-consumer stability, or
   keep `v1alpha1` and rely on the doc contract. Owner call on how much stability to
   commit to now.
3. **Phasing / MVP scope.** Options: **(A) MVP = same-namespace** — require the
   `NextApp` to live *in* `scale-zero-pg` (no mirror, no cross-ns RBAC), prove the
   `spec.database` → `AppDatabase` → env-injection loop, then add cross-ns projection
   in phase 2. **(B) MVP = cross-ns from day one** — the full mirror + scoped Role.
   Recommendation: **(A) then (B)** — (A) validates the delegation + gating + teardown
   contract with the least moving parts; (B) adds only the mirror + RBAC. Owner to pick.
4. **`appName` derivation + collision policy.** Confirm `<namespace>-<name>` with a
   namespace-qualified short hash on overflow/collision, stored on `NextApp.status`.
   This is security-relevant (§4.4), not just cosmetic.
5. **Hard-gate vs soft-deploy on DB-not-Ready** (§4.1). Recommendation: **hard-gate**.
   Confirm.
6. **BYO-database escape hatch.** Confirm that `spec.database.enabled=false` +
   explicit `spec.secrets.envMap` remains fully supported (bring an external/existing
   DB) — the inline path is additive, not a replacement.
7. **RBAC blast radius.** Confirm the knext operator may hold `create`/`delete` on
   `appdatabases` (scoped `Role`, `scale-zero-pg` ns only) — i.e. a knext operator
   compromise could provision/destroy databases on the shared plane (bounded to the
   apps tenant; cannot touch the storage plane).

---

## Facts we could not fully verify (flagged for review)

- The knext operator's exact reconcile ordering for injecting a *new* `envMap` entry
  and rolling a Knative Revision on Secret change was inferred from
  `nextapp_controller.go` (envMap → `SecretKeyRef`) + knext ADR-0008
  (`GenerationChangedPredicate`); the checksum-annotation roll (§4.3) is a
  **proposed** mechanism, not existing behavior.
- Whether knext apps are guaranteed one-per-namespace or many-per-namespace was not
  confirmed (a sample uses `namespace: default`). The `appName` derivation is designed
  to be safe **either** way, but the collision-hash detail (Open decision 4) depends on it.
- `DATABASE_URL_RO` is **not** emitted by the current appdb operator (verified in
  `k8s.go` `CreateSecret` — keys are `PGUSER`/`PGPASSWORD`/`APP_ROLE_VERIFIER`/`DATABASE_URL`
  only); the two-DSN RO pattern is documented in `docs/connecting.md`. Injecting `_RO`
  requires the API-hardening item in Open decision 2.
