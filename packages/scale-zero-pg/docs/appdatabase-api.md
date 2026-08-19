# AppDatabase API — scale-zero-pg's provisioning contract

The `AppDatabase` custom resource is scale-zero-pg's **declarative provisioning
interface** (ADR-0004), reconciled by scale-zero-pg's **own** operator (see §5 of
[`ARCHITECTURE.md`](ARCHITECTURE.md)). This page is its **stable external-driver
contract**: the surface any *external* controller depends on to drive
branch-per-app provisioning programmatically (ADR-0006, unified config, #119).

> **knext is a consumer, not the driver.** After **ADR-0025** the knext operator
> no longer provisions databases at all — it binds an already-provisioned database
> **BYO** via a `DATABASE_URL`-from-Secret (ADR-0019) and depends only on the
> resulting DSN, not on this CRD. This contract is **scale-zero-pg's own**; it
> exists for whoever chooses to drive `AppDatabase` from their controller.

Everything here is a **soft-compatibility surface**: the CRD stays `v1alpha1`
(see [Versioning](#versioning)), but the fields, Secret keys, and status
semantics below are treated as an API and changed only with care and migration
notes. If you drive `AppDatabase` from your own controller, depend on **these**
names and semantics.

- CRD: [`deploy/82-appdb-crd.yaml`](../deploy/82-appdb-crd.yaml)
- Operator: [`deploy/83-appdb-operator.yaml`](../deploy/83-appdb-operator.yaml)
- External-driver RBAC: [`deploy/84-appdb-external-driver-role.yaml`](../deploy/84-appdb-external-driver-role.yaml)
- Design: [`docs/adr-0006-unified-config.md`](adr-0006-unified-config.md)

---

## 1. The resource

`apps.scale-zero-pg.dev/v1alpha1`, `kind: AppDatabase`, **Namespaced**, shortName
`appdb`. Every `AppDatabase` lives in the **`scale-zero-pg`** namespace, alongside
the shared storage plane and the per-app computes.

```yaml
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata:
  name: team-acme-shop            # the external driver's derived, plane-unique name
  namespace: scale-zero-pg
spec:
  appName: team-acme-shop         # required, immutable; the DSN db name + compute-<app> suffix
  tier: cold                      # cold (scale-to-zero) | warm (permanent warm hold; §2a)
  readReplicas: false             # see roPool; drives DATABASE_URL_RO emission
  roPool: { enabled: false }      # read-replica pool; enabled => emit DATABASE_URL_RO
  quotas: { cpu: "1000m", mem: "1Gi", maxConnections: 100 }
  keepTimelineOnDelete: false     # false = safe two-sided timeline reclaim on delete
  warmSchedule:                   # optional scheduled DB warm windows (knext #388; §3b)
    - { start: "0 8 * * 1-5", end: "0 20 * * 1-5", timezone: America/New_York }
```

> **Note on `readReplicas` vs `roPool.enabled`.** The `AppDatabase` spec field is
> `roPool.enabled`. knext's `NextApp.spec.database.readReplicas` (a simple bool)
> **maps to** `roPool.enabled` (ADR-0006 §1). Enabling it makes the operator emit
> the `DATABASE_URL_RO` Secret key (§3).

`appName` rules (enforced by the operator, in lock-step with `provision-app.sh`):
RFC1123 DNS label, ≤63 chars, lowercase `[a-z0-9-]`, not leading/trailing `-`, and
**not** a reserved name (`tmpl`/`warm`/`ro`). An invalid name is a **terminal**
`Failed` (no requeue) — the spec must change.

---

## 2. Status contract — what a driver waits on

The operator reconciles `.status`. A driver gates its own work on these fields:

| field | meaning | driver use |
|---|---|---|
| `status.phase` | `Provisioning` \| `Ready` \| `Failed` \| `Deleting` | wait for `Ready`; surface `Failed` |
| `status.conditions[type=Ready]` | `status: "True"` when servable | the canonical readiness gate |
| `status.conditions[type=Provisioned]` | branch + child objects exist | provisioning progress |
| `status.conditions[type=ColdRestorable]` | `"True"` once this app is recoverable by a **cold** disaster restore (ancestor WAL durable in object storage; runbook-dr.md §9d-bis) | **do NOT gate readiness on this** — it is disaster-restore coverage, not serving; alert if it stays non-`True` for long |
| `status.conditions[type=WarmHold]` | **present and meaningful whenever warmth is requested** — `spec.tier: warm` (§2a) or a non-empty `spec.warmSchedule` (§3b). `"True"`/`TierWarm` while the permanent hold is established, `"True"`/`WindowActive` while a scheduled window holds it; `"False"`/`WindowInactive`, `/HoldFailed`, `/InvalidWarmWindow`, or `/HoldsUnavailable` otherwise. **Absent** while the CR has never asked for warmth, and **retracted to `"False"`/`WarmthNotRequested`** in the same pass that releases the hold when warmth is *withdrawn* by a `spec` edit (`tier: warm` → `cold`, or the last `warmSchedule` window deleted) — so a `"True"` here never outlives the spec that asked for it | the **only** true statement about whether the DB is warm right now — but **never gate serving on it**; a hold failure degrades to the ordinary cold wake |
| `status.secretName` | the output Secret name (`app-db-<app>`) | **read the Secret to mirror** — do not reconstruct |
| `status.observedGeneration` | last `spec` generation reconciled | detect stale status after a `spec` edit |
| `status.timelineId` | the app's Neon timeline id | diagnostics |
| `status.ancestorLsn` | the template LSN this app branched from (persisted at branch time; back-filled from the branch for adopted/pre-existing apps, #209) | diagnostics; the cold-restorability comparison point |
| `status.computeReady` | compute has ≥1 available replica **right now** | diagnostic only — it reflects what the gateway has scaled to, not a readiness gate for either tier |

**Readiness semantics — identical for both tiers.** A database reaches
`phase: Ready` / `Ready=True` as soon as it is *provisioned*, because the wake
path is the same for both tiers: the apps-gateway wakes the compute on the first
connection. `computeReady` is `false` at rest on a cold tier and that is
expected; it is also `false` on a warm tier in the moments before the hold is
(re-)established. The `Ready` condition's **reason** distinguishes them:
`Provisioned` (cold), `WarmHeld` (warm and actually held), `WarmHoldDegraded`
(warm requested but **not** in effect — see `WarmHold` for why). So a driver's
gate is:

```
phase == Ready  &&  conditions[Ready].status == "True"
```

Wait on that before reading `status.secretName` and mirroring the Secret. A
`Failed` phase carries the reason verbatim in `status.message` — surface it; do
**not** deploy the app on a `Failed` DB (ADR-0006 §4.1 hard-gate).

**Cold-restorability (`ColdRestorable`).** Independently of serving readiness, the
operator reports whether the app is recoverable by a **cold** disaster restore (fresh
cluster, object-storage bucket only) *right now*. A freshly-branched app reads its
unmodified pages from the shared template at its ancestor LSN, so a cold restore can
only reconstruct it once the template's layers up to that LSN are durable in object
storage (`remote_consistent_lsn ≥ ancestorLsn`; see runbook-dr.md §9d-bis). For the
first seconds-to-minutes of an app's life that is briefly `False`
(`AncestorWALNotYetDurable`) and then self-heals to `True` (`AncestorDurable`) — the
property is monotonic. **Do not gate app rollout on this** (the app is fully usable
while it is still `False`); it is an operational signal — alert if it stays non-`True`
far longer than expected (a stuck template upload). `Unknown` means the operator could
not read the pageserver on that pass and will re-check.

---

## 2a. Tiers (`spec.tier`) — what `warm` actually is

| tier | mechanism | what you get | what it costs |
|---|---|---|---|
| `cold` (default) | nothing is held; the compute sits at 0 replicas | the apps-gateway wakes it 0→1 on the first connection; that connection pays the wake | nothing at rest |
| `warm` | a **permanent warm hold**: the operator keeps ONE authenticated idle postgres connection to the app open through the apps-gateway, forever | the compute never idles to zero, so queries pay **no compute wake and no cold auth** | 1 connection of `GW_MAX_CONNS` (90), one liveness ping per resync (`APPDB_RESYNC_MS`, default 15 s), and the compute's cpu/mem reserved 24/7 |

**`warm` is a held connection, not a replica floor.** The operator writes
`replicas: 0` for **both** tiers and never writes a replica count to keep an app
warm — the apps-gateway is the single writer of `compute-<app>` replicas, and its
idle scale-to-zero only arms when a compute has **zero** connections. A replica
pin would simply be undone: the gateway parks the compute `GW_IDLE_MS` after the
last connection closes regardless of what `spec.replicas` says. (This is exactly
how `spec.tier: warm` used to be implemented, and why it silently degraded to
cold after its first idle window. There is deliberately **no** `minWarm` /
replica-floor field; adding one would recreate the two-writer defect.)

Mechanically, `tier: warm` is the same actuator as a 24/7 `warmSchedule` window —
see §3b for the full mechanism, cost, and failure semantics.

**Precedence — `tier: warm` subsumes `warmSchedule`.** If both are set, the
permanent hold wins and the windows are **not evaluated at all**: a window
boundary never drops a warm tier's hold, and a malformed window on a warm-tier
AppDatabase is inert (it raises no `InvalidWarmWindow` event, because it is
warming nothing that the tier is not already warming). Use `warmSchedule`
*instead of* `tier: warm` when you want warmth only during declared hours.

**Degrade, don't fail.** If the hold cannot be established (compute still waking,
gateway rollout, Secret not yet minted) the database is **not** warm — and says
so rather than reporting warm-and-healthy:

- `WarmHold` = `False` / `HoldFailed` (or `HoldsUnavailable` if the operator has
  no warm-hold actuator wired), plus a `WarmHoldFailed` Warning event;
- `Ready` = `True` with reason **`WarmHoldDegraded`** and a `status.message`
  saying the compute wakes on connect.

Serving is never gated on warmth: a degraded warm tier behaves exactly like a
cold one, and the operator retries the hold every resync.

**Withdrawing warmth is reconciled like any other edit.** Editing `tier: warm` →
`cold` (or deleting the last `warmSchedule` window) **releases** the hold within
one resync tick and retracts `WarmHold` to `False`/`WarmthNotRequested`; the
compute then parks on the gateway's ordinary idle window and
the `appdb_warm_hold_active{app=...}` series disappears (it is emitted only while
held; the alert's PromQL carries `or vector(0)` for absence). A hold never outlives the spec
that asked for it — if it did, the app's compute could never sleep again *and*
the stale subtraction would blind the `ComputePhantomKeepalive` alert.

---

## 3. Output Secret contract

The operator mints one Secret per app, named by `status.secretName`
(**`app-db-<appName>`**), in `scale-zero-pg`, labelled
`app.kubernetes.io/managed-by=appdb-operator`. Keys:

| key | always? | value |
|---|---|---|
| `PGUSER` | yes | the per-app role, `app_<app>` |
| `PGPASSWORD` | yes | the per-app random password |
| `APP_ROLE_VERIFIER` | yes | the role's **SCRAM-SHA-256 verifier** (`SCRAM-SHA-256$…`), injected verbatim as the Neon `compute_ctl` `encrypted_password` (issue #117; renamed from `APP_ROLE_MD5`). Non-reversible — never the plaintext. |
| `DATABASE_URL` | yes | `postgres://app_<app>:<pw>@pggw-apps.scale-zero-pg.svc:55432/<app>?sslmode=disable` |
| `DATABASE_URL_RO` | **only when `roPool.enabled`** | the writer DSN with the gateway **RO port** (`55434`) |

`DATABASE_URL_RO` is derived from `DATABASE_URL` by swapping **only** the gateway
port (`55432` → `55434`); same role, password, host and database. It is
**reconciled idempotently every pass** — added when `roPool.enabled` flips on,
removed when it flips off — and **`PGPASSWORD` is never touched** (a live app is
never locked out). The port is operator-configurable via `APPDB_GATEWAY_RO_PORT`.

> ### ✅ The per-app RO serving endpoint is LIVE (issue #127) — tenant-isolated
> `DATABASE_URL_RO` is a real, per-app read endpoint. When `roPool.enabled` the
> operator also provisions the app's **own** read-only compute (`compute-ro-<app>`,
> attached to the app's **own** timeline, `0↔N` on connect, own Service, optional
> per-app HPA when `roPool.maxReplicas>0`), and the apps-gateway runs a second
> listener on `55434` in **template mode** so `database=<app>` reads route to
> `compute-ro-<app>`.
>
> **Hard isolation guarantee (never another tenant, never the shared pool).** The RO
> port enforces the identical `(user,database)` authz as the writer port, and each
> app resolves to a **distinct** `compute-ro-<app>` on its **own** timeline. App A's
> reads can never reach app B's RO compute (authz-refused + distinct target) or the
> shared primary `compute-ro` pool (which is fronted by the *different* primary
> gateway `pggw:55434` on the *primary* timeline). `_verify-perapp-ro.sh` proves it:
> A reads A, never B (data **and** authz, both directions), writes on the RO DSN are
> rejected, and staleness is measured (Replica tip-following).
>
> Point per-app reads at `DATABASE_URL_RO` and writes at `DATABASE_URL`. Because the
> RO endpoint is a hot standby, use `DATABASE_URL` for strict read-your-writes.

---

## 3b. Scheduled warm windows (`spec.warmSchedule`, knext #388)

An AppDatabase may declare **scheduled DB warm windows** — the DB half of the
knext scheduled warm floor (knext ADR-0030 + its 2026-07-18 addendum). While any
window is active the operator keeps the app's compute warm so the first
in-window query pays **no compute wake and no cold-auth**; outside every window
the compute sleeps at zero exactly as before.

> `spec.tier: warm` (§2a) runs on this same actuator as a **permanent** hold, and
> takes precedence: when a warm tier also declares windows, the windows are not
> evaluated.

```yaml
spec:
  warmSchedule:
    - start: "0 8 * * 1-5"        # 5-field cron (minute hour day month weekday), required
      end:   "0 20 * * 1-5"       # 5-field cron, required
      timezone: America/New_York  # IANA zone; defaults to UTC
```

**Semantics — deliberately identical to the knext NextApp's
`spec.scaling.warmSchedule`.** Same 5-field cron parser (the flavour the
Kubernetes CronJob controller uses), same per-window timezone, same membership
rule (a window is active between a `start` fire and its `end`). Declare the SAME
windows on both resources and the knext pod floor and this DB hold flip together
— this side flips within one operator resync of a boundary (`APPDB_RESYNC_MS`,
default 15s). One deliberate shape divergence: **no `replicas`** — a Neon
compute is single-writer (`Recreate`, one attach per timeline), so DB warm is
binary: exactly one compute held awake.

**Mechanism — a held connection, never a replica write.** While a window is
active the operator holds ONE authenticated idle postgres connection to the app
through the apps-gateway (the DSN is read verbatim from the `app-db-<app>`
Secret's `DATABASE_URL` key; SCRAM-SHA-256). The apps-gateway's idle
scale-to-zero only arms when a compute has **zero** connections, so the hold —
not any replica pin — is what keeps the compute at 1 for the whole window. This
preserves the single-writer invariant (the gateway is the only scaler of
`compute-<app>`; the operator holds no `deployments/scale` grant): a CronJob or
operator that pinned `replicas: 1` would be undone by the gateway
`GW_IDLE_MS` after the last query — two writers, thrash. The first dial at
window start rides the ordinary wake path (one wake-budget token, the normal
0→1). At window end the hold is released and the gateway parks the compute on
its usual idle window.

**Cost while held (the opt-in warm cost):** 1 connection of the compute's
`GW_MAX_CONNS` (90), one liveness ping per resync, and the compute's reserved
cpu/mem for the window's duration.

**Failure semantics — warming is best-effort.** A hold failure (compute still
waking, gateway rollout, Secret not yet minted) never fails provisioning: the
operator emits a `WarmHoldFailed` Warning event, sets `WarmHold=False/HoldFailed`,
and retries next resync; the app keeps its ordinary cold-wake path. A window
that fails to parse (this CRD has **no admission webhook**) is loud, never
silently skipped: an `InvalidWarmWindow` Warning event + `WarmHold=False/InvalidWarmWindow`.
Deleting the AppDatabase releases the hold before the compute objects are
removed, and so does **withdrawing** warmth from the spec (removing the last
window, or `tier: warm` → `cold`) — `WarmHold` is then retracted to
`False`/`WarmthNotRequested`. Operator restarts drop holds (TCP dies with the
process) and the next resync re-establishes them — crash-only, self-healing.

**Observability.** The `WarmHold` status condition (§2) per app — for scheduled
windows and for `tier: warm` alike — and the
`appdb_warm_hold_active{app=...}` gauge on the operator's `:9092/metrics`
(scraped by the platform Prometheus). The `ComputePhantomKeepalive` alert
subtracts held connections: a declared warm hold is intended warming, not a
phantom pool.

**External drivers** may set `spec.warmSchedule` like any other spec field (the
`knext-appdb-driver` Role already grants update). knext itself does not write it
— the owner (or GitOps) declares the same windows on both resources; knext binds
the database only via the Secret (DATABASE_URL contract, knext ADR-0025).

---

## 4. Cross-namespace consumability + RBAC

An external operator creates an `AppDatabase` **in `scale-zero-pg`** and reads the
output Secret there, then mirrors the Secret into the app's own namespace (an
`envMap`/`SecretKeyRef` is namespace-local, ADR-0006 §3). scale-zero-pg ships the
exact scoped grant for this:
[`deploy/84-appdb-external-driver-role.yaml`](../deploy/84-appdb-external-driver-role.yaml)
— a **namespace-scoped `Role`** (`knext-appdb-driver`) plus a `RoleBinding`
template. It grants:

- `appdatabases`: `get,list,watch,create,update,patch,delete`
- `appdatabases/status`: `get`
- `secrets`: `get,list,watch` (to read `app-db-*` and mirror it)

and **nothing on the storage plane** — no pageserver/safekeeper/minio, no
StatefulSets/Deployments/Pods/PVCs, no compute control. A compromise of the bound
SA is bounded to the apps tenant (create/destroy app databases + read `app-db-*`
DSNs); it cannot read or touch the storage plane. Bind it by editing the
`RoleBinding` subject to the external operator's ServiceAccount (which may live in
another namespace — a `RoleBinding` in `scale-zero-pg` may reference it).

### Hardening the secret read

Core Kubernetes RBAC **cannot** prefix-scope `resourceNames` for `list`/`watch`,
so the `secrets` rule above grants read of **all** Secrets in `scale-zero-pg` —
which includes storage-plane credentials. It is namespace-scoped and read-only,
but for deployments that need strict `app-db-*`-only reads, use one of:

- **Name-scoped `get`** — grant `secrets: [get]` with
  `resourceNames: ["app-db-<app>"]` per app (works for `get`; the driver reads by
  the exact name it derived, and re-reads on its own resync instead of a
  namespace-wide `watch`). A controller that manages many apps can maintain these
  per-app grants, or an admin can add them.
- **Dedicated namespace** — provision `app-db-*` Secrets into a namespace that
  holds *only* app DSNs, and grant the blanket read there. (Larger change; not the
  default layout today.)

The default manifest ships the working namespace-scoped read so the mirror works
out of the box; the strict variants are opt-in.

---

## 5. Versioning

The CRD stays **`v1alpha1`** for now. Rationale:

- The API is still evolving under the unified-config work (ADR-0006); promoting to
  `v1beta1`/`v1` signals a conversion/deprecation commitment we are not ready to make.
- The **stability guarantee is carried by this document**, not by the version
  string: the field names, Secret keys, and status semantics above are a
  **soft-compat surface** — additive changes are expected; renames/removals get a
  migration note and, if warranted, a served version bump.

An external driver should pin `apps.scale-zero-pg.dev/v1alpha1` and depend on the
documented names, not on the version implying frozen stability. When the surface is
proven across a couple of consumers, promotion to `v1beta1` is the natural next step.

---

## 6. Lifecycle summary

- **Create** an `AppDatabase` → operator branches the template timeline, renders the
  per-app compute (Deployment/Service/ConfigMap at `replicas: 0` — the gateway owns
  the replica count for **both** tiers, §2a), mints `app-db-<app>`, sets
  `status.secretName`, and settles `phase: Ready`.
- **Update** `spec` (tier / `roPool.enabled` / quotas / `warmSchedule`) → reconciled
  idempotently; e.g. toggling `roPool.enabled` adds/removes `DATABASE_URL_RO` with
  no password churn, setting `tier: warm` engages the permanent warm hold on the
  next resync (§2a), and adding a `warmSchedule` engages the warm hold at the next
  window (§3b). **Withdrawal is symmetric:** `tier: warm` → `cold`, or removing the
  last `warmSchedule` window, RELEASES the hold on the next resync and retracts
  `WarmHold` to `False`/`WarmthNotRequested` — the compute goes back to sleeping at
  zero (§2a).
- **Delete** → the `apps.scale-zero-pg.dev/deprovision` finalizer runs the safe
  two-sided Neon timeline reclaim (unless `keepTimelineOnDelete`) before the object
  is removed. An external driver deletes the `AppDatabase` from its own teardown
  finalizer (cross-namespace ownerRefs are not possible — ADR-0006 §3c).

Drilled end-to-end by [`deploy/_verify-operator.sh`](../deploy/_verify-operator.sh).
