/**
 * Port selection for specs that spawn a server and rebind the port in the
 * child.
 *
 * A bare `20000 + random * 20000` puts 36% of draws in the Linux ephemeral
 * range (32768-60999), where any outbound socket on the runner can hold the
 * port, and nothing checks it is free. The Nitro server swallows an
 * EADDRINUSE on listen and exits 0 with no output, so the collision surfaced
 * as an unexplained `code=0`.
 *
 * Draw below the ephemeral range, from a slice of it derived from the process
 * id (so concurrent test processes draw from different slices), and only hand
 * out a port that binds now and that this process has not already handed out.
 * A listener started by another process between this check and the child's
 * bind is still possible, so `waitForHttpOk` diagnoses a silent exit instead
 * of hiding it.
 */

import { createServer } from "node:net";

/** First port of the Linux ephemeral range; draws stay below it. */
const EPHEMERAL_START = 32768;
const RANGE_START = 20000;
/** The range is split into this many pid-selected slices. */
const SLICES = 64;
const SLICE_WIDTH = Math.floor((EPHEMERAL_START - RANGE_START) / SLICES);

const handedOut = new Set<number>();

export type BindOutcome = "ok" | "busy" | "unsupported";

export interface PickServerPortOptions {
    /** Injectable for tests. */
    random?: () => number;
    /** Injectable for tests. Default: bind the port on the wildcard and release it. */
    isFree?: (port: number) => Promise<boolean>;
    /** Draws before giving up. Default 50. */
    attempts?: number;
    /** Injectable for tests. Selects the slice of the range. Default process.pid. */
    pid?: number;
}

/** Try to bind `host:port` and release it. */
export function tryBind(port: number, host: string): Promise<BindOutcome> {
    return new Promise((resolve) => {
        const s = createServer();
        s.once("error", (e: NodeJS.ErrnoException) =>
            resolve(
                e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL"
                    ? "unsupported"
                    : "busy",
            ),
        );
        s.listen({ port, host }, () => s.close(() => resolve("ok")));
    });
}

/**
 * True when `port` can be bound on the wildcard address right now. Binds `::`
 * (what the servers listen on); a host with IPv6 disabled cannot, so that
 * alone must not read as "taken" - fall back to `0.0.0.0`.
 */
export async function canBind(
    port: number,
    bind: (port: number, host: string) => Promise<BindOutcome> = tryBind,
): Promise<boolean> {
    const v6 = await bind(port, "::");
    if (v6 !== "unsupported") return v6 === "ok";
    return (await bind(port, "0.0.0.0")) === "ok";
}

export async function pickServerPort(
    opts: PickServerPortOptions = {},
): Promise<number> {
    const random = opts.random ?? Math.random;
    const isFree = opts.isFree ?? ((p: number) => canBind(p));
    const attempts = opts.attempts ?? 50;
    const slice = (opts.pid ?? process.pid) % SLICES;
    const base = RANGE_START + slice * SLICE_WIDTH;
    for (let i = 0; i < attempts; i++) {
        const port = base + Math.floor(random() * SLICE_WIDTH);
        if (handedOut.has(port)) continue;
        if (!(await isFree(port))) continue;
        handedOut.add(port);
        return port;
    }
    throw new Error(
        `no free port in ${base}-${base + SLICE_WIDTH - 1} after ${attempts} attempts`,
    );
}
