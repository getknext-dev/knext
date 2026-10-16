# Redis ACL compatibility spike: can the cache run as a per-app ACL user?

- **Date:** 2026-10-16. **Issue:** #2404 (precedes #2396). **Decision record:** ADR-0071.
- **Question.** Each app's Redis keyspace is separated by a key prefix (#2171), but every app uses
  the same Redis credential, so the prefix is only a convention. Can each app instead connect as its
  own Redis ACL user, limited to `~<prefix>:*` and a minimal command set, without the cache handler,
  the `'use cache'` backend or their outage replays hitting `NOPERM`?
- **Answer: yes, on self-hosted Redis 7 and Valkey 8, with the rule set below.** Measured, not
  inferred: the real cache handler ran under that user on both server engines and both production
  Redis clients with no unexpected denial. There are three known gaps (one key outside the prefix,
  two connect-time commands sent by ioredis), three residuals (`SCAN` exposes other apps' key
  *names*, nested prefixes, and a busy Lua script under `+eval` blocks every app on the server), and
  one operational fact that shapes provisioning (ACL users do not survive
  a restart unless the server persists them).

Everything in the **Measured** sections was run. Everything about managed offerings is **documented,
not measured**, and labelled that way where it appears.

## How it was measured

| | |
|---|---|
| Servers | **CI's pinned Redis**, `redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2` (Redis **7.4.10**, the digest `ci.yml`'s live lane runs); `redis:7-alpine` (`redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`, Redis **7.4.11**, the first round's local pull); `valkey/valkey:8-alpine` (`valkey/valkey@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507`, Valkey **8.1.10**, reports `redis_version:7.2.4`) |
| Clients | **ioredis 5.9.3** under Node 24.14 (the standalone Node path; the version the lockfile gives `@getknext/core`, and what CI runs), and **Bun 1.4.2's native `RedisClient`** (the Bun path; `cache-handler.js` picks it whenever `Bun.RedisClient` exists). The round-2 local re-runs resolved **ioredis 6.0.0** (a worktree without its own install falls through to a parent checkout's); their outcomes were identical row for row. |
| Where | plain `docker run` on loopback. The kind clusters on this machine were held by other lanes, and nothing here needs Kubernetes: the question is what Redis allows a user to do. |
| Script | [`scripts/redis-acl-spike.mjs`](../../scripts/redis-acl-spike.mjs), guarded by [`tests/redis-acl-spike.test.ts`](../../tests/redis-acl-spike.test.ts) |

The script creates two throwaway users (app **A** and app **B**, random names, random 48-hex
passwords that are never printed), runs three layers, then deletes the users and their keys:

1. **Command matrix.** Every command the cache runtime issues, with the file it comes from, run as
   A against A's keys (must pass) and against B's keys (must be `NOPERM`). The two Lua scripts are
   imported from `use-cache-handler.js`, not copied. Also: commands an app must never reach, and
   pinned known gaps.
2. **Real handler.** `cache-handler.js` itself, with `REDIS_URL` set to A's user: ISR `set` / `get` /
   `revalidateTag`, the `'use cache'` handler's `set` / `get` / `getExpiration` / `updateTags`, then
   **two forced outages** (`CLIENT PAUSE` until a command times out and the breaker opens, then
   invalidations queued while it is open). The first replays narrowly (ISR per-tag `SMEMBERS` + `DEL`;
   `'use cache'` `EVAL` of the replay script). The second queues 1001 tags so **both replays collapse**
   to a prefix-wide `SCAN MATCH` + `DEL`. The admin connection records `MONITOR` (every command Redis
   executed for the handler, including those a Lua script ran) and reads `ACL LOG` afterwards. The
   handler is also checked to have really reached Redis: a handler that fell back to its in-memory
   cache would produce no `NOPERM` and prove nothing.
3. **Lifecycle.** Re-asserting the user, rotating its password, and deleting it, each against a live
   connection.

Reproduce:

```sh
docker run -d --name knext-acl-spike -p 127.0.0.1:6409:6379 redis:7-alpine \
  redis-server --save '' --appendonly no
KNEXT_REDIS_ACL_SPIKE_URL=redis://127.0.0.1:6409 node scripts/redis-acl-spike.mjs --assert
KNEXT_REDIS_ACL_SPIKE_URL=redis://127.0.0.1:6409 bun  scripts/redis-acl-spike.mjs --assert
# the guard, including the mutation proofs below:
KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6409 bun test tests/redis-acl-spike.test.ts
```

