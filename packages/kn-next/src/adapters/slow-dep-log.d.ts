// Declarations for slow-dep-log.js (kept as .js to match cache-handler.js's
// runtime-loaded style; this .d.ts exists because TS consumers — currently the
// tests — import it and @getknext/core's typecheck runs with implicit-any off).
export declare const SLOW_DEP_PREFIX: string;
export declare function slowDepThresholdMs(): number;
export declare function logSlowDep(
  dep: 'pg' | 'redis-connect' | 'redis-ready' | string,
  op: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): void;
export declare function instrumentConnectTiming(
  client: { on(event: string, cb: (...args: unknown[]) => void): unknown },
  now?: () => number,
): () => void;
