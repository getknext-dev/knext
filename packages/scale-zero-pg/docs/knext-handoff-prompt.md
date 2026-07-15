# Handoff prompt for the knext agent (copy-paste)

You (knext agent) are being looped into a sibling initiative: **scale-zero-pg** —
a scale-to-zero PostgreSQL platform built specifically to pair with knext, now
production-drilled and running **on your own cluster** (`knext2`, OKE
me-abudhabi-1, kube context `context-ckmva7v7zvq`, namespace `scale-zero-pg`).
Repo: https://github.com/getknext-dev/scale-zero-pg (private, getknext-dev org).

## What it is (30 seconds)

One Postgres database per app that consumes **zero compute while idle** and
wakes on the first client connection. Native Postgres 17 on Neon's OSS storage
plane; the only custom piece is a Go wake-on-connect gateway. It was built as
the exact "Option C wake-on-connection proxy" your own draft ADR
(`knext-plan-out/database-engine/`) evaluated and declined to build in-core —
it exists now, alongside you, as cluster infrastructure.

## The contract (this is ALL knext needs)

Apps consume it via a `DATABASE_URL` Secret — nothing else changes:

```yaml
# NextApp CR
spec:
  secrets:
    envMap:
      - env: DATABASE_URL
        secret: myapp-database
        key: DATABASE_URL
```

DSN (copy the Secret from `scale-zero-pg` ns or mint per-app):
```
postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/postgres?sslmode=disable
```
(`sslmode=require` also works — TLS 1.3 at the gateway; dev creds, rotation documented.)

What the app experiences, all drill-measured on this cluster:
- **Idle → first connection: ~2.5s** (gateway holds the connection, wakes the DB,
  replays — no error, no retry needed). Warm connections: ~120ms.
- Opt-in **warm tier: ~0.4s** wakes for latency-sensitive apps (costs a parked
  256Mi pod; `deploy/25-compute-warm.yaml`).
- The gateway absorbs Postgres's "starting up" state and connection caps return
  a clean SQLSTATE 53300. Set client connect timeout ≥ 10s.
- **One sizing rule:** your pool's idle timeout must be **below** the gateway's
  idle window (60s deployed) — `getDbPool`'s defaults are already compatible —
  or the DB never sleeps.

## What we're asking you to do (tracked as scale-zero-pg issue #8)

1. **Install/verify the kn-next operator on `knext2`** — we checked: no
   `NextApp` CRDs exist on this cluster yet.
2. **Deploy a demo NextApp** (file-manager or any Postgres-using app) bound to
   the Secret above.
3. **Validate the interplay**: app and DB both sleeping at zero; a cold visitor
   waking both (measure the combined first-request latency — the DB wake should
   largely hide inside your app's own cold start + bytecode window); knext's
   pool behavior vs the idle window.
4. **Feed findings back** as issues on getknext-dev/scale-zero-pg — anything
   from DSN ergonomics to wake-latency UX. The platform team runs a
   plan→PR→blind-review loop and your findings enter it directly.

## Reading order

- `docs/connecting.md` — the app-facing contract (tiers, pooling rules, TLS)
- `docs/getting-started.md` — how the platform deploys (already done on knext2)
- `docs/BENCHMARKS.md` — every measured number with provenance
- `docs/adr-0002-database-foundation.md` — why Neon two-tier, kill criteria

Constraints for you: don't modify the `scale-zero-pg` namespace or its manifests
(file issues instead); your lane is the knext operator, the demo app namespace,
and the NextApp binding. The `pggw` Service is the only intended entry point.
