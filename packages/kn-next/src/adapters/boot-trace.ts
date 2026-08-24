/**
 * boot-trace.ts — opt-in phase tracer for the supervisor's cold start (#441/#592).
 *
 * ## Why this exists
 *
 * #441 measured the wrapper adding 842ms over booting Next's `server.js`
 * directly, and every attribution attempt since has been an ABLATION — remove a
 * feature, re-measure, see if the number moves. Seven of those failed, and the
 * one that succeeded (the supervisor-init deferral) only told us the aggregate
 * moved, not where the time went. An ablation can only ever falsify a named
 * suspect; it cannot produce a breakdown.
 *
 * This produces the breakdown directly: one timestamped line per boot phase,
 * anchored at PROCESS START (not module load), so a run answers "which interval
 * did the time go into" without re-deriving it from wall-clock deltas outside
 * the process.
 *
 * ## The two properties that make it safe to ship
 *
 * 1. **Off by default, and free when off.** `KNEXT_BOOT_TRACE` gates it. When
 *    unset, `mark()` does not read the clock, does not allocate, and does not
 *    write. The measurement must never become the thing being measured — this
 *    supervisor's whole #441 story is about work that competes with the child's
 *    boot for CPU.
 * 2. **Fail-open.** A diagnostic that can throw is a liability on a path that
 *    runs before the app serves its first request. A broken writer is swallowed.
 *
 * ## Anchoring at process start
 *
 * `process.hrtime.bigint()` is monotonic but its zero is arbitrary, so it cannot
 * on its own say "how long since the process started". `process.uptime()` can,
 * so the origin is derived ONCE at construction as `now() - uptime`, and every
 * later mark is a pure hrtime delta from that origin. That makes the very first
 * phase — node's own bootstrap plus this module graph's evaluation, the interval
 * no in-process instrument can otherwise see the start of — a measured quantity
 * rather than an inference.
 *
 * Deliberately DEPENDENCY-FREE: importing this must cost nothing, since it is
 * imported by the supervisor entry whose module-graph cost is what we measure.
 */

/** Set to `1`/`true`/`yes`/`on` to emit boot phase marks on stderr. */
export const BOOT_TRACE_ENV = "KNEXT_BOOT_TRACE";

type Env = Record<string, string | undefined>;

/** Values that turn the trace on. Anything else — including unset — is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether boot tracing is enabled. Fail-safe toward OFF: an unset, empty or
 * unrecognised value leaves production untouched.
 */
export function isBootTraceEnabled(env: Env = process.env): boolean {
    const raw = env[BOOT_TRACE_ENV];
    return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

export interface BootTracerOptions {
    /** Gate. When false, every method is a no-op that samples nothing. */
    readonly enabled: boolean;
    /** Monotonic clock in nanoseconds. Injected for tests. */
    readonly now?: () => bigint;
    /** Milliseconds the process has been alive, sampled once with `now`. */
    readonly uptimeMs?: () => number;
    /** Sink for the marks. Injected for tests; defaults to stderr. */
    readonly write?: (line: string) => void;
}

export interface BootTracer {
    /** Whether marks are being emitted. */
    readonly enabled: boolean;
    /**
     * Emit one structured line for `phase`. Never throws. A no-op — including
     * no clock read — when the tracer is disabled.
     */
    mark(phase: string, detail?: Readonly<Record<string, unknown>>): void;
    /** Milliseconds since process start, or 0 when disabled. */
    elapsedMs(): number;
}

const NS_PER_MS = 1e6;

/** The disabled tracer: allocated once, samples nothing, writes nothing. */
const DISABLED: BootTracer = {
    enabled: false,
    mark(): void {
        /* off */
    },
    elapsedMs(): number {
        return 0;
    },
};

/**
 * Build a boot tracer. Construction samples the clock exactly once (to anchor
 * the origin at process start) and only when enabled.
 */
export function createBootTracer(options: BootTracerOptions): BootTracer {
    if (!options.enabled) {
        return DISABLED;
    }
    const now = options.now ?? process.hrtime.bigint;
    const uptimeMs = options.uptimeMs ?? (() => process.uptime() * 1000);
    const write =
        options.write ?? ((line: string) => process.stderr.write(line));

    // Origin = process start, expressed on the monotonic clock. Sampled once so
    // every later mark is a pure hrtime delta and no phase inherits uptime()'s
    // coarser resolution.
    const originNs = now() - BigInt(Math.round(uptimeMs() * NS_PER_MS));
    let lastNs = originNs;
    let prevPhase = "process-start";

    const sinceMs = (from: bigint, to: bigint): number =>
        Number(to - from) / NS_PER_MS;

    return {
        enabled: true,
        mark(phase: string, detail?: Readonly<Record<string, unknown>>): void {
            try {
                const at = now();
                const line = `${JSON.stringify({
                    knextBootTrace: true,
                    phase,
                    prevPhase,
                    sinceStartMs: sinceMs(originNs, at),
                    sinceLastMs: sinceMs(lastNs, at),
                    ...detail,
                })}\n`;
                lastNs = at;
                prevPhase = phase;
                write(line);
            } catch {
                // Fail-open: a diagnostic never takes the supervisor down.
            }
        },
        elapsedMs(): number {
            try {
                return sinceMs(originNs, now());
            } catch {
                return 0;
            }
        },
    };
}

/**
 * The supervisor's tracer. Created at module evaluation so the origin is
 * anchored before the rest of the entry graph finishes loading; a no-op object
 * unless `KNEXT_BOOT_TRACE` is set.
 */
export const bootTrace: BootTracer = createBootTracer({
    enabled: isBootTraceEnabled(),
});
