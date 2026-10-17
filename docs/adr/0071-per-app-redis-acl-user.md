# ADR-0071: Per-app Redis ACL user, issued by the operator

- **Status:** **Accepted with conditions (2026-10-17, sprint-5 close design review: architect
  `v2-sprint5-close-architect.md`, concurred by the system designer
  `v2-sprint5-close-systemdesigner.md`).** Proposed 2026-10-16. A low-confidence call (jev split),
  taken by the architect on the evidence. #2396 builds against it and against these conditions:
  1. **Phase 1 covers in-cluster Service FQDNs only.**
  2. **Managed Redis stays bring-your-own** (provisioning there is phase 2).
  3. **The #2457 residuals fold into the #2396 build PR.**
  4. **knext makes no per-zone isolation claim** (Ready reason, docs or `doctor` wording saying
     "isolated") until the operator has observed the shared or default path refused. While
     `AUTH default` or a no-auth connect still succeeds against the registered endpoint, `doctor`
     and `status` report **"isolation not in force: shared credential live"**.
  5. **The build's kind exit includes a leg** where, after `ACL SETUSER default off`, zone B's pod
     using the old shared URL gets `NOPERM` / `WRONGPASS` on zone A's keys.

  Scope guard: this becomes PaaS drift if it grows into general Redis user management.
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
3. **Three residuals.** `SCAN` cannot be filtered by a key pattern, so a user lists other apps' key
   *names* (not values). A nested prefix (`<A>:<more>`) sits inside A's pattern. And `+eval` lets a
   user run a Lua loop that blocks every client on the server (measured in round 2; see D8).
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
      - endpoint: redis.cache.svc.cluster.local:6379   # Service FQDN:port, canonical form (D1a)
        provisionerSecretRef: { name: redis-provisioner, key: url }
```

- **Endpoint-bound.** The operator uses a provisioner credential only for an app whose
  `spec.cache.url`, **canonicalised** (D1a), equals a registered `endpoint`. It only ever dials the
  registered endpoint, never the host as the CR author spelled it. A CR author cannot send the
  credential anywhere else, because an unregistered host gets no provisioning (D6). That closes the
  confused-deputy path described in *Context*.
- **Never leaves the operator namespace.** It is not referenced from any `NextApp`, not mounted into
  any app pod, and not written to status, events or logs.
- **A dedicated user, not `default`.** The docs ship a provisioner rule set:
  `on ><pw> ~* resetchannels -@all +acl|setuser +acl|deluser +acl|getuser +acl|users +acl|whoami +scan +del +ping +info|server +client|setinfo`.
  `+acl|users` (with `+acl|getuser`) is what lets the operator see the users actually present on
  the endpoint for the conflict check in D6a, not only the CRs it watches.
  Stated plainly so nobody mistakes it for least privilege: **a user that can run `ACL SETUSER` can
  grant itself anything, so this credential is root-equivalent on that Redis** (measured: the
  provisioner's `ACL SETUSER <itself> +@all` returns `OK` on both engines). The narrow rule set limits
  what the operator does by accident, not what a thief can do. That is why the credential is
  endpoint-bound and confined to the operator namespace. `+info|server` is the only `INFO` it gets,
  for the restart signal in D2.

### D1a. One canonical form for an endpoint

A pod resolves a short Service name in **its own** namespace; the operator resolves it in the
operator's. The same Redis is also reachable as `redis.cache`, `redis.cache.svc`, the FQDN with a
trailing dot, or the Service's ClusterIP. Matching the string the CR author typed would let an app
on a registered Redis dodge every rule tied to "this app is on a registered endpoint" (the D3
admission refusals, the D6 table) by spelling the host differently, and would let the operator
provision on one Redis while the app talks to another. So:

- **Registration requires the canonical form**: `<service>.<namespace>.svc.<cluster-domain>:<port>`,
  lowercase, no trailing dot, port explicit. `KnextPlatform` admission refuses anything else. (An
  endpoint outside the cluster is out of scope for phase 1; it has no Service to canonicalise to.)
- **An app's `spec.cache.url` is canonicalised relative to the APP's namespace** before any match:
  lowercase; strip a trailing dot; default port `6379`; `svc` → `svc.<app-ns>.svc.<cluster-domain>`;
  `svc.ns` and `svc.ns.svc` → the full FQDN; an IP literal that is a registered Service's ClusterIP →
  that Service's canonical endpoint. The operator reads the registered Services to know their
  ClusterIPs.
- **Every rule keyed on "registered" uses the canonical form**: the D3 admission refusals, the D6
  table, the D6a conflict check, and the `REDIS_URL` the operator writes (always the registered
  canonical endpoint, never the app's spelling).
- **What canonicalisation cannot see** is a deliberate alias: an `ExternalName` Service, a
  selector-less Service with hand-written Endpoints, a TCP proxy, or a pod IP. An app that uses one
  reaches the Redis without being recognised as "on a registered endpoint", so it keeps whatever
  credential it already has. That is only closed by retiring the shared credential (D5 step 5): an
  alias does not help an app that holds no credential the server still accepts. See *Threats*.

### D2. Where `ACL SETUSER` runs: in the operator, re-asserted, never once

A cache-credentials step in the `NextApp` reconcile, before the Knative Service render, connects to
the registered endpoint with the provisioner credential and runs:

```
ACL SETUSER knext-app-<cluster tag>-<app hash> reset on ><password> [#<sha256 of the previous password, during rotation>]
  ~<glob-escaped prefix>:* [%W~knext:cdn:purged:<cdn-tag-prefix>:*]
  resetchannels -@all
  +get +set +del +sadd +smembers +lpush +ltrim +lrange
  +hget +hset +hdel +hmget +hscan +scan +eval +time +multi +exec +discard +ping
  +client|setinfo
```

- **Username** `knext-app-<cluster tag>-<app hash>`. `<app hash>` is the first 12 hex of
  `sha256("<namespace>/<name>")`, the same derivation as the default prefix and the CDN tag prefix.
  `<cluster tag>` is the first 8 hex of `sha256(<cluster identity>)`, where the cluster identity is
  `KnextPlatform` `spec.cache.clusterId` when the platform admin sets one, and otherwise the
  `metadata.uid` of the `kube-system` Namespace. The name is deterministic, unique per app **and per
  cluster**, and does not expose app names in `ACL LIST`.
- **Why the cluster is in the name.** Two clusters, each with its own operator, can register the same
  Redis endpoint. Without a cluster component, an app with the same namespace and name in both
  derives the same username, and cluster B's re-assert (`reset … ><B's password>`) replaces cluster
  A's password: A's pods get `WRONGPASS` on their next connection. The `kube-system` uid is stable
  across operator reinstalls and `KnextPlatform` recreation, and changes only when the cluster is
  rebuilt, which is a new cluster (its old users become orphans, D6a rule 3). `clusterId` is for a
  platform admin who wants one identity across a rebuild; two clusters given the same `clusterId`
  collide again, which is a platform-admin misconfiguration (out of scope, like any admin error). The
  `KnextPlatform` uid was rejected: deleting and recreating the singleton would rename every user and
  leave the old ones behind as orphans, which win every conflict (D6a rule 3) and so would fail the
  whole cluster closed.
- **A rebuild that reattaches to the same Redis fails every app closed, unless the admin acts.**
  The same thing happens to the `kube-system` uid when a cluster is rebuilt and pointed back at the
  Redis it used before (this happened on the OKE test cluster). The new uid gives a new cluster tag,
  so every user the old cluster created is now a foreign user whose pattern overlaps the re-created
  app with the same namespace and name. A foreign user always wins (D6a rule 3), and the operator
  never deletes a user it cannot attribute, so **every app fails closed with `PrefixConflict`**.
  That is the safe direction (a second live cluster looks exactly the same), but it is an outage.
  The remedy is the platform admin's, and the docs must say it: **before the rebuild**, set
  `spec.cache.clusterId` on the new cluster's `KnextPlatform` to the old identity (the old
  `kube-system` uid, or the `clusterId` it already had), so the tag and every username stay the
  same; **after the fact**, either do that or `ACL DELUSER` the old tag's `knext-app-*` users once
  the old cluster is known to be gone. To make the second path safe to run, `kn-next doctor` (or an
  operator report in `status.cache`) should list foreign-tag users per endpoint (Action item 10).
