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
 */
export type ShutdownDrain = () => Promise<void>;

// Module-level registry. The runtime (node-server.ts) registers drains here so
// the @knext/lib pool stays free of any dependency on @knext/kn-next — the
// runtime, which already depends on both, wires lib's pool into this hook. This
// keeps the boundary clean and avoids a circular dependency.
const shutdownDrains: ShutdownDrain[] = [];

/** Register a drain hook to be awaited on SIGTERM (after HTTP drain). */
export function registerShutdownDrain(drain: ShutdownDrain): void {
    shutdownDrains.push(drain);
}

/** Clear all registered drains. Exposed for test isolation. */
export function clearShutdownDrains(): void {
    shutdownDrains.length = 0;
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
}

/**
 * Drain the Next.js standalone child on `signal`, then exit at most once.
 * `signal` is informational (the caller logs it); the drain behaviour is the same
 * for SIGTERM/SIGINT.
 */
export function gracefulShutdown(signal: string, opts: ShutdownOptions): void {
    void signal;

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
    opts.child.once("exit", () => {
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

    const timer = (opts.setTimeoutFn ?? setTimeout)(
        () => finish(0),
        opts.graceMs,
    );
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
