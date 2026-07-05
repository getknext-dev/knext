# Binding an existing Postgres to a NextApp

Point your app at any existing Postgres — a scale-zero-pg per-app database, a
managed cloud Postgres, anything that speaks a DSN — with one typed field on the
`NextApp` CR. knext stays engine-agnostic: it never provisions or manages the
database here, it **binds a Secret**.

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: shop
spec:
  image: ghcr.io/acme/shop:v3@sha256:…
  database:
    secretRef:
      name: shop-db          # a Secret in the app's namespace
      # key: DATABASE_URL    # default
```

The operator injects the Secret's key into the container as `DATABASE_URL`,
through the same machinery as `spec.secrets.envMap` — this field is typed sugar
over that path, not a new mechanism. Your app reads `process.env.DATABASE_URL`
and never knows the difference.

Optionally bind a read-only DSN as `DATABASE_URL_RO`:

```yaml
spec:
  database:
    secretRef:   { name: shop-db }   # -> DATABASE_URL   (key defaults to DATABASE_URL)
    roSecretRef: { name: shop-db }   # -> DATABASE_URL_RO (key defaults to DATABASE_URL_RO)
```

The defaults are chosen so a single Secret carrying both keys — the layout
scale-zero-pg mints — binds with no `key` configuration at all. Set `key`
explicitly when your Secret uses a different layout (e.g. `key: uri`).

## One command: `kn-next db bind`

You don't have to hand-edit the CR. From your app directory (or with the app
name as a positional):

```sh
kn-next db bind --secret shop-db --ro-secret shop-db
```

The CLI validates the whole rule matrix below **client-side** — DNS-1123 Secret
names, `DATABASE_URL`/`DATABASE_URL_RO` collisions with `spec.secrets.envMap`,
and the managed-vs-BYO mutual exclusion — so a conflict fails at your keyboard
with the exact reason instead of an apiserver rejection. It then issues a
single merge-patch of the `NextApp` CR's `spec.database` (the operator
reconciles everything else; the CLI never touches the ksvc or the Secret).

Useful flags:

- `--key` / `--ro-key` — when your Secret uses a non-default key layout
  (e.g. `--key uri`).
- `-n, --namespace` — the app's namespace (default `default`).
- `--dry-run` — print the CR merge-patch YAML without applying anything.
- `--dsn <dsn>` or `--secret-file <path>` — run the local connection-contract
  check: warns on `sslmode=disable` and prints the pool rules from
  [the connection contract](#the-connection-contract-read-this-once). The DSN
  is read locally only and never sent anywhere.

```sh
# Preview the patch and check a locally-minted Secret's DSN:
kn-next db bind shop --secret shop-db --ro-secret shop-db \
  --secret-file ./shop-db-secret.yaml --dry-run
```

## Rules the API enforces for you

- `secretRef.name` must be a valid Secret name (lowercase DNS-1123) in the
  **app's own namespace** — there is no cross-namespace binding.
- `spec.database` **owns** `DATABASE_URL`/`DATABASE_URL_RO`: also defining them
  in `spec.secrets.envMap` is rejected when you create the app or add the
  conflict, so there is never a silent winner. Apps that already carried the
  conflict before this rule keep deploying — `spec.database` wins and the
  operator records a Warning event naming the ignored `envMap` entry. Use
  `envMap` freely for every *other* secret-backed env var.
- `secretRef` (bind an existing DB) and `enabled: true` (let the platform
  provision one — see the [unified-config guide](./unified-config-database.md))
  are mutually exclusive: one mode per app. Provisioning knobs (`tier`,
  `readReplicas`, `quotas`, `keepOnDelete`) are rejected alongside `secretRef`
  rather than silently ignored.
- If the Secret doesn't exist yet, the app is still deployed and its pods wait
  on the Secret (`CreateContainerConfigError`) — create the Secret and the pod
  starts. The operator does not gate the deploy on a Secret it doesn't manage.
- Rotating the DSN inside the Secret does **not** roll a new revision by
  itself; redeploy (or bump the CR) to pick it up.

## The connection contract (read this once)

When both your app and its database scale to zero, two timing rules keep the
first request after idle from failing. They are client-side pool settings — the
platform cannot set them for you:

1. **Pool idle timeout < the gateway's idle window (60 s for scale-zero-pg).**
   The gateway closes server-side connections it considers idle. If your pool
   keeps sockets longer than that, it holds dead connections and the next query
   fails. Keep pool idle at ~10 s, and `min` idle connections at `0` — idle
   pooled connections also look like activity and keep the database awake,
   defeating scale-to-zero.
2. **Connect timeout ≥ 10 s.** A cold database wakes in about **2.5 s**
   (sub-second on the warm tier); the gateway holds your connection open while
   it wakes. A 2–5 s connect timeout can give up right before the wake
   completes — 10 s gives comfortable margin. (node-postgres's own default of
   `0` waits *indefinitely*: that survives wakes too, but a truly-unreachable
   database then hangs every request forever instead of failing fast — set a
   bound.)

```ts
// e.g. node-postgres
new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  min: 0,
  idleTimeoutMillis: 10_000,        // < the 60s gateway idle window
  connectionTimeoutMillis: 15_000,  // bounded: survives a cold DB wake, fails fast when the DB is dead
});
```

`@knext/lib`'s `getDbPool()` ships exactly these defaults (overridable via
`DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECT_TIMEOUT_MS`).

**What to expect on a fully cold start** (app *and* database at zero, measured
on a live cluster): the database connect happens *inside* the app container's
own startup window, so the two wakes overlap rather than add up — total
time-to-first-byte is roughly **13 s**, dominated by the app's cold start, not
the database's ~2.5 s wake. Once either side is warm, only the other's latency
remains.

## Worked example: scale-zero-pg

scale-zero-pg provisions a per-app, scale-to-zero Postgres and mints a Secret
whose DSN points at its gateway (`pggw`) — the gateway is what wakes the
database, so the DSN host is **always the gateway, never the compute**:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: shop-db
  namespace: my-app-ns
stringData:
  DATABASE_URL: postgres://app_shop:…@pggw-apps.scale-zero-pg.svc:55432/shop?sslmode=disable
  DATABASE_URL_RO: postgres://app_shop:…@pggw-apps.scale-zero-pg.svc:55434/shop?sslmode=disable
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: shop
  namespace: my-app-ns
spec:
  image: ghcr.io/acme/shop:v3@sha256:…
  database:
    secretRef:   { name: shop-db }
    roSecretRef: { name: shop-db }
```

App sleeps at zero, database sleeps at zero, one visitor wakes both.

Prefer not to manage the `AppDatabase`/Secret yourself? `spec.database.enabled:
true` has the platform provision and wire it end-to-end — see
[unified config](./unified-config-database.md). The wider platform picture
(tiers, replicas, backups) is in [database platform](./database-platform.md).
