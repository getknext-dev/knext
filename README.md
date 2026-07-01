# scale-zero-pg

MVP starter for a **scale-to-zero PostgreSQL platform** for Self-Contained Systems (SCS): one
database per system, zero compute when idle, sub-second wake on connect. Native Postgres compute
on a **self-hosted Neon storage stack** (Apache-2.0), orchestrated by **Knative/KEDA**.

> New here? Read `CLAUDE.md` (goal, invariants, phased plan) — it's also the kickoff brief for
> driving the rest of the build with Claude Code.

## Why this shape
Reuse over reinvention: Neon's storage layer already provides durable WAL (safekeepers),
page storage + object-storage offload (pageserver), replication, branching, and PITR — so we build
only the thin glue that makes it scale-to-zero and self-hostable:
- **gateway** — wake-on-connect Postgres proxy (route by `system_id`, wake compute, pipe bytes)
- **provisioner** — `system_id` -> Neon tenant/timeline + registry
- **compute scaling** — KEDA scales each system's primary 0<->1 (Postgres is TCP, hence KEDA not Knative Serving)

## Layout
```
gateway/       Node service — TCP wake-on-connect proxy (stdlib only). Tests: _smoke.js, _e2e.js
provisioner/   Node service — SCS provisioning API (stdlib only). Test: _smoke.js
deploy/        Kubernetes manifests (Neon CRDs, gateway+RBAC, provisioner, compute+KEDA template)
local/         docker-compose Neon storage plane for local dev
CLAUDE.md      goal + invariants + phased tasks (Claude Code kickoff)
TASKS.md       dependency-ordered checklist
```

## Quickstart (no cluster needed)
```
make check      # syntax-check all sources
make smoke      # run offline tests: proto parser + provisioner API
node gateway/src/_e2e.js   # full path: ssl decline -> parse -> wake -> replay -> pipe
```
Local storage plane + running the services against it: see `local/README.md`.
Deploying to a cluster (prereqs + apply order): see `deploy/README.md`.

## Status
Working today: gateway core (startup parse, SSL decline, static/template wake, byte-pipe) and the
provisioner API in mock mode, with green smoke + e2e tests. Stubbed next (see TASKS.md): real
storage-controller calls, on-cluster wake wiring, per-system compute template rendering.

## "Works at scale" — definition of done
The MVP earns the phrase only when four risks are retired with load-test evidence: (1) concurrent
cold starts stay sub-second, (2) measured tenant density per storage set, (3) gateway is
horizontally scalable / not a SPOF, (4) idle detection is real (systems truly reach zero).
See `CLAUDE.md`.

## License note
Neon's storage + compute are Apache-2.0; Databricks (acquirer) has committed to keeping it open.
Re-confirm the license on the exact components/versions you deploy.
