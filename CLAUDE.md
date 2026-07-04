# CLAUDE.md — kickoff brief for this MVP

## Goal (current, updated 2026-07-04)
Ship a **Knative-ecosystem MVP of scale-to-zero PostgreSQL**: one database that is easy to host,
easy to maintain, and reliable enough. Idle DB consumes zero compute; a client connection wakes it
sub-second(ish). Reuse open source (Neon) for everything below the wire; build only the glue.

**Multi-tenancy is UN-PARKED — branch-per-app shipped in v0.6.0 (ADR-0003).** The `template`
wake-mode seam that was anticipated as the return path has returned and is wired. Honest scope
bound: **DB-per-app** for tens/low-hundreds of apps on ONE shared storage plane; each app is a
Neon branch (own timeline) with its own 0↔1 `compute-<app>` Deployment, provisioned
**imperatively** by `deploy/provision-app.sh` and routed by the apps-gateway — a CRD operator is
**deferred/post-MVP**. A **read-scaling axis** also shipped (`compute-ro` / `DATABASE_URL_RO`).
Distinguish clearly: **DB-per-app (branch-per-app) is SHIPPED**; any **SCS multi-SYSTEM /
full data-sovereignty-zone multi-tenancy** ambition remains **parked / out of scope**.

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
