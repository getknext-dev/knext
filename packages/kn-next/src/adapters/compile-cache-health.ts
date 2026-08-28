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
 * every case that is not a genuine refusal:
 *
 *  - `NODE_COMPILE_CACHE` unset — nothing was asked for;
 *  - `NODE_DISABLE_COMPILE_CACHE` present — Node's documented opt-out; the
 *    operator turned bytecode caching off deliberately and must not be sent
 *    hunting a volume problem;
 *  - **Bun** — Bun does not implement `NODE_COMPILE_CACHE`, and, importantly,
 *    it DOES export `module.getCompileCacheDir`, returning `undefined`
 *    unconditionally (verified against bun 1.3.5 on a healthy writable dir).
 *    Feature-detecting the function is therefore NOT enough to decide the
 *    answer is meaningful; the runtime is checked explicitly, or every Bun pod
 *    would be told its healthy volume "was refused". `node-server.ts` branches
 *    on `process.versions.bun`, so Bun is a supported target and this path is
 *    reachable in production, not hypothetical.
 *
 * Wired into the supervisor's DEFERRED init, so it runs only once the child is
 * already serving.
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

export type CompileCacheStatus =
    | "unset"
    | "active"
    | "degraded"
    | "disabled"
    | "unknown";

interface HealthLogger {
    warn(obj: object, msg: string): void;
}

/**
 * Everything the verdict depends on, gathered explicitly so the decision is
 * pure and every branch is reachable in a test.
 */
export interface CompileCacheSignals {
    /** The injected NODE_COMPILE_CACHE (or undefined). */
    readonly requested: string | undefined;
    /** What the runtime reports it actually used. */
    readonly effective: string | undefined;
    /** The runtime exposes a `getCompileCacheDir` at all. */
    readonly probeSupported: boolean;
    /**
     * The runtime IMPLEMENTS `NODE_COMPILE_CACHE`. This is NOT the same as
     * `probeSupported`, and conflating them was a real false-alarm bug: **Bun
     * exports `module.getCompileCacheDir` and returns `undefined`
     * unconditionally**, even for a perfectly healthy writable directory
     * (verified against bun 1.3.5). Feature-detecting the function therefore
     * proves nothing, and every Bun pod would be told its healthy cache volume
     * "was refused".
     */
    readonly runtimeHonoursCompileCache: boolean;
    /**
     * `NODE_DISABLE_COMPILE_CACHE` is PRESENT in the environment — Node's
     * documented opt-out. Presence, not truthiness: verified on node 24, the
     * cache is disabled for `1`, `0`, and the empty string alike, so an
     * operator who set `=0` expecting "off means on" still gets it off, and
     * telling them a volume was "refused" would send them hunting a problem
     * that does not exist.
     */
    readonly disabledByRequest: boolean;
}

/**
 * Pure status decision. Order matters: every "we cannot tell" case must be
 * decided BEFORE the degraded verdict, since degraded is the only one that
 * speaks.
 */
export function evaluateCompileCacheStatus(
    signals: CompileCacheSignals,
): CompileCacheStatus {
    if (!signals.requested) return "unset";
    // Deliberately off ⇒ report it, never warn about it.
    if (signals.disabledByRequest) return "disabled";
    // Cannot tell ⇒ silent. Both directions: no probe at all, or a runtime
    // whose probe cannot answer this question (Bun).
    if (!signals.probeSupported) return "unknown";
    if (!signals.runtimeHonoursCompileCache) return "unknown";
    return signals.effective ? "active" : "degraded";
}

/**
 * The production probe. Read off a NAMESPACE import (a named import of a
 * possibly-missing export is a load-time error) and feature-detected.
 *
 * Feature detection alone is NOT sufficient to decide whether the answer is
 * meaningful — see {@link CompileCacheSignals.runtimeHonoursCompileCache}.
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
 * The Bun release that implements `NODE_COMPILE_CACHE` for real (#807).
 * Below this, the probe is a stub; at or above it, the probe answers.
 */
const BUN_COMPILE_CACHE_MAJOR = 1;
const BUN_COMPILE_CACHE_MINOR = 4;

/**
 * `major.minor` of a Bun version string, or `undefined` if it cannot be read.
 *
 * Leading digits only, so a prerelease (`1.4.0-canary.20260820`) reads as 1.4 —
 * canaries of a release that implements the cache do implement it. A version
 * with no minor (`1`) is NOT guessed at; see the caller for why.
 */
function bunMajorMinor(
    version: string,
): { major: number; minor: number } | undefined {
    const m = /^(\d+)\.(\d+)/.exec(version);
    if (!m) return undefined;
    return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Does THIS runtime implement `NODE_COMPILE_CACHE`?
 *
 * Node: yes. Bun: **only from 1.4** (#807). Before 1.4 it shipped
 * `module.getCompileCacheDir` as a stub returning `undefined` unconditionally,
 * so a verdict there would tell every Bun pod its healthy volume "was refused"
 * — the #309 false alarm.
 *
 * Both shapes are MEASURED, against real binaries, because only having both
 * makes it safe to enable:
 *
 * | | healthy writable dir | refused (`/dev/null`) |
 * |---|---|---|
 * | bun 1.3.5 | `undefined` | `undefined` |
 * | **bun 1.4.0** | **a path** | **`undefined`** |
 * | node 24 | a path | `undefined` |
 *
 * Bun 1.4 is Node's shape exactly, so both `active` and `degraded` are earned
 * there. Checking only the healthy case would have enabled a diagnostic unable
 * to tell "refused" from "not implemented", silencing real volume faults on
 * every 1.4 pod — the #309 defect inverted.
 *
 * The comparison is NUMERIC. `"1.10.0" < "1.4.0"` lexically, so a string
 * compare would classify a newer Bun as old and keep the diagnostic off
 * permanently.
 *
 * An unparseable version resolves to **false** — the silent direction. Never
 * guess upward: a missed diagnostic beats a false alarm, the same asymmetry the
 * original Bun check was built on.
 */
export function runtimeHonoursCompileCache(
    versions: { bun?: string } = process.versions as { bun?: string },
): boolean {
    if (versions.bun === undefined) return true;
    const v = bunMajorMinor(versions.bun);
    if (!v) return false;
    if (v.major !== BUN_COMPILE_CACHE_MAJOR)
        return v.major > BUN_COMPILE_CACHE_MAJOR;
    return v.minor >= BUN_COMPILE_CACHE_MINOR;
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
 * `versions` is the seam for the Bun check — production reads
 * `process.versions`.
 */
export function warnOnDegradedCompileCache(opts: {
    env: Record<string, string | undefined>;
    log: HealthLogger;
    getCompileCacheDir?: (() => string | undefined) | undefined;
    versions?: { bun?: string };
}): CompileCacheStatus {
    let status: CompileCacheStatus = "unknown";
    try {
        const requested = opts.env.NODE_COMPILE_CACHE;
        const probe =
            "getCompileCacheDir" in opts
                ? opts.getCompileCacheDir
                : defaultCompileCacheProbe();
        const effective = probe ? probe() : undefined;
        status = evaluateCompileCacheStatus({
            requested,
            effective,
            probeSupported: probe !== undefined,
            runtimeHonoursCompileCache: runtimeHonoursCompileCache(
                opts.versions ?? (process.versions as { bun?: string }),
            ),
            // PRESENCE, not truthiness — Node disables the cache for any
            // value, including "0" and "".
            disabledByRequest:
                opts.env.NODE_DISABLE_COMPILE_CACHE !== undefined,
        });
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
