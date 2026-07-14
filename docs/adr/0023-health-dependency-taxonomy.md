# ADR-0023 — Health/readiness dependency taxonomy: hard ⇒ `down`, soft ⇒ `degraded`

- **Status:** Accepted
- **Date:** 2026-07-14
- **Relates to:** ADR-0001 (operator = single source of truth), the SCS/Zones
  cache-fails-open contract (`.claude/rules/scs-zones.md`), graceful-shutdown /
  scale-to-zero pod lifecycle.
- **Scope:** `checkDeepHealth()` in `packages/lib/src/health/index.ts`, which
  backs the Knative **readiness** probe.

## Context

The deep readiness probe verifies connectivity to a zone's infrastructure
dependencies (Postgres, Redis). Its verdict drives the Knative **readiness**
gate, which under scale-to-zero decides not only whether traffic is routed to a
pod but whether the pod is kept in rotation or **evicted**.

The prior implementation had a **dead-branch bug**: the Postgres catch set the
overall `status = 'degraded'` but never wrote `checks.postgres`, and a final
"if any sub-check is `down` ⇒ overall `down`" re-derivation then unconditionally
overwrote that `degraded` back to `down`. The `degraded` branch was therefore
unreachable, and a **transient Postgres blip drove overall `down` ⇒ readiness
failed ⇒ the pod was evicted**. Separately, a slow-but-alive dependency that
blew the 3s cluster-timeout needed to be handled so the timeout could never
leave a sub-check falsely `up`.

Fixing the dead branch forces an explicit decision that was previously implicit
and inconsistent: **when should a dependency failure fail CLOSED (`down`) vs
fail OPEN (`degraded`)?** Naively "softening" everything to `degraded` is the
inverse bug — it keeps a dead pod (one whose datastore is unreachable) in
rotation.

## Decision

Classify each dependency by **severity** and derive the overall status from that
taxonomy, not from a flat "any sub-check down ⇒ down":

- **Hard dependency — Postgres.** The pod cannot serve correct responses
  without it. Configured + unreachable ⇒ overall **`down`**. Readiness **fails
  CLOSED**: never route traffic to, nor keep in rotation, a pod that can't
  serve. A slow-PG timeout is treated the same (`down`), and the timed-out
  sub-check stays at its initialized `down` (never a false `up`).
- **Soft dependency — Redis-as-cache.** The cache layer **fails OPEN** per the
  SCS/Zones contract: a cache miss still serves from the origin. Configured +
  unreachable ⇒ overall **`degraded`** but still **Ready**. A Redis blip must
  NOT evict a pod that can still serve cache-miss traffic.
- **Precedence.** A hard-dep failure dominates: if Postgres is `down` (or the
  probe timed out), overall is `down` regardless of Redis.

Readiness truth-table (overall status by dependency state):

| postgres      | redis (cache)   | overall    | rationale                          |
|---------------|-----------------|------------|------------------------------------|
| up / unconfig | up / unconfig   | `ok`       | all good                           |
| up / unconfig | down            | `degraded` | soft dep fails OPEN → still Ready  |
| down          | up / down / uncfg | `down`   | hard dep fails CLOSED              |
| timeout       | *               | `down`     | slow hard dep; no false `up`       |

`degraded` is reserved exclusively for soft/optional-dependency failures. It is
a Ready state — Knative keeps the pod in rotation; it exists to surface reduced
capacity to observability, not to gate traffic.

## Consequences

- **Live behaviour change (pod lifecycle under partial failure).** A Postgres
  blip still evicts the pod (correct — it can't serve), but a **Redis/cache
  blip no longer evicts the pod** — it stays Ready and serves cache-miss
  traffic. This is a deliberate change to readiness semantics under partial
  failure and should be called out in the change's PR body.
- If Redis is later used for something a zone genuinely **cannot serve without**
  (e.g. session store on the hot path, not just cache), that usage would be a
  **hard** dependency and must get its own `down`-mapped check — do not reuse
  the cache soft-check for it.
- The taxonomy is centralized in `checkDeepHealth`'s derivation; adding a new
  dependency means classifying it hard/soft and slotting it into the same
  precedence rule.
- `process.env` is read at call time, but the pool/redis singletons cache their
  DSN at first construction — re-pointing env does not re-point an existing
  pool (documented in the source and asserted-around in tests).
