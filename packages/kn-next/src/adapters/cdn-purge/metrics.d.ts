// Declarations for metrics.js (kept as plain JS: it runs inside the Next server
// process through the cache handler, like the rest of cdn-purge/). This .d.ts
// exists because TS consumers (currently the tests) import it, and
// @getknext/core's typecheck runs with implicit-any off.

/** The purge counter's family name. */
export declare const PURGE_METRIC: "knext_cdn_purge_total";

/** A dependency-free counter registry, rendered as Prometheus text. */
export interface CdnMetricsRegistry {
    /** Increment a counter series by `by` (default 1). */
    inc(name: string, labels?: Record<string, string>, by?: number): void;
    /** Current value of one series (0 when never incremented). */
    get(name: string, labels?: Record<string, string>): number;
    /** Prometheus text exposition of every family. */
    render(): string;
}

/** A fresh, isolated registry. */
export declare function createMetricsRegistry(): CdnMetricsRegistry;

/** The process-wide registry, anchored on `globalThis`. */
export declare function defaultMetricsRegistry(): CdnMetricsRegistry;

/** Prometheus text for the process-wide registry. */
export declare function renderCdnPurgeMetrics(): string;
