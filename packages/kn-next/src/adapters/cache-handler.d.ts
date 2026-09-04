// Minimal declaration for cache-handler.js — first TS import arrived with the
// slow-dep tests; the runtime consumer (next.config cacheHandler) loads it
// untyped. `unknown` default: the tests cast to the shape they exercise.
declare const _default: unknown;
export default _default;

/**
 * Test-only: clears the module-level env cache (`Redis`, `redis`,
 * `connectPromise`, `useRedis`, `unhealthyUntil`) so a suite can re-read the
 * environment. Exported from cache-handler.js since the bun migration — bun
 * has no module-registry reset, so the state this module owns has to be
 * clearable by name. Declared here because the .d.ts carried only a default
 * and TS consumers were told this real export does not exist.
 */
export declare function __resetEnvForTests(): void;

/**
 * Test-only: repoints (or, with `undefined`, disables) the process-wide Redis
 * client. FAIL-CLOSED on a published subpath: throws unless the harness sets
 * KNEXT_TEST_SEAMS=1 (sprint-close design-gate block — a consumer calling this
 * in production would silently drop every request to the in-memory fallback).
 */
export declare function __setRedisClientForTests(client: unknown): void;

/** Pure helper: the Redis TTL (seconds) derived from a set() context. */
export declare function __redisTtlSeconds(ctx: unknown): number;
