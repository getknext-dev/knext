# ARCHITECTURE — the scale-zero-pg code map

> **Audience: a future LLM agent (or engineer) who has never seen this repo and needs to
> understand and change it.** This is a navigable map — "where does X live, and how does it
> work" — with `file:path` pointers you can jump straight to. It is deliberately grounded in
> the actual code; every claim was read from source. When code and this doc disagree, the
> code wins — fix the doc (rule 2b: docs ship with the change).
>
> **Read these first, in order:** `CLAUDE.md` (kickoff brief + hard rules), `HANDOFF.md`
> (current state + open decisions), then this file. Deep-dives live in `docs/` (see §10).

## Table of contents

1. [The 30-second model](#1-the-30-second-model)
2. [The three planes](#2-the-three-planes)
3. [The wake-on-connect gateway](#3-the-wake-on-connect-gateway)
4. [Drivers, modes, and the two gateways](#4-drivers-modes-and-the-two-gateways)
5. [The AppDatabase operator](#5-the-appdatabase-operator)
6. [The Zone operator + writer autoscaler](#6-the-zone-operator--writer-autoscaler)
7. [Security model](#7-security-model)
8. [Repo layout](#8-repo-layout)
9. [Build / test / deploy](#9-build--test--deploy)
10. [Docs & the ADR ledger](#10-docs--the-adr-ledger)
11. [Known constraints for a future agent](#11-known-constraints-for-a-future-agent)

---

## 1. The 30-second model

An idle Postgres database costs **zero compute**; the first client TCP connection wakes it in
a few seconds. We do **not** rebuild Postgres or its durability — we run native Neon compute on
Neon's open-source disaggregated storage, and the *only* thing this repo builds is a small Go
**wake-on-connect gateway**. Consumer: the **knext** platform, bound by one `DATABASE_URL`
Secret. (See `README.md` for the ASCII diagram; `CLAUDE.md` "Architecture (fixed)" for the rules.)

```
client ──pg wire──▶ GATEWAY (Go, always on, stateless)          gateway/
                      │  parse startup ▸ authorize ▸ compute asleep?
                      │  ▸ scale 0→1 (client-go) ▸ settle ▸ replay ▸ pipe bytes
                      │  ▸ idle GW_IDLE_MS → scale 1→0
                      ▼
                    COMPUTE (Deployment, replicas 0↔1, Recreate)   deploy/20-compute.yaml
                    native Postgres 17 + neon ext — stateless, no volume
                      │ WAL out                ▲ GetPage@LSN
                      ▼                        │
                    STORAGE (never scales to zero)                 deploy/5X-*.yaml
                    safekeeper (durable WAL) · pageserver (pages) · MinIO/S3
```

The compute holds **no state**: kill its pod and nothing is lost; a fresh pod re-attaches to the
tenant/timeline and lazily fetches pages. Durability, replication, branching, PITR all come from
Neon's storage components — reused, not rebuilt (`CLAUDE.md` hard rule 5).

---

## 2. The three planes

The system is three planes with a hard separation. **Read `CLAUDE.md` "Architecture (fixed)" +
"Hard rules" to understand *why* the separation is non-negotiable.**

### Storage plane — durable, never scale-to-zero
Neon's OSS storage stack, on Kubernetes. Manifests `deploy/50`–`deploy/64`:

| Manifest | Workload | Role |
|---|---|---|
| `deploy/50-minio.yaml` | Deployment + PVC | S3-compatible object store (default; ADR-0005 makes it optional/configurable) |
| `deploy/51-storage-broker.yaml` | Deployment | Neon storage broker (coordination) |
| `deploy/52-safekeeper.yaml` | **StatefulSet** (3-member quorum) | Durable WAL, single-writer authority |
| `deploy/53-pageserver.yaml` | **StatefulSet** (1 replica — SPOF) + Service + ConfigMap | Pages + S3/MinIO offload |
| `deploy/55-storage-init.yaml` | Job | One-time plane bootstrap |
| `deploy/57-pageserver-standby.yaml` | StatefulSet + Job | Pageserver failover standby |

> **Nuance to remember:** CLAUDE.md summarizes storage as "StatefulSets". Precisely: **safekeeper
> and pageserver are StatefulSets; MinIO and the broker are Deployments with PVCs.** The
> invariant that matters is *never scale-to-zero, never on Knative* — not the workload kind.

### Compute plane — stateless, scaled 0↔1
One stateless Neon compute per database, a Deployment at `replicas: 0` at rest.
- `deploy/20-compute.yaml` — the primary single-DB compute. `strategy: Recreate` is
  load-bearing: **single-writer is intrinsic to Neon**, so two computes must never attach one
  timeline, even mid-rollout (`deploy/20-compute.yaml:24`). Serves Postgres on **:55433**.
- `deploy/25-compute-warm.yaml` — opt-in warm-standby tier (ADR-0002): a gated parked pod for
  sub-second wakes at the cost of a small reservation.
- `deploy/26-compute-ro.yaml` — the read-replica pool (0↔N), the read-scaling axis.
- Per-app computes (`compute-<app>`, `compute-ro-<app>`) are **rendered at runtime** by the
  AppDatabase operator (§5), templated from `deploy/compute-app.template.yaml`.

Cold start = attach + lazy page fetch; **no restore**. There is deliberately **no lease/fencing
layer** — Neon owns single-writer (`CLAUDE.md` hard rule 3).

### Routing plane — the only thing we build (`gateway/`)
The Go wake-on-connect proxy. Two deployments of the *same binary/image*, different env:
- `deploy/10-gateway.yaml` — **`pggw`**, the single-DB gateway (kubectl mode). **Frozen on the
  v0.6.1 release image** and NOT receiving recent hardening — see HANDOFF §3 "maintain vs legacy".
- `deploy/81-apps-gateway.yaml` — **`pggw-apps`**, the multi-tenant gateway (template mode). This
  is the **primary, current** path. All branch-per-app traffic flows here.

Storage plane is never on Knative and compute scaling is **TCP-triggered** (the gateway / KEDA),
not Knative Serving — because Knative's activator is HTTP-only (`CLAUDE.md` hard rule 4).

---

## 3. The wake-on-connect gateway

**Package:** `gateway/internal/gateway/` (server) + `gateway/internal/wake/` (compute drivers +
wake logic) + `gateway/internal/proto/` (just-enough Postgres wire protocol).
**Entry point:** `gateway/cmd/gateway/main.go`.

The gateway is a **dumb byte pipe after the handshake**: it parses only the startup packet, then
pipes bytes untouched. It never speaks SCRAM/md5 or the query protocol — the compute verifies
auth once awake. Read the package doc-comment at the top of
`gateway/internal/gateway/gateway.go` for the one-paragraph summary.

### The full connection flow — trace with these pointers

Start at `Gateway.Serve` → `Gateway.handle` → `Gateway.proxy` in `gateway/internal/gateway/gateway.go`:

1. **Accept TCP** — `Serve()` (`gateway.go:247`). Sets `TCP_NODELAY`; enforces the optional
   `GW_MAX_CONNS` cap via a semaphore (`capConn`), refusing over-cap connections cleanly (53300).
2. **Parse the initial packet** — `handle()` (`gateway.go:289`) loops reading packets via
   `proto.ReadInitialPacket` / `proto.ParseInitialPacket` (`gateway/internal/proto/proto.go`).
   Classifies SSL / GSSEnc / Cancel / Startup.
3. **Decline SSL / GSS** — on `TypeSSL`: if TLS is configured (`GW_TLS_CERT_FILE`+`_KEY_FILE`,
   `loadTLS()`), reply `S`, wrap in `tls.Server`, restart reading over the encrypted channel;
   otherwise reply `N` (plaintext continues). `TypeGSSEnc` always gets `N`. See `handle()` switch.
4. **Authorize BEFORE any wake** — `authorizeStartup()` (`gateway.go:411`) calls the driver's
   `Authorize(user, database)` (ordinary) or `AuthorizeReplication` (replication). Refusal →
   uniform 28P01 with a constant-floor delay (`authFloor`, `gateway.go:442`). Only template mode
   implements this (§7); single-DB pggw accepts every startup unchanged.
5. **Resolve the target** — `driver.Resolve(systemID)` maps the DSN database name to a
   `wake.Target{Host,Port,Key}`.
6. **Rewrite the served database (#123)** — if the driver implements `ServedDatabase()`
   (template mode), `rewriteStartupDatabase()` (`gateway/internal/gateway/dbrewrite.go`) rewrites
   the startup packet's `database` param to the single physical DB each branch serves (default
   `postgres`). The DSN dbname only *routes*; every branch serves one physical DB. Non-template
   drivers never touch the bytes.
7. **Wake the compute (0→1)** — `proxy()` (`gateway.go:523`) calls
   `wake.ConnectWithWake(...)` (`gateway/internal/wake/wake.go:327`):
   - Try to connect first — a **warm** compute answers and is *never* gated (wake-on-connect UX
     preserved for warm apps).
   - Asleep → consult the **wake budget** (`Opts.WakeGuard`, §7) BEFORE scaling. Over-budget →
     `ErrWakeBudgetExceeded`, no scale.
   - Scale via **bounded idempotent retry** — `wakeWithRetry()` in
     `gateway/internal/wake/retry.go` (#190): exponential backoff + jitter around the client-go
     Scale call, each attempt deadline-boxed to the wake budget (`GW_WAKE_TIMEOUT_MS`). Terminal
     errors (NotFound/Forbidden/Invalid — `isTerminalWakeErr`) fail loud immediately; transient
     apiserver blips (5xx/throttle/timeout/conflict) retry. `OnWakeRetry` bumps
     `pggw_wake_retries_total`.
   - Then poll `TryConnect` every `GW_RETRY_MS` until the compute answers or the deadline passes.
8. **Cold-boot settle / `/status` gate (#132/#181)** — `gateColdWake()` in
   `gateway/internal/gateway/statusgate.go`. Fires ONLY on a genuine 0→1 cold wake of a per-app
   front door (a `systemAuthorizer` driver). `compute_ctl` opens the socket a beat before it
   (re)applies the per-app spec role, so the first connection can transiently see 28P01.
   - **Deterministic (opt-in, default OFF):** if `GW_STATUS_PORT`+token configured, poll
     compute_ctl's `/status` until it reports `running` (`statusProbe.awaitReady`). Live-enable
     is deferred (#182) because port 3080 is not yet exposed on the compute Service/NetworkPolicy.
   - **Fallback (default):** `settleColdWake()` (`gateway.go:463`) holds the client a bounded
     `GW_ROLE_APPLY_SETTLE_MS` (default 250ms). Both paths clamp to the wake deadline. This makes
     the race *negligible*, not deterministically zero — that's what the `/status` gate is for.
9. **Readiness handshake** — `handshakeUntilReady()` (`gateway.go:611`) writes the startup packet
   and absorbs any transient `57P03` ("system is starting up") FATALs, reconnecting until the
   backend answers for real. The client never sees the transient FATAL.
10. **Replay + pipe** — write the backend's first reply + any buffered client bytes, then two
    `io.Copy` goroutines pipe bytes both ways until either side closes (`proxy()` tail).
11. **Idle → 0** — connection accounting in `connStarted`/`connEnded` (`gateway.go:674`/`697`).
    When the last connection for a compute closes and stays closed for `GW_IDLE_MS`,
    `scheduleSleep()` (`gateway.go:716`) scales it back to 0. Guards: a live **replication**
    stream (`replCount`, ADR-0007) pins the publisher awake; a multi-replica fleet only sleeps
    when **peers** also report zero (`PeerChecker` / `gateway/internal/gateway/peers.go`, #75); a
    TOCTOU heal wakes it right back if a connection arrived mid-scale-down.

Key env knobs (all `GW_*`, read in `gateway.New` / `wake.MakeDriver`): `GW_IDLE_MS` (300000),
`GW_WAKE_TIMEOUT_MS` (60000), `GW_CONNECT_TIMEOUT_MS` (1000), `GW_RETRY_MS` (250),
`GW_ROLE_APPLY_SETTLE_MS` (250), `GW_MAX_CONNS`, `GW_WAKE_BUDGET`/`GW_WAKE_WINDOW_MS`,
`GW_PORT` (55432), `GW_RO_PORT` (55434), `GW_METRICS_PORT` (9090). Env is injected as a map
(`wake.Env`, `wake.EnvFromOS`) so tests never touch process env.

---

## 4. Drivers, modes, and the two gateways

The gateway is **mode-agnostic**: every mode implements the `wake.Driver` interface
(`Mode / Resolve / Wake / Sleep / CanSleep`) in `gateway/internal/wake/wake.go`. `MakeDriver`
(`wake.go:219`) builds one from `GW_COMPUTE_MODE`:

| Mode | Driver | Compute target | Used by |
|---|---|---|---|
| `static` | `staticDriver` | fixed `GW_TARGET`, wake/sleep no-ops | local dev / always-on |
| `exec` | `execDriver` | shell `GW_WAKE_CMD`/`GW_SLEEP_CMD` | docker-compose / scripts |
| `kubectl` | `kubeDriver` | one Deployment `GW_K8S_DEPLOYMENT`, scaled 0↔1 via client-go | **`pggw`** (single-DB, `deploy/10-gateway.yaml`) |
| `template` | `templateDriver` | per-app `compute-{system}` from `GW_K8S_DEPLOYMENT_TEMPLATE` | **`pggw-apps`** (branch-per-app, `deploy/81-apps-gateway.yaml`) |
| `warmpool` | `warmDriver` (`wake/warm.go`) | gated parked pod on the gate port | opt-in warm tier (ADR-0002) |

- **Scaling** for the k8s modes is a client-go `GetScale`→`UpdateScale` (idempotent) in
  `gateway/internal/wake/k8s.go` (the `Scaler` interface, injected so tests fake it).
- **`static` = single-DB** (one fixed compute); **`template`/apps = branch-per-app** (one compute
  Deployment per app, `compute-<app>`, keyed by the DSN database name). `templateDriver` also
  carries `ServedDatabase()` (§3 step 6) and the per-app/per-zone role prefixes for authz (§7).
- **The RO listener (`DATABASE_URL_RO`, port 55434)** — `gateway/cmd/gateway/main.go:71` starts a
  **second `Gateway`** on `GW_RO_PORT`, built from a `GW_RO_*`-remapped env
  (`gateway/internal/wake/ro.go`): `ROEnv` (kubectl → one fixed `compute-ro`) for `pggw`, or
  `ROTemplateEnv` (template → per-app `compute-ro-<app>`) for `pggw-apps`. It reuses the *entire*
  wake/idle/peer/TLS machinery with **zero SQL parsing** — the app opts in by pointing reads at
  the RO port. Using the kubectl `ROEnv` on the apps-gateway would collapse every app's reads onto
  one shared pool — a cross-tenant leak; `ROTemplateEnv` keeps per-app isolation (#127, see the
  long comment in `ro.go`).

---

## 5. The AppDatabase operator

**The declarative provisioning interface for branch-per-app multi-tenancy (ADR-0004, #96).**
It reimplements the proven `deploy/provision-app.sh` logic in Go. `provision-app.sh` is retained
as **break-glass** only.

- **Binary:** `gateway/cmd/appdb-operator/main.go` — ships in the *same multi-binary image* as the
  gateway; the Deployment overrides ENTRYPOINT to `/appdb-operator`. Config is env-only (`APPDB_*`).
- **Package:** `gateway/internal/appdb/`. The reconcile logic (`reconcile.go`) is **pure and
  port-driven** — `Deps` holds interfaces (`Cluster`, `Pageserver`, `Safekeeper`) so it is
  table-testable with fakes.
- **CRD:** `deploy/82-appdb-crd.yaml`, `deploy/83-appdb-operator.yaml` (Deployment + RBAC).
  Group/Version/Kind = `apps.scale-zero-pg.dev` / `v1alpha1` / `AppDatabase`
  (`appdb/types.go:16`). Key spec: `appName`, `tier` (cold|warm), `quotas`,
  `roPool{enabled,minReplicas,maxReplicas}`, `keepTimelineOnDelete`.

### Reconcile loop
`Controller.Run` (`appdb/controller.go`) drives it from a **watch informer + a resync ticker**
(`APPDB_RESYNC_MS`, default 15s). Each CR goes through `Deps.Reconcile` (`appdb/reconcile.go:20`):
validate app name (RFC1123, no reserved `tmpl/warm/ro`) → branch to `reconcileDelete` or
`reconcileApply`.

`reconcileApply` (`reconcile.go:41`) is **intent-first and idempotent** (persist the durable owner
of record — `status.timelineId` + the compute ConfigMap — *before* the pageserver branch, so a
crash never orphans a branch, #76). Steps:
1. **Finalizer first** (`apps.scale-zero-pg.dev/deprovision`, `types.go:24`).
2. **Mint the timeline id** (32-hex Neon id), persist to status.
3. **Per-app credential Secret** `app-db-<app>` via `Cluster.CreateSecret` (`appdb/k8s.go`):
   keys `PGUSER`, `PGPASSWORD`, `APP_ROLE_VERIFIER` (SCRAM, see below), `DATABASE_URL`, and
   `DATABASE_URL_RO` when `roPool.enabled` (#119). Re-provision **preserves the password** so a
   live app is never locked out (#74).
4. **Compute children** — rendered by `RenderConfig` in `appdb/render.go`:
   `RenderConfigMap` (carries `TIMELINE_ID`), `RenderService` (:55433), `RenderDeployment`
   (Recreate, single-writer, quotas → resources). And when `roPool.enabled`:
   `RenderROService`, `RenderRODeployment` (RollingUpdate — RO is not single-writer, so N>1 is
   safe), `RenderROHPA` (`render.go:317`) → `compute-ro-<app>` on the app's *own* timeline (#127).
5. **Branch the timeline** on the pageserver from the shared apps-template LSN
   (`Pageserver.Branch`), idempotent on the timeline id.
6. **Observe readiness**, settle `status.phase` (Provisioning→Ready) + conditions.

### ownerReferences / native cascade-GC (#122/#189)
`cr.ownerRef()` (`appdb/types.go`) is stamped on **every** child (Secret/ConfigMap/Deployment/
Service/HPA), and back-filled on pre-existing children (`EnsureSecretOwnerRef`). This is
defense-in-depth **over** the finalizer: k8s cascade-GC reaps children on CR delete even if the
finalizer path is skipped. Guarded against a dangling owner (no UID → no ownerRef written).

### Finalizer + two-sided Neon-branch reclaim
`reconcileDelete` (`reconcile.go:218`): delete RO compute → delete compute objects → unless
`keepTimelineOnDelete`, **two-sided timeline reclaim** (`reclaimTimeline`, `reconcile.go:279`):
DELETE the timeline on the pageserver **and every safekeeper ordinal**. A safekeeper being down
is recorded durably (a reclaim-ledger ConfigMap) and the CR keeps its finalizer + requeues until
the plane is truly clean — the object disappears only once there's no orphan (#91).

### SCRAM verifier minting (#117)
`scramSHA256Verifier` (`appdb/scram.go`) precomputes a Postgres-format SCRAM-SHA-256 verifier
(`SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`, RFC 5802, Go stdlib `crypto/pbkdf2`, 16-byte
salt). compute_ctl stores it verbatim as the role's `encrypted_password`, so the app role is
**SCRAM from boot** — no plaintext tenant password ever lands on the compute, and no post-boot
`ALTER`.

### Quotas
`Quotas` (`appdb/types.go`, defaults `Quotas.resolved()`): `cpu/cpuRequest/mem/memRequest/
maxConnections`. Rendered into Deployment resource requests/limits **and** ConfigMap env
(`PG_MAX_CONNECTIONS` etc). Enforcement = k8s resource limits + the Postgres `max_connections` GUC.

---

## 6. The Zone operator + writer autoscaler

### Zone operator (ADR-0007, #145) — the eventual-consistency / cross-zone axis
- **Binary:** `gateway/cmd/zone-operator/main.go`. **Package:** `gateway/internal/zone/`.
  **CRD:** `deploy/86-zone-crd.yaml` + `deploy/87-zone-operator.yaml`. Group/Kind =
  `zones.scale-zero-pg.dev` / `Zone`.
- **It composes an AppDatabase** (delegation, ADR-0006) named after the zone, then layers a
  cross-zone replication fabric on top. `Zone.Reconcile` (`zone/reconcile.go:25`) →
  `reconcileApply`: ensure the composed AppDatabase is Ready, then (per `spec.publishes[]` /
  `spec.dataDependencies[]`) create the per-zone `repl_<zone>` REPLICATION role, publications,
  and subscriptions (`replicate`) or postgres_fdw foreign tables (`federate`). SQL is executed
  in-pod over cloud_admin loopback (`zone/execsql.go`), with identifiers validated + quoted
  (`zone/sql.go`) against injection.
- **The generation-gate** (`reconcile.go` ~line 161–186): once Ready and `ObservedGeneration ==
  Generation`, it **skips all in-DB SQL** — publications/subscriptions are durable on the timeline
  and survive scale-to-zero, so re-asserting them every resync would force-wake the compute every
  tick. This false-green (an early version woke publishers every 15s) was caught by code-review
  pre-merge — the sign-off gate's key win (see MEMORY). Only a spec edit (generation bump)
  re-applies. A narrow exception polls streaming subscriptions for slot invalidation without
  waking a settled peer.
- **Single-writer-per-replicated-table guard** — `validate()` → `checkSingleWriter()` cross-checks
  all Zones so a table is published by at most one zone, and **fails CLOSED** if the Zone lister is
  momentarily unreadable (`errZonesUnavailable`, #147): never admit a spec whose safety it can't
  verify.

### Writer vertical autoscaler (#103) — the write-scaling axis
- **Binary:** `gateway/cmd/writer-autoscaler/main.go`. **Package:** `gateway/internal/writerscaler/`.
  **Manifest:** `deploy/85-writer-autoscaler.yaml`.
- Polls writer-compute CPU/memory *usage* (metrics-server) vs current limits every `WAS_POLL_MS`
  (15s). Pure decision in `writerscaler/decide.go` (`Decide()`): compares usage/limit against
  up/down ratios → **in-place pod resize** (k8s 1.33+ `pods/resize` subresource) that moves CPU/mem
  *limits* live with **no restart** (postmaster stays up). Hysteresis + cooldown counters in
  `controller.go` prevent flapping; a memory-bound-at-max pod is *annotated* for an operator
  maintenance-window bounce, never auto-bounced. Selector `plane=compute,role!=ro`.

**The four scaling axes** (see `docs/SCALING.md`): write=vertical (this autoscaler),
read=horizontal (`compute-ro` pool), tenant=horizontal (branch-per-app), zone=eventual (Zone op).

---

## 7. Security model

The gateway is a dumb byte pipe with **no tenant credentials** by design (`CLAUDE.md` rule 5).
Isolation is enforced in layers. **Read `docs/adr-0008-wake-primitive-security.md` +
`docs/operations.md` for the full model.**

- **SCRAM-SHA-256 (#117):** every per-app role is SCRAM from boot (§5). The **compute**, not the
  gateway, verifies auth. `gateway/internal/appdb/scram.go`.
- **`cloud_admin` is loopback-only (#112/#168):** the shared superuser is rejected over TCP by
  `pg_hba` and usable only over pod-local `127.0.0.1:55433` (this is why the Zone operator execs
  SQL *inside* the pod, §6). The #112 fix closed a CRITICAL cross-tenant superuser bypass found in
  the independent security review.
- **Per-app tenant boundary (#74/#123):** enforced by isolation of **credential + Neon timeline**,
  **NOT** db-name isolation — every branch physically serves the same `postgres` database, and the
  DSN dbname only *routes* (that's why the startup is rewritten, §3 step 6). Pre-wake authz lives
  in `gateway/internal/wake/authz.go`: `templateDriver.Authorize(user,database)` requires
  `user == app_<database>` (via `GW_APP_ROLE_PREFIX`), refuses `cloud_admin`, reserved names
  (`tmpl/warm/ro`), and malformed names — all with the *same* uniform 28P01
  (`UniformAuthFailure`) so there's no tenant-existence oracle (#92). Replication startups need the
  distinct `repl_<zone>` role (`AuthorizeReplication`); the two prefixes must differ or `MakeDriver`
  fails fast.
- **The wake budget (#116, ADR-0008):** because a syntactically-valid (user,db) pair can *wake*
  a compute before any password check, a per-app **token-bucket** on the wake primitive
  (`gateway/internal/wake/budget.go`, `WakeLimiter`) caps 0→1 churn. Over-budget wakes are refused
  with SQLSTATE **53400** (transient/retryable, *not* an auth failure and *not* a wake failure —
  distinct metric/alert, never pages the wake-failure pager). Enabled via
  `GW_WAKE_BUDGET`/`GW_WAKE_WINDOW_MS`. This is the CNI-independent control; the NetworkPolicy layer
  (`deploy/70-networkpolicy.yaml` `apps-compute-ingress`) needs a policy-capable CNI (#118, not yet
  enforcing).
- **Accepted residual — md5 cold-wake window (#158):** on a genuine cold wake, compute_ctl opens the
  socket a beat before applying the SCRAM role, leaving a brief window. Accepted-and-documented; the
  `/status` gate (#181/#182) closes it deterministically once live-enabled. See `docs/operations.md`
  "Accepted residual".

---

## 8. Repo layout

```
gateway/         Go wake-on-connect proxy + operators (one multi-binary image). go test ./...
  cmd/           entrypoints: gateway, appdb-operator, zone-operator, writer-autoscaler,
                 pswatcher (pageserver-failover watcher), alertsink
  internal/
    gateway/     the proxy server, peer-aware idle, /status gate, dbrewrite
    wake/        driver abstraction, ConnectWithWake, wake-retry, budget, authz, RO env, warm pool
    proto/       minimal Postgres wire protocol (startup framing, SSL codes, ErrorResponse)
    appdb/       AppDatabase operator (reconcile, render, k8s ports, scram, pageserver/safekeeper)
    zone/        Zone operator (reconcile, sql/execsql, single-writer guard)
    writerscaler/ writer vertical autoscaler (decide, controller, in-place resize)
    metrics/     Prometheus metrics registry
    pswatcher/   pageserver failover watcher
deploy/          ALL k8s manifests (numbered) + the drill battery + provision-app.sh + skctl.py
docs/            user docs, ADRs (0001–0008), SCALING/BENCHMARKS/SCORECARD, runbooks, research
```

### The numbered `deploy/*.yaml` convention
Manifests apply in numeric order (`make deploy` = `kubectl apply -f deploy/`). Bands:
- **00** namespace · **10** `pggw` gateway+RBAC · **20/25/26** compute (cold `replicas:0` / warm /
  RO pool) · **30** knext `DATABASE_URL` Secret · **40** KEDA ScaledObject (`.optional`).
- **50–64** storage + observability plane: 50 MinIO, 51 broker, 52 safekeeper, 53 pageserver,
  54 compute ConfigMaps, 55 storage-init Job, 56 PDB, 57 pageserver-standby, 58 pswatcher,
  59 kube-state-metrics, 60 Prometheus, 61 Alertmanager, 62 backup, 63 repl-slot-monitor,
  64 zone-status-monitor.
- **70** NetworkPolicy (default-deny + explicit allows).
- **81–87** the multi-tenant stack: 81 `pggw-apps`, 82 AppDatabase CRD, 83 appdb-operator,
  84 external-driver RBAC role, 85 writer-autoscaler, 86 Zone CRD, 87 zone-operator.
- `deploy/compute-app.template.yaml` — the per-app compute template (also the operator's render
  source of truth); `deploy/provision-app.sh` — imperative break-glass provisioner (superseded by
  the operator, ADR-0004); `deploy/skctl.py` — the safekeeper.control (de)serializer that writable
  restore depends on (CI-guarded).

### The drill battery
The OKE acceptance suite (`CLAUDE.md` loop step 3). Run before requesting review.
- `deploy/_lib-drill.sh` — **pure, cluster-free** shared helpers. The key idea (#198): every timing
  budget is derived from **one knob, `WAKE_BUDGET_MS`** (default 30000), via `wake_budget_ms` /
  `idle_budget_ms` etc — so a slow/CPU-constrained cluster (where cold wakes run ~14s vs the
  historical ~2–5s) re-tunes the whole battery from a single env var instead of scattered magic
  numbers. `sh deploy/_lib-drill.sh selftest` unit-tests it.
- `deploy/_verify-*.sh` (~40 scripts) — one drill each, grouped by concern: **wake/coldboot**
  (`_verify-wake`, `_verify-coldboot`, `_verify-warmtier`, `_verify-wake-guard`); **storage/failover**
  (`_verify-storage`, `_verify-restore`, `_verify-app-restore`, `_verify-backup-portability`,
  `_verify-objstore`, `_verify-pageserver-failover`); **multitenant/quota** (`_verify-multitenant`,
  `_verify-tenant-quotas`, `_verify-scale-ceiling`, `_verify-operator`, `_verify-unified-config`);
  **read pool** (`_verify-readpool`, `_verify-perapp-ro`); **zone/repl** (`_verify-zones`,
  `_verify-zone-deploy`, `_verify-repl-wake`, `_verify-slot-janitor`, `_verify-wal-janitor`,
  `_verify-janitor-protect`); **security** (`_verify-netpol`, `_verify-tls`); **observability**
  (`_verify-alerting`, `_verify-cronjob-alerting`, `_verify-ksm-down`, `_verify-ha`);
  **ops** (`_verify-drift`, `_verify-base-admin`, `_verify-upgrade`, `_verify-extensions`,
  `_verify-writer-autoscaler`).
- `deploy/_validate.sh` — manifest server-dry-run + contract checks (also run in CI).
- `deploy/_rehearse-upgrade.sh` — storage-plane upgrade rehearsal (a kill-criterion tripwire).

---

## 9. Build / test / deploy

### CI — `.github/workflows/ci.yml` (push to main + all PRs)
Jobs: **gateway** (Go 1.26 `gofmt` check, `go vet`, `go test ./...`, `docker build`) ·
**manifests** (kind cluster + `deploy/_validate.sh` server dry-run) · **skctl** (Python round-trip
+ version-guard on the safekeeper.control serializer, #22/#24) · **provision** (provision-app.sh
name-validation, #79/#74) · **e2e** (heavy; opt-in via `[e2e]` in the commit message).

### CD — `.github/workflows/cd.yml` (push to `gateway/**`, `v*` tags, or manual)
Builds + pushes the gateway image (amd64) to OCIR
`me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway`. Tags: immutable `sha-<short>@sha256:<digest>`
always; mutable `edge` only from main / tags; `v*` on version tags. A feature build never clobbers
`edge`.

### The merged ≠ deployed "pin-and-roll" pattern
**A merge to `gateway/**` builds an image; it does NOT deploy it.** Deploy is a *separate* commit
that bumps the manifest's pinned image digest. Grep the live pins:
- `deploy/81-apps-gateway.yaml` — e.g. `...gateway:sha-45dbec3@sha256:...` (current `pggw-apps`).
- `deploy/83-appdb-operator.yaml` — e.g. `...gateway:sha-f3c3c00@sha256:...` (operator).
- `deploy/10-gateway.yaml` — pinned at **`v0.6.1`** (the frozen single-DB `pggw`, HANDOFF §3).

So "the code merged" and "the cluster runs it" are two distinct facts — always check the manifest's
pinned digest to know what's actually live. See commit `cf768ad` ("deploy(#192): pin apps-gateway
to sha-…") for the pattern.

### The sign-off gate (mandatory — `CLAUDE.md` loop step 4/5, HANDOFF §5)
Every change: **plan (GitHub issue) → TDD (red→green commits) → OKE drill battery → code review →
architect SIGN-OFF + system-designer SIGN-OFF → merge.** An implementer lane NEVER merges or
self-spawns reviewers — it opens the PR and STOPS; the lead merges only after all THREE sign-off
comments are on the PR. User docs + `docs/BENCHMARKS.md` ship in the same PR (rule 2b).

### OKE cluster access (HANDOFF §6)
kubeconfig context **`context-ckmva7v7zvq`**, namespace **`scale-zero-pg`**. Always
`kubectl config use-context context-ckmva7v7zvq` first (the wrapper self-resets to local orbstack
if `--context` precedes the subcommand). OCI session refresh:
`oci session authenticate --profile-name knext --region me-abudhabi-1` (browser SSO, human-only;
a launchd job auto-refreshes during active use — see §11).

Local dev: `make local-up` (compose storage plane) · `make smoke` (`go test ./...`) ·
`make gateway` (run the proxy) · `make deploy` (`kubectl apply -f deploy/`).

---

## 10. Docs & the ADR ledger

Where to read for depth:
- `docs/getting-started.md`, `docs/connecting.md` — user-facing; the two-DSN
  (`DATABASE_URL` + `DATABASE_URL_RO`) pattern, dbname routing, connection error semantics.
- `docs/operations.md` — runbooks, kill-criteria tripwires, the #158 accepted residual.
- `docs/SCALING.md` — the four scaling axes. `docs/BENCHMARKS.md` — every drill/bake-off number.
- `docs/SCORECARD.md` — the blind-trio review scores over time.
- `docs/appdatabase-api.md` — the external-driver (knext operator) contract for AppDatabase.
- `docs/runbook-dr.md` — disaster recovery (restore the real plane into a fresh cluster).
- `docs/knext-research.md` — the consumer platform integration notes.

**The ADR ledger** (`docs/adr-0001` … `docs/adr-0008` ACCEPTED; `docs/adr-0009` PROPOSED —
research note). Read the one that governs the area you're changing — an ADR change is a review
trigger.

| ADR | Decides |
|---|---|
| 0001 | Platform extensions: TimescaleDB + pgvector as opt-in trusted, timeline-scoped extensions (Apache-2 tier bound; no bg-worker features on scale-to-zero); sharding as documented levers. |
| 0002 | The database foundation: **self-hosted Neon** (two-tier: cold-zero + opt-in warm), *not* CloudNativePG-hibernation — sub-second warm wake is structural to Neon's stateless compute. |
| 0003 | Multi-tenancy: **branch-per-app** — each app is a Neon timeline under a shared "apps" tenant, its own compute, routed by the apps-gateway template mode. |
| 0004 | Provisioning: **BUILD** the AppDatabase CRD operator (overrode the "bless the script" option); `provision-app.sh` becomes break-glass. |
| 0005 | Object storage: **configurable, MinIO-optional** — the durable store is a configured S3 endpoint (OCI/S3/on-prem), MinIO just the local-dev default. |
| 0006 | Unified config: `NextApp.spec.database` auto-provisions + wires the DB cross-repo (knext declares inline; scale-zero-pg composes the AppDatabase + injects the Secret). |
| 0007 | Zoned consistency: DB-per-zone, strong in-zone, eventual across-zone via logical replication; gateway-mediated replication-wake; Zone composes AppDatabase. |
| 0008 | Wake-primitive security: the wake is a **bounded, observable shared-plane property, not pre-authenticated** — layered control (per-app rate-limit/budget/alert now + NetworkPolicy via #118). |
| 0009 | *(PROPOSED — research)* In-DB durable execution (`pg_durable`): on-strategy but blocked by scale-to-zero (background-worker conflict, same class as pg_cron); adopt only behind a **wake-on-scheduled-step** primitive. No code. |

---

## 11. Known constraints for a future agent

- **2-node CPU-request capacity ceiling (the big one).** The live OKE cluster is 2 nodes; the
  resident platform reserves ~88–93% of allocatable CPU *requests* (each compute requests 250m).
  Consequences: (a) cold wakes are elevated to **~14s mean / 19s max / p95 ~50s** under load vs the
  historical ~2–5s — this is **scheduling/attach latency, NOT a code regression** (node CPU *usage*
  is only 7–16%); (b) you **cannot co-schedule two computes warm** (writer + RO), which blocks clean
  multi-compute drills (`lag_s`, the #197 discriminator). A roomier ≥3-node cluster restores ~2–5s
  wakes and unblocks those. Size drill timing off `WAKE_BUDGET_MS` (§8), don't hard-code timeouts.
- **OCI session lapses.** The `knext` OCI session token expires (hourly-ish; a full overnight expiry
  needs a human browser SSO re-auth). A launchd job (`com.knext.oci-session-refresh`, every 25 min)
  keeps it alive during active use. If `kubectl` suddenly fails auth, re-auth per §9 / HANDOFF §6.
  See `~/.claude/.../memory/oke-auth-persistence-blocked.md`.
- **`pggw` (single-DB) is frozen on v0.6.1** and has NOT received recent hardening (settle-gate,
  SCRAM, wake-retry). `pggw-apps` is the current, primary path. Don't assume the two gateways behave
  identically — HANDOFF §3 tracks the maintain-vs-legacy decision.
- **`/status` gate is default-OFF** (#182): the deterministic cold-boot readiness gate is coded and
  tested but not live (compute_ctl :3080 not exposed on the Service/NetworkPolicy). The bounded
  time-settle is what actually runs.
- **Where the durable memory lives: the repo IS the memory.** There is no chat continuity — a fresh
  agent rebuilds context from `CLAUDE.md` + `HANDOFF.md` + `docs/` + the GitHub issues/PRs/ADRs.
  Keep them truthful and current after **each** step of work (owner directive, HANDOFF §8). The
  local `~/.claude/.../memory/` files are recall aids, not required to function.