- **An operator owns only the users that carry its own cluster tag.** It re-asserts (on reconcile and
  on the `run_id` resync) and deletes only those. A `knext-app-*` user with another tag belongs to
  another cluster: this operator never re-asserts, resets or deletes it, and it is a conflict only
  when its key pattern overlaps one of this cluster's apps (D6a rule 3).
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
  there is no rolling-upgrade split between pods that claim under two different keys. The
  `<cdn-tag-prefix>` in the selector is the operator's own derivation from the app's identity
  (`cdnTagPrefix` in `cdn.go`), never a value from the CR, so whatever the pod's environment says,
  its user can write only its own claim keys. The claim keys of every app live in one shared
  keyspace, `knext:`, which D6a rule 0 reserves.
- **Idempotent re-assertion, from persisted state only.** The `reset` makes every call converge to
  the same state, so the step runs on every reconcile. The arguments are a pure function of the app's
  identity, its spec, and the operator-owned Secret (D3, D4): the current password from `REDIS_URL`,
  plus `#<previous-password-sha256>` for as long as the Secret carries it. Nothing comes from operator
  memory, so a re-assert after an operator restart, a Redis restart, or a finalizer re-assert (D7)
  rebuilds the same user, mid-rotation included. A Redis restart deletes every user, so the operator also resyncs each
  registered endpoint on a timer: it reads `INFO server` `run_id`, and when that changes it re-asserts
  every user it owns on the endpoint (its own cluster tag), rate-bounded by `KnextPlatform` `rollout.maxAppsPerMinute`. Pods that
  connect between a restart and the re-assert fail authentication (the user no longer exists), trip the breaker and fail open, as
  the cache already does for any outage. Their invalidations are replayed when the breaker closes.
- **Redis/Valkey 7.0 or later** (the `%W~` selector and the script-ACL behaviour the spike measured).
  An endpoint whose provisioner gets `ERR unknown command` / `unknown subcommand` for `ACL`, or reports
  a version below 7.0, is treated as having no ACL support (D6).
