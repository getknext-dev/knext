# ADR-0002 (scale-zero-pg): Peer-scrape auth (F6), the operator→gateway config channel, and the per-app idle knobs

- Status: Accepted
- Date: 2026-09-19
- Scope: `packages/scale-zero-pg/` (the wake-on-connect gateway). Module-local ADR. Does **not**
  amend any main-repo ADR — the operator-single-writer invariant (main-repo ADR-0001) is **upheld,
  not amended** (see "Operator→gateway config channel" below).
- Amends: **ADR-0001 (scale-zero-pg)** — the **F6 clause is now CLOSED** (peer-scrape auth is
  implemented, fail-closed). **F5 remains DEFERRED** with its original expiry intact (scale-zero-pg
  GA / first external-tenant use, whichever comes first).

## Context

This is one design round covering three decisions that ship close together. Only **F6** is
implemented in this change; `idleDelay` and `alwaysWarm` are recorded here as accepted design and
implemented next, because they share the same operator→gateway config channel and it is cheaper to
settle that channel once.

ADR-0001 accepted two security gaps as a dated exception. **F6** — the peer idle-scrape
(`GET /metrics.json`, read by every gateway pod to sum the fleet's per-app active-connection counts)
was unauthenticated, so an in-namespace pod answering on a peer IP could bias the fleet sleep/wake
decision (report high → pin awake, cost leak; report 0 → premature sleep). ADR-0001 classed this an
**integrity gap on a decision input**, not an open mutating endpoint, and deferred it. It is cheap to
close now and closing it removes the F6 half of the dated exception, so we do.

Closing F6 surfaced a **latent correctness bug** in the scrape reader independent of auth: `scrape`
decoded the response body **regardless of HTTP status**. Once the server can answer `401`, a 401 body
(or any non-200) would have decoded to `Active=0` and **wrongly scaled an active database to zero**.
The fix (checking status before decoding, treating any non-200 as peer-unknown → postpone sleep) is
the load-bearing part of this change and is guarded by a mutation-proved test.

## Decision (F6): shared fleet bearer token, fail-closed by construction

Authenticate `GET /metrics.json` with a **shared fleet bearer token** (env `GW_PEER_TOKEN`, from the
`pggw-peer-token` k8s Secret mounted into every gateway pod). The server requires
`Authorization: Bearer <token>` (constant-time compare, `crypto/hmac.Equal`) and returns **401**
otherwise. Only `/metrics.json` is gated; `/metrics` (Prometheus text) and `/healthz` stay open.

**Fail-closed by construction.** Startup refuses to serve an open scrape: if `GW_PEER_TOKEN` is empty
**and** `GW_PEER_AUTH_DISABLED != "true"`, the gateway aborts at boot (fatal). `GW_PEER_AUTH_DISABLED=true`
is the explicit dev-only opt-out and logs a loud `WARN`. There is no silent-open path — a missing
token is an error, never a default-open.

**Reader hardening (C1, load-bearing).** The scrape checks `resp.StatusCode` **before** decoding.
Any non-200 returns a real error, so the idle caller's `err != nil` branch **postpones** the sleep
(keeps the compute awake). A `401` (e.g. a token mismatch mid-rotation) is logged as a peer auth
mismatch and returned as an error — "peer unknown" biases toward keeping a possibly-used compute up,
never toward a wrong scale-to-zero.

### Options considered (F6 auth mechanism)

| Option | Pro | Con | Verdict |
|--------|-----|-----|---------|
| **A. Shared fleet bearer token, fail-closed (this ADR)** | Cheap; homogeneous fleet needs one Secret; constant-time compare; boot refuses to serve open; rotation is a Secret swap + rollout | Shared secret (not per-pod identity); a rotation window yields brief 401s (handled by C1: postpone, never wrong-sleep) | **Recommended — shipped default** |
| B. Per-pod mTLS on the scrape | Strong per-identity authn matching `security.md`'s mTLS intent | Cert distribution + rotation machinery; this is **F5 territory** (gateway↔compute mTLS) and carries the same pre-GA cost F5 was deferred for | Deferred — belongs with F5 at the ADR-0001 expiry |
| C. Leave open (status quo) | Zero effort | The gap ADR-0001 dated; keeps a foothold-gated integrity hole on the idle decision | Rejected |

Fail-closed is the **shipped default**: `deploy/gen-peer-token.sh` mints the token idempotently and
both `deploy/10-gateway.yaml` and `deploy/81-apps-gateway.yaml` mount it, so a stock apply is
authenticated, and a gateway with no token refuses to boot rather than serve open.

## Operator→gateway config channel (upholds main-repo ADR-0001)

The forthcoming per-app knobs (`idleDelay`, `alwaysWarm`) need a channel from the operator (the
single writer of cluster state) to the gateway (a read-only consumer of that state). The decision:
**the operator writes an annotation on the compute Deployment it already owns; the gateway reads that
annotation and never writes it.** This keeps main-repo ADR-0001 intact — the gateway mutates **no**
cluster resource for config; it only reads. The gateway's existing cluster writes remain limited to
the scale subresource (waking/sleeping) and warmpool pod deletes, unchanged by this round.

| Option | Pro | Con | Verdict |
|--------|-----|-----|---------|
| **A. Operator annotates the compute Deployment; gateway reads (this ADR)** | Operator stays single writer; gateway read-only; per-app, co-located with the resource it scales; no new CRD read path | Gateway must watch/get Deployments (RBAC it already has for scale) | **Recommended** |
| B. Gateway reads the AppDatabase CR directly | No annotation indirection | Gives the gateway a second source of truth + CR read RBAC; drifts toward two readers of the spec | Rejected |
| C. Per-app config via env | Simple | Not per-app at runtime (env is per-pod, fleet-homogeneous); needs a redeploy to change one app | Rejected |

## idleDelay (design, implemented next)

A **per-app** idle window override. `spec.idleDelay` (a duration) on the AppDatabase; the operator
writes it as the compute-Deployment annotation above; the gateway reads it per target key and uses it
in place of the fleet-default `GW_IDLE_MS` for that app. **nil or `0s` ⇒ the fleet default** (current
behaviour, no per-app override). This is additive: apps without the field behave exactly as today.

## alwaysWarm (design, implemented next)

An **additive alias** over the **existing** `tier: warm` warmhold (`internal/appdb/warmhold.go`),
not a new mechanism. `spec.alwaysWarm: true` resolves to the same warmhold that pins a compute ACTIVE
so its idle scale-to-zero never arms — it is sugar for the existing tier, chosen because "always
warm" reads more clearly than a tier enum for the common case. It does **not** interact with F6: the
peer-scrape auth gates the idle *decision input*; `alwaysWarm` removes an app from the idle decision
entirely. Recorded separately so the alias does not dilute the F6 security decision.

## Consequences

- **ADR-0001 F6 is closed.** Any "unauthenticated peer scrape" caveat tied to F6 is now stale; drop
  it. The scrape is bearer-authenticated and the boot is fail-closed.
- **ADR-0001 F5 is unchanged** — gateway→compute plaintext transport stays deferred to the original
  expiry. This ADR does not touch it, and per-pod mTLS (option B above) is explicitly filed with F5.
- **Rotation is safe.** A token mismatch during a rollout yields 401 → peer-unknown → postpone sleep;
  it can only *delay* a scale-to-zero, never wrong-sleep an active DB (C1 guarantees this).
- **No main-repo ADR change.** The operator remains the single writer; the gateway reads config from
  an operator-owned annotation and writes nothing new.
- The `pggw-peer-token` Secret is a new required input for a stock deploy; `gen-peer-token.sh` mints
  it idempotently and `_validate.sh` asserts both gateways source it.

## Action items

- [x] F6: server bearer auth on `/metrics.json` (401 on mismatch/absent, constant-time compare).
- [x] F6: fail-closed boot (`ResolvePeerAuth`); `GW_PEER_AUTH_DISABLED=true` dev opt-out + WARN.
- [x] C1: reader checks status before decoding; non-200 → error → postpone sleep (mutation-proved).
- [x] `pggw-peer-token` Secret + `gen-peer-token.sh` + mounts in `10-gateway.yaml` and
      `81-apps-gateway.yaml`; `_validate.sh` contract; rotation documented in `docs/operations.md`.
- [ ] Implement `idleDelay` over the operator→annotation channel (next task).
- [ ] Implement `alwaysWarm` as an alias over the existing `tier: warm` warmhold (next task).
- [ ] At the ADR-0001 expiry: close F5 (gateway→compute mTLS) or re-justify; revisit per-pod mTLS on
      the scrape (option B) then.
