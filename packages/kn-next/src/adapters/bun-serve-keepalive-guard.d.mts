// Declarations for bun-serve-keepalive-guard.mjs (kept as .mjs so a compiled
// single-exec bundle injection and a `bun --preload` can both load it as a
// dependency-free ESM module; this .d.mts exists because TS consumers — the
// tests — statically import its named exports and @getknext/core's typecheck
// runs with implicit-any off, the same reason slow-dep-log.d.ts exists for the
// node lane's .js guard).

/**
 * Pure gating rule. NO version ceiling — the Bun.serve reset is measured
 * still-present at Bun 1.4.2, so the guard is on whenever running under Bun and
 * the escape-hatch env var is not "0".
 */
export declare function shouldInstall(
    env: Record<string, string | undefined> | undefined,
    bun: { serve?: unknown } | undefined,
): boolean;

/** Stamp `Connection: close` on a response in place, best-effort, never throws. */
export declare function stampConnectionClose<T>(response: T): T;

// Wrap a Bun.serve `fetch` handler so its responses (sync/async) are stamped.
// The wrapper forwards every argument unchanged, so it is typed variadic rather
// than preserving the handler's declared arity — the tests call the wrapper with
// a Request even when the handler was written with no formal parameters.
export declare function wrapFetch<R>(
    fetchHandler: (...args: unknown[]) => R,
): (...args: unknown[]) => R;

/** Shallow-clone Bun.serve options with the `fetch` handler wrapped. */
export declare function wrapServeOptions(options: unknown): unknown;

/** Patch `bun.serve` so every server it starts stamps `Connection: close`. */
export declare function install(
    bun:
        | { serve?: (...a: unknown[]) => unknown; [k: symbol]: unknown }
        | undefined,
    env: Record<string, string | undefined> | undefined,
): boolean;