- **Status.** A new `CacheCredentialsReady` condition, computed in `computeStatusVerdict`, carries
  the reason (`Provisioned`, `SharedCredential`, `EndpointUnregistered`, `AclUnsupported`,
  `ProvisionerRefused`, `PrefixConflict`, `PrefixReserved`, `RotationStalled`). `status.cache` reports the isolation mode, username and
  Secret name, and never a password.

### D3. Who owns the per-app password: an operator-owned Secret in the app's namespace

- The operator generates 32 random bytes per app and writes Secret `<app>-redis-credentials` in the
  app's namespace. Its `ownerReference` is the `NextApp`, so it is garbage-collected with the app.
  Key `REDIS_URL` is `redis://<username>:<password>@<registered endpoint>`, with no database index.
- The Knative Service gets `REDIS_URL` through `valueFrom.secretKeyRef` and **never** a literal. The
  password never appears in the CR, its status, events, operator logs or the image.
- Admission (the existing `failurePolicy: Fail` `NextApp` validating webhook), for any app whose
  **canonical** endpoint (D1a) matches a registered one and whose `isolation` is not `none`: refuse
  `spec.cache.url` with userinfo (a credential in the CR), and refuse `REDIS_URL` in
  `spec.secrets.envMap`. Today `REDIS_URL` is exempt so the user's value always wins, which here
  would silently replace the issued credential with a shared one. The reconcile re-checks both, so a
  CR admitted before the endpoint was registered fails closed (`SharedCredential`) rather than
  keeping its shared credential silently.
- **The CLI does not change role.** It writes `spec.cache.isolation` into the CR when the app's
  config sets it, and nothing else: it never connects to Redis, never sees the provisioner
  credential, never writes the Secret. `kn-next doctor` reads `CacheCredentialsReady` from the CR's
  status.

### D4. Rotation: overlap, roll, retire

1. A rotation is requested by bumping an annotation on the `NextApp`
   (`apps.kn-next.dev/rotate-cache-credentials: <any new value>`), or by the operator on a schedule if
   #2396 adds one. **One rotation at a time:** while one is in flight (the Secret still carries
   `previous-password-sha256`), a new request is **queued, not started**. The operator records the
   requested value as `status.cache.rotation.pending`, emits a Normal `RotationQueued` event, and
   starts it in the first reconcile after the retire (step 4). The Secret has one previous-hash slot;
   a second rotation before the retire would overwrite it with the hash of the password the first
   rotation just issued, dropping the oldest password while pods that hold it still run.
2. The operator generates a new password and re-asserts the user with **both**: `>new` and
   `#<sha256(old)>` (Redis accepts a password by its SHA-256, so the old plaintext is never needed
   again). A re-assert with one password would remove the one live pods use (the `reset`).
3. In **one** update of the owned Secret it writes: `REDIS_URL` with the new password,
   `previous-password-sha256: <hex>`, and the annotations `apps.kn-next.dev/rotated-at: <RFC 3339>`
   (the time of this write) and `apps.kn-next.dev/retire-previous-after: <RFC 3339>` (`rotated-at`
   plus a bounded grace period). Then it stamps a hash of the Secret's content on the revision
   template. A changed Secret alone does not restart pods, so the stamp is what makes Knative roll a
   new revision onto the new password.
4. **Retire, only when no pod can still hold the old password.** Kubernetes resolves
   `valueFrom.secretKeyRef` when it creates a container and never updates a running one. A container
   that restarts inside a pod is created again and re-reads the Secret, so a pod created before
   step 3 may already hold the new password. The gate below therefore **errs safe**: it treats every
   such pod as holding the old one, which can only delay a retire, never let it run under a pod that
   still needs the old password. The operator retires only once **no non-terminal pod of the app, in
   any revision, has a `creationTimestamp` at or before `rotated-at` plus one second** (timestamps
   have one-second resolution, so a pod in the same second counts as old). **Non-terminal** means
   phase `Pending`, `Running` or `Unknown`: `Unknown` counts because a pod on an unreachable node may
   still be running, and a `Running` pod counts whether or not it is `Ready` or already terminating,
   because a draining pod can still open connections. A pod in phase `Failed` or `Succeeded` runs no
   container and opens no connection, so it does not count. That matters: an evicted Knative pod stays
   behind as a `Failed` object until terminated-pod garbage collection removes it, which by default
   only starts at 12,500 terminated pods cluster-wide. A gate that counted those would stall the
   rotation, and every rotation queued behind it, more or less for good. Once the gate is clear the
   operator deletes `previous-password-sha256` and both annotations from the Secret and re-asserts
   with `>new` only. Measured: connections that authenticated earlier keep working until they close,
   and a new `AUTH` with the old password gets `WRONGPASS`, which is why a still-running old pod
   blocks the retire: every connection it opens afterwards (a reconnect, a pool growing) would be
   refused. Pods that an older revision starts after step 3 read the new password, so an old revision
   kept alive by a traffic split or `minScale` does not block the retire forever, only its
   non-terminal pods from before the rotation do. **`retire-previous-after` no longer retires.** When
   it passes and such pods remain, the operator sets `CacheCredentialsReady` to reason
   `RotationStalled` (still `True`: both passwords belong to the same scoped user, so the boundary
   holds), emits a Warning event naming the pods, and `kn-next doctor` lists them. Deleting those pods
   unblocks the retire, and then any queued rotation. The cost is stated: until then, the old password
   stays valid.

