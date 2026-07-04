# Unified config: one `NextApp`, its database auto-provisioned

> **Status:** implemented (ADR-0006, #119). The knext operator provisions and
> wires a [scale-zero-pg](https://github.com/getknext-dev/scale-zero-pg) database
> from a single inline block on your `NextApp`.

knext and scale-zero-pg are **one platform, two layers**: knext scales your
*application* (Next.js on Knative), scale-zero-pg scales its *database* (a
wake-on-connect Postgres gateway). Both scale to zero. With **unified config** you
declare an app **and** its database in one `NextApp`, in one namespace — and the two
sleep at zero and **wake together on a single visitor request**.

## The whole author surface

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: shop
  namespace: team-acme
spec:
  image: registry.example.com/shop@sha256:abc123…
  scaling: { minScale: 0, maxScale: 10 }
  database:                 # ← inline DB: auto-provisioned + wired
    enabled: true
    tier: cold              # cold (scale-to-zero) | warm (~0.4s wake)
    readReplicas: true      # also injects DATABASE_URL_RO
    quotas:
      cpu: "1000m"
      mem: "1Gi"
      maxConnections: 100
  # No secrets.envMap for the DB needed — the operator injects
  # DATABASE_URL (and DATABASE_URL_RO) automatically.
```

Your app container receives `DATABASE_URL` (and `DATABASE_URL_RO` when
`readReplicas: true`) exactly as if you had hand-written the `secrets.envMap`
entries — but you didn't have to provision the DB, find its Secret, copy it across
namespaces, or wire it. And when you `kubectl delete nextapp shop`, the database is
reclaimed too (no leaked timeline).

## What the operator does

1. **Derives** a plane-globally-unique `appName` from the NextApp's own
   `(namespace, name)` — e.g. `team-acme/shop` → `team-acme-shop`. Recorded on
   `status.databaseAppName`. **You never set this** (see [Security](#security-isolation)).
2. **Creates an `AppDatabase`** CR in the scale-zero-pg namespace (default
   `scale-zero-pg`; configurable via the operator's `--database-namespace` flag).
3. **Hard-gates** the app on the `AppDatabase` reaching `status.phase == Ready` —
   no Knative Service is created until then. A `cold` DB reaches `Ready` in
   ~seconds (the compute wakes lazily on first connect), so this rarely adds latency.
4. **Mirrors** the minted `app-db-<appName>` Secret from the scale-zero-pg namespace
   into **your** namespace as `<name>-db` (e.g. `shop-db`), owner-referenced to the
   NextApp. Kubernetes `secretKeyRef` cannot cross namespaces, so a same-namespace
   copy is required; the owner reference makes it garbage-collected with your app.
5. **Injects** `DATABASE_URL` (+ `DATABASE_URL_RO`) into the app env via the existing
   `secrets.envMap` → `SecretKeyRef` path.

`status.conditions[DatabaseReady]` reflects the gate: `False`/`Provisioning` while
the DB comes up, `True` once the DSN is wired.

## Security & isolation

The `appName` is **derived, never author-supplied** — this is the load-bearing
security seam (ADR-0006 §4.4). Because it is computed from the NextApp's own
`(namespace, name)`:

- A `NextApp` in namespace **A** can only ever provision/bind the database minted for
  **its own** identity. It cannot name — and therefore cannot bind — namespace **B**'s
  database.
- Two apps that share a name in **different** namespaces (`tenant-a/shop` and
  `tenant-b/shop`) get **distinct** databases (`tenant-a-shop`, `tenant-b-shop`) — no
  accidental cross-tenant sharing.
- The mirrored Secret is written only into the requesting NextApp's own namespace,
  with a same-namespace owner reference.

Defense-in-depth continues at the scale-zero-pg layer: each DB has a per-app role +
random password, and the apps-gateway refuses any `(user, database)` pair that is not
the app's own — before waking anything.

## Sizing note: pool idle vs `GW_IDLE_MS`

scale-zero-pg scales the database compute back to zero after `GW_IDLE_MS` with no
connections. If your app holds a **connection pool open at idle**, the database never
sees zero connections and never sleeps. Keep the app's pool **idle timeout below
`GW_IDLE_MS`** (or use a pool that closes idle connections) so the app and DB can both
reach zero. This is the same guidance as the manual two-Secret integration — unified
config does not change it.

## Read replicas

`readReplicas: true` requests the scale-zero-pg read-only pool and injects
`DATABASE_URL_RO`. The RO DSN is emitted into the source Secret by scale-zero-pg's
read-scaling lane; until a given cluster emits the `DATABASE_URL_RO` key, the operator
tolerates its absence (it injects `DATABASE_URL` only and adds `_RO` as soon as the
key appears). Point read-only queries at `DATABASE_URL_RO`; writes always use
`DATABASE_URL`.

## Credential rotation

When scale-zero-pg rotates the database password, the source Secret changes. The
operator re-mirrors it and stamps a checksum of `DATABASE_URL` onto the app's pod
template (`apps.kn-next.dev/db-secret-hash`), which rolls a new Knative Revision so
running pods pick up the new DSN (pods read `secretKeyRef` at **start** only).

## Teardown

Deleting the `NextApp` runs a `db-cleanup` finalizer that deletes the `AppDatabase`
(whose own deprovision finalizer performs the safe two-sided Neon timeline reclaim).
The mirrored Secret is garbage-collected by its owner reference. Set
`keepOnDelete: true` to retain the timeline for PITR/forensics (reclaim it later on the
scale-zero-pg side). If scale-zero-pg is unreachable at delete time, the finalizer
records a warning and releases the app anyway (never wedging it in `Terminating`),
leaving an orphan for scale-zero-pg's `reclaim-orphans` sweep — a deliberate trade-off.

## Required RBAC

The operator needs a **namespace-scoped** grant in the scale-zero-pg namespace to
drive the `AppDatabase` API and read the minted Secret. Apply the shipped manifest
(`config/rbac/appdb_driver.yaml`) — a `Role` + `RoleBinding` in `scale-zero-pg` that
binds the knext operator's ServiceAccount to exactly:

- `appdatabases`: `get, list, watch, create, update, patch, delete`
- `secrets` (read): `get, list, watch` — to mirror the DSN

This is least privilege: the operator gets **no** power over the storage plane, the
per-app computes, or any Secret other than the `app-db-*` DSNs. (scale-zero-pg's
appdb-api lane may ship an equivalent `Role`; applying both is idempotent.)

## Bring your own database (escape hatch)

Unified config is **additive**, not a replacement. Omit `spec.database` (or set
`enabled: false`) and wire an external/existing database by hand through
`spec.secrets.envMap` — that path is unchanged and fully supported.
