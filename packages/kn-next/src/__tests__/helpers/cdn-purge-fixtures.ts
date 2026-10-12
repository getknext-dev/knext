/**
 * Fixtures for the CDN purge module's tests (ADR-0068 D6, D10, D13).
 *
 * The purge module is exercised over REAL HTTP against an in-process fake
 * Cloudflare/emulator listener on an OS-assigned port. The module itself
 * refuses any host that is not the provider's hardcoded API or a
 * `*.svc.cluster.local` emulator, so the tests reach the fake the way a
 * cluster would: through a `fetch` that resolves the (validated) hostname to
 * 127.0.0.1. The URL the module ASKED for is recorded before the rewrite, so a
 * test can still assert the exact hardcoded provider URL.
 *
 * No secret appears in any fixture: tokens are generated at run time.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedRequest {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
    json: unknown;
}

export interface Reply {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    /** Hold the response until `release()` (a slow / hung provider). */
    hang?: boolean;
    /** Kill the socket without answering (a network error). */
    destroy?: boolean;
}

export type Handler = (
    req: RecordedRequest,
    index: number,
) => Reply | Promise<Reply>;

export interface FakeCdn {
    port: number;
    requests: RecordedRequest[];
    /** Replace the per-request behaviour (default: 200 `{"success":true}`). */
    reply(handler: Handler): void;
    /** Let every held (`hang`) response go. */
    release(): void;
    close(): Promise<void>;
}

export async function startFakeCdn(
    initial: Handler = () => ({ status: 200 }),
): Promise<FakeCdn> {
    let handler = initial;
    const requests: RecordedRequest[] = [];
    const sockets = new Set<Socket>();
    let gate: () => void = () => {};
    let open = false;
    const gated = new Promise<void>((resolve) => {
        gate = resolve;
    });

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
                json = JSON.parse(body);
            } catch {
                json = undefined;
            }
            const recorded: RecordedRequest = {
                method: req.method ?? "",
                url: req.url ?? "",
                headers: req.headers,
                body,
                json,
            };
            const index = requests.length;
            requests.push(recorded);
            const out = await handler(recorded, index);
            if (out.destroy) {
                req.socket.destroy();
                return;
            }
            if (out.hang && !open) await gated;
            res.writeHead(out.status ?? 200, out.headers ?? {});
            res.end(out.body ?? '{"success":true}');
        });
    });
    server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    return {
        port,
        requests,
        reply(next) {
            handler = next;
        },
        release() {
            // Permanent: a request that arrives after release() is not held.
            open = true;
            gate();
        },
        async close() {
            open = true;
            gate();
            for (const s of sockets) s.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/**
 * A `fetch` that sends whatever URL it is given to the fake on 127.0.0.1,
 * recording the ORIGINAL url first. Redirects are NOT followed by the shim
 * itself: `init.redirect` is passed through, so the module's own choice is what
 * is exercised.
 */
export function routeFetch(
    port: number,
    seen: string[] = [],
): typeof fetch & { seen: string[] } {
    const routed = ((input: unknown, init?: RequestInit) => {
        const url = String(input);
        seen.push(url);
        const u = new URL(url);
        return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    }) as typeof fetch & { seen: string[] };
    routed.seen = seen;
    return routed;
}

/** A clock whose `sleep` records the wait and advances time without waiting. */
export function fakeClock(start = 1_700_000_000_000) {
    let t = start;
    const sleeps: number[] = [];
    return {
        sleeps,
        now: () => t,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            t += ms;
        },
        advance: (ms: number) => {
            t += ms;
        },
    };
}

/** An injected logger that records every line it is handed. */
export function captureLog() {
    const lines: string[] = [];
    const fmt =
        (level: string) =>
        (...args: unknown[]) => {
            lines.push(
                `${level} ${args
                    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                    .join(" ")}`,
            );
        };
    return {
        lines,
        log: { info: fmt("info"), warn: fmt("warn"), error: fmt("error") },
    };
}

/** Run `fn` with console.* captured, restoring them in all cases. */
export async function captureConsole<T>(
    fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) {
        console[m] = (...args: unknown[]) => {
            lines.push(
                args
                    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                    .join(" "),
            );
        };
    }
    try {
        return { result: await fn(), lines };
    } finally {
        methods.forEach((m, i) => {
            console[m] = saved[i] as never;
        });
    }
}

/** The app tag prefix the operator would derive (12 lowercase hex). */
export const PREFIX = "abcdef012345";

export function freshZoneId(): string {
    return randomBytes(16).toString("hex");
}

export function freshToken(): string {
    return `dummy-${randomUUID()}`;
}

/** A complete, valid Cloudflare environment with a run-time-generated token. */
export function cloudflareEnv(
    overrides: Record<string, string | undefined> = {},
) {
    const token = freshToken();
    const env: Record<string, string | undefined> = {
        KNEXT_CDN_PROVIDER: "cloudflare",
        KNEXT_CDN_TAG_PREFIX: PREFIX,
        KNEXT_CDN_PURGE_TARGET: freshZoneId(),
        KNEXT_CDN_PURGE_TOKEN: token,
        ...overrides,
    };
    return { env, token };
}

export const EMULATOR_ENDPOINT =
    "http://cdn-emulator.e2e.svc.cluster.local:8080";

export function emulatorEnv(
    overrides: Record<string, string | undefined> = {},
) {
    const token = freshToken();
    const env: Record<string, string | undefined> = {
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: PREFIX,
        KNEXT_CDN_PURGE_TARGET: "zone-1",
        KNEXT_CDN_EMULATOR_ENDPOINT: EMULATOR_ENDPOINT,
        KNEXT_CDN_PURGE_TOKEN: token,
        ...overrides,
    };
    return { env, token };
}

/**
 * A Redis stand-in with the real `SET … NX` contract, shared by every "pod"
 * handed the same instance. `shape: "ioredis"` exposes `.set(k, v, ...opts)`;
 * `shape: "native"` exposes only `.send(cmd, args)` (Bun's client).
 */
export function fakeRedis(shape: "ioredis" | "native" = "ioredis") {
    const store = new Map<string, string>();
    const calls: { key: string; args: string[] }[] = [];
    const apply = (key: string, value: string, opts: string[]) => {
        calls.push({ key, args: opts });
        const upper = opts.map((o) => o.toUpperCase());
        if (upper.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        return "OK";
    };
    const client: Record<string, unknown> =
        shape === "ioredis"
            ? {
                  async set(key: string, value: string, ...opts: unknown[]) {
                      return apply(key, value, opts.map(String));
                  },
              }
            : {
                  async send(cmd: string, args: string[]) {
                      if (cmd.toUpperCase() !== "SET") {
                          throw new Error(`unexpected ${cmd}`);
                      }
                      const [key, value, ...opts] = args;
                      return apply(key as string, value as string, opts);
                  },
              };
    return { client, store, calls };
}

export const sha256hex = async (s: string): Promise<string> => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(s).digest("hex");
};