**The rotation state lives in the Secret, so every re-assert during a rotation carries both
passwords** (D2: the arguments are a function of the Secret). Each crash point converges:

| Crash or restart after | What the Secret says | Next re-assert | Result |
|---|---|---|---|
| step 2, before step 3 | old password only | `>old` (`reset` drops the unused new one) | consistent; the rotation is retried, because the annotation on the `NextApp` is not yet acknowledged in status |
| step 3 | new password + previous hash | `>new #<old>` | both work until retire, as intended |
| a Redis restart anywhere mid-rotation | as above | the `run_id` resync re-asserts from the Secret | both passwords restored, not only the new one |
| step 4's Secret update, before its re-assert | new password only | `>new` | the old password goes, as intended |
| `retire-previous-after` passes while a non-terminal pod (`Pending`, `Running`, `Unknown`) created before step 3 remains | new password + previous hash | `>new #<old>` (not retired) | the old pod keeps connecting; `RotationStalled` until it is gone; then the retire runs |
| a pod created before step 3 was evicted or completed and lingers as a `Failed` / `Succeeded` object until terminated-pod GC | new password + previous hash | `>new` once no non-terminal old pod remains | not counted (it runs no container), so the retire is not stalled by it |
| a second rotation is requested before the retire | unchanged: one previous hash | `>new #<old>` | the request is queued (`status.cache.rotation.pending`), never written into the slot; it starts after the retire |
| a crash after the retire, with a rotation queued | new password only; `pending` in status | `>new` | the next reconcile starts the queued rotation at step 2 |

The `NextApp` status records only the acknowledged rotation annotation value, a queued one, and the
retire time, never a password or a hash.

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
| Prefix equal to, nesting inside, or containing another app's on the same endpoint | **fail closed** for the app that loses the D6a tiebreak (`PrefixConflict`) | **fail closed** (same) | shared credential, doctor warns |
| Prefix in the reserved platform keyspace (`knext`, `knext:…`; D6a rule 0), on a CR admitted before the rule | **fail closed** (`PrefixReserved`) | **fail closed** (same) | shared credential, doctor warns; the finalizer does not sweep it |

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

### D6a. Who owns a prefix, and who loses a conflict

"Fail closed for the later app" is not a rule: the derived prefix `kn-<12 hex of
sha256("<namespace>/<name>")>` is **predictable** from a victim's namespace and name, and
`spec.cache.keyPrefix` accepts any value. A CR author who claims a victim's derived prefix first, or
who wins the race when a migration provisions every app on an endpoint at once, would be issued
`~kn-<victim>:*`: the victim's whole cache. So ownership is decided by rule, never by order of
arrival:

0. **The platform keyspace `knext` is reserved, for every app.** Keys under `knext:` are shared
   across apps by design: today, every app with a CDN writes its first-ready claim key
   `knext:cdn:purged:<cdn-tag-prefix>:<build>` there (D2). A prefix `P` is issued `~P:*`, which
   covers those keys exactly when `P` is `knext` or starts with `knext:` (`knext`, `knext:cdn`,
   `knext:cdn:purged`, `knext:cdn:purged:<victim's tag prefix>`). Such a user could `SET … NX` a
   victim's claim key before the victim's first ready pod, which suppresses the victim's edge purge,
   or `DEL` it to force a repeat purge, and with `+get` read every app's claims. In shared-credential
   mode the finalizer's `SCAN MATCH <P>:*` + `DEL` would delete every app's claim keys on that app's
   delete. So the `NextApp` admission webhook refuses an explicit `spec.cache.keyPrefix` equal to
   `knext` or starting with `knext:`, **for every app, whatever its isolation**: no app has a
   legitimate claim to the platform keyspace. The reconcile re-applies the check, so a CR admitted
   before the rule shipped fails closed (`PrefixReserved`) on a registered endpoint and is listed by
   `kn-next doctor` elsewhere, and the finalizer never sweeps a reserved prefix. Redis keys are
   case-sensitive, so `KNEXT:` is a different keyspace and is not covered; a prefix that merely
   contains `knext:` after other text (`app:knext:x`) does not reach `knext:…` either, because the
   pattern is anchored at the start of the key.
   **How this relates to `kn-next`.** The CRD (a CEL rule) and the CLI's copy of it already refuse
   `kn-next` and `kn-next:*` for every app: that is the runtime's shared **fallback** keyspace, used
   when no prefix is configured. `knext:` is a different reserved keyspace, the cross-app **platform**
   one. Both are refused for the same reason (a tenant must not own a keyspace other apps share);
   only the enforcement point differs. This ADR puts `knext` in the webhook and the reconcile, and
   leaves the CRD alone: a CRD change is trigger-class and belongs to #2396, which should move
   `knext` / `knext:*` into the same CEL rule and CLI copy as `kn-next` (Action item 9).
