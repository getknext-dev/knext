// Postgres pool for the scale-to-zero demo.
//
// This intentionally mirrors @knext/lib's getDbPool()
// (packages/lib/src/clients.ts in the knext monorepo) so the demo behaves like
// a real knext app without vendoring the whole pnpm workspace into the image:
//
//   - a singleton pg.Pool built from process.env.DATABASE_URL
//   - max = DB_POOL_MAX (default 5)
//   - idleTimeoutMillis = DB_POOL_IDLE_TIMEOUT_MS (default 10_000 ms)
//
// The idle timeout (10s) is deliberately BELOW the gateway's GW_IDLE_MS (60s):
// pooled connections are dropped after 10s idle, so they never look like live
// traffic and never block the database from scaling back to zero. This is the
// #1 sizing rule from docs/connecting.md.
const { Pool } = require("pg");

const DEFAULT_DB_POOL_MAX = 5;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 10_000;

function toFinitePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let pool;

function getDbPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: toFinitePositiveInt(process.env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX),
      idleTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_IDLE_TIMEOUT_MS,
        DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      ),
      // Generous connect timeout so a cold DB wake (gateway holds the socket
      // ~2.5s while the compute pod starts) never races the client.
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

module.exports = { getDbPool };