`--assert` exits 1 on **any** unexpected outcome in either direction (a needed command refused, or a
forbidden command or cross-app key reachable). Exit 1 means only that, and it covers a spike user's
ACL refusal (`NOPERM`, `ACL failure in script`) that aborts a whole layer, in every mode: with
`--drop=set` in the default mode the lifecycle user's first write is refused, which is the rule set
being wrong, not a crash (it used to exit 3). A usage error exits 2: an unknown argument, a `--drop`
that is not in the minimal rule set, a `--grant` that is not a Redis command or is already granted
(a mutation proof that silently mutated nothing would otherwise pass), or a missing, malformed or
non-loopback URL. Infrastructure trouble or a crash exits 3 (Redis unreachable, no ACL support, an
ACL refusal of the **admin** user, which means the admin URL lacks a permission the spike needs).
The admin URL comes only from `KNEXT_REDIS_ACL_SPIKE_URL` (never `REDIS_URL`) and must be loopback.

**Result: all six runs (CI's Redis 7.4.10, Redis 7.4.11 and Valkey 8.1.10, each under node and bun)
exit 0.** The 7.4.10 and 7.4.11 tables are identical apart from the version line (diffed, node and
bun). In CI, the `use-cache-lua-live-redis` job runs the live lane on the 7.4.10 digest on every
PR, so that is the digest of record; keep this row equal to CI's when either moves.

### The guard goes red when it should

Proved by exit code (output is never grepped). The live rows are asserted **exactly** (1, not
"non-zero"), so a mutation that crashed the run (3) or was refused as a typo (2) cannot pass as a
finding.

| Mutation | Exit | What turned it red |
|---|---|---|
| `--drop=time` | 1 | `TIME` inside the replay script is refused (`ERR ACL failure in script`) |
| `--drop=eval` | 1 | both stamp scripts refused |
| `--drop=scan` | 1 | the collapse sweep refused |
| `--drop=multi` | 1 | the atomic ISR write refused |
| `--drop=hdel` | 1 | `HDEL` inside the prune script refused (the matrix row's cutoff is above the stamp it wrote, so the script's `HDEL` really runs; with the earlier cutoff of 0 this mutation exited 0) |
| `--drop=discard` | 1 | Bun's transaction abort refused (a `MULTI` · `DISCARD` row; no row sent `DISCARD` before, and this mutation exited 0) |
| `--drop=set`, default (full) mode | 1 | the lifecycle user's first write refused: a finding, not a crash (it exited 3) |
| every `--drop=<cmd>` of the 20, default mode, Redis 7.4.11 and Valkey 8.1.10, node and bun | 1 | swept by exit code; the unmutated run exits 0 in all four |
| `--grant=flushall` | 1 | a forbidden command became reachable |
| `--grant=info` | 1 | a pinned known gap changed |
| `--drop=hmget --handler-only` | 1 | the **real handler** layer alone (its `ACL LOG`), without the matrix |
| `hscan` removed from the rule set | 1 | the always-on source scan: the runtime issues a command the rule set lacks |
| `re-assert` during rotation without `#<sha256(old)>` | 1 | the lifecycle layer: the old password is refused mid-rotation |
| `--drop=nosuch`, `--drop=info`, `--grant=nosuch`, `--grant=get`, `--bogus`, a non-loopback URL | 2 | usage, refused before any Redis is touched |
| an unreachable Redis | 3 | infrastructure, never the finding code |

The always-on source scan (`tests/redis-acl-spike.test.ts` with `tests/redis-command-scan.ts`),
proved by the test file's exit code with one line injected into `cache-handler.js` (anchor
asserted to occur once, restored with `git checkout`, tree verified clean, control green before and
after):

| Injected | Exit |
|---|---|
| nothing (control) | 0 |
| `await client.call('UNLINK', 'x');` | 1 |
| `await redisCommand(c, 'EXPIRE', ['k', '1']);` | 1 |
| `await conn.expire('k', 1);` | 1 |
| `await client.call(name, ...args);` (command not a literal) | 1 |
| `const probe = [['unlink', 'k']];` (lowercase tuple) | 1 |
| a new tracked file `packages/lib/src/redis/mutation-probe.ts` calling `r.unlink('x')` (no list names it) | 1 |
| nothing (control, after restore) | 0 |

The first three are the escapes the round-1 code review proved green against the earlier,
enumerated scan.