1. **The derived shape is reserved.** A derived prefix belongs to the app it derives from. Admission
   (the `failurePolicy: Fail` `NextApp` webhook, which can compute the hash because it knows the CR's
   namespace and name) refuses an explicit `spec.cache.keyPrefix` that matches
   `^kn-[0-9a-f]{12}(:.*)?$` unless it **equals the app's own derived prefix**. That covers another
   app's derived prefix, any nesting under one (`kn-<victim>:x`), and every `kn-<12 hex>` an attacker
   might pre-compute for an app that does not exist yet. The reconcile re-applies the same check, so
   a CR admitted before this rule shipped fails closed (`PrefixConflict`) instead of being
   provisioned.
2. **Explicit prefixes conflict by a deterministic tiebreak**, evaluated over every app whose
   canonical endpoint (D1a) is the same: equal, nesting inside, or containing another prefix at a
   `:` boundary. The winner keeps the prefix and is provisioned; every loser fails closed
   (`PrefixConflict`, naming the winner's namespace/name in the condition message). In order:
   **(a)** an app whose prefix is its own derived prefix wins; **(b)** the oldest
   `metadata.creationTimestamp` wins; **(c)** the lexically smallest `metadata.uid` wins (timestamps
   have one-second resolution). The order the operator happens to provision in never decides, so a
   migration cannot be raced. Rule (b) means an older CR keeps an explicit prefix that a newer one
   copies; an older CR that *squats* an explicit prefix keeps it too, and the platform admin
   resolves that, informed by the condition. That is accepted: an explicit prefix has no owner
   other than whoever set it first, and failing both apps would let any CR author take a victim's
   cache offline by copying its prefix.
3. **The check reads what is on the endpoint, not only the CRs.** Before asserting app X's user, the
   operator lists the endpoint's users (`ACL USERS`) and reads each `knext-app-*` user's key patterns
   (`ACL GETUSER`). A `knext-app-*` user other than X's whose pattern is equal to, nests inside, or
   contains `<X's prefix>:*` is a conflict **even when no `NextApp` the operator can see owns it**:
   an app in a namespace this operator does not watch, a user left behind by a delete that never ran
   its finalizer, or **a second cluster sharing the Redis**. That last case is real only because the
   username carries the cluster (D2): another cluster's user has another cluster tag, so this
   operator never derives its name, never re-asserts (`reset`s) it and never deletes it, and sees it
   here only as a foreign user whose pattern overlaps. Such a user always wins against X: X fails
   closed with `PrefixConflict` naming the user (and, for a foreign tag, saying it belongs to another
   cluster), and `kn-next doctor` lists it. The operator never deletes a user it cannot attribute to
   a `NextApp` it reconciles. Users that are not `knext-app-*` (the shared credential, `default`, the
   provisioner) are not knext's; they are reported in `status.cache` but are not a conflict, and
   retiring them is D5 step 5.
   Two consequences, stated rather than discovered later. **(a)** The derived **prefix** has no
   cluster component, on purpose: it keys the cache, and changing it would drop every entry on the
   D5 migration. So the same namespace and name in two clusters on one Redis derive the same prefix,
   and whichever cluster provisions second fails closed with `PrefixConflict` until one of them is
   given an explicit prefix (any value outside the reserved shapes). They were sharing a cache
   before isolation; the conflict makes that visible instead of leaving it silent. **(b)** Two
   clusters provisioning that pair at the same moment, before either sees the other's user, can both
   create a user; on the next reconcile each sees a foreign overlapping user and **both** fail
   closed. That is a visible double failure for a human to resolve, never one cluster resetting the
   other's password.

### D7. The finalizer

On `NextApp` delete, the operator runs the existing `SCAN MATCH <escaped prefix>:*` + `DEL` **as the
app's own user** (least privilege, and the key pattern enforces the scope a second time). It then
runs `ACL DELUSER` with the provisioner credential. If the user was lost to a restart, it re-asserts
the user first. The Secret goes with the `NextApp` through its `ownerReference`.

### D8. Residuals, accepted and tracked

- **Key-name disclosure through `SCAN`.** `+scan` stays, because both outage collapse sweeps need
  it. The residual is documented, and a follow-up rebuilds the sweeps on an index the app owns
  (a set under `<prefix>:`), so `+scan` can be dropped.
- **Nested prefixes** are refused per endpoint (D6 `PrefixConflict`, decided by D6a), not left to
  admission alone. The admission pattern allows `:` in `keyPrefix`, and a nesting between two
  explicit prefixes is a relation between two apps, which no single object's validation can see.
  Admission does refuse the one case a single object can see: a reserved derived shape that is not
  the app's own.
- **A busy Lua script blocks every app on the endpoint.** `+eval` is granted, so an app's user can
  run any Lua it likes within its keys. Measured on Redis 7.4.10 (the CI digest): `EVAL "while true
  do end" 0` as a per-app user makes every other client, any user, get `BUSY` once
  `busy-reply-threshold` (5000 ms by default) has passed; the app user's own `SCRIPT KILL` is
  `NOPERM`; an admin `SCRIPT KILL` stops it. A script that **writes first** and then loops is
  `UNKILLABLE`: only `SHUTDOWN NOSAVE` recovers, which on a cache with no persistence loses every
  app's entries and every ACL user (D2's resync then re-asserts them). `busy-reply-threshold` only
  decides when other clients start getting `BUSY`; it never stops the script. So "can do only what
  the cache does" holds for keys and commands, not for server time. Mitigations, in the order this
  ADR recommends them: **(1)** a follow-up replaces `+eval` with `+fcall`: the operator loads knext's
  two scripts as Redis 7 Functions with the provisioner credential, so an app user can invoke only
  that reviewed code, never arbitrary Lua; **(2)** until then, alert on `BUSY` replies and on
  `INFO`'s blocked-script state, and keep `busy-reply-threshold` at or below the default; **(3)** a
  Redis per tenant where one app's availability must not depend on another's code.

