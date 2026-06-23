# ADR-0015: The bounded-aggregator exception to "no unauthenticated mutating endpoint"

- Status: Accepted
- Date: 2026-06-23
- Deciders: knext architect, system designer
- Related: ADR-0001 (operator = single source of truth), `.claude/rules/security.md`,
  `docs/security/mutating-endpoints.md`, issue #94 (RUM), issue #90 (NetworkPolicy)

## Context

knext's hard security rule is **no unauthenticated mutating endpoints** — every state-changing
route requires a signed token and/or an internal-only `NetworkPolicy`. The RUM feature (#94) added
`POST /api/rum`: a browser beacon that reports Web Vitals. It **mutates** state (it `observe()`s
Prometheus histograms), yet by nature it is sent by anonymous browsers and **cannot** carry the
`CACHE_INVALIDATE_TOKEN` Bearer secret (that would leak the secret to every client). This is a
genuine, recurring category — analytics/telemetry beacons — and we needed a recorded rule for when
such an endpoint is acceptable, rather than re-arguing it each time.

## Decision

A browser-facing mutating endpoint is acceptable **without a Bearer token** only when it is a
**bounded aggregator** — it must satisfy *all four* neutering conditions, and the audit
(`docs/security/mutating-endpoints.md`) must record it as an explicit, justified exception:

1. **Not a write primitive.** The handler can ONLY `observe()`/increment a fixed set of
   pre-declared metrics. It cannot create series, set arbitrary values, write storage, revalidate
   cache, or perform any general state mutation.
2. **Server-enforced bounded label cardinality.** Every label comes from a closed, server-side
   allow-list; any client-supplied free text (e.g. a URL path) is mapped to a fixed **template** or
   an `other` bucket. No user/session/IP/raw-URL label. This caps the series count at a small
   constant and prevents a cardinality-DoS.
3. **Rate-limited + size-capped + shape-validated.** An in-process rate limiter, a hard request-body
   cap, and strict schema validation; malformed/oversized/over-rate requests are rejected.
4. **Network-isolated, same-origin.** Reachable only as broadly as the app already is (the
   operator's default-on `NetworkPolicy`, #90) — it adds no new external surface.

`POST /api/rum` satisfies all four and is the reference implementation.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| **Bounded-aggregator exception, 4 conditions, audited (chosen)** | Accepted | Lets unauthenticatable telemetry exist while bounding blast radius to "skew percentiles within fixed buckets"; honest and recorded |
| Require a Bearer token on the beacon | Rejected | Impossible — leaks the secret to every browser |
| A separate authenticated server-side collector | Rejected | Heavier; the beacon still needs an unauthenticated public ingress somewhere |

## Consequences

- The exception is **narrow and testable**: the four conditions are an explicit checklist a reviewer
  applies to any future browser-facing mutating endpoint before it ships.
- It is **not** a general loophole — anything that can create series, write storage, or carry
  unbounded labels is NOT covered and still requires auth.
- The audit doc remains the source of truth; a CI guard (every mutating route under `apps/*/src/app/api`
  must carry `isAuthorized` or be a listed exception) keeps it honest.

## Action items

- [x] `/api/rum` implemented as a bounded aggregator (validate / rate-limit / closed allow-lists).
- [x] Recorded as a justified exception in `docs/security/mutating-endpoints.md`.
- [ ] Wire the CI guard that fails a new unlisted mutating route lacking `isAuthorized`.
