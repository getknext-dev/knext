import path from "node:path";
import type {
    CacheEntryType,
    CacheValue,
    IncrementalCache,
    WithLastModified,
} from "@opennextjs/aws/types/overrides";
import Redis from "ioredis";
import { logCacheEvent } from "./cache-events";

/**
 * JSON replacer/reviver for types that JSON.stringify/parse cannot handle natively.
 * Next.js 16 uses Map<string, Buffer> for segmentData and Buffer for rscData.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
    if (value instanceof Map) {
        return { __type: "Map", entries: Array.from(value.entries()) };
    }
    if (Buffer.isBuffer(value)) {
        return { __type: "Buffer", data: value.toString("base64") };
    }
    return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && "__type" in value) {
        const typed = value as {
            __type: string;
            entries?: [string, unknown][];
            data?: string;
        };
        if (typed.__type === "Map" && Array.isArray(typed.entries)) {
            return new Map(typed.entries);
        }
        if (typed.__type === "Buffer" && typeof typed.data === "string") {
            return Buffer.from(typed.data, "base64");
        }
    }
    return value;
}

const { REDIS_URL, REDIS_KEY_PREFIX } = process.env;

// Redis client with automatic reconnection
const redis = new Redis(REDIS_URL ?? "redis://localhost:6379", {
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
    if (redis.status === "ready") {
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

const prefix = REDIS_KEY_PREFIX ?? "kn-next";

/**
 * Build Redis key for incremental cache.
 * Includes BUILD_ID for version isolation (different from tag cache).
 */
function buildKey(key: string, cacheType: CacheEntryType): string {
    return path.posix.join(
        prefix,
        "cache",
        cacheType === "fetch" ? "__fetch" : "",
        process.env.NEXT_BUILD_ID ?? "",
        cacheType === "fetch" ? key : `${key}.${cacheType}`,
    );
}

/**
 * Redis entry structure with metadata
 */
interface RedisCacheEntry<T> {
    value: T;
    lastModified: number;
}

const incrementalCache: IncrementalCache = {
    async get<CacheType extends CacheEntryType = "cache">(
        key: string,
        cacheType?: CacheType,
    ): Promise<WithLastModified<CacheValue<CacheType>> | null> {
        const startTime = Date.now();
        try {
            await ensureConnected();
            const redisKey = buildKey(key, cacheType ?? "cache");
            const data = await redis.get(redisKey);

            if (!data) {
                logCacheEvent("MISS", "redis", key, {
                    durationMs: Date.now() - startTime,
                    details: `Type: ${cacheType ?? "cache"}`,
                });
                return null;
            }

            const entry: RedisCacheEntry<CacheValue<CacheType>> = JSON.parse(
                data,
                jsonReviver as (key: string, value: unknown) => unknown,
            );

            logCacheEvent("HIT", "redis", key, {
                durationMs: Date.now() - startTime,
                details: `Type: ${cacheType ?? "cache"}`,
            });

            return {
                value: entry.value,
                lastModified: entry.lastModified,
            };
        } catch (error) {
            console.error(
                "[Redis Cache] Error getting cache entry:",
                key,
                error,
            );
            logCacheEvent("MISS", "redis", key, {
                durationMs: Date.now() - startTime,
                details: `Error: ${(error as Error).message}`,
            });
            return null;
        }
    },

    async set<CacheType extends CacheEntryType = "cache">(
        key: string,
        value: CacheValue<CacheType>,
        cacheType?: CacheType,
    ): Promise<void> {
        const startTime = Date.now();
        try {
            await ensureConnected();
            const redisKey = buildKey(key, cacheType ?? "cache");

            const entry: RedisCacheEntry<CacheValue<CacheType>> = {
                value,
                lastModified: Date.now(),
            };

            // Set with 1 hour TTL by default (can be configured)
            await redis.set(
                redisKey,
                JSON.stringify(
                    entry,
                    jsonReplacer as (key: string, value: unknown) => unknown,
                ),
                "EX",
                3600,
            );

            logCacheEvent("SET", "redis", key, {
                durationMs: Date.now() - startTime,
                details: `Type: ${cacheType ?? "cache"}`,
            });
        } catch (error) {
            console.error(
                "[Redis Cache] Error setting cache entry:",
                key,
                error,
            );
        }
    },

    async delete(key: string): Promise<void> {
        const startTime = Date.now();
        try {
            await ensureConnected();
            const redisKey = buildKey(key, "cache");
            await redis.del(redisKey);

            logCacheEvent("DELETE", "redis", key, {
                durationMs: Date.now() - startTime,
            });
        } catch (error) {
            console.error(
                "[Redis Cache] Error deleting cache entry:",
                key,
                error,
            );
        }
    },

    name: "redis-cache",
};

export default incrementalCache;