## Threats

The attacker in every row is a `NextApp` author on the same cluster, or an app's own code: the
actors per-app isolation exists to contain. A compromised operator or platform admin is out of
scope (they hold the provisioner credential by design).

| Threat | Path | Mitigation | Residual |
|---|---|---|---|
| Confused deputy: get the operator to present the provisioner credential to a host the attacker controls | set `spec.cache.url` to that host | provisioning only on a registered, canonicalised endpoint; the operator dials the registered FQDN, never the CR's spelling (D1, D1a) | none known |
| **Prefix squatting: be issued `~kn-<victim>:*`** | set `spec.cache.keyPrefix` to a victim's predictable derived prefix (or a nesting under it), before the victim exists or during the migration race | the derived shape is reserved for its own app, refused at admission and re-checked at reconcile; explicit conflicts resolved by a deterministic tiebreak, not arrival order; conflicts also checked against users present on the endpoint (D6a) | an older CR keeps an explicit (non-derived) prefix a newer app also wants; surfaced as `PrefixConflict` for a human |
| Keep the shared credential on a registered endpoint | userinfo in `spec.cache.url`, or `REDIS_URL` in `spec.secrets.envMap` | refused at admission and reconcile for any app whose canonical endpoint is registered (D3, D1a) | a deliberate alias (D1a) or any copy of the shared password works until the shared credential is retired (D5 step 5) |
| Read or change another app's entries | a bug, a reused prefix, Lua through an undeclared key | the per-app key pattern, enforced by Redis inside Lua too (measured) | key *names* through `SCAN` (D8); nested explicit prefixes are refused (D6a) |
| Deny service to every app on the endpoint | a busy or write-then-busy Lua script under `+eval` | alerting now; `+fcall` with operator-loaded functions next; per-tenant Redis for strict isolation (D8) | **open** until the `+fcall` follow-up; measured, see D8 |
| **Suppress another app's CDN purges** | set `spec.cache.keyPrefix` to `knext` or anything under `knext:`, which is issued a pattern over every app's claim keys | the platform keyspace is reserved for every app, refused at admission and re-checked at reconcile; the finalizer never sweeps it; each app's claim selector uses the operator-derived tag prefix (D2, D6a rule 0) | the CRD itself does not refuse `knext` yet (Action item 9); until then the webhook is the only admission gate |
| Lock out an app on another cluster | run an app with the victim's namespace and name on a second cluster that shares the Redis, so its operator re-asserts the victim's user with a new password | the username carries a cluster tag, and an operator never re-asserts or deletes a user with another cluster's tag (D2, D6a rule 3) | the two apps share a derived prefix, so the second to provision fails closed (`PrefixConflict`) until one gets an explicit prefix; two clusters given the same `clusterId` by their admins collide (admin misconfiguration) |
| Lock out a victim by stealing its rotation | none found: rotation is driven by an annotation on the victim's own `NextApp` | the rotation state lives in the victim's operator-owned Secret (D4) | none known |
| Break an app's own pods with a rotation | rotate while pods created before the rotation still run, or rotate twice before the retire | the retire waits until no non-terminal pod created before `rotated-at` remains (an evicted `Failed` pod does not block it); a second request is queued, never written over the previous-hash slot (D4) | while a stale pod lives, the old password stays valid (`RotationStalled` makes that visible) |

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
- **Once the shared credential is retired (D5 step 5)**, a bug or a reused prefix in one app can no
  longer read, overwrite or delete another app's cache. Redis refuses it, as measured, including
  from Lua. Before that step, isolation is only as strong as the shared credential's secrecy: an app
  on `isolation: none`, an app reaching the Redis through an alias (D1a), or any code holding a copy
  of the shared password keeps full reach. The per-app user limits what knext hands an app, not
  what an app that already has the shared password can do.
- The credential each app holds reaches only the cache's keys and commands: no `FLUSHALL`, `KEYS`,
  `CONFIG`, `ACL`, pub/sub, or other apps' keys. It does **not** bound server time: through `+eval`
  a script can block every app on the endpoint (D8) until the `+fcall` follow-up lands.
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
- An explicit `keyPrefix` in the reserved `kn-<12 hex>` shape is refused unless it is the app's own
  derived prefix. A CR that set one by copying it from another app's status stops being admitted.
- An explicit `keyPrefix` of `knext` or under `knext:` is refused for every app (D6a rule 0). A CR
  that uses one today stops being admitted, and on a registered endpoint fails closed.
- The operator reads the `kube-system` Namespace's uid (one `get` on one cluster-scoped object) to
  derive its cluster tag, and lists the app's pods to decide a rotation's retire (D2, D4): two RBAC
  grants it does not hold for this today.
