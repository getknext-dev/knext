// Declarations for otel-api-compile-shim.mjs (kept as .mjs, same reasoning as
// bun-serve-keepalive-guard.d.mts: a compiled single-exec bundle injection has
// to load it as a dependency-free ESM module, and @getknext/core's typecheck
// runs with implicit-any off, so a TS consumer importing named exports needs a
// declaration file).

/** Installs (at most once) a `require('@opentelemetry/api')` interceptor on `globalObj`. */
export declare function installOtelApiRequireShim(
    globalObj: unknown,
    apiModule: Record<string, unknown>,
): void;
