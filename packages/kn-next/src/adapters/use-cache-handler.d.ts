// Declarations for use-cache-handler.js (kept as .js to match cache-handler.js's
// runtime-loaded style). NOT shipped: the package publishes `dist` and
// `templates` only. This .d.ts exists because TS consumers -- currently the
// tests -- import it and @getknext/core's typecheck runs with implicit-any off.

/**
 * The Lua source of the stamp-prune compare-and-delete: KEYS[1] is the stamp
 * hash, ARGV[1] the cutoff (epoch ms, Redis clock), ARGV[2..] the candidate
 * fields. A field is deleted only while its CURRENT value is below the cutoff.
 */
export declare const PRUNE_STAMPS_SCRIPT: string;

/** One `'use cache'` entry, as Next 16.4's `cacheHandlers` contract passes it. */
export interface UseCacheEntry {
    value: ReadableStream<Uint8Array>;
    tags: string[];
    stale: number;
    timestamp: number;
    expire: number;
    revalidate: number;
}

/** The handler object Next uses as a `cacheHandlers` kind. */
export interface UseCacheHandler {
    get(
        cacheKey: string,
        softTags?: string[],
    ): Promise<UseCacheEntry | undefined>;
    set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
    refreshTags(): Promise<void>;
    getExpiration(tags: string[]): Promise<number>;
    updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

/** What `cache-handler.js` injects: its connection, breaker, prefix and build id. */
export interface UseCacheCore {
    ensureConnected(): Promise<unknown>;
    redisCall<T>(fn: () => Promise<T>): Promise<T>;
    command(client: unknown, name: string, args: string[]): Promise<unknown>;
    keyPrefix(): string;
    buildId(): string | undefined;
    redisConfigured(): boolean;
}

export declare function createUseCacheHandler(args: {
    kind: "default" | "remote" | string;
    core: UseCacheCore;
}): UseCacheHandler;