- The same namespace and name in two clusters on one Redis now fail closed for the second cluster
  instead of silently sharing a cache (D6a rule 3).
- A cluster rebuilt and reattached to the same Redis fails every app closed (`PrefixConflict`)
  until the platform admin carries the old identity over in `spec.cache.clusterId` or sweeps the
  old tag's users (D2, Action item 10).
- A rotation can stay open while a pod from before it runs; the old password stays valid that long
  (`RotationStalled`).
- Registration takes only an in-cluster Service FQDN in phase 1 (D1a).

## Action items

1. **#2396 (the build), against this ADR:** D1 (`KnextPlatform.spec.cache.redisEndpoints`, with
   `+acl|users` in the provisioner rule set), D1a (canonical-FQDN registration; canonicalising app
   URLs relative to the app's namespace, ClusterIP included), D2 (the reconcile step, the
   cluster-tagged username from `spec.cache.clusterId` or the `kube-system` uid, with the RBAC to
   `get` that Namespace; resync on `run_id` over this cluster's users only; re-assert as a pure
   function of the Secret; `CacheCredentialsReady` in `computeStatusVerdict`), D3 (operator-owned
   Secret, `secretKeyRef` wiring, the two admission refusals keyed on the canonical endpoint,
   re-checked at reconcile), D4 (rotation with the previous password's hash, `rotated-at` and
   `retire-previous-after` persisted in the Secret; the retire gated on no **non-terminal** pod
   (`Pending`, `Running`, `Unknown`; not `Failed` / `Succeeded`) created at or before `rotated-at`,
   with the RBAC to list the app's pods, and a test that an evicted `Failed` pod does not stall it; `RotationStalled`; a queued second rotation
   in `status.cache.rotation.pending`; a test per crash point in the D4 table), D6
   (`spec.cache.isolation` and the fail-closed table), **D6a** (rule 0: admission and reconcile
   refuse `knext` / `knext:…` for every app, and the finalizer never sweeps it; rule 1: admission
   refuses a reserved `kn-<12 hex>` prefix that is not the app's own; the deterministic tiebreak;
   the conflict check over `ACL USERS`/`ACL GETUSER`, orphans and other clusters' users included;
   envtest cases for the squatting attack in *Threats*, both before the victim exists and in a
   migration where the attacker's CR is provisioned first, and for a foreign-tag user with an
   overlapping pattern), D7 (finalizer). Its existing acceptance stands: a kind e2e
   with two apps on one Redis, A refused (`NOPERM`) on B's keys, both apps' ISR and `'use cache'`
   paths including the outage replay working, and the password only in a Secret.
2. **One source for the rule set.** The operator's command list and
   `scripts/redis-acl-spike.mjs`'s `MINIMAL_COMMANDS` must not drift; #2396 adds a test that compares
   them. On the runtime side, `tests/redis-acl-spike.test.ts` already reds when the runtime can
   issue a command the list lacks. What that scan covers, exactly: every git-tracked source file
   under `packages/<pkg>/src/` (tests and `.d.ts` aside) that references a Redis client or the shared
   helpers, **or in which the scan finds any hit or any construct it cannot resolve** (so a file only
   handed a client is scanned for what it calls), except the CLI directory (it never runs as the
   app's user). In those files it counts a member named like a Redis command (the canonical
   `COMMAND LIST` of Redis 7.4 and Valkey 8.1 plus the command methods ioredis and Bun's client
   expose that those engines do not list, such as `hgetdel`; any run of ioredis's `Buffer` /
   `Stream` suffixes on one, such as `zscanBufferStream`; or an ioredis method that sends a fixed
   command, such as `defineCommand`; any receiver) that is called, optionally called, bound /
   called / applied, handed to `Reflect.apply`, or assigned;
   `.call/.pcall/.send/.sendCommand/.send_command/.callBuffer`, `command/redisCommand`,
   `new Command` and ioredis's builtin-command helpers with a literal command; `['CMD', …]` tuples;
   destructured command keys; `Reflect.get(x, 'cmd')`. Every member of the ioredis 5 and 6 and Bun
   client prototypes must resolve under those rules or be a listed non-command, so a client upgrade
   that adds a command method or a suffix reds. A command it cannot resolve fails unless it is an
   exact, justified forwarder line. Three exclusions, each tested both ways: language-global
   receivers; a `.digest(…)` ending a `createHash(…)` / `createHmac(…)` chain in one expression; and
   calls that pass no Redis argument to a measured command that needs one (Redis checks arity
   before ACL, measured), never applied to a `*Stream` method or a client-only command. False
   positives are explained per file (a receiver, for its listed commands only, with the declaration
   that binds it and no other binding of it, or an exact line), and every entry must still occur. It
   does **not** see a command method passed as an argument or stored in a literal, a computed member
   read now and invoked later, nested or parameter destructuring, `eval`/`with`/Proxy tricks, or a
   client bound to an exempt receiver's name through a parameter or property; the scanner's and the
   test's headers list them, and the live lane's real-handler layer is the backstop for the paths it
   runs. `scripts/mutation-prove-redis-command-scan.mjs` proves each rule by exit code.
