# ADR-0009 — In-database durable execution (`microsoft/pg_durable`): on-strategy, but blocked by scale-to-zero until a wake-on-scheduled-step primitive exists

- **Status: PROPOSED — research note; owner decision pending.** This ADR does **not**
  adopt anything. It records the analysis of whether `microsoft/pg_durable` (in-Postgres
  durable execution / workflow state machines) fits the scale-zero-pg platform, so a future
  agent or the owner can decide without re-deriving it. Recommendation (see §Decision):
  **do not adopt now**; revisit only if/when a **wake-on-scheduled-step** primitive ships
  (the same primitive family as repl-wake #139/#140 and the parked #35 pg_cron question).
- **Date:** 2026-07-14
- **Deciders:** architecture owner (to accept/reject); analysis by the scale-zero-pg lead lane.
- **Source:** owner research prompt 2026-07-13 — "how does this plugin help:
  https://github.com/microsoft/pg_durable". Captured here from a HANDOFF bullet so the
  reasoning survives the session.

## Context

`pg_durable` is a PostgreSQL extension that provides **durable execution** inside the
database: long-running, multi-step workflows whose state (which step ran, its result,
what's next) is persisted transactionally in Postgres tables rather than in an external
orchestrator. It is philosophically "compute close to the data" — the workflow engine
lives next to the state it mutates, so a crash resumes from the last committed step with
no lost work and no separate durable store.

Why it is **on-strategy** for this platform, on the surface:
- Our whole thesis is that Neon's disaggregated storage makes Postgres state durable **for
  free** — WAL to the safekeeper quorum, pages offloaded to object storage. A durable-
  execution engine that leans on Postgres durability inherits that for free too: no extra
  durable store to run, no second consistency model.
- It would let a knext app express a saga / retry / scheduled pipeline in its own database
  over its own `DATABASE_URL`, with the same tenant isolation (timeline-scoped, per-app
  credential) that already bounds every other in-DB extension (TimescaleDB, pgvector — see
  ADR-0001, v1.4.0 platform extensions).

## The blocking conflict (why it does not fit *today*)

Durable execution engines advance work with a **background worker** — a resident process
(or `pg_cron`-style scheduler) that polls for due steps and drives the state machine
forward **without a client connection present**. That is the exact property scale-to-zero
removes:

- Our compute is a **Deployment at `replicas: 0` at rest**, woken **0→1 by a client TCP
  connection** at the gateway (the wake primitive; see docs/ARCHITECTURE.md and ADR-0008).
  Nothing wakes it on a *timer* or on *internal work becoming due*.
- A background worker that must run "every N seconds to advance pending workflows" therefore
  either (a) never runs, because the compute is asleep and no client is connecting, so
  durable workflows silently stall; or (b) forces the compute to **stay awake** to keep the
  worker alive — which **defeats scale-to-zero**, the entire product.

This is **the same class of conflict** already decided against elsewhere on the platform:
- TimescaleDB **continuous aggregates** and **compression** are disabled per app (ADR-0001)
  for exactly this reason — they rely on background jobs.
- `pg_cron` (issue #35) is parked on the same conflict: a scheduler with no one awake to run.

So `pg_durable` is not a special case; it is another instance of "**background execution is
incompatible with connection-triggered wake**." Adopting it naively would reintroduce the
always-warm cost the platform exists to eliminate.

## Decision (proposed — NOT ratified)

**Do not adopt `pg_durable` (or any background-worker durable-execution engine) now.**
Record it as a **candidate that unblocks only behind a new primitive**: a
**wake-on-scheduled-step** capability that lets an *internal, time-or-event-driven* need
wake a sleeping compute the way a client connection does today, then let it sleep again once
the due work drains.

That primitive is **not** hypothetical hand-waving — it is the generalization of work the
platform is already doing:
- **repl-wake (#139/#140, ADR-0007 §4c):** the gateway already wakes a sleeping *publisher*
  compute when a *subscriber's* walreceiver connects, holds it awake while streaming, and
  lets it sleep after. That is "wake on an internal replication need," a sibling of "wake on
  a due workflow step."
- **#35 (pg_cron):** the parked scheduled-work question is the same primitive from the
  cron angle.

If/when a `wake-on-scheduled-step` primitive exists (e.g. an external, cheap "due-work
poker" that opens a wake connection when the next step's timestamp arrives, keeping the
*poller* resident but the *compute* scale-to-zero), `pg_durable` becomes reconsiderable —
and should get its own implementation ADR then, with a drill proving the compute still
returns to zero between due steps.

## Consequences & follow-ups

- **No code change.** This ADR is analysis only. Nothing ships.
- Keeps the platform's "no always-warm background jobs" invariant intact and **documented**,
  so the next agent does not re-litigate `pg_durable` (or the next durable-execution
  extension) from scratch.
- **Follow-up (owner-gated):** if durable execution is deemed strategically important, the
  real work item is the **wake-on-scheduled-step primitive** (a v2-class feature in the
  repl-wake / #35 family), not the extension itself. That primitive would also unblock
  pg_cron and continuous aggregates — so it is a high-leverage bet, not a one-extension one.
- **Non-goal:** running `pg_durable`'s worker in a *separate always-on* sidecar Deployment.
  That is just an external orchestrator wearing a Postgres-extension costume — it abandons
  the "durable for free via Neon" benefit (the sidecar is now the thing you must keep alive
  and make durable) and reintroduces always-warm cost. If an external orchestrator is
  acceptable, use a purpose-built one; do not smuggle it in as an in-DB extension.

## Relationship to existing ADRs

- **ADR-0001** (Timescale/sharding) — same background-job exclusion; this ADR extends that
  principle to durable-execution engines.
- **ADR-0007** (zoned consistency) — repl-wake (§4c) is the closest existing primitive to
  the wake-on-scheduled-step this ADR says is the real prerequisite.
- **ADR-0008** (wake-primitive security) — any new wake trigger (a scheduled-step poker)
  must respect the same wake-budget / observability posture ratified there.
