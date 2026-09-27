/**
 * Graceful-shutdown logic for the Knative runtime entry (A5).
 *
 * Extracted as a pure, injectable function so it is unit-testable without
 * spawning real processes or installing real signal handlers.
 *
 * Contract: on SIGTERM (Knative scale-down) we
 *   1. stop accepting connections on the sidecar servers (metrics),
 *   2. FORWARD SIGTERM to the Next.js standalone child so it drains in-flight
 *      requests and runs `after()` callbacks before exiting,
 *   3. once the child has drained, run any registered drain hooks (e.g. closing
 *      the DB pool so in-flight transactions commit-or-rollback before the
 *      connections close — PGS-1) and AWAIT them,
 *   4. exit as soon as the drains finish — with a hard cap (`graceMs`) so a
 *      stuck child or a hanging drain can't hang the pod past its
 *      terminationGracePeriodSeconds.
 */

export interface Closable {
    close(callback?: () => void): void;
}

/**
 * An async resource-drain hook run on SIGTERM after HTTP has drained — e.g. the
 * DB pool's `end()` so in-flight transactions settle before connections close.
 * Must resolve (or reject) on its own; `gracefulShutdown` still force-exits at
 * the grace cap if a hook hangs.
 *
 * ISR cache writes (T13). `cache-handler.js` exports `drainCacheWrites()` for
 * registration here, so an in-flight revalidation write commits rather than
 * being abandoned. Be precise about WHERE that applies:
 *
 *   - **node target** — this module runs in the SUPERVISOR process
 *     (`node-server.ts`), while `cache-handler.js` is loaded by the Next.js
 *     standalone server in a CHILD process. This registry cannot see the child's
 *     writes. There the protection against a torn entry is the cache handler's
 *     own MULTI/EXEC atomicity (a transmission cut short applies nothing), plus
 *     the SIGTERM this module forwards so Next drains and runs `after()`.
 *   - **single-process target** (ADR-0036 `bun-exec`) — handler and shutdown
 *     share a process, and registering `drainCacheWrites` here is what makes the
 *     write survive the signal. Covered by
 *     `__tests__/shutdown-cache-drain.test.ts`.
 *
 * Either way the grace cap below is the backstop: a cache that will not commit
 * must never push the pod past its terminationGracePeriodSeconds.
 */
export type ShutdownDrain = () => Promise<void>;

// Module-level registry. The runtime (node-server.ts) registers drains here so
// the @getknext/lib pool stays free of any dependency on @getknext/core — the
// runtime, which already depends on both, wires lib's pool into this hook. This
// keeps the boundary clean and avoids a circular dependency.
const shutdownDrains: ShutdownDrain[] = [];

// Whether a graceful shutdown is in progress. Set true the moment `gracefulShutdown`
// begins so the supervisor's module-level child-`exit` handler can DEFER to the
// drain instead of calling `process.exit()` synchronously on the child's exit —
// which would preempt the awaited DB-pool drain (#449). Terminal in production
// (the process exits after gracefulShutdown); reset only for test isolation.
let shuttingDown = false;

/**
 * Reports whether a graceful shutdown has begun. The supervisor's child-`exit`
 * listener checks this and, when true, does nothing — letting `gracefulShutdown`
 * own the final exit AFTER the DB-pool drain (#449).
 */
export function isShuttingDown(): boolean {
    return shuttingDown;
}

/** Register a drain hook to be awaited on SIGTERM (after HTTP drain). */
export function registerShutdownDrain(drain: ShutdownDrain): void {
    shutdownDrains.push(drain);
}

/** Clear all registered drains + reset shutdown state. Exposed for test isolation. */
export function clearShutdownDrains(): void {
    shutdownDrains.length = 0;
    shuttingDown = false;
}

export interface ChildLike {
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: "exit", listener: () => void): void;
}

export interface ShutdownOptions {
    /** The spawned Next.js standalone server child process. */
    child: ChildLike;
    /** Sidecar servers (e.g. the Prometheus metrics server) to close. */
    closables: Closable[];
    /** Hard cap before forcing exit, in ms. Should be < the pod's grace period. */
    graceMs: number;
    /** Injectable process exit (real `process.exit` in prod, a spy in tests). */
    exit: (code: number) => void;
    /** Injectable setTimeout (for deterministic tests). */
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    /**
     * Where the grace-cap warning goes (the supervisor's logger in prod;
     * defaults to `console.warn`). Called only when the cap actually fires.
     */
    warn?: (message: string) => void;
}

