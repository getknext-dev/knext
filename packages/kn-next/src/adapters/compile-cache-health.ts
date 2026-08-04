/**
 * compile-cache-health.ts — make an UNAVAILABLE compile cache observable (#309).
 *
 * ## The gap
 *
 * knext leans on `NODE_COMPILE_CACHE` for cold starts (ADR-0035): the image
 * bakes a populated V8 compile cache, and the operator may inject a path on a
 * shared volume instead. V8's handling of a broken cache directory is
 * fail-open — an unwritable mount, a path that is a file, a volume that never
 * mounted, all end with the cache silently DISABLED and the process booting
 * normally. That is the right trade (a cold-start optimisation must never turn
 * a volume problem into a crashloop, see
 * `__tests__/compile-cache-volume-fallback.test.ts`) but its cost is silence:
 * the pod runs at cold speed forever with no signal anywhere.
 *
 * #440 made the SHADOW case observable (`compile-cache-shadow.ts`, an injected
 * path bypassing a populated bake). This closes the sibling case: the injected
 * path was accepted by nobody.
 *
 * ## Same discipline as its sibling: diagnostics, fail-open, off the hot path
 *
 * Never throws, never delays boot, never changes behaviour, and stays SILENT on
 * any uncertainty — NODE_COMPILE_CACHE unset, or a runtime that cannot report a
 * cache dir at all (Bun has no `module.getCompileCacheDir`, so "no dir" there
 * means "cannot tell", not "refused"; warning on it would fire on every Bun
 * pod). Wired into the supervisor's DEFERRED init, so it runs only once the
 * child is already serving.
 *
 * ## What the signal actually proves
 *
 * `module.getCompileCacheDir()` reports THIS process's verdict, and the
 * standalone child is a separate process. They share the env and the
 * filesystem, so the supervisor's verdict is a faithful proxy for the child's:
 * a directory V8 refuses for one refuses for the other. It is a diagnostic, and
 * a proxy is the appropriate strength for one — reading the child's verdict
 * would mean a runtime channel into the app, which this must never justify.
 */

import * as nodeModule from "node:module";

export type CompileCacheStatus = "unset" | "active" | "degraded" | "unknown";

interface HealthLogger {
    warn(obj: object, msg: string): void;
}

/**
 * Pure status decision.
 *
 * @param requested       the injected NODE_COMPILE_CACHE (or undefined)
 * @param effective       what the runtime reports it actually used
 * @param probeSupported  false when the runtime has no way to report one
 */
export function evaluateCompileCacheStatus(
    requested: string | undefined,
    effective: string | undefined,
    probeSupported = true,
): CompileCacheStatus {
    if (!requested) return "unset";
    if (!probeSupported) return "unknown";
    return effective ? "active" : "degraded";
}

/**
 * The production probe: `module.getCompileCacheDir` exists on Node ≥22.8 and
 * NOT under Bun, so it is read off a NAMESPACE import (a named import of a
 * missing export is a load-time error) and feature-detected.
 */
function defaultCompileCacheProbe(): (() => string | undefined) | undefined {
    const probe = (
        nodeModule as {
            getCompileCacheDir?: () => string | undefined;
        }
    ).getCompileCacheDir;
    return typeof probe === "function" ? () => probe() : undefined;
}

/**
 * Emit a one-line WARNING when an injected NODE_COMPILE_CACHE was silently
 * refused by the runtime. Silent in every other case. Never throws — a
 * diagnostic that can take the boot down is worse than no diagnostic.
 *
 * Returns the computed status so callers/tests can assert it without parsing
 * logs; `"unknown"` is returned for any fault.
 *
 * Omit `getCompileCacheDir` entirely to use the production probe; pass it
 * explicitly (including as `undefined`) to simulate a runtime without one.
 */
export function warnOnDegradedCompileCache(opts: {
    env: Record<string, string | undefined>;
    log: HealthLogger;
    getCompileCacheDir?: (() => string | undefined) | undefined;
}): CompileCacheStatus {
    let status: CompileCacheStatus = "unknown";
    try {
        const requested = opts.env.NODE_COMPILE_CACHE;
        const probe =
            "getCompileCacheDir" in opts
                ? opts.getCompileCacheDir
                : defaultCompileCacheProbe();
        const effective = probe ? probe() : undefined;
        status = evaluateCompileCacheStatus(
            requested,
            effective,
            probe !== undefined,
        );
        if (status !== "degraded") return status;
        opts.log.warn(
            { nodeCompileCache: requested, compileCacheStatus: status },
            `NODE_COMPILE_CACHE=${requested} was refused by the runtime (unwritable, unmounted, or not a directory); ` +
                "the server is serving normally but WITHOUT bytecode reuse, so every cold start pays full compile cost.",
        );
        return status;
    } catch {
        // Includes a throwing logger: stay silent, never affect boot.
        return status === "degraded" ? status : "unknown";
    }
}