The round-2 review proved seven more green by exit code: `client.unlink?.('k')`,
`const {unlink}=client; unlink('k')`, `Reflect.apply(client.unlink, client, ['k'])`,
`client.unlink.bind(client)`, `client.unlinkBuffer('k')`, `client.callBuffer('UNLINK', …)` and
`client.zscanStream('k')`, and showed that discovery skipped a new file whose only signal was a
method call. Each is now a test, and the scan's rules are proved by a committed harness,
`scripts/mutation-prove-redis-command-scan.mjs` (exit codes only, baseline green and a canary red
first, anchors asserted to occur once, byte-exact restore, clean tree between rows). Every row
removes one rule and must turn the test red:

| Row | Rule removed | Exit |
|---|---|---|
| S1–S8 | optional call; destructuring; `Reflect.apply`; `.bind/.call/.apply`; assignment; `Buffer` variant; `callBuffer`; `Stream` variant; the command helper (`new Redis.Command`) | 1 each |
| U1–U5 | UNPARSEABLE for an optional or bound computed member; a generic issuer handed on; a computed destructuring key; `Reflect.get` with a non-literal; `Reflect.apply` on an unnamed target | 1 each |
| X1–X4 | an exclusion widened: the no-argument rule drops `client.info()`; every argument a function literal; every `.call` dropped; `client` treated as a language global | 1 each |
| D1, D2 | discovery by any hit; discovery by an unparseable construct | 1 each |
| B1 | a second declaration of an allowlisted receiver | 1 |
| E1, E2 | the spike's ACL-refusal classification and its exit code | 1 each |
| L1–L3 (`KNEXT_REDIS_LIVE_URL` set) | full-mode `--drop=set` exits 1; the prune cutoff; the `DISCARD` row | 1 each |

Its first run found one rule that survived its own removal: a separate `new Command(` rule was
redundant with the command helper rule, which already resolves `new Redis.Command('UNLINK', …)`.
The duplicate was deleted, and the row now removes the rule that carries it.

The source scan runs in every CI run (it needs no Redis). The live half runs when
`KNEXT_REDIS_LIVE_URL` is set and is skipped otherwise, like the existing live Lua lane.

## Measured: the minimal rule set

```
ACL SETUSER <user> reset on ><password> ~<prefix>:* resetchannels -@all
  +get +set +del +sadd +smembers +lpush +ltrim +lrange
  +hget +hset +hdel +hmget +hscan +scan
  +eval +time +multi +exec +discard +ping
```

