import RedisClient from 'ioredis';
import { getDbPool } from '../clients';
import { logger } from '../logger';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down' | 'waking';
  timestamp: string;
  checks: {
    postgres: 'up' | 'down' | 'unconfigured' | 'waking';
    redis: 'up' | 'down' | 'unconfigured';
  };
}

/**
 * Shallow liveness/readiness result — the process/server is up. It carries NO
 * dependency verdicts because a shallow check never dials Postgres or Redis.
 */
export interface ShallowHealthStatus {
  status: 'ok';
  timestamp: string;
  check: 'shallow';
}

/**
 * Default deep-check cluster-timeout budget (ms). Deliberately aligned with the
 * scale-zero-pg DB wake budget — NOT the old 3s — so a legitimately-waking
 * scale-to-zero database is classified `waking`, not fatally `down`. Override
 * per-deployment via `HEALTH_DEEP_TIMEOUT_MS`.
 */
const DEFAULT_DEEP_TIMEOUT_MS = 8000;

function deepTimeoutMs(): number {
  const raw = process.env.HEALTH_DEEP_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DEEP_TIMEOUT_MS;
}

/**
 * Classify a Postgres probe error as a scale-to-zero WAKE signal vs a genuine
 * fault. A connection-level failure (refused / reset / host unreachable /
 * timeout) is the normal signature of a scale-to-zero compute that is asleep or
 * mid-wake behind the scale-zero-pg gateway — it is transient and expected, not
 * a reason to declare the pod unhealthy. A reachable-but-erroring query (auth,
 * missing relation, syntax) is a real fault and stays `down`.
 */
function isWakeSignal(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  const code = e?.code;
  if (code && WAKE_ERROR_CODES.has(code)) return true;
  const msg = (e?.message ?? '').toUpperCase();
  return WAKE_ERROR_CODES_ARR.some((c) => msg.includes(c)) || msg.includes('CONNECT');
}

const WAKE_ERROR_CODES_ARR = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
];
const WAKE_ERROR_CODES = new Set(WAKE_ERROR_CODES_ARR);

/**
 * Shallow liveness/readiness probe (#338).
 *
 * Returns healthy whenever this process/server is running, WITHOUT touching
 * Postgres or Redis. This is what backs the Knative **readiness** and
 * **liveness** gates. Gating readiness on deep DB reachability defeats
 * scale-to-zero: an asleep/waking scale-to-zero database (scale-zero-pg
 * `compute-<app>`) is NORMAL, and a 2–6s cold wake would otherwise flap
 * readiness and compound cold-start latency under load. Deep dependency
 * reachability is exposed separately by {@link checkDeepHealth} for
 * observability/alerting only.
 */
export function checkShallowHealth(): ShallowHealthStatus {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    check: 'shallow',
  };
}

let redisCache: RedisClient | null = null;
function getRedisClient(): RedisClient | null {
  if (redisCache) return redisCache;
  if (!process.env.REDIS_URL) return null;
  redisCache = new RedisClient(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1, // Fail fast for health checks
    connectTimeout: 2000,
  });
  return redisCache;
}

/**
 * Deep dependency check — hard-vs-soft dependency taxonomy (ADR-0023), now
 * WAKE-AWARE and used for **observability/alerting only** (ADR-0026, #338).
 *
 * This check does NOT back the Knative readiness/liveness gate — those are
 * backed by {@link checkShallowHealth} so a legitimately asleep/waking
 * scale-to-zero DB never flaps readiness. Its verdict surfaces dependency
 * reachability to monitoring. The overall `status` is derived from the
 * dependencies by **severity**, not by a flat "any sub-check down ⇒ down":
 *
 * - **Waking (scale-to-zero):** a Postgres connection-level failure or a
 *   timeout that exceeds the (configurable) wake budget is classified `waking`
 *   — the DB is asleep/mid-wake behind the scale-zero-pg gateway. This is a
 *   NORMAL, transient state, not a fault.
 *
 * - **Hard dependency (Postgres):** the pod cannot serve without it. Configured
 *   + unreachable ⇒ overall `down` (readiness **fails CLOSED** — never route
 *   traffic to a pod that can't serve, and don't keep it in rotation).
 * - **Soft dependency (Redis-as-cache):** the cache layer **fails OPEN** per
 *   `.claude/rules/scs-zones.md` — a cache miss still serves from the origin.
 *   Configured + unreachable ⇒ overall `degraded` (still **Ready**). A Redis
 *   blip must NOT evict a pod that can still serve cache-miss traffic.
 * - **Timeout / hard-dep failure dominates:** a slow-but-alive hard dependency
 *   that exceeds the cluster-timeout window ⇒ `down`, and the timed-out
 *   sub-check is left at its initialized `down` (never a false `up`).
 *
 * Readiness truth-table (overall status by dependency state):
 *
 *   postgres      redis (cache)   ⇒ overall
 *   ------------- --------------- ----------
 *   up/uncfg      up/uncfg        ⇒ ok
 *   up/uncfg      down            ⇒ degraded   (soft dep fails OPEN → still Ready)
 *   down          up/down/uncfg   ⇒ down       (hard dep fails CLOSED)
 *   timeout       *               ⇒ down       (no sub-check left falsely 'up')
 *
 * NOTE: `process.env` is read at call time, but the pool/redis singletons cache
 * their DSN at first construction — re-pointing env does not re-point an
 * already-constructed pool.
 *
 * @returns {Promise<HealthStatus>} Comprehensive health state
 */
