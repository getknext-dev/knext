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
 * #345 — the db-wake span/metric must fire on the FIRST client acquisition
 * whether the app used `pool.query(...)` OR `pool.connect()`.
 *
 * The live bug: file-manager (and the typical pattern) calls `db.query(...)`,
 * never `db.connect()`. node-pg's `Pool.query()` acquires a client via an
 * internal path that bypasses the monkey-patched `pool.connect()`, so the #317
 * wrapper never ran — `knext_db_wake_*` was ABSENT on a warm pod after DB
 * traffic. These tests exercise the query-first path (the real usage) and prove
 * a SHARED latch across connect+query fires the wake exactly once.
 *
 * Mirrors tracing-integration.test.ts: BasicTracerProvider + InMemorySpanExporter
 * + a real async-hooks context manager; the wrapper emits the spans (no
 * hand-opened spans).
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

/**
 * A fake pg pool mirroring node-pg's Pool surface: BOTH `query()` and
 * `connect()`. `query()` supports the real overloads — (text), (text, values),
 * (config), and an optional trailing callback (in which case it returns void
 * and yields the result via the callback). It does NOT internally call the
 * public `connect()` (matching node-pg, which acquires via an internal path).
 */
function makeFakePool() {
    let connects = 0;
    let queries = 0;
    return {
        connects: () => connects,
        queries: () => queries,
        async connect() {
            connects += 1;
            return { release() {} };
        },
        // biome-ignore lint/suspicious/noExplicitAny: mirrors pg's overloaded signature
        query(...args: any[]): any {
            queries += 1;
            const last = args[args.length - 1];
            const rows = { rows: [{ ok: 1 }] };
            if (typeof last === "function") {
                // callback form → returns void, delivers via callback async
                setImmediate(() => last(null, rows));
                return undefined;
            }
            return Promise.resolve(rows);
        },
    };
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

function dbWakeSpans() {
    return exporter
        .getFinishedSpans()
        .filter((s) => s.name === DB_WAKE_SPAN_NAME);
}

describe("#345 db-wake fires on the pool.query() path", () => {
    beforeEach(() => {
        bootRuntime();
    });

    it("(a) query-first (no explicit connect) fires exactly ONE db_wake span + emitter call", async () => {
        const pool = makeFakePool();
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        // Real usage: getDbPool() → db.query('select 1'). No connect().
        await handleRequest("GET /files", async () => {
            const res = await pool.query("select 1");
            expect(res).toEqual({ rows: [{ ok: 1 }] });
        });

        const spans = dbWakeSpans();
        expect(
            spans,
            "exactly one db_wake span on the query path",
        ).toHaveLength(1);
        // Metric emitter fired once (knext_db_wake_total increment path #315).
        expect(emitter).toHaveBeenCalledTimes(1);
        expect(emitter.mock.calls[0][0]).toBe("writer");
        expect(typeof emitter.mock.calls[0][1]).toBe("number");
        // The span nests under the active request span (one trace).
        const http = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /files");
        expect(spans[0].parentSpanContext?.spanId).toBe(
            http?.spanContext().spanId,
        );
        expect(spans[0].attributes["knext.db_role"]).toBe("writer");
    });

    it("(a2) query with params, config-object, and callback overloads all preserve pg semantics", async () => {
        const pool = makeFakePool();
        instrumentPoolForDbWake(pool, "writer");

        // text + values (promise)
        const r1 = await pool.query("select $1", [1]);
        expect(r1).toEqual({ rows: [{ ok: 1 }] });
        // config object (promise)
        const r2 = await pool.query({ text: "select 1" });
        expect(r2).toEqual({ rows: [{ ok: 1 }] });
        // callback form → resolves via callback, returns void
        const cbResult = await new Promise((resolve, reject) => {
            const ret = pool.query("select 1", (err: unknown, res: unknown) =>
                err ? reject(err) : resolve(res),
            );
            expect(ret).toBeUndefined();
        });
        expect(cbResult).toEqual({ rows: [{ ok: 1 }] });
        // Still exactly one db_wake regardless of overload mix.
        expect(dbWakeSpans()).toHaveLength(1);
        expect(pool.queries()).toBe(3);
    });

    it("(b) connect-first still fires exactly once (no regression)", async () => {
        const pool = makeFakePool();
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "reader", emitter);

        await handleRequest("GET /a", async () => {
            const c = await pool.connect();
            c.release();
        });

        expect(dbWakeSpans()).toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
        expect(dbWakeSpans()[0].attributes["knext.db_role"]).toBe("reader");
    });

    it("(c) SHARED latch: query-first then connect → still exactly ONE db_wake", async () => {
        const pool = makeFakePool();
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            await pool.query("select 1"); // first acquisition → wake
            await (await pool.connect()).release(); // warm — no new span
            await pool.query("select 2"); // warm — no new span
        });

        expect(dbWakeSpans()).toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(c2) SHARED latch: connect-first then query → still exactly ONE db_wake", async () => {
        const pool = makeFakePool();
        const emitter = vi.fn();
        instrumentPoolForDbWake(pool, "writer", emitter);

        await handleRequest("GET /a", async () => {
            await (await pool.connect()).release(); // first acquisition → wake
            await pool.query("select 1"); // warm — no new span
        });

        expect(dbWakeSpans()).toHaveLength(1);
        expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("(d) query error path: rejection recorded on the span + rethrown, span ends", async () => {
        const boom = new Error("db exploded");
        const pool = {
            async connect() {
                return { release() {} };
            },
            query(..._args: unknown[]): Promise<unknown> {
                return Promise.reject(boom);
            },
        };
        instrumentPoolForDbWake(pool, "writer");

        await handleRequest("GET /err", async () => {
            await expect(pool.query("select 1")).rejects.toBe(boom);
        });

        const spans = dbWakeSpans();
        expect(spans).toHaveLength(1);
        // ERROR status (SpanStatusCode.ERROR === 2) recorded, span ended.
        expect(spans[0].status.code).toBe(2);
        expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
    });

    it("(e) fail-open: a throwing emitter never breaks pool.query", async () => {
        const pool = makeFakePool();
        const throwingEmitter = vi.fn(() => {
            throw new Error("emitter blew up");
        });
        // Wrapping + a broken emitter must not change pool.query's contract.
        instrumentPoolForDbWake(pool, "writer", throwingEmitter);

        await handleRequest("GET /a", async () => {
            const res = await pool.query("select 1");
            expect(res).toEqual({ rows: [{ ok: 1 }] });
        });
        // The query still resolved normally despite the emitter throwing.
        expect(pool.queries()).toBe(1);
    });
});
