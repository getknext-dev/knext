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

/**
 * The Lua source of the tag replay's compare-and-set write: KEYS[1] is the
 * stamp hash, ARGV pairs are (field, ms). At the script's own `TIME`, `s:` only
 * moves forward; `e:` wants now + ms but an expiry already in effect is never
 * moved into the future and a pending one is never pushed later.
 */
export declare const REPLAY_STAMPS_SCRIPT: string;

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
    /** How long until the breaker closes, for the tag replay's probe (5 s if absent). */
    retryInMs?(): number;
}

/** Forget the process's backlog of dropped tag stamps and its probe timer. */
export declare function resetUseCacheTagReplay(core: UseCacheCore): void;

export declare function createUseCacheHandler(args: {
    kind: "default" | "remote" | string;
    core: UseCacheCore;
}): UseCacheHandler;

/** The counter family the app's metrics port serves for this handler. */
export declare const USE_CACHE_METRIC: "knext_use_cache_events_total";

/** The prefix every app falls back to when it sets none; collapse sweeps refuse it. */
export declare const LEGACY_SHARED_KEY_PREFIX: "kn-next";

/** A Redis glob matching `text` literally (escapes * ? [ ] and the backslash). */
export declare function escapeGlob(text: string): string;

/** Whether a prefix-wide collapse sweep may run under `prefix`. */
export declare function collapseSweepAllowed(prefix: string): boolean;

/** The error a refused collapse sweep logs. */
export declare function collapseRefusedMessage(
    what: string,
    prefix: string,
): string;

/** Each counter the handler increments, mapped to its `event` label value. */
export declare const USE_CACHE_EVENTS: Readonly<Record<string, string>>;

/** The counters in Prometheus text: one family, one sample per event. */
export declare function renderUseCacheMetrics(): string;

/** The `globalThis` key the render function is published under. */
export declare const USE_CACHE_METRICS_SEAM_KEY: symbol;