/**
 * The warning logged when the grace cap forces the exit. Before this the cap
 * exited 0 silently, so a pod that dropped work looked exactly like a clean
 * drain. The exit code stays 0; this line is what makes the drop visible.
 *
 * This process is the SUPERVISOR: the Next.js server runs in a child process
 * whose sockets it cannot see, so when the child is still draining the number
 * of dropped requests is stated as unknown rather than guessed.
 */
export function graceCapWarning(args: {
    signal: string;
    graceMs: number;
    childExited: boolean;
    /** How many drain hooks were registered (they run concurrently). */
    pendingDrains: number;
}): string {
    const what = args.childExited
        ? `the ${args.pendingDrains} registered shutdown drain hook(s) all finished (the server itself had drained) — forcing exit and abandoning the unfinished ones`
        : "the Next.js server finished draining — forcing exit and DROPPING an unknown number of in-flight request(s) (the supervisor cannot see the server's connections)";
    return (
        `[knext] shutdown grace cap reached: SHUTDOWN_GRACE_MS=${args.graceMs}ms elapsed after ${args.signal} before ${what}. ` +
        "Raise SHUTDOWN_GRACE_MS (keep it below the pod termination grace period) or find the request, after() callback or drain hook that never finishes."
    );
}

/**
 * Drain the Next.js standalone child on `signal`, then exit at most once.
 * `signal` is informational (it appears in the grace-cap warning); the drain
 * behaviour is the same for SIGTERM/SIGINT.
 */
export function gracefulShutdown(signal: string, opts: ShutdownOptions): void {
    // Re-entrancy guard (#494): a second signal (e.g. SIGTERM then SIGINT, or a
    // repeated SIGTERM) mid-shutdown must not start a duplicate drain + grace
    // timer or forward SIGTERM again — the FIRST invocation owns the drain and the
    // single final exit. Ignore any later call while a shutdown is in progress.
    if (shuttingDown) {
        return;
    }

    // Mark shutdown in progress so the supervisor's child-`exit` handler defers
    // to us (below) instead of exiting synchronously and preempting the drain (#449).
    shuttingDown = true;

    // 1. Stop the sidecar servers accepting new connections.
    for (const closable of opts.closables) {
        try {
            closable.close();
        } catch {
            // Already closed / never listened — nothing to do.
        }
    }

    // 2. Forward SIGTERM so Next drains in-flight requests + runs after().
    opts.child.kill("SIGTERM");

    // 3. Exit once: as soon as the child drains, or at the grace cap.
    let exited = false;
    const finish = (code: number): void => {
        if (exited) {
            return;
        }
        exited = true;
        opts.exit(code);
    };

    // When the child drains, run+await the registered drain hooks (DB pool, …)
    // before exiting. If a hook hangs, the grace-cap timer below still forces
    // exit, so the pod never exceeds terminationGracePeriodSeconds.
    let childExited = false;
    opts.child.once("exit", () => {
        childExited = true;
        if (shutdownDrains.length === 0) {
            // Nothing to drain — exit synchronously (the common no-DB case).
            finish(0);
            return;
        }
        runDrains(shutdownDrains).then(
            () => finish(0),
            () => finish(0),
        );
    });

    // The grace cap still exits 0 (unchanged), but no longer silently: it
    // says what it abandoned, so a dropped drain is visible in the pod logs.
    const timer = (opts.setTimeoutFn ?? setTimeout)(() => {
        if (!exited) {
            const warn =
                opts.warn ??
                ((message: string) => {
                    // biome-ignore lint/suspicious/noConsole: fallback when no logger is injected
                    console.warn(message);
                });
            try {
                warn(
                    graceCapWarning({
                        signal,
                        graceMs: opts.graceMs,
                        childExited,
                        pendingDrains: shutdownDrains.length,
                    }),
                );
            } catch {
                // a failing logger must never block the exit below
            }
        }
        finish(0);
    }, opts.graceMs);
    if (
        timer &&
        typeof (timer as { unref?: () => void }).unref === "function"
    ) {
        (timer as { unref: () => void }).unref();
    }
}

/** Run every drain hook, tolerating individual rejections (best-effort). */
async function runDrains(drains: ShutdownDrain[]): Promise<void> {
    await Promise.all(
        drains.map((drain) =>
            Promise.resolve()
                .then(drain)
                .catch(() => {
                    // A failed drain must not block the others or exit; the
                    // grace cap is the backstop.
                }),
        ),
    );
}
