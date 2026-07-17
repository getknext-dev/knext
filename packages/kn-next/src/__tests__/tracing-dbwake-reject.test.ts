import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DB_WAKE_SPAN_NAME,
    instrumentPoolForDbWake,
} from "../adapters/tracing";

/**
 * #336 — the db_wake span/metric must land on the FIRST *successful* client
 * acquisition, even when the very first acquisition REJECTS during the 0→1 wake
 * (the scale-zero-pg cold case: gateway still waking / connect timeout, then a
 * retry succeeds).
 *
 * The bug: the per-pool `waked` latch was flipped BEFORE awaiting the wrapped
 * connect()/query(). So the failed first attempt consumed the latch, and the
 * subsequent SUCCESSFUL retry (the real wake) was recorded as a warm no-op —
 * knext_db_wake_* measured the failed attempt's latency, not the actual wake.
 *
 * Fix: consume the latch only on a SUCCESSFUL acquisition. A rejection is still
 * error-spanned but does NOT steal the latch, so the retry gets its own db_wake
 * span/metric on success.
 *
 * Mirrors tracing-dbwake-query.test.ts: BasicTracerProvider + InMemorySpanExporter
 * + a real async-hooks context manager; the wrapper emits the spans.
 */

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();

function bootRuntime(): void {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    trace.disable();
    context.disable();
    contextManager.disable();
    provider = undefined;
    exporter = new InMemorySpanExporter();
});

function dbWakeSpans() {
    return exporter
        .getFinishedSpans()
        .filter((s) => s.name === DB_WAKE_SPAN_NAME);
}

async function handleRequest(
    name: string,
    handler: () => Promise<void>,
): Promise<void> {
    const tracer = trace.getTracer("@vercel/otel");
    const server = tracer.startSpan(name, { kind: SpanKind.SERVER });
    const ctx = trace.setSpan(context.active(), server);
    await context.with(ctx, handler);
    server.end();
}

