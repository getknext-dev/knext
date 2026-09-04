// Declarations for slow-dep-log.js (kept as .js to match cache-handler.js's
// runtime-loaded style; this .d.ts exists because TS consumers — currently the
// tests — import it and @getknext/core's typecheck runs with implicit-any off).
export declare const SLOW_DEP_PREFIX: string;
export declare function slowDepThresholdMs(): number;
export declare function logSlowDep(
    dep: "pg" | "redis-connect" | "redis-ready" | string,
    op: string,
    durationMs: number,
    extra?: Record<string, unknown>,
    // `boolean`, not `void`: every return path in slow-dep-log.js returns one
    // (`return false` below the threshold, `return true` after logging, `return
    // false` on a formatting failure), and @getknext/lib's TypeScript twin
    // declares `boolean` too. The declaration said `void`, so TS consumers were
    // told the result is unusable — and it silently defeated
    // slow-dep-format-parity.test.ts, whose `.toBe(true)` / `.toBe(false)`
    // assertions typechecked as comparisons against `void`.
): boolean;
export declare function instrumentConnectTiming(
    client: { on(event: string, cb: (...args: unknown[]) => void): unknown },
    now?: () => number,
): () => void;
