/**
 * A minimal, REAL RESP2 server over a REAL TCP socket — the seam T13/T14 need.
 *
 * Why not a mock of `ioredis`?
 *
 *   - T13 (atomicity) needs to observe what the SERVER actually applied when the
 *     connection dies mid-write. Whether `set` + `sadd` land together is a
 *     property of MULTI/EXEC vs a pipeline, and a mocked client cannot express
 *     the difference: a pipeline's commands are applied as they ARRIVE, a
 *     transaction's only at `EXEC`. This server implements exactly that, so
 *     destroying the socket between the two is a genuine torn-write experiment.
 *   - T14's hang mode needs a socket that ACCEPTS and never answers. A mocked
 *     rejection is a different fault: it settles. A blackhole does not, and that
 *     is the case that exhausts capacity rather than merely adding latency
 *     (SPRINT_1.md, the "silently useless" row for T14).
 *
 * Scope: only the commands `cache-handler.js` and ioredis's handshake issue.
 */

import net from "node:net";

export type FakeRedisMode =
    | "normal"
    | "blackhole"
    | "garbage"
    /**
     * Completes the TCP handshake, then answers the ready-check `INFO` with a
     * bulk header whose body it dribbles out forever, never finishing.
     *
     * This is the case a socket-inactivity timeout CANNOT catch — the socket is
     * continuously active, so ioredis's own `connectTimeout` never fires, yet
     * the client never reaches `ready`. It is what a loaded or half-wedged
     * Redis looks like, and only an explicit readiness budget bounds it.
     */
    | "slow-ready";

export interface FakeRedisOptions {
    /**
     * - `normal`   — a working server.
     * - `blackhole`— accepts the TCP connection, parses nothing, NEVER replies.
     * - `garbage`  — well-formed RESP carrying a payload that is not the JSON
     *                the handler stored (the "corrupt value in the key" fault).
     */
    mode?: FakeRedisMode;
    /**
     * Called for every command the server receives, BEFORE it is applied.
     * Returning a promise pauses the server at that point — the deterministic
     * mid-write seam. Throwing/`destroy()`ing inside it simulates process death.
     */
    onCommand?: (
        cmd: string,
        args: string[],
        socket: net.Socket,
    ) => void | Promise<void>;
}

export interface FakeRedis {
    port: number;
    url: string;
    /** Strings written by an applied SET. */
    strings: Map<string, string>;
    /** Sets written by an applied SADD. */
    sets: Map<string, Set<string>>;
    /** Every command received, in arrival order (`"multi"`, `"set"`, …). */
    received: string[];
    /** How many TCP connections have been ACCEPTED — the capacity signal. */
    connections: number;
    /** How many of those are still open. */
    openConnections: () => number;
    close: () => Promise<void>;
}

const CRLF = "\r\n";

function bulk(value: string | null): string {
    if (value === null) return `$-1${CRLF}`;
    return `$${Buffer.byteLength(value)}${CRLF}${value}${CRLF}`;
}

/** Incremental RESP2 array-of-bulk-strings parser. Returns whole commands only. */
function parseCommands(buf: Buffer): { cmds: string[][]; rest: Buffer } {
    const cmds: string[][] = [];
    let offset = 0;

    for (;;) {
        const start = offset;
        if (offset >= buf.length) break;
        if (buf[offset] !== 0x2a /* '*' */) {
            // Inline command (used by some clients for PING) — consume a line.
            const nl = buf.indexOf("\r\n", offset);
            if (nl === -1) break;
            const line = buf.toString("utf8", offset, nl).trim();
            if (line) cmds.push(line.split(/\s+/));
            offset = nl + 2;
            continue;
        }
        const headerEnd = buf.indexOf("\r\n", offset);
        if (headerEnd === -1) break;
        const count = Number.parseInt(
            buf.toString("utf8", offset + 1, headerEnd),
            10,
        );
        offset = headerEnd + 2;
        const parts: string[] = [];
        let truncated = false;
        for (let i = 0; i < count; i++) {
            if (offset >= buf.length || buf[offset] !== 0x24 /* '$' */) {
                truncated = true;
                break;
            }
            const lenEnd = buf.indexOf("\r\n", offset);
            if (lenEnd === -1) {
                truncated = true;
                break;
            }
            const len = Number.parseInt(
                buf.toString("utf8", offset + 1, lenEnd),
                10,
            );
            const valueStart = lenEnd + 2;
            if (valueStart + len + 2 > buf.length) {
                truncated = true;
                break;
            }
            parts.push(buf.toString("utf8", valueStart, valueStart + len));
            offset = valueStart + len + 2;
        }
        if (truncated) {
            offset = start;
            break;
        }
        cmds.push(parts);
    }

    return { cmds, rest: buf.subarray(offset) };
}