describe("#336 db-wake lands on the first SUCCESSFUL acquisition (reject-then-retry)", () => {
    beforeEach(() => {
        bootRuntime();
    });

    it("(a) connect(): first attempt REJECTS, retry SUCCEEDS → db_wake ends on the SUCCESS, failed attempt is error-spanned", async () => {
        const boom = new Error("gateway still waking");
        let attempt = 0;
        const client = { release: vi.fn() };
        const pool = {
            connect() {
                attempt += 1;
                if (attempt === 1) {
                    return Promise.reject(boom);
                }
                return Promise.resolve(client);
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /files", async () => {
            // First acquisition rejects (cold wake still in progress).
            await expect(pool.connect()).rejects.toBe(boom);
            // Retry succeeds — this is the REAL wake.
            const c = await pool.connect();
            expect(c).toBe(client);
        });

        const spans = dbWakeSpans();
        // Exactly TWO db_wake spans: one for the failed attempt, one for the
        // successful retry — the latch was NOT consumed by the failure.
        expect(spans).toHaveLength(2);
        const errorSpan = spans.find((s) => s.status.code === 2);
        const okSpan = spans.find((s) => s.status.code !== 2);
        expect(errorSpan, "failed attempt is error-spanned").toBeDefined();
        expect(okSpan, "successful retry gets a db_wake span").toBeDefined();
        expect(
            errorSpan?.events.some((e) => e.name === "exception"),
            "the failed attempt recorded the exception",
        ).toBe(true);
        // The metric fires ONCE — on the successful wake only, with a latency.
        expect(emitter).toHaveBeenCalledTimes(1);
        expect(emitter.mock.calls[0][0]).toBe("writer");
        expect(typeof emitter.mock.calls[0][1]).toBe("number");
    });

    it("(a2) query(): first attempt REJECTS, retry SUCCEEDS → db_wake ends on the SUCCESS", async () => {
        const boom = new Error("connect timeout");
        let attempt = 0;
        const pool = {
            query(..._args: unknown[]): Promise<unknown> {
                attempt += 1;
                if (attempt === 1) {
                    return Promise.reject(boom);
                }
                return Promise.resolve({ rows: [{ ok: 1 }] });
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "reader", emitter);

        await handleRequest("GET /a", async () => {
            await expect(pool.query("select 1")).rejects.toBe(boom);
            const res = await pool.query("select 1");
            expect(res).toEqual({ rows: [{ ok: 1 }] });
        });

        const spans = dbWakeSpans();
        expect(spans).toHaveLength(2);
        const okSpan = spans.find((s) => s.status.code !== 2);
        expect(okSpan, "successful retry gets a db_wake span").toBeDefined();
        expect(okSpan?.attributes["knext.db_role"]).toBe("reader");
        // Metric fired only on the successful wake.
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(a3) query() callback overload: first attempt errors, retry succeeds → db_wake on the success", async () => {
        const boom = new Error("cb wake fail");
        let attempt = 0;
        const pool = {
            // biome-ignore lint/suspicious/noExplicitAny: mirrors pg overload
            query(...args: any[]): any {
                attempt += 1;
                const cb = args[args.length - 1];
                const err = attempt === 1 ? boom : null;
                const res = attempt === 1 ? undefined : { rows: [{ ok: 1 }] };
                setImmediate(() => cb(err, res));
                return undefined;
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            await new Promise<void>((resolve) => {
                pool.query("select 1", (err: unknown) => {
                    expect(err).toBe(boom);
                    resolve();
                });
            });
            await new Promise<void>((resolve, reject) => {
                pool.query("select 1", (err: unknown, res: unknown) => {
                    if (err) return reject(err);
                    expect(res).toEqual({ rows: [{ ok: 1 }] });
                    resolve();
                });
            });
        });

        const spans = dbWakeSpans();
        expect(spans).toHaveLength(2);
        expect(spans.some((s) => s.status.code !== 2)).toBe(true);
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(b) first attempt SUCCEEDS → exactly one db_wake (no #345 regression)", async () => {
        const pool = {
            query(..._args: unknown[]): Promise<unknown> {
                return Promise.resolve({ rows: [{ ok: 1 }] });
            },
            connect() {
                return Promise.resolve({ release() {} });
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            await pool.query("select 1"); // wake
            await pool.query("select 2"); // warm — no new span
            await (await pool.connect()).release(); // warm — no new span
        });

        expect(dbWakeSpans()).toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(c) shared latch: after a successful wake, warm calls across query+connect never double-count", async () => {
        let connects = 0;
        let queries = 0;
        const pool = {
            connect() {
                connects += 1;
                return Promise.resolve({ release() {} });
            },
            query(..._args: unknown[]): Promise<unknown> {
                queries += 1;
                return Promise.resolve({ rows: [] });
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            await pool.query("select 1"); // wake
            await (await pool.connect()).release(); // warm
            await pool.query("select 2"); // warm
            await (await pool.connect()).release(); // warm
        });

        expect(dbWakeSpans()).toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
        expect(connects).toBe(2);
        expect(queries).toBe(2);
    });

    it("(d) concurrency: two concurrent first-connects, one rejects one succeeds → exactly ONE db_wake for the success", async () => {
        const boom = new Error("racing wake failed");
        let attempt = 0;
        let releaseFirst: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const okClient = { release() {} };
        const pool = {
            async connect() {
                attempt += 1;
                if (attempt === 1) {
                    // First (loser): wait for the gate, then reject.
                    await gate;
                    throw boom;
                }
                // Second (winner): succeed immediately.
                return okClient;
            },
        };
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            const p1 = pool.connect(); // in-flight, will reject once gate opens
            const p2 = pool.connect(); // concurrent first, will succeed
            const c = await p2;
            expect(c).toBe(okClient);
            releaseFirst(); // now let p1 reject
            await expect(p1).rejects.toBe(boom);
        });

        // Exactly one db_wake span records the SUCCESS (status OK). There may be
        // an additional error span for the failed attempt, but the success must
        // be represented exactly once and the metric fires exactly once.
        const ok = dbWakeSpans().filter((s) => s.status.code !== 2);
        expect(ok, "exactly one successful db_wake span").toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(e) fail-open: a throwing emitter never breaks a reject-then-retry acquisition", async () => {
        const boom = new Error("cold");
        let attempt = 0;
        const pool = {
            query(..._args: unknown[]): Promise<unknown> {
                attempt += 1;
                return attempt === 1
                    ? Promise.reject(boom)
                    : Promise.resolve({ rows: [{ ok: 1 }] });
            },
        };
        const throwing = vi.fn(() => {
            throw new Error("emitter blew up");
        });
        instrumentPoolForDbWake(pool, "writer", throwing);

        await handleRequest("GET /a", async () => {
            await expect(pool.query("select 1")).rejects.toBe(boom);
            const res = await pool.query("select 1");
            expect(res).toEqual({ rows: [{ ok: 1 }] });
        });

        // The successful retry resolved normally despite the emitter throwing,
        // and still produced a db_wake span for the success.
        expect(dbWakeSpans().some((s) => s.status.code !== 2)).toBe(true);
    });
});
