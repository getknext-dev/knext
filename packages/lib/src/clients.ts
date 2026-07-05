import { GRPC as Cerbos } from '@cerbos/grpc';
import * as Minio from 'minio';
import { Pool } from 'pg';

// Singleton instances
let cerbosClient: Cerbos | null = null;
let minioClient: Minio.Client | null = null;
let pgPool: Pool | null = null;

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
