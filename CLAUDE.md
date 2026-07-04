# CLAUDE.md — kickoff brief for this MVP

## Status: v1.0.0 SHIPPED (2026-07-05) — now in open-ended post-1.0 loop
**v1.0.0 GA released.** All 10 ratified GA criteria met (#73): declarative provisioning
(AppDatabase CRD + reconcile operator, ADR-0004), per-app restore executed, tenant quotas,
read-replica-pool GA, storage-plane upgrade executed, KC5 real-knext-use, independent security
review (a cross-tenant bypass was found + fixed pre-tag, #112/#115), scale ceiling demonstrated
(30 apps, linear), observability parity, configurable object storage (ADR-0005: OCI/S3/on-prem,
MinIO optional). The improvement loop is GRADUATED + now OPEN-ENDED (owner: "continue looping
until I stop"): trigger-gated reviews + owner-directed post-1.0 work.

## Product vision: UNIFIED knext platform (app layer + database layer)
**scale-zero-pg and knext are ONE platform, two layers.** knext scales the *applications*
(Next.js on Knative, HTTP activator); scale-zero-pg scales their *databases* (TCP wake-on-connect
gateway — deliberately non-Knative, because Knative's activator is HTTP-only). Same cluster,
both scale-to-zero, joined by a single `DATABASE_URL` Secret (`NextApp.spec.secrets.envMap`).
The unified pitch: an app and its database sleep at zero and wake together on one visitor request.
Unified-platform docs live in the knext doc site (getknext-dev/knext `docs/`), positioning
scale-zero-pg as the knext platform's database layer.

## Original goal (met)
Ship a **Knative-ecosystem scale-to-zero PostgreSQL**: databases easy to host, maintain, reliable.
Idle DB → zero compute; a client connection wakes it sub-second(ish). Reuse Neon OSS below the
wire; build only the glue. Multi-tenancy shipped as **branch-per-app** (DB-per-app, tens/low-
hundreds of apps on one shared plane; each app a Neon branch + its own 0↔1 compute, now
provisioned by the **AppDatabase CRD operator**, `provision-app.sh` retained as break-glass).
Read-scaling axis shipped (`compute-ro` / `DATABASE_URL_RO`). **SCS multi-SYSTEM / full
data-sovereignty-zone multi-tenancy remains parked / out of scope.**

## Consumer
The **knext** platform (`~/alpheya/pocs/knext`) — a scale-to-zero Next.js framework on
Knative (Go operator, `NextApp` CRD). knext binds databases only via a `DATABASE_URL` Secret
(`NextApp.spec.secrets.envMap`) and deliberately builds no DB machinery itself. KS-PG ships as
cluster infrastructure **alongside** knext; integration = one Secret pointing at our gateway.
Research notes: `docs/knext-research.md`.

## Architecture (fixed)
Native Postgres compute on Neon's OSS storage stack, all **on Kubernetes** (no docker-compose):
- **Storage plane (reused, StatefulSets):** safekeeper (durable WAL, single-writer authority),
  pageserver (pages + S3/MinIO offload), storage broker, MinIO. Never scaled to zero.
- **Compute plane:** one stateless Neon compute (`neondatabase/compute-node-v17`) as a Deployment,
  `replicas: 0` at rest, scaled 0↔1. Cold start = attach + lazy page fetch; no restore.
- **Routing plane (we build, Go):** `gateway/` — wake-on-connect Postgres proxy. Parses the
  startup packet, declines SSL, scales the compute Deployment via the API server (client-go),
  replays startup, pipes bytes, and scales back to 0 after `GW_IDLE_MS` with no connections.

## Hard rules
1. **Go for everything Kubernetes-native. No JS/TS unless necessary.**
2. **TDD commits**: test/verification commit first (red), implementation commit second (green).
2b. **User docs ship WITH the change.** Any change that alters user-visible behavior,
   config, drills, or measured numbers updates docs/ (getting-started, connecting,
   operations) in the same commit or the same PR-sized batch. Doc drift found in
   review counts as a defect.
3. Single-writer is intrinsic to Neon — no lease/fencing layer. Compute uses `Recreate` strategy.
4. Storage plane never on Knative, never scale-to-zero. Compute scaling is TCP-triggered
   (gateway/KEDA), not Knative Serving — the activator is HTTP-only.
5. Don't rebuild what Neon gives free: WAL durability, replication, branching, PITR.
6. Everything runs on the cluster (`orbstack` context locally). No compose files.

## Repo map
- `gateway/`  — Go wake-on-connect proxy (client-go). Tests in package; `go test ./...`.
- `deploy/`   — all k8s manifests: 00 namespace, 10 gateway, 20 compute (replicas:0),
                30 knext Secret, 40 KEDA (optional), 5X storage plane + init Job.
                `_validate.sh` (manifest contracts), `_verify-storage.sh` (survival test).
- `docs/`     — knext research, recipes.

## The improvement loop (GitHub-native, owner-defined)
Repo: github.com/getknext-dev/scale-zero-pg (auto-merge + delete-branch enabled).

**Cadence: GRADUATED (2026-07-03, unanimous iteration-7 trio ruling, issue #36).**
Per-iteration review rounds have ended. A fresh blind trio re-convenes only on
TRIGGERS: (a) a release tag, (b) an ADR change or a knext-side change to the
DATABASE_URL contract, (c) any kill-criterion tripwire firing (mapping:
docs/operations.md "Kill-criteria tripwires"), (d) `_rehearse-upgrade.sh`
exit ≠ 0, (e) the dated KC5 review (issue #65, due 2026-10-03). Steps 1–6 below
still govern any implementation work; only the review cadence changed.
1. **Plan** = GitHub issues (one per work item, acceptance criteria in the body).
2. **Implement** on a branch per issue, TDD commits, PR references the issue
   ("Closes #N"). User docs + BENCHMARKS.md ship in the same PR (rule 2b).
3. **Test**: full drill battery on the OKE cluster (context context-ckmva7v7zvq,
   ns scale-zero-pg) before requesting review.
4. **Review** = the blind reviewer trio (system designer, DevOps/SRE, architect)
   reviews THE PR — findings as PR review comments, scorecard (maturity / ease of
   maintenance / production reliability, 1-10 each) in the review body; verdicts
   approve or request changes.
5. **Merge**: auto-merge once reviews pass; issues close; new findings become the
   next iteration's issues. Scorecard history: docs/SCORECARD.md.
6. **Cleanup (mandatory, after every successful workflow)**: the finished agent is
   shut down, its git worktree removed (`git worktree remove` + `prune`), and its
   cmux/tmux pane closed — verified, not assumed (wedged panes get killed after
   identification via `tmux capture-pane`). Safe because the repo is the memory:
   all agent output lives in merged PRs/issues/docs before cleanup starts.

## Definition of done (MVP)
On a local k8s cluster, with a one-table test DB:
1. Compute at 0 → `psql` through the gateway → compute wakes → rows return. Wake time recorded.
2. Idle window passes → compute back to 0 (verified, no phantom keepalives).
3. Reconnect wakes it again; data intact (storage plane owns durability).
4. knext integration documented: Secret + pool-idle-below-GW_IDLE_MS sizing note.

**Shipped beyond the single-DB DoD (v0.6.0, see `docs/adr-0003-multi-tenancy.md`):**
5. **Multi-tenant axis** — branch-per-app: N apps as Neon branches on one shared plane, each with
   its own 0↔1 `compute-<app>`, provisioned by `deploy/provision-app.sh`, routed by the
   apps-gateway (`template` wake mode). Scope bound + deferred CRD operator per the Goal above.
6. **Read-scaling axis** — read-replica pool `compute-ro` (0↔N) via `DATABASE_URL_RO`, optional
   warm tier and HPA.