export async function checkDeepHealth(): Promise<HealthStatus> {
  // Postgres initializes to 'waking' when configured: a sub-check that never
  // settles (times out) is a scale-to-zero wake in progress (#338), NOT a fault
  // — and never a false 'up'. The catch demotes it to 'down' only on a genuine
  // reachable-but-erroring fault; success promotes it to 'up'.
  // Redis (soft dep) initializes to 'down'; a timeout there yields 'degraded'.
  const checks: HealthStatus['checks'] = {
    postgres: process.env.DATABASE_URL ? 'waking' : 'unconfigured',
    redis: process.env.REDIS_URL ? 'down' : 'unconfigured',
  };

  const checkPromises: Promise<void>[] = [];

  // Check Postgres (HARD dependency)
  if (process.env.DATABASE_URL) {
    checkPromises.push(
      (async () => {
        try {
          const pool = getDbPool();
          await pool.query('SELECT 1 as healthy');
          checks.postgres = 'up';
        } catch (error) {
          if (isWakeSignal(error)) {
            // Scale-to-zero DB asleep/mid-wake: NORMAL, not a fault.
            logger.info({ err: error }, '[Health Check] Postgres waking (scale-to-zero)');
            checks.postgres = 'waking';
          } else {
            logger.error({ err: error }, '[Health Check] Postgres connection failed');
            checks.postgres = 'down';
          }
        }
      })(),
    );
  }

  // Check Redis (SOFT dependency — cache layer, fails OPEN)
  if (process.env.REDIS_URL) {
    checkPromises.push(
      (async () => {
        try {
          const redis = getRedisClient();
          if (redis) {
            await redis.ping();
            checks.redis = 'up';
          }
        } catch (error) {
          logger.error({ err: error }, '[Health Check] Redis connection failed');
          checks.redis = 'down';
        }
      })(),
    );
  }

  // Wait for all checks to complete, with a configurable cluster timeout
  // (HEALTH_DEEP_TIMEOUT_MS, default aligned with the DB wake budget). A
  // slow-but-alive hard dependency that blows this window is a wake in progress
  // (#338), not a fault — the derivation below classifies it `waking`.
  let timedOut = false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Health check cluster timeout')), deepTimeoutMs()),
    );
    await Promise.race([Promise.all(checkPromises), timeoutPromise]);
  } catch (error) {
    logger.info({ err: error }, '[Health Check] Deep verification timed out (wake in progress)');
    timedOut = true;
  }

  // A soft-dep (Redis) that never settled within the window stays at its
  // initialized 'down' → degraded. `timedOut` needs no separate branch: an
  // unsettled hard-dep is already 'waking' and an unsettled soft-dep 'down'.
  void timedOut;

  // Derive overall status from the dependency taxonomy (ADR-0023 + ADR-0026).
  // NOTE: this no longer gates readiness — it is observability-only (#338).
  //  - waking:   scale-to-zero PG asleep/mid-wake (conn-refused or timeout).
  //  - down:     PG reachable but erroring (genuine fault) — fails CLOSED.
  //  - degraded: soft/optional cache (Redis) blip — fails OPEN.
  let status: HealthStatus['status'] = 'ok';
  if (checks.postgres === 'down') {
    // Reachable-but-erroring hard dependency ⇒ genuine fault.
    status = 'down';
  } else if (checks.postgres === 'waking') {
    // Connection-level refusal or timeout ⇒ scale-to-zero wake in progress.
    status = 'waking';
  } else if (checks.redis === 'down') {
    // Soft/optional dependency (Redis cache) unreachable ⇒ degraded.
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    checks,
  };
}
