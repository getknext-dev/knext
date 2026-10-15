/**
 * Readiness wait for tests that spawn a server: poll `url` until it answers
 * 200 or a bounded deadline passes. A server that has bound its port can
 * still answer non-200 (or reset the connection) while it warms up, which a
 * single probe turns into a flake under CI load.
 *
 * On failure the error carries the last status (or last connection error) and
 * the server's own output, so a genuinely broken server is diagnosable.
 */

export interface WaitForHttpOkOptions {
    /** Total time to wait. Default 60 s. */
    deadlineMs?: number;
    /** Pause between probes. Default 250 ms. */
    intervalMs?: number;
    /** The spawned server's combined stdout/stderr, appended to failures. */
    log?: () => string;
    /** Returns a description once the server process has exited, else null. */
    exited?: () => string | null;
}

export async function waitForHttpOk(
    url: string,
    opts: WaitForHttpOkOptions = {},
): Promise<Response> {
    const { deadlineMs = 60_000, intervalMs = 250 } = opts;
    const deadline = Date.now() + deadlineMs;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    const fail = (why: string): never => {
        const seen =
            lastStatus !== undefined
                ? `last status ${lastStatus}`
                : `no response (${lastError ?? "none"})`;
        const log = opts.log?.() ?? "";
        throw new Error(
            `${url}: ${why}; ${seen}${log ? `\n--- server output ---\n${log}` : ""}`,
        );
    };
    const failIfExited = () => {
        const gone = opts.exited?.();
        if (gone) fail(`server exited before ready (${gone})`);
    };

    for (;;) {
        failIfExited();
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(
                    Math.max(1, Math.min(5000, deadline - Date.now())),
                ),
            });
            if (res.status === 200) return res;
            lastStatus = res.status;
            lastError = undefined;
            await res.body?.cancel();
        } catch (e) {
            // Keep a status already seen: the final probe is cut short by the
            // deadline, and its abort must not erase the answer before it.
            lastError = e instanceof Error ? e.message : String(e);
        }
        if (Date.now() >= deadline) {
            // Crash vs slow: the process may have died during the last probe,
            // after the loop's own exit check.
            failIfExited();
            fail(
                `not ready with HTTP 200 within ${deadlineMs} ms` +
                    (opts.exited ? " (server process still running)" : ""),
            );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
