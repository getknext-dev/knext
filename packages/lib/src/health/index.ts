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
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  return redisCache;
}

/**
 * Deep Readiness Probe
 * Verifies connectivity to core infrastructure dependencies
 *
 * @returns {Promise<HealthStatus>} Comprehensive health state
 */
export async function checkDeepHealth(): Promise<HealthStatus> {
  const status: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: {
      postgres: process.env.DATABASE_URL ? 'down' : 'unconfigured',
      redis: process.env.REDIS_URL ? 'down' : 'unconfigured',
    },
  };

  const checkPromises: Promise<void>[] = [];

  // Check Postgres
  if (process.env.DATABASE_URL) {
    checkPromises.push(
      (async () => {
        try {
          const pool = getDbPool();
          await pool.query('SELECT 1 as healthy');
          status.checks.postgres = 'up';
        } catch (error) {
          logger.error({ err: error }, '[Health Check] Postgres connection failed');
          status.status = 'degraded';
        }
      })(),
    );
  }

  // Check Redis
  if (process.env.REDIS_URL) {
    checkPromises.push(
      (async () => {
        try {
          const redis = getRedisClient();
          if (redis) {
            await redis.ping();
            status.checks.redis = 'up';
          }
        } catch (error) {
          logger.error({ err: error }, '[Health Check] Redis connection failed');
          status.status = 'degraded';
        }
      })(),
    );
  }

  // Wait for all checks to complete, with a fast 3-second timeout
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Health check cluster timeout')), 3000),
    );
    await Promise.race([Promise.all(checkPromises), timeoutPromise]);
  } catch (error) {
    logger.error({ err: error }, '[Health Check] System health verification timed out');
    status.status = 'down';
  }

  // If ANY configured check is down, mark as down for the readiness probe
  if (Object.values(status.checks).includes('down')) {
    status.status = 'down';
  }

  return status;
}
