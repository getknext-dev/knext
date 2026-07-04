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
