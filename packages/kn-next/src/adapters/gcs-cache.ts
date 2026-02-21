import path from "node:path";
import { Storage } from "@google-cloud/storage";
import type {
    CacheEntryType,
    CacheValue,
    IncrementalCache,
    WithLastModified,
} from "@opennextjs/aws/types/overrides";
import { logCacheEvent } from "./cache-events";

// GCS client - uses Application Default Credentials (ADC) in GKE
const storage = new Storage();

// Lazy bucket initialization to avoid errors at build time
let _bucket: ReturnType<typeof storage.bucket> | null = null;
function getBucket() {
    if (!_bucket) {
        const bucketName = process.env.GCS_BUCKET_NAME;
        if (!bucketName) {
            throw new Error(
                "[GCS Cache] GCS_BUCKET_NAME environment variable is required",
            );
        }
        _bucket = storage.bucket(bucketName);
    }
    return _bucket;
}

function buildGcsKey(key: string, extension: CacheEntryType): string {
    return path.posix.join(
        process.env.GCS_BUCKET_KEY_PREFIX ?? "",
        extension === "fetch" ? "__fetch" : "",
        process.env.NEXT_BUILD_ID ?? "",
        extension === "fetch" ? key : `${key}.${extension}`,
    );
}

const incrementalCache: IncrementalCache = {
    async get<CacheType extends CacheEntryType = "cache">(
        key: string,
        cacheType?: CacheType,
    ): Promise<WithLastModified<CacheValue<CacheType>> | null> {
        const startTime = Date.now();
        try {
            const file = getBucket().file(
                buildGcsKey(key, cacheType ?? "cache"),
            );
            const [exists] = await file.exists();

            if (!exists) {
                logCacheEvent("MISS", "gcs", key, {
                    durationMs: Date.now() - startTime,
                    details: `Type: ${cacheType ?? "cache"}`,
                });
                return null;
            }

            const [metadata] = await file.getMetadata();
            const [content] = await file.download();
            const cacheData = JSON.parse(content.toString("utf-8"));

            logCacheEvent("HIT", "gcs", key, {
                durationMs: Date.now() - startTime,
                details: `Type: ${cacheType ?? "cache"}`,
            });

            return {
                value: cacheData,
                lastModified: metadata.updated
                    ? new Date(metadata.updated).getTime()
                    : Date.now(),
            };
        } catch (error) {
            console.error("[GCS Cache] Error getting cache entry:", key, error);
            logCacheEvent("MISS", "gcs", key, {
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
            const file = getBucket().file(
                buildGcsKey(key, cacheType ?? "cache"),
            );
            await file.save(JSON.stringify(value), {
                contentType: "application/json",
                metadata: {
                    cacheControl: "private, max-age=0",
                },
            });
            logCacheEvent("SET", "gcs", key, {
                durationMs: Date.now() - startTime,
                details: `Type: ${cacheType ?? "cache"}`,
            });
        } catch (error) {
            console.error("[GCS Cache] Error setting cache entry:", key, error);
        }
    },

    async delete(key: string): Promise<void> {
        const startTime = Date.now();
        try {
            const file = getBucket().file(buildGcsKey(key, "cache"));
            await file.delete({ ignoreNotFound: true });
            logCacheEvent("DELETE", "gcs", key, {
                durationMs: Date.now() - startTime,
            });
        } catch (error) {
            console.error(
                "[GCS Cache] Error deleting cache entry:",
                key,
                error,
            );
        }
    },

    name: "gcs",
};

export default incrementalCache;
