# ADR-0071: Per-app Redis ACL user, issued by the operator

- **Status:** **Proposed (2026-10-16).** It is accepted or revised at the sprint-close design review,
  under the 2026-09-22 workflow amendment. #2396 builds against it once it is Accepted.
- **Issue:** #2404. **Builds:** #2396. **Evidence:**
  [`docs/security/redis-acl-spike.md`](../security/redis-acl-spike.md), reproduced by
  [`scripts/redis-acl-spike.mjs`](../../scripts/redis-acl-spike.mjs).
- **Relates to:** ADR-0001 (the operator is the single source of truth; the CLI writes only the
  `NextApp` CR), ADR-0017 (the CRD stays `v1alpha1`, additive changes only), ADR-0019 (Secret-backed
  bindings), ADR-0064 (the cluster-scoped `KnextPlatform` singleton), ADR-0068 (CDN tag purge, whose
  first-ready claim key this ADR has to account for).
- **Numbering:** 0070 is taken by the open Bun single-exec ADR (PR #2449).
- **Trigger class:** security (credentials, cluster-write surface) and CRD.

## Context

Each app's Redis keyspace is now separated by a key prefix: `kn-<12 hex>` derived from the app's
identity, or an explicit `spec.cache.keyPrefix`. But every app on a Redis connects with the **same
credential**: `spec.cache.url` (which can carry a password in the CR itself), or `REDIS_URL` from a
Secret through `spec.secrets.envMap`. So the prefix is a convention, not a boundary. A bug, or a
deliberately reused `keyPrefix`, can read, overwrite or delete another app's ISR entries and tag
stamps, and `kn-next doctor` can only warn. The operator's finalizer reaches Redis with the app's own
`spec.cache.url` to `SCAN` + `DEL` `<prefix>:*` on delete.

The spike measured the runtime under a per-app ACL user on Redis 7.4.11 and Valkey 8.1.10, with
both production clients (ioredis under Node, Bun's native client):

1. **It works.** `reset on >pw ~<prefix>:* resetchannels -@all` plus 20 commands runs the real cache
   handler (ISR, `'use cache'`, and both outage replays including the prefix-wide collapse sweep) with
   no unexpected denial. Cross-app `GET`/`SET`/`DEL`/`EVAL` are refused, including a Lua script that
   touches another app's key through an undeclared key.
2. **Three known gaps.** The CDN first-ready claim key `knext:cdn:purged:<cdn-tag-prefix>:<build>`
   sits outside `<prefix>:`. ioredis sends `INFO` (its ready check) and `CLIENT SETINFO` on every
   connect. All three are refused and tolerated (the purge is skipped; ioredis logs a warning and
   carries on). Bun's native client sends neither.
3. **Two residuals.** `SCAN` cannot be filtered by a key pattern, so a user lists other apps' key
   *names* (not values). And a nested prefix (`<A>:<more>`) sits inside A's pattern.
4. **ACL users do not survive a restart** of a Redis with no `aclfile` (the usual in-cluster setup).
   Re-running `ACL SETUSER` with `reset` is idempotent and leaves live connections alone. Rotation
   works with two overlapping passwords. `ACL DELUSER` drops live connections.
5. **Managed services (documented, not measured):** ElastiCache, Memorystore and Azure Cache for
   Redis do not let a client run `ACL SETUSER`. Users, where they exist, are created through the
   provider's API. In-band provisioning is a self-hosted Redis/Valkey capability.

Constraints this ADR has to satisfy: the CLI writes only the CR (ADR-0001); secrets live only in
Kubernetes Secrets; `Ready` must not report a requested security control that is not in force
(`computeStatusVerdict`); knext stays a narrow adapter, so no per-cloud provisioning; CRD changes are
additive in `v1alpha1` (ADR-0017). One more constraint comes from the threat itself:
**`spec.cache.url` is written by the CR author.** Any design in which the operator presents an admin
credential to "the app's Redis" lets a CR author point that credential at a host they control.

## Decision

### D1. Who holds the admin credential: the platform admin registers it, the operator alone reads it

The platform admin creates a Secret **in the operator's namespace** holding a provisioner credential
for one Redis endpoint, and registers it on the cluster-scoped `KnextPlatform` singleton:

```yaml
apiVersion: platform.kn-next.dev/v1alpha1
kind: KnextPlatform
metadata: { name: default }        # the singleton
spec:
  cache:
    redisEndpoints:
      - endpoint: redis.cache.svc.cluster.local:6379   # host:port, exact match
        provisionerSecretRef: { name: redis-provisioner, key: url }
```

- **Endpoint-bound.** The operator uses a provisioner credential only for an app whose
  `spec.cache.url` host and port **exactly** match a registered `endpoint`. A CR author cannot send
  the credential anywhere else, because an unregistered host gets no provisioning (D6). That closes
  the confused-deputy path described in *Context*.
- **Never leaves the operator namespace.** It is not referenced from any `NextApp`, not mounted into
  any app pod, and not written to status, events or logs.
- **A dedicated user, not `default`.** The docs ship a provisioner rule set:
  `on ><pw> ~* resetchannels -@all +acl|setuser +acl|deluser +acl|getuser +acl|whoami +scan +del +ping +info|server +client|setinfo`.
  Stated plainly so nobody mistakes it for least privilege: **a user that can run `ACL SETUSER` can
  grant itself anything, so this credential is root-equivalent on that Redis** (measured: the
  provisioner's `ACL SETUSER <itself> +@all` returns `OK` on both engines). The narrow rule set limits
  what the operator does by accident, not what a thief can do. That is why the credential is
  endpoint-bound and confined to the operator namespace. `+info|server` is the only `INFO` it gets,
  for the restart signal in D2.

### D2. Where `ACL SETUSER` runs: in the operator, re-asserted, never once

A cache-credentials step in the `NextApp` reconcile, before the Knative Service render, connects to
the registered endpoint with the provisioner credential and runs:

```
ACL SETUSER knext-app-<12 hex> reset on ><password> [><previous password during rotation>]
  ~<glob-escaped prefix>:* [%W~knext:cdn:purged:<cdn-tag-prefix>:*]
  resetchannels -@all
  +get +set +del +sadd +smembers +lpush +ltrim +lrange
  +hget +hset +hdel +hmget +hscan +scan +eval +time +multi +exec +discard +ping
  +client|setinfo
```

- **Username** `knext-app-<first 12 hex of sha256("<namespace>/<name>")>`, the same derivation as the
  default prefix and the CDN tag prefix. It is deterministic, unique per app, and does not expose app
  names in `ACL LIST`.
- **The command list** is the spike's measured minimal set, plus `+client|setinfo`, which only
  labels the caller's own connection. Without it, every connect of every ioredis client, including
  ones the app's own code opens, adds two `ACL LOG` entries. `ACL LOG` is a bounded ring, so that
  noise would push out the entries that matter.
- **`INFO` is not granted.** It is in `@dangerous` and returns server-wide statistics across every
  app (key counts, per-command counts, clients). ioredis proceeds after the refusal, at the cost of
  one warning line per connection. #2396 may silence that in knext's own clients
  (`enableReadyCheck: false` under a per-app user). The rule set does not change for it.
- **The CDN claim key gets a write-only selector**, `%W~knext:cdn:purged:<cdn-tag-prefix>:*`, added
  only when the app has a CDN configured. Measured: it allows the `SET … NX EX` claim and refuses a
  read of the key, `SET … NX GET`, and another app's claim key. The key keeps its current name, so
  there is no rolling-upgrade split between pods that claim under two different keys.
- **Idempotent re-assertion.** The `reset` makes every call converge to the same state, so the step
  runs on every reconcile. A Redis restart deletes every user, so the operator also resyncs each
  registered endpoint on a timer: it reads `INFO server` `run_id`, and when that changes it re-asserts
  every user on the endpoint, rate-bounded by `KnextPlatform` `rollout.maxAppsPerMinute`. Pods that
  connect between a restart and the re-assert fail authentication (the user no longer exists), trip the breaker and fail open, as
  the cache already does for any outage. Their invalidations are replayed when the breaker closes.
- **Redis/Valkey 7.0 or later** (the `%W~` selector and the script-ACL behaviour the spike measured).
  An endpoint whose provisioner gets `ERR unknown command` / `unknown subcommand` for `ACL`, or reports
  a version below 7.0, is treated as having no ACL support (D6).
- **Status.** A new `CacheCredentialsReady` condition, computed in `computeStatusVerdict`, carries
  the reason (`Provisioned`, `SharedCredential`, `EndpointUnregistered`, `AclUnsupported`,
  `ProvisionerRefused`, `PrefixConflict`). `status.cache` reports the isolation mode, username and
  Secret name, and never a password.

### D3. Who owns the per-app password: an operator-owned Secret in the app's namespace

- The operator generates 32 random bytes per app and writes Secret `<app>-redis-credentials` in the
  app's namespace. Its `ownerReference` is the `NextApp`, so it is garbage-collected with the app.
  Key `REDIS_URL` is `redis://<username>:<password>@<registered endpoint>`, with no database index.
- The Knative Service gets `REDIS_URL` through `valueFrom.secretKeyRef` and **never** a literal. The
  password never appears in the CR, its status, events, operator logs or the image.
- Admission, for an app that isolation applies to: refuse `spec.cache.url` with userinfo (a
  credential in the CR), and refuse `REDIS_URL` in `spec.secrets.envMap`. Today `REDIS_URL` is
  exempt so the user's value always wins, which here would silently replace the issued credential
  with a shared one.
- **The CLI does not change role.** It writes `spec.cache.isolation` into the CR when the app's
  config sets it, and nothing else: it never connects to Redis, never sees the provisioner
  credential, never writes the Secret. `kn-next doctor` reads `CacheCredentialsReady` from the CR's
  status.

### D4. Rotation: overlap, roll, retire

1. A rotation is requested by bumping an annotation on the `NextApp`
   (`apps.kn-next.dev/rotate-cache-credentials: <any new value>`), or by the operator on a schedule if
   #2396 adds one.
2. The operator generates a new password and re-asserts the user with **both** passwords (`>new`
   `>old`). A re-assert with one password would remove the one live pods use (the `reset`).
3. It writes the new `REDIS_URL` to the Secret, and stamps a hash of the Secret's content on the
   revision template. A changed Secret alone does not restart pods, so the stamp is what makes
   Knative roll a new revision onto the new password.
4. Once the new revision is Ready and holds all traffic, and the old revision has scaled to zero (or
   a bounded grace period has passed), the operator removes the old password (`<old`). Measured:
   connections that authenticated earlier keep working until they close, and a new `AUTH` with the
   old password gets `WRONGPASS`.

Rotating the provisioner credential is the platform admin's job: they rotate it in Redis and update
the Secret. The operator watches the Secret and uses the new value on its next connection.

### D5. Migration off the shared credential

1. Upgrade the operator and CRD first, then the CLI (the standing upgrade order).
2. The platform admin creates the provisioner user and Secret and registers the endpoint (D1).
   Nothing changes until this step: an unregistered endpoint keeps today's shared credential.
3. On a registered endpoint, every app whose `spec.cache.isolation` is unset (`auto`, the default)
   moves to its own user. The operator creates the user and the Secret, then rolls one new revision
   per app, bounded by `rollout.maxAppsPerMinute`. **The prefix does not change, so no cache entry
   is lost.** Old-revision pods keep the shared credential until they scale down.
4. `kn-next doctor` lists apps still on a shared credential, and why (`isolation: none`,
   unregistered endpoint, refused).
5. When none are left, the platform admin retires the shared credential (for example
   `ACL SETUSER default off`, or a new `requirepass`). knext does not do this: that credential is not
   knext's.
6. Rollback per app: `spec.cache.isolation: none` stops wiring the Secret and makes the operator
   `ACL DELUSER` the app's user.

**Before step 3, apps whose own code uses `REDIS_URL` for keys outside the prefix** (sessions, rate
limits, queues) will get `NOPERM` on those keys. They need to move those keys under the prefix, or
set `isolation: none`. The operator cannot see application code, so the docs have to say this
prominently.

### D6. A Redis without ACL support: fail closed when isolation was requested

`spec.cache.isolation` takes `auto` (the default), `acl` or `none`:

| Situation | `auto` | `acl` | `none` |
|---|---|---|---|
| Endpoint registered, provisioning succeeds | per-app user | per-app user | shared credential, doctor warns |
| Endpoint **not** registered | shared credential, doctor warns (today's behaviour) | **fail closed** (`EndpointUnregistered`) | shared credential, doctor warns |
| Registered, but no ACL support / the provisioner is refused | **fail closed** (`AclUnsupported` / `ProvisionerRefused`) | **fail closed** | shared credential |
| Prefix equal to, nesting inside, or containing another app's on the same endpoint | **fail closed** for the later app (`PrefixConflict`) | **fail closed** | shared credential, doctor warns |

**Fail closed** means the operator does not render the app onto a shared credential. It sets
`CacheCredentialsReady=False` with the reason, emits a Warning event, and leaves the last good
revision serving. A new app gets no Knative Service, so it never becomes `Ready`.

**Why fail closed and not warn.** Once isolation has been requested, by the app (`acl`) or by the
platform admin registering the endpoint (`auto`), falling back to the shared credential is the false
green that knext's status rules exist to prevent. The app would report `Ready` while the boundary it
asked for is missing, and the only signal would be a log line. A warning that fires on every
reconcile also gets ignored. A visible, unmissable `False` is the cheaper failure. The blast radius is
bounded: no app fails closed until someone has opted it in, because an unregistered endpoint with
`auto` stays on today's behaviour.

**Managed Redis that blocks `ACL SETUSER`** (ElastiCache, Memorystore, Azure Cache for Redis) lands
in the "no ACL support" row. Phase 2 adds `spec.cache.credentialsSecretRef`: the user creates the
scoped user through the provider (ElastiCache RBAC, Azure data access policies) and references a
Secret holding its `REDIS_URL`. The operator does not provision, but before reporting
`CacheCredentialsReady=True` it verifies the scope with a read probe outside the prefix that must be
refused. A credential that can read outside its prefix fails closed like any other.

### D7. The finalizer

On `NextApp` delete, the operator runs the existing `SCAN MATCH <escaped prefix>:*` + `DEL` **as the
app's own user** (least privilege, and the key pattern enforces the scope a second time). It then
runs `ACL DELUSER` with the provisioner credential. If the user was lost to a restart, it re-asserts
the user first. The Secret goes with the `NextApp` through its `ownerReference`.

### D8. Residuals, accepted and tracked

- **Key-name disclosure through `SCAN`.** `+scan` stays, because both outage collapse sweeps need
  it. The residual is documented, and a follow-up rebuilds the sweeps on an index the app owns
  (a set under `<prefix>:`), so `+scan` can be dropped.
- **Nested prefixes** are refused per endpoint (D6 `PrefixConflict`), not left to admission. The
  admission pattern allows `:` in `keyPrefix`, and a nesting is a relation between two apps, which
  no single object's validation can see.

## Options considered

| Option | Isolation | ADR-0001 | Secrets | Managed Redis | Restart-safe | Cost / scope | Verdict |
|---|---|---|---|---|---|---|---|
| **A. Operator issues the user in-band with an endpoint-bound provisioner credential (D1–D8)** | per app, enforced by Redis | yes: the operator writes the user and the Secret | provisioner credential stays in the operator namespace; per-app password only in an owned Secret | self-hosted only; managed through BYO Secret (phase 2) | yes, by re-assertion | one reconcile step, one CRD field, one platform field | **Recommended** |
| B. The CLI runs `ACL SETUSER` at deploy time | per app | **no**: the CLI mutates cluster-adjacent state out of band | the provisioner credential sits on developer machines and CI | same as A | **no**: nothing re-asserts after a restart | small | Rejected |
| C. BYO only: users create ACL users and Secrets themselves | per app, if done right | yes | user-managed | works everywhere | user's problem | none for knext | Rejected as the default (it pushes a security control onto every user, unverified); kept as A's phase 2 for managed Redis |
| D. Per-cloud API integration (ElastiCache RBAC, Azure policies, Memorystore) | per app | yes | cloud IAM | yes | yes | one integration per cloud, plus their auth | Rejected: per-cloud provisioning is PaaS scope, and the lock-in knext avoids |
| E. One Redis (or one `SELECT` database) per app | per instance; a database index is **not** a boundary, because ACL key patterns span databases | yes | per instance | yes | yes | an instance per app defeats a shared cache tier; `SELECT` isolates nothing | Rejected |
| F. Status quo: shared credential, doctor warns | none | yes | shared | yes | yes | none | Rejected: the problem #2396 exists to fix |

## Consequences

**Positive**
- A bug or a reused prefix in one app can no longer read, overwrite or delete another app's cache.
  Redis refuses it, as measured, including from Lua.
- The credential each app holds can do only what the cache does: no `FLUSHALL`, `KEYS`, `CONFIG`,
  `ACL`, pub/sub, or other apps' keys.
- The CLI's role is unchanged, and no credential is added to the CR.

**Negative / costs**
- The provisioner credential is root-equivalent on its Redis and now lives in the cluster, in the
  operator namespace. Compromise of the operator's Secret read access compromises every app's cache
  on that endpoint. Today the shared credential already has that reach, so this is no worse, but it
  is a new object to protect.
- A Redis restart costs every app a short `WRONGPASS` window until the resync re-asserts the users.
  The cache fails open during it, as it does for any outage.
- Apps that use `REDIS_URL` for their own keys outside the prefix break on migration until they move
  those keys or opt out (D5).
- `SCAN` still discloses other apps' key names until the index follow-up lands.
- Managed Redis gets isolation only through a user-created credential (phase 2), not automatically.
- Redis/Valkey 7.0 or later is required for `isolation: acl`.
- `REDIS_URL` loses its envMap exemption for isolated apps. That is a deliberate narrowing on the
  CRD's admission surface, scoped to apps that isolation applies to.

## Action items

1. **#2396 (the build), against this ADR:** D1 (`KnextPlatform.spec.cache.redisEndpoints`), D2 (the
   reconcile step, resync on `run_id`, `CacheCredentialsReady` in `computeStatusVerdict`), D3
   (operator-owned Secret, `secretKeyRef` wiring, the two admission refusals), D4 (rotation), D6
   (`spec.cache.isolation` and the fail-closed table), D7 (finalizer). Its existing acceptance stands:
   a kind e2e with two apps on one Redis, A refused (`NOPERM`) on B's keys, both apps' ISR and
   `'use cache'` paths including the outage replay working, and the password only in a Secret.
2. **One source for the rule set.** The operator's command list and
   `scripts/redis-acl-spike.mjs`'s `MINIMAL_COMMANDS` must not drift. #2396 adds a test that compares
   them. `tests/redis-acl-spike.test.ts` already reds when the runtime issues a command the list
   lacks.
3. **Run the live lane in CI.** Add `tests/redis-acl-spike.test.ts` with `KNEXT_REDIS_LIVE_URL` to the
   job that already runs the live Lua test against a digest-pinned Redis. Today it runs locally only.
4. **Follow-up issue:** rebuild both collapse sweeps on an app-owned index, then drop `+scan` (D8).
5. **Follow-up issue:** `spec.cache.credentialsSecretRef` for managed Redis, with the scope probe
   (D6 phase 2). Re-check each provider's documentation then; the spike's managed-offering table is
   unverified.
6. **Docs** (the user-facing site, no internal numbers): enabling isolation, the provisioner user's
   rule set, the migration path including the app-owned-keys warning, and what fail-closed looks like.
7. **Not this ADR's to do:** retiring the shared credential (D5 step 5) is the platform admin's call.

## Decision log (jev, 2026-10-16)

The founder's standing rule is that every decision gets a jev score. These are the inputs this ADR
recommends from; `jev` informs, and the spike's measurements decide.

| Decision | Pick | Score |
|---|---|---|
| Who issues the user | operator in-band, BYO Secret for managed | 1.00 |
| Isolation requested, Redis has no ACL support | fail closed | 0.91 |
| Where the provisioner credential is registered | `KnextPlatform`, endpoint-bound | 0.99 |
| Restart loses users | re-assert on reconcile and resync | 0.95 |
| Default | endpoint-scoped `auto` | 0.91 (vs opt-in 0.09) |
| `INFO` | not granted | 0.65 (vs disable the ready check 0.30, grant 0.05) |
| CDN claim key | `%W~` write-only selector | 0.70 (vs move under the prefix 0.30) |
| `SCAN` name disclosure | accept, document, follow up | 1.00 |
| Finalizer credential | per-app user for `SCAN`+`DEL`, provisioner for `DELUSER` | 0.87 |
| Refuse userinfo in `spec.cache.url` and envMap `REDIS_URL` under isolation | yes | 0.74 |
| `CLIENT SETINFO` | **tie** (grant 0.38, disable in knext's clients 0.38, accept 0.24). Broken toward grant on one fact: app-owned ioredis clients also send it, and a client option in knext's code does not reach them | 0.38 |