export async function startFakeRedis(
    options: FakeRedisOptions = {},
): Promise<FakeRedis> {
    const mode = options.mode ?? "normal";
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    const received: string[] = [];
    const live = new Set<net.Socket>();
    let connections = 0;

    /** Apply one command to the store and produce its RESP reply. */
    const apply = (cmd: string, args: string[]): string => {
        switch (cmd) {
            case "get": {
                if (mode === "garbage") {
                    // Well-formed RESP, malformed payload: the value in the key
                    // is not the JSON envelope the handler wrote.
                    return bulk("<<<not-json>>>");
                }
                const v = strings.get(args[0]);
                return v === undefined ? bulk(null) : bulk(v);
            }
            case "set":
                strings.set(args[0], args[1]);
                return `+OK${CRLF}`;
            case "del": {
                let n = 0;
                for (const k of args) {
                    if (strings.delete(k)) n++;
                    if (sets.delete(k)) n++;
                }
                return `:${n}${CRLF}`;
            }
            case "sadd": {
                const s = sets.get(args[0]) ?? new Set<string>();
                let n = 0;
                for (const m of args.slice(1)) {
                    if (!s.has(m)) {
                        s.add(m);
                        n++;
                    }
                }
                sets.set(args[0], s);
                return `:${n}${CRLF}`;
            }
            case "smembers": {
                const s = sets.get(args[0]);
                if (!s) return `*0${CRLF}`;
                const members = [...s];
                return `*${members.length}${CRLF}${members.map(bulk).join("")}`;
            }
            case "lpush":
            case "ltrim":
                return `:1${CRLF}`;
            case "info":
                return bulk(
                    "# Server\r\nredis_version:7.2.0\r\nrole:master\r\n",
                );
            case "ping":
                return `+PONG${CRLF}`;
            default:
                return `+OK${CRLF}`;
        }
    };

    const server = net.createServer((socket) => {
        connections += 1;
        live.add(socket);
        socket.on("close", () => live.delete(socket));
        socket.on("error", () => {
            /* client went away mid-write — that is the experiment */
        });

        if (mode === "blackhole") {
            // Accept, read, and never write a single byte back.
            socket.resume();
            return;
        }

        if (mode === "slow-ready") {
            // Promise a large bulk reply, then dribble it forever. The socket
            // is never idle, so an inactivity timeout never fires — but the
            // reply never completes, so the client never becomes `ready`.
            socket.resume();
            socket.once("data", () => {
                socket.write(`$100000${CRLF}`);
                const drip = setInterval(() => {
                    if (socket.destroyed) {
                        clearInterval(drip);
                        return;
                    }
                    socket.write("x");
                }, 20);
                drip.unref?.();
                socket.on("close", () => clearInterval(drip));
            });
            return;
        }

        // Annotated rather than inferred: `Buffer.alloc` yields the narrower
        // `Buffer<ArrayBuffer>`, but the parser hands back a `subarray`, which
        // is `Buffer<ArrayBufferLike>`. The accumulator is the wider of the two.
        let pending: Buffer = Buffer.alloc(0);
        // Commands queued by MULTI. `null` = not inside a transaction. This is
        // the whole point: queued commands are NOT applied until EXEC arrives.
        let queued: Array<[string, string[]]> | null = null;
        let chain: Promise<void> = Promise.resolve();

        socket.on("data", (chunk: Buffer | string) => {
            // A socket yields strings once `setEncoding` has been called on it
            // and Buffers otherwise. Nothing here sets an encoding, so this is
            // the Buffer branch in practice — but the seam is deliberately at
            // the socket, so the type describes what a socket can actually
            // hand over rather than what this server happens to configure.
            const bytes =
                typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            pending = Buffer.concat([pending, bytes]);
            const { cmds, rest } = parseCommands(pending);
            pending = rest;

            for (const parts of cmds) {
                const cmd = (parts[0] ?? "").toLowerCase();
                const args = parts.slice(1);
                received.push(cmd);
                chain = chain.then(async () => {
                    if (socket.destroyed) return;
                    await options.onCommand?.(cmd, args, socket);
                    if (socket.destroyed) return;

                    if (cmd === "multi") {
                        // Real Redis REFUSES a nested MULTI, and modelling that is
                        // load-bearing: a client that multiplexes commands on one
                        // connection lets two concurrent callers interleave between
                        // MULTI and EXEC, and the second gets this error while its
                        // write is silently lost. Without this branch the server
                        // accepted the nesting and the bug was invisible here while
                        // failing four times per compat-smoke run.
                        if (queued !== null) {
                            socket.write(
                                `-ERR MULTI calls can not be nested${CRLF}`,
                            );
                            return;
                        }
                        queued = [];
                        socket.write(`+OK${CRLF}`);
                        return;
                    }
                    if (cmd === "discard") {
                        queued = null;
                        socket.write(`+OK${CRLF}`);
                        return;
                    }
                    if (cmd === "exec") {
                        const batch = queued ?? [];
                        queued = null;
                        // ATOMIC: every queued command lands here, together.
                        const replies = batch.map(([c, a]) => apply(c, a));
                        socket.write(
                            `*${replies.length}${CRLF}${replies.join("")}`,
                        );
                        return;
                    }
                    if (queued !== null) {
                        queued.push([cmd, args]);
                        socket.write(`+QUEUED${CRLF}`);
                        return;
                    }
                    // Outside a transaction (i.e. a plain pipeline) the command
                    // is applied the moment it arrives — hence tearable.
                    socket.write(apply(cmd, args));
                });
            }
        });
    });

    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("fake-redis: failed to bind");
    }
    const port = address.port;

    return {
        port,
        url: `redis://127.0.0.1:${port}`,
        strings,
        sets,
        received,
        get connections() {
            return connections;
        },
        openConnections: () => live.size,
        close: async () => {
            for (const socket of live) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** A port nothing listens on — every connect is REFUSED immediately. */
export async function reservedClosedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("fake-redis: failed to bind");
    }
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}
