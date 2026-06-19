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
 *   3. exit as soon as the child finishes draining — with a hard cap
 *      (`graceMs`) so a stuck child can't hang the pod past its
 *      terminationGracePeriodSeconds.
 */

export interface Closable {
    close(callback?: () => void): void;
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

    opts.child.once("exit", () => finish(0));

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
