import { GRPC as Cerbos } from '@cerbos/grpc';
import * as Minio from 'minio';
import { Pool } from 'pg';

// Singleton instances
let cerbosClient: Cerbos | null = null;
let minioClient: Minio.Client | null = null;
let pgPool: Pool | null = null;
let pgPoolRO: Pool | null = null;

// ── Pool-instrumentor seam (dependency inversion, #317) ───────────────────────
// This module stays OTel-free (mirroring `./context`'s `setTraceIdProvider`): an
// OTel-aware layer (`@knext/core/adapters/tracing`) installs an instrumentor
// that is invoked ONCE per pool as it is created, with the pool and its role.
// The tracing adapter uses it to wrap the pool's first `connect()` in a
// `knext.db_wake` span so the scale-zero-pg 0→1 DB wake shows up on the request
// trace WITHOUT any app code. Default is a no-op — an app that has not opted
// into tracing pays nothing, and pool creation is unchanged.

/** Which scale-zero-pg endpoint a pool talks to. */
export type PoolRole = 'writer' | 'reader';

/** Instrument a freshly-created pool (e.g. wrap its first connect for tracing). */
export type PoolInstrumentor = (pool: Pool, role: PoolRole) => void;

const NO_POOL_INSTRUMENTOR: PoolInstrumentor = () => {};
let poolInstrumentor: PoolInstrumentor = NO_POOL_INSTRUMENTOR;

/**
 * Install the pool instrumentor. Called once at startup by an OTel-aware app so
 * new pools get a `knext.db_wake` span around their first connect, without this
 * package taking an OTel dependency.
 */
export const setPoolInstrumentor = (fn: PoolInstrumentor): void => {
  poolInstrumentor = fn;
};

/** Reset the pool instrumentor to the default no-op. Mainly for tests. */
export const resetPoolInstrumentor = (): void => {
  poolInstrumentor = NO_POOL_INSTRUMENTOR;
};

/**
 * Run the installed instrumentor over a newly-created pool. Best-effort: a
 * misbehaving instrumentor must never break pool creation (fail-open) — the
 * pool is far more important than its span.
 */
const instrumentPool = (pool: Pool, role: PoolRole): Pool => {
  try {
    poolInstrumentor(pool, role);
  } catch {
    // Instrumentation is observability sugar; never let it sink the DB path.
  }
  return pool;
};

export const getCerbosClient = () => {
  if (!cerbosClient) {
    const target = process.env.CERBOS_URL || 'cerbos.default.svc.cluster.local:3593';
    cerbosClient = new Cerbos(target, { tls: false });
  }
  return cerbosClient;
};

export const getMinioClient = () => {
  if (!minioClient) {
    minioClient = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'minio.default.svc.cluster.local',
      port: Number.parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minio',
      secretKey: process.env.MINIO_SECRET_KEY || 'minio123',
    });
  }
  return minioClient;
};

// Scale-to-zero-sane pool defaults. Under Knative each pod owns its own pool,
// and a zone can scale to `maxScale` pods — so the cluster opens up to
// `maxScale × DB_POOL_MAX` backend connections. We therefore keep each pod's
// pool SMALL (many small pools, not a few large ones) and let a transaction-mode
// pooler in front (PGS-2) bound the real Postgres connections. `max: 5` keeps
// `maxScale(10) × 5 = 50` well under a typical `max_connections` of 100–200.
// A finite idle timeout lets idle connections drop quickly so a freshly-scaled
// pod doesn't hold backend slots it isn't using. Both are env-overridable per
// zone (DB_POOL_MAX / DB_POOL_IDLE_TIMEOUT_MS) — see the Postgres-under-
// scale-to-zero guide.
const DEFAULT_DB_POOL_MAX = 5;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 10_000;
// pg's default connect timeout is 0 = wait indefinitely: that survives a cold
// scale-to-zero DB wake, but it also hangs every request forever when the DB
// is truly unreachable. A bounded 15s fails fast with a clear pool error while
// leaving ~6x margin over the ~2.5s scale-zero-pg cold wake (the
// postgres-binding guide's contract: connect timeout >= 10s). Env-overridable
// per zone (DB_POOL_CONNECT_TIMEOUT_MS).
const DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS = 15_000;

const toFinitePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getDbPool = () => {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: toFinitePositiveInt(process.env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX),
      idleTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_IDLE_TIMEOUT_MS,
        DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      ),
      connectionTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_CONNECT_TIMEOUT_MS,
        DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS,
      ),
    });
    // Wrap the fresh pool for db-wake tracing (no-op unless an app opted in).
    instrumentPool(pgPool, 'writer');
  }
  return pgPool;
};

/**
 * Drain and close the singleton Postgres pool, letting in-flight transactions
 * commit-or-rollback before the connections close. Safe to call when no pool was
 * ever created (no-op). Intended to be wired into the runtime's SIGTERM drain
 * (see `registerShutdownDrain` in @knext/kn-next) so scale-down doesn't sever
 * transactions. Resets the singleton so a later `getDbPool()` reconnects.
 */
export const closeDbPool = async (): Promise<void> => {
  if (!pgPool) {
    return;
  }
  const pool = pgPool;
  pgPool = null;
  await pool.end();
};

/**
 * Read-only pool over `DATABASE_URL_RO` — the scale-zero-pg RO gateway
 * (port 55434), a **bounded-staleness** endpoint (~9s ceiling, NO
 * read-your-writes). Reads are a deliberate, explicit opt-in: nothing is
 * auto-routed (scale-zero-pg `docs/connecting.md`), so the writer pool
 * (`getDbPool`) and this reader stay two distinct singletons and the caller
 * picks which one a query uses.
 *
 * Returns `null` when `DATABASE_URL_RO` is unset — an app without a read
 * replica simply has no RO pool (callers such as `@knext/db`'s `getDbRO()`
 * fall back to the writer). Otherwise mirrors the writer pool's scale-to-zero
 * contract (ADR-0019): small `max` (many small pools under `maxScale`), idle
 * timeout < the gateway's 60s idle (no dead sockets), connect timeout >= 10s
 * (tolerates the ~2.5s cold wake). Independently tunable via `DB_POOL_RO_MAX`,
 * `DB_POOL_RO_IDLE_TIMEOUT_MS`, `DB_POOL_RO_CONNECT_TIMEOUT_MS`.
 */
export const getDbPoolRO = (): Pool | null => {
  const connectionString = process.env.DATABASE_URL_RO;
  if (!connectionString) {
    return null;
  }
  if (!pgPoolRO) {
    pgPoolRO = new Pool({
      connectionString,
      max: toFinitePositiveInt(process.env.DB_POOL_RO_MAX, DEFAULT_DB_POOL_MAX),
      idleTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_RO_IDLE_TIMEOUT_MS,
        DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      ),
      connectionTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_RO_CONNECT_TIMEOUT_MS,
        DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS,
      ),
    });
    // Wrap the fresh RO pool for db-wake tracing (no-op unless opted in).
    instrumentPool(pgPoolRO, 'reader');
  }
  return pgPoolRO;
};

/**
 * Drain and close the singleton read-only Postgres pool, mirroring
 * `closeDbPool`. Safe to call when no RO pool was ever created (no-op) — e.g.
 * when `DATABASE_URL_RO` was unset. The runtime's SIGTERM drain closes this
 * alongside the writer pool. Resets the singleton so a later `getDbPoolRO()`
 * reconnects.
 */
export const closeDbPoolRO = async (): Promise<void> => {
  if (!pgPoolRO) {
    return;
  }
  const pool = pgPoolRO;
  pgPoolRO = null;
  await pool.end();
};
