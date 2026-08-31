/**
 * Centralized logging service for kn-next framework.
 *
 * Uses Pino for structured JSON logging in production
 * and pretty-printed output in development / CLI contexts.
 *
 * Cold-start note (#441): pino is loaded LAZILY — on the first actual log emit,
 * never at module import. Merely importing this module (and constructing child
 * loggers via `createLogger`) initialises NOTHING; pino's ~13.5ms
 * load+instantiate cost stays OFF the pre-spawn critical path. The Knative
 * supervisor imports this logger before it spawns the Next.js child, so an eager
 * pino here would steal CPU from the child's boot. Output is byte-identical to
 * the previous eager path — only WHEN pino loads changes. pino ships CJS, so a
 * synchronous `require` keeps `createLogger` synchronous.
 */

import { createRequire } from "node:module";
import type { Logger, LoggerOptions } from "pino";

/** The callable pino factory (its default export), typed for the lazy require. */
type PinoFactory = (opts?: LoggerOptions) => Logger;

let isProduction = process.env.NODE_ENV === "production";

// Sync CJS require so the lazy load stays synchronous (pino is CJS). This is a
// real Node require against node_modules; it is NOT a static import, so pino is
// not part of this module's import graph and does not load until first use.
const requirePino = createRequire(import.meta.url);

/** The lazily-instantiated root pino logger (created on first emit). */
let rootLogger: Logger | undefined;

/**
 * Drop the memoised root logger and re-read the env it was built from (tests).
 *
 * The explicit replacement for `vi.resetModules()`, which bun has no equivalent
 * of. BOTH halves are needed and forgetting either is silent: clearing
 * `rootLogger` without re-reading `isProduction` rebuilds the logger with the
 * previous NODE_ENV, and re-reading without clearing leaves the old instance in
 * place — each looks like a reset and neither is one.
 *
 * `isProduction` is a `let` for exactly this reason; it is never reassigned
 * outside this function.
 */
export function __resetLoggerForTests(): void {
    rootLogger = undefined;
    isProduction = process.env.NODE_ENV === "production";
}

/** Instantiate (once) the root pino logger with the framework's exact config. */
function getRoot(): Logger {
    if (rootLogger === undefined) {
        const pino = requirePino("pino") as PinoFactory;
        rootLogger = pino({
            name: "kn-next",
            level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
            transport: isProduction
                ? undefined
                : {
                      target: "pino-pretty",
                      options: {
                          colorize: true,
                          translateTime: "HH:MM:ss",
                          ignore: "pid,hostname",
                      },
                  },
        });
    }
    return rootLogger;
}

/**
 * Wrap a lazily-resolved pino `Logger` in a Proxy that defers pino until the
 * first property access (i.e. the first `.info()/.warn()/...` emit). All known
 * consumers only CALL log methods (`debug/info/warn/error/fatal`); the `set`/
 * `has` traps are defence-in-depth so property mutation (e.g. `log.level = ...`)
 * and `in` checks still work if a consumer ever needs them.
 */
function lazyLogger(resolve: () => Logger): Logger {
    return new Proxy({} as Logger, {
        get(_target, prop, receiver) {
            const real = resolve();
            const value = Reflect.get(real as object, prop, receiver);
            return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(real)
                : value;
        },
        set(_target, prop, value) {
            return Reflect.set(resolve() as object, prop, value);
        },
        has(_target, prop) {
            return Reflect.has(resolve() as object, prop);
        },
    });
}

/**
 * Framework logger instance.
 *
 * - Production: structured JSON (12-factor compliant, machine-parseable)
 * - Development/CLI: pretty-printed with timestamps and colors
 *
 * Lazy: pino is not touched until the first log method is called on this proxy.
 */
export const logger: Logger = lazyLogger(getRoot);

/**
 * Creates a child logger with additional context bindings.
 * Useful for scoping logs to a specific module or operation.
 *
 * The returned logger is lazy: constructing it loads no pino; the underlying
 * `root.child(bindings)` (and pino itself) materialises on the first emit.
 *
 * @example
 * ```ts
 * const log = createLogger({ module: 'deploy' });
 * log.info({ imageTag: 'v1.0.0' }, 'Starting deployment');
 * ```
 */
export function createLogger(bindings: Record<string, string>): Logger {
    let child: Logger | undefined;
    return lazyLogger(() => {
        if (child === undefined) {
            child = getRoot().child(bindings);
        }
        return child;
    });
}