- `~<prefix>:*` — the colon is part of the pattern, so a prefix that merely *starts with* the app's
  (`<prefix>x:…`) is refused (measured). The prefix is glob-escaped in the pattern (`* ? [ ] \`),
  the same escaping the runtime's `SCAN` uses. Admission now refuses those characters in
  `keyPrefix` anyway; the escape is defence in depth.
- `resetchannels` — no pub/sub channel. The runtime uses no pub/sub; Redis 7's default
  `acl-pubsub-default` is already `resetchannels` (measured), but stating it does not depend on a
  server setting.
- `-@all` then an explicit list — no category grants, so a command added to a category in a later
  Redis release is not granted by accident.

### The exact command list

| Command | ACL categories (Redis 7.4) | Issued by | Own keys | Other app's keys | Run by the real handler |
|---|---|---|---|---|---|
| `GET` | `@read @string @fast` | `cache-handler.js` `get()`, `isBuildLive`; `use-cache-handler.js` `doGet` | ok | `NOPERM` | yes |
| `SET … EX` | `@write @string @slow` | ISR write (in `MULTI`), `touchBuildLive`, `'use cache'` `doSet` | ok | `NOPERM` | yes |
| `DEL` | `@keyspace @write @slow` | entry delete, tag invalidation (in `MULTI`), both collapse sweeps | ok | `NOPERM` | yes |
| `SADD` | `@write @set @fast` | ISR write: tag index (in `MULTI`) | ok | `NOPERM` | yes |
| `SMEMBERS` | `@read @set @slow` | `invalidateTagInRedis` | ok | `NOPERM` | yes |
| `MULTI` / `EXEC` / `DISCARD` | `@transaction` | `execAtomic` (ioredis `multi()`; native: explicit `MULTI`…`EXEC`, `DISCARD` on error) | ok | (per queued command) | `MULTI`, `EXEC` yes; `DISCARD` only on an error path |
| `LPUSH` / `LTRIM` | `@write @list` | `logCacheEvent` event log (`<prefix>:cache-events`) | ok | `NOPERM` | yes |
| `LRANGE` | `@read @list @slow` | reference app's `/api/cache/events` (not core) | ok | `NOPERM` | no (matrix only) |
| `HMGET` | `@read @hash @fast` | `'use cache'` tag stamps (`<prefix>:uc:tags`) | ok | `NOPERM` | yes |
| `HSET` | `@write @hash @fast` | `'use cache'` `updateTags`; also inside the replay script | ok | `NOPERM` | yes (top level and in Lua) |
| `HSCAN` | `@read @hash @slow` | `'use cache'` `pruneStamps` | ok | `NOPERM` | yes |
| `EVAL` | `@slow @scripting` | `PRUNE_STAMPS_SCRIPT`, `REPLAY_STAMPS_SCRIPT` | ok | `NOPERM` | yes |
| `HGET` | `@read @hash @fast` | **inside** both Lua scripts | ok | `NOPERM` | yes (in Lua) |
| `HDEL` | `@write @hash @fast` | **inside** `PRUNE_STAMPS_SCRIPT` | ok | `NOPERM` | no: prune only deletes stamps past their cutoff (matrix only) |
| `TIME` | `@fast` | `clockOffset`; **inside** `REPLAY_STAMPS_SCRIPT` | ok | n/a | yes (top level and in Lua) |
| `SCAN … MATCH <prefix>:…` | `@keyspace @read @slow` | both collapse sweeps | ok | see *Residuals* | yes |
| `PING` | `@fast @connection` | `@getknext/lib` deep health check | ok | n/a | no (matrix only) |

Notes that matter for the build:

- **Scripts run under the caller's ACL.** A Lua script that touches another app's key is refused even
  when the key is not declared in `KEYS` (measured: `EVAL "return redis.call('HSET', ARGV[1], …)" 0
  <B>:uc:tags` → `ERR ACL failure in script: No permissions to access a key`). So every command a
  script calls needs its own grant (`HGET`, `HDEL`, `HSET`, `TIME`), and Redis 7.4 reports the
  in-script refusal as `ERR ACL failure in script`, not `NOPERM`.
- **`EVALSHA` / `SCRIPT LOAD` are not needed and not granted.** The runtime sends `EVAL` only (the
  issue text assumed `EVALSHA`; the code does not use it). If a later change moves to `EVALSHA`,
  `+evalsha +script|load` must be added; the source scan in the guard reds until it is.
- **`AUTH` and `HELLO` are never gated** (measured: both executed for a `-@all` user with no grant
  and left no `ACL LOG` entry). ioredis authenticates with `AUTH`; Bun's native client with `HELLO 3`.
- **`SELECT` is not granted.** The operator-issued URL carries no database index. A URL that does
  would need `+select`; key patterns apply across databases, so it does not widen isolation.
- The topology caveat in `cache-handler.js` still holds: `MULTI` across an entry key and its tag
  keys needs one hash slot, so this is single-node (or slot-tolerant) Redis. Nothing here measured
  Redis Cluster.

### Commands an app user must never reach (all refused, measured)

`FLUSHALL`, `FLUSHDB`, `KEYS *`, `CONFIG GET`, `ACL SETUSER` (escalation), `ACL LIST` (other users'
password hashes), `SCRIPT FLUSH`, `EVALSHA`, `PUBLISH`, `CLIENT LIST`, `CLIENT KILL`, `SHUTDOWN`, a
script writing another app's hash through an undeclared key, the shipped replay script aimed at
another app's hash, a key under a prefix that only starts with the app's, and the CDN claim key
(next section).

## Measured: known gaps (the runtime tolerates them; the build must close or accept them)

| What | Under the minimal rule set | Consequence today | Closed by (see the ADR) |
|---|---|---|---|
| CDN first-ready purge claim, `SET knext:cdn:purged:<cdn-tag-prefix>:<build> 1 NX EX 86400` (`cdn-purge/purger.js`) — the one key **outside** `<prefix>:` | `NOPERM` | the first-ready edge purge is skipped and logged ("the edge stays stale until its TTL") | a write-only selector on the user: `%W~knext:cdn:purged:<cdn-tag-prefix>:*`. Measured: it allows `SET … NX EX` (and the second `NX` correctly returns nil), refuses `GET` of that key, refuses `SET … NX GET`, and refuses another app's claim key. Needs Redis/Valkey 7.0+. |
| `INFO` — ioredis's ready check (`enableReadyCheck`, default on), every connect | `NOPERM` | ioredis prints `Skipping the ready check because INFO command fails: "NOPERM …"` once per connection and proceeds; one `ACL LOG` entry per connect | not granted (decided in the ADR) |
| `CLIENT SETINFO LIB-NAME` / `LIB-VER` — ioredis's client identity (`disableClientInfo`, default off), every connect | `NOPERM` | ioredis swallows both; two `ACL LOG` entries per connect | `+client|setinfo` (decided in the ADR) |

Bun's native client sends neither `INFO` nor `CLIENT SETINFO`: its run left **no** `ACL LOG` entry at
all. The operator's own client, go-redis **v9.21.0**, also sends `CLIENT SETINFO` on connect and
tolerates a Redis error reply to it (read from its source, `redis.go` `initConn`; **not measured
live**).

Why the two connect-time denials are not simply ignored: **`ACL LOG` is a bounded ring**
(`acllog-max-len`, 128 by default). Routine denials on every connect of every pod push out the
entries an operator would actually look for, such as a real cross-app attempt.

## Measured: residuals (isolation the ACL does not give)

1. **`SCAN` exposes other apps' key names.** `SCAN` has no key argument, so the key pattern cannot
   filter what it returns: A's `SCAN 0 MATCH <B's prefix>:*` returned B's key names (measured, both
   engines). Values stay unreadable (`GET` is `NOPERM`). ISR keys are route paths and tag names, so
   this discloses which pages and tags another app has cached. `+scan` is needed today by both
   outage collapse sweeps; dropping it needs the sweeps rebuilt on an index the app owns.
2. **Nested prefixes are not isolated.** If app B's prefix is `<A's prefix>:<more>`, B's keys sit
   inside A's pattern and A's user reads them (measured). Admission allows `:` in `keyPrefix`, so the
   operator has to refuse a prefix that nests inside (or contains) another app's on the same Redis.
3. **A busy Lua script blocks every app.** Measured on CI's Redis 7.4.10 with a throwaway user
   holding `+eval`: `EVAL "while true do end" 0` made every other client, any user, get `BUSY`
   after `busy-reply-threshold` (5000 ms); the user's own `SCRIPT KILL` was `NOPERM`; an admin
   `SCRIPT KILL` (redis-cli) stopped it. A script that wrote a key first and then looped answered an
   admin `SCRIPT KILL` with `UNKILLABLE`, and only `SHUTDOWN NOSAVE` recovered. New ioredis
   connections cannot even finish their handshake while the server is `BUSY`. Not measured on
   Valkey. The ADR records the mitigations (D8).

## Measured: lifecycle (what provisioning has to live with)

| Action | Result |
|---|---|
| Re-run `ACL SETUSER` with the identical rule set (`reset on >pw …`) against a user with a live connection | the live connection keeps working |
| Rotation: `ACL SETUSER <u> >new`, then `ACL SETUSER <u> <old` | both passwords authenticate during the overlap; after `<old`, a new `AUTH` with the old one gets `WRONGPASS invalid username-password pair`; connections that authenticated earlier keep working |
| `ACL DELUSER <u>` | the user's live connections are dropped |
| `ACL SAVE` on a server with no `aclfile` | `ERR This Redis instance is not configured to use an ACL file` |
| Restart a server with no `aclfile` | **the user is gone** |
| Rotation as ADR-0071 D4 re-asserts it: `ACL SETUSER <u> reset … >new #<sha256(old)>`, then `ACL SETUSER <u> reset … >new` | both passwords authenticate during the overlap; after the second re-assert, a new `AUTH` with the old one gets `WRONGPASS`; a connection opened during the overlap keeps working (both engines; also a lifecycle check in the script) |

The restart result is the one that shapes the design: on the common in-cluster setup (no `aclfile`,
no persistent config), every Redis pod restart deletes every app user, and the next connection from
each app fails `WRONGPASS`. The provisioner must re-assert users, not create them once. The `reset`
in the rule set makes re-assertion idempotent, and it does not disturb live connections. During a
rotation, though, a re-assert must carry **both** passwords, or `reset` removes the one still in use.

## Measured: the provisioner user

The ADR has the operator provision app users with a dedicated provisioner credential, not `default`.
The rule set it proposes was run on both engines with throwaway `nopass` users on loopback:

```sh
redis-cli ACL SETUSER spike-prov on nopass '~*' resetchannels -@all \
  '+acl|setuser' '+acl|deluser' '+acl|getuser' '+acl|users' '+acl|whoami' +scan +del +ping '+info|server' '+client|setinfo'
# then, authenticated as spike-prov:
ACL SETUSER spike-app reset on nopass ~spike-app:* %W~knext:cdn:purged:abc:* resetchannels -@all +get +set '+client|setinfo'
ACL GETUSER spike-app            # rules round-trip, selector included
INFO server                      # allowed (first-argument rule)
INFO keyspace / INFO             # NOPERM
GET spike-app:k / FLUSHALL       # NOPERM
ACL SETUSER spike-prov +@all     # OK  <- the provisioner can escalate itself
```

| Step | Redis 7.4.11 | Valkey 8.1.10 |
|---|---|---|
| Create an app user with the per-app rules and the `%W~` selector | OK | OK |
| `ACL GETUSER` round-trips the rules | yes | yes |
| `SCAN` / `DEL` under the app's prefix (the finalizer's sweep) | OK | OK |
| `INFO server` (needed for `run_id`, the restart signal) with `+info\|server` | allowed | allowed |
| `INFO keyspace`, bare `INFO` | `NOPERM` | `NOPERM` |
| Read a key, `FLUSHALL` | `NOPERM` | `NOPERM` |
| `ACL USERS`, and `ACL GETUSER` of an app user's key patterns (the conflict check, ADR D6a; round 2, `+acl\|users` added) | allowed | allowed |
| `ACL LIST` (every user's password hashes) | `NOPERM` | `NOPERM` |
| **`ACL SETUSER <itself> +@all`** | **OK** | **OK** |

The last row is the point: **any user that can run `ACL SETUSER` can grant itself everything.** A
narrow provisioner rule set limits what the operator does by accident, not what a thief of its
credential can do. The credential is root-equivalent and has to be handled that way. `+info|server`
uses Redis's first-argument rule form, which the Redis docs mark deprecated; it works on both engines
measured.

## Documented, not measured: managed Redis offerings

None of these was run, and the pages were **not re-fetched while writing this** (the spike
environment had no web access). The rows are our reading of each provider's documentation from
before the spike, so treat every cell as a pointer to verify, not a finding. The build (#2396) must
re-check the linked page before relying on a row.

| Offering | Can a client run `ACL SETUSER`? | How per-user access is managed instead | Do users survive restarts / failover? |
|---|---|---|---|
| **AWS ElastiCache** (Redis OSS / Valkey) | No — ACL management commands are restricted ([restricted commands](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SupportedCommands.html)) | Role-based access control: users with Redis-syntax access strings and user groups, through the ElastiCache API; requires in-transit encryption ([RBAC](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html)) | Yes, managed by the service |
| **Google Cloud Memorystore for Redis** | No — ACL commands are on the blocked list ([product constraints](https://cloud.google.com/memorystore/docs/redis/product-constraints)) | One instance-wide AUTH string ([AUTH](https://cloud.google.com/memorystore/docs/redis/about-redis-auth)); no per-user key patterns | n/a |
| **Google Cloud Memorystore for Valkey / Redis Cluster** | No in-band user management documented | IAM authentication ([Valkey IAM auth](https://cloud.google.com/memorystore/docs/valkey/about-iam-auth)); not a per-key-pattern ACL | n/a |
| **Azure Cache for Redis** | No — `ACL` is on the unsupported-commands list ([unsupported commands](https://learn.microsoft.com/azure/azure-cache-for-redis/cache-configure#redis-commands-not-supported-in-azure-cache-for-redis)) | Data access policies (Redis ACL permission syntax) assigned to Microsoft Entra identities, through Azure ([data access policies](https://learn.microsoft.com/azure/azure-cache-for-redis/cache-configure-role-based-access-control)) | Yes, managed by the service |
| **OCI Cache** (Redis / Valkey) | Not established from the docs we read | Varies by release; see the [OCI Cache documentation](https://docs.oracle.com/en-us/iaas/Content/ocicache/home.htm) | Not established |

What follows for the design, and does not depend on any one row being exact: **in-band `ACL SETUSER`
is a self-hosted Redis/Valkey capability.** On a managed service the per-app user (where one exists)
is created through the provider's API, so knext can only consume a credential created there. It
cannot issue one without a per-cloud integration, which would cut against staying a narrow adapter
with no lock-in.

## Not covered

- Redis 6.x (ACL exists but `%R~`/`%W~` selectors and the Redis 7 script-ACL behaviour differ).
- Redis Cluster and Sentinel topologies; TLS (`rediss://`).
- go-redis's handshake, live (read from source only).
- Any managed offering (above).
- Kubernetes wiring: the per-app Secret, the operator reconciling users, the two-app kind e2e. That
  is #2396's acceptance, built against ADR-0071.
