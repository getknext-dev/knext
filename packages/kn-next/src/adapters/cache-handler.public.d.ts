// Minimal declaration for cache-handler.public.js, the published entry. Untyped
// like the module it fronts (tsup emits no .d.ts for it); the in-repo suites
// import it only to compare its export names with the implementation's.
declare const _default: unknown;
export default _default;
export declare const CacheHandler: unknown;
export declare const ioredisClient: unknown;
export declare const nativeRedisClient: unknown;
