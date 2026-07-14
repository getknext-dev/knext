import RedisClient from 'ioredis';
import { getDbPool } from '../clients';
import { logger } from '../logger';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    postgres: 'up' | 'down' | 'unconfigured';
    redis: 'up' | 'down' | 'unconfigured';
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
 * Deep Readiness Probe — hard-vs-soft dependency taxonomy (ADR-0023).
 *
 * This probe backs the Knative **readiness** gate, so its verdict decides
 * whether traffic is routed to the pod and — under scale-to-zero — whether the
 * pod is kept in rotation or evicted. The overall `status` is derived from the
 * dependencies by **severity**, not by a flat "any sub-check down ⇒ down":
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
  // Sub-checks initialize to 'down' when configured; the check only ever
  // promotes them to 'up'. A dependency that times out (never settles) is
  // therefore left 'down' — the timeout can never produce a false 'up'.
  const checks: HealthStatus['checks'] = {
    postgres: process.env.DATABASE_URL ? 'down' : 'unconfigured',
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
          logger.error({ err: error }, '[Health Check] Postgres connection failed');
          checks.postgres = 'down';
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

  // Wait for all checks to complete, with a fast 3-second timeout. A slow-but-
  // alive hard dependency that blows this window leaves `checks.postgres` at its
  // initialized 'down' — the derivation below then correctly yields `down`.
  let timedOut = false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Health check cluster timeout')), 3000),
    );
    await Promise.race([Promise.all(checkPromises), timeoutPromise]);
  } catch (error) {
    logger.error({ err: error }, '[Health Check] System health verification timed out');
    timedOut = true;
  }

  // Derive overall status from the dependency taxonomy (see the doc comment /
  // ADR-0023). Hard-dep failure fails CLOSED (down) and dominates; a soft-dep
  // (cache) failure fails OPEN (degraded, still Ready).
  let status: HealthStatus['status'] = 'ok';
  if (timedOut || checks.postgres === 'down') {
    // Hard dependency unreachable (or a slow-PG timeout) ⇒ down. Never route
    // traffic to — nor keep in rotation — a pod that can't serve.
    status = 'down';
  } else if (checks.redis === 'down') {
    // Soft/optional dependency (Redis cache) unreachable ⇒ degraded but still
    // Ready: the pod serves cache-miss traffic from the origin.
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    checks,
  };
}
