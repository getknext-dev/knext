import path from 'node:path';
import type { OriginalTagCache, OriginalTagCacheWriteInput } from '@opennextjs/aws/types/overrides';
import Redis from 'ioredis';
import { logCacheEvent } from './cache-events';

const { REDIS_URL, REDIS_KEY_PREFIX } = process.env;

// Redis client with automatic reconnection
const redis = new Redis(REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// Ensure connection on first use (with race condition protection)
let connectionPromise: Promise<void> | null = null;
async function ensureConnected(): Promise<void> {
  if (connectionPromise) {
    return connectionPromise;
  }
  if (redis.status === 'ready') {
    return;
  }
  connectionPromise = redis
    .connect()
    .then(() => {
      // Connection successful
    })
    .catch((err) => {
      // Allow retry on next call
      connectionPromise = null;
      throw err;
    });
  return connectionPromise;
}

const prefix = REDIS_KEY_PREFIX ?? 'kn-next';

/**
 * Build Redis key with stable prefix.
 * NOTE: We intentionally DO NOT include NEXT_BUILD_ID here.
 * Tag cache should persist across deploys. Only incremental cache (GCS)
 * uses BUILD_ID to isolate cached pages between versions.
 */
function buildKey(key: string): string {
  return path.posix.join(prefix, key);
}

// Redis key patterns:
// tag:{tag} -> Set of paths associated with this tag
// path:{path}:tags -> Set of tags for this path
// path:{path}:revalidatedAt -> Timestamp of last revalidation

const tagCache: OriginalTagCache = {
  mode: 'original',

  async getByTag(tag: string): Promise<string[]> {
    const startTime = Date.now();
    try {
      await ensureConnected();
      const paths = await redis.smembers(buildKey(`tag:${tag}`));
      // Paths are stored without BUILD_ID prefix (stable across deploys)
      const result = paths;

      logCacheEvent(result.length > 0 ? 'HIT' : 'MISS', 'redis', `tag:${tag}`, {
        durationMs: Date.now() - startTime,
        tag,
        details: `Found ${result.length} paths`,
      });

      return result;
    } catch (error) {
      console.error('[Redis TagCache] Error in getByTag:', tag, error);
      logCacheEvent('MISS', 'redis', `tag:${tag}`, {
        durationMs: Date.now() - startTime,
        tag,
        details: `Error: ${(error as Error).message}`,
      });
      return [];
    }
  },

  async getByPath(pathKey: string): Promise<string[]> {
    try {
      await ensureConnected();
      const tags = await redis.smembers(buildKey(`path:${pathKey}:tags`));
      // Tags are stored without BUILD_ID prefix (stable across deploys)
      return tags;
    } catch (error) {
      console.error('[Redis TagCache] Error in getByPath:', pathKey, error);
      return [];
    }
  },

  async getLastModified(pathKey: string, lastModified?: number): Promise<number> {
    try {
      await ensureConnected();

      // Get all tags for this path
      const tags = await redis.smembers(buildKey(`path:${pathKey}:tags`));

      if (tags.length === 0) {
        return lastModified ?? Date.now();
      }

      // Check if any tag has been revalidated after lastModified
      const pipeline = redis.pipeline();
      for (const tag of tags) {
        pipeline.get(buildKey(`tag:${tag}:revalidatedAt`));
      }
      const results = await pipeline.exec();

      const staleeTags: string[] = [];
      for (let i = 0; i < (results?.length ?? 0); i++) {
        const [err, result] = results?.[i] ?? [];
        if (!err && result) {
          const revalidatedAt = Number.parseInt(result as string, 10);
          if (revalidatedAt > (lastModified ?? 0)) {
            staleeTags.push(tags[i]);
          }
        }
      }

      if (staleeTags.length > 0) {
        // Clear the revalidatedAt timestamps to prevent infinite revalidation loop
        // The next cache.set() will create a fresh entry with new lastModified
        const clearPipeline = redis.pipeline();
        for (const tag of staleeTags) {
          clearPipeline.del(buildKey(`tag:${tag}:revalidatedAt`));
        }
        await clearPipeline.exec();

        // Return -1 to force cache miss and regeneration
        return -1;
      }

      return lastModified ?? Date.now();
    } catch (error) {
      console.error('[Redis TagCache] Error in getLastModified:', pathKey, error);
      return lastModified ?? Date.now();
    }
  },

  async writeTags(tags: OriginalTagCacheWriteInput[]): Promise<void> {
    const startTime = Date.now();
    try {
      await ensureConnected();

      const pipeline = redis.pipeline();

      for (const { tag, path: pathKey, revalidatedAt } of tags) {
        const builtTag = buildKey(tag);
        const builtPath = buildKey(pathKey);

        // Add path to tag's set
        pipeline.sadd(buildKey(`tag:${tag}`), pathKey);

        // Add tag to path's set
        pipeline.sadd(buildKey(`path:${pathKey}:tags`), tag);

        // If revalidatedAt is set, update the revalidation timestamp
        if (revalidatedAt) {
          pipeline.set(buildKey(`tag:${tag}:revalidatedAt`), revalidatedAt.toString());

          // Log revalidation event
          logCacheEvent('REVALIDATE', 'redis', pathKey, {
            tag,
            details: `RevalidatedAt: ${revalidatedAt}`,
          });
        }
      }

      await pipeline.exec();

      logCacheEvent('SET', 'redis', `${tags.length} tags`, {
        durationMs: Date.now() - startTime,
        details: `Tags: ${tags.map((t) => t.tag).join(', ')}`,
      });
    } catch (error) {
      console.error('[Redis TagCache] Error in writeTags:', error);
    }
  },

  name: 'redis',
};

export default tagCache;
