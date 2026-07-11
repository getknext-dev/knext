-- Base schema seeded into the branch-per-app TEMPLATE timeline (ADR-0003, #6).
-- Every app branched from the template inherits this instantly (copy-on-write),
-- then diverges. Keep it minimal: a migrations ledger + one sample table so the
-- isolation drill (_verify-multitenant.sh) has shared schema to write into.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    bigint PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS app_items (
    id   serial PRIMARY KEY,
    note text NOT NULL
);
-- Idempotent seed: re-running init-plane against an existing template must not
-- accumulate duplicate seed rows.
INSERT INTO app_items (note)
SELECT 'seeded-in-template'
WHERE NOT EXISTS (SELECT 1 FROM app_items WHERE note = 'seeded-in-template');

-- Per-app role access (issue #74). Each app authenticates as its own role
-- app_<app> (created by compute_ctl every boot from the app's Secret). Data
-- isolation is at the Neon TIMELINE level — each app is a separate branch and
-- only ever sees its own branch's rows — so intra-DB privileges can be open: a
-- credential is authentication, not the isolation boundary. Grant the public
-- schema to PUBLIC (inherited by every future app role) so a per-app login can
-- use its database. cloud_admin remains the superuser/owner for admin/DDL.
GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC;

-- Self-service TRUSTED extensions (issues #177 timescaledb / #178 pgvector,
-- ADR-0001 "Accepted"). timescaledb (2.17.1) and vector (0.8.0) both ship in
-- neondatabase/compute-node-v17 with `trusted = true` in their control file. A
-- trusted extension can be installed by any role that holds CREATE on the current
-- DATABASE (not just the schema) — Postgres does NOT require superuser. So we grant
-- CREATE on the app's OWN database to PUBLIC, which lets a per-app login run
-- `CREATE EXTENSION timescaledb;` / `CREATE EXTENSION vector;` itself through its
-- DATABASE_URL — opt-in, no operator action, no per-app code. Safe because isolation
-- is at the Neon TIMELINE level: each app is its own branch + its own Postgres +
-- loopback-only cloud_admin, so PUBLIC here == only this app's own role(s), and a
-- DB-level CREATE grant only lets an app create schemas/extensions in ITS OWN
-- branch — never cross-tenant (same rationale as the schema grants above:
-- intra-DB privileges are open; the credential is auth, not the isolation boundary).
-- Operators who prefer central control can instead enable extensions as cloud_admin
-- at provision time (docs/connecting.md "Enabling extensions"); this grant only
-- makes the app-self-service path possible, it does not install anything.
GRANT CREATE ON DATABASE postgres TO PUBLIC;