3. **The live lane runs in CI** (landed in #2454, already on `integration/v2`, not in this PR):
   `ci.yml`'s `use-cache-lua-live-redis` job runs `tests/redis-acl-spike.test.ts` in its own blocking `--no-skip` step against the job's
   digest-pinned Redis (`e7723ff…`, Redis 7.4.10), and the spike doc records that digest. Keep the
   spike doc's recorded digest equal to CI's when either moves.
4. **Follow-up issue:** rebuild both collapse sweeps on an app-owned index, then drop `+scan` (D8).
5. **Follow-up issue:** replace `+eval` with `+fcall`, the operator loading knext's two scripts as
   Redis 7 Functions with the provisioner credential, so an app user cannot run arbitrary Lua and
   block the endpoint (D8). Until it lands, the docs carry the `BUSY` alerting recipe.
6. **Follow-up issue:** `spec.cache.credentialsSecretRef` for managed Redis, with the scope probe
   (D6 phase 2). Re-check each provider's documentation then; the spike's managed-offering table is
   unverified.
7. **Docs** (the user-facing site, no internal numbers): enabling isolation, the provisioner user's
   rule set, the migration path including the app-owned-keys warning, what fail-closed and `PrefixConflict`
   look like, and the `BUSY` alerting recipe.
8. **Not this ADR's to do:** retiring the shared credential (D5 step 5) is the platform admin's call.
9. **#2396, CRD (trigger-class, not changed by this ADR's PR):** add `knext` and `knext:*` to the
   CRD's `keyPrefix` CEL rule and to the CLI's copy of it, next to `kn-next` / `kn-next:*`, so the
   reserved platform keyspace is refused at the schema as well as by the webhook (D6a rule 0).
10. **#2396, foreign-tag report (D2):** `kn-next doctor`, or an operator report in `status.cache`,
    lists the `knext-app-*` users on each registered endpoint whose cluster tag is not this
    cluster's, with their key patterns and whether they overlap an app here. It reports, never
    deletes: it is what lets a platform admin tell a rebuilt cluster's orphans from a live second
    cluster before sweeping them, and the docs carry the `clusterId`-before-rebuild step.

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

Round 2 (code review of PR #2454):

| Decision | Pick | Score |
|---|---|---|
| Who keeps a conflicting explicit prefix (D6a) | derived owner, then oldest `creationTimestamp`, then smallest `uid` | 0.64 (vs both fail closed 0.35, first provisioned 0.01). The runner-up is safer against an older squatting CR but lets any author take a victim offline by copying its prefix; the reserved derived shape removes the case that matters most |
| Where rotation state survives a restart (D4) | the owned Secret: previous password's SHA-256 plus `retire-previous-after` | 1.00 (vs `NextApp` status 0.00, operator memory 0.00) |
| How an app is matched to a registered endpoint (D1a) | canonical Service FQDN, app URL canonicalised in the app's namespace | 0.98 (vs DNS-resolve both to IP:port 0.02, exact string 0.00) |
| The `+eval` busy-script residual (D8) | follow-up to `+fcall` with operator-loaded functions; document until then | 0.90 (vs document only 0.07, block this ADR on it 0.03) |
| Spike doc's Redis digest vs CI's | re-run the spike on CI's digest and record it | 0.90 (vs re-pin CI to the local digest 0.10) |

Round 3 (code review of round 2; carried by a follow-up PR, because #2454 merged at round 1):

| Decision | Pick | Score |
|---|---|---|
| Cluster scope in the username (D2, D6a rule 3) | a cluster tag from `spec.cache.clusterId`, else the `kube-system` Namespace uid | 0.99 (vs drop the cross-cluster claim 0.01, the `KnextPlatform` uid 0.00) |
| Reserving the `knext` platform keyspace (D6a rule 0) | refuse for every app at the webhook and reconcile; CRD rule as an action item | 0.98 (vs change the CRD in this PR 0.02, reserve only for isolated apps 0.00) |
| When the previous password retires (D4) | no pod created at or before `rotated-at` remains; the deadline only raises `RotationStalled` | 0.84 (vs gate on older revisions' Ready pods with a forced deadline 0.16, retire at the deadline 0.00) |
| A second rotation before the retire (D4) | queue it until the retire | 0.43 (vs refuse it at admission 0.31, two previous-hash slots 0.26). Low confidence: queueing needs no new admission rule and never drops a live password, which is what tipped it |

Round 4 (code review of round 3):

| Decision | Pick | Score |
|---|---|---|
| Which pods the retire gate counts (D4) | non-terminal pods only (`Pending`, `Running`, `Unknown`) | 0.94 (vs Ready pods only 0.06, every pod object 0.00) |
| A rebuilt cluster reattached to the same Redis (D2) | name the remedy (`clusterId` before the rebuild, or an admin sweep of the old tag) and add a foreign-tag report | 0.96 (vs `clusterId` only 0.04, the operator deleting foreign users 0.00) |
| Client command methods the measured engines do not list (scan) | a generated client command list, checked against every installed client's prototypes | 0.73 (vs leave them as a residual 0.17, import the client's list at scan time 0.10) |
| `DIGEST` false hits on node:crypto chains (scan) | a narrow exclusion for a `createHash` / `createHmac` chain, tested both ways | 1.00 (vs per-line allowlist entries 0.00, drop `digest` 0.00) |
