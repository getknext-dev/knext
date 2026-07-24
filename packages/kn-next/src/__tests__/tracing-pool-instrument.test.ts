/**
 * tracing.ts — instrumentPoolForDbWake (#345/#336). Wraps a pg pool's FIRST
 * client acquisition (via query() OR connect()) in a knext.db_wake span and
 * fires the optional Prometheus emitter on the 0→1 wake. Tracing is default-off
 * here (no-op tracer), so we assert the EMITTER + latch behaviour, which is the
 * observable contract:
 *  - the first query() wake emits once; later queries are warm (no re-emit),
 *  - the callback overload (pool.query(text, cb)) still emits + delivers via cb,
 *  - a rejected first attempt does NOT consume the latch, so the retry re-wakes,
 *  - connect() is wrapped on the same shared latch.
 */

import { describe, expect, it, vi } from "vitest";
import { instrumentPoolForDbWake } from "../adapters/tracing";

describe("instrumentPoolForDbWake — query()", () => {
    it("emits the db_wake metric once on the first query, then treats later queries as warm", async () => {
        const onDbWake = vi.fn();
        // Keep a ref to the ORIGINAL spy — instrumentPoolForDbWake replaces
        // pool.query with a wrapper that delegates to this underlying fn.
        const underlying = vi.fn(async (..._a: unknown[]) => ({ rows: [] }));
        const pool = { query: underlying };
        instrumentPoolForDbWake(pool, "writer", onDbWake);

        await pool.query("select 1");
        await pool.query("select 2");

        expect(onDbWake).toHaveBeenCalledTimes(1);
        expect(onDbWake).toHaveBeenCalledWith("writer", expect.any(Number));
        expect(underlying).toHaveBeenCalledTimes(2);
    });

    it("supports the callback overload and still emits + delivers via the callback", async () => {
        const onDbWake = vi.fn();
        const pool = {
            query: (
                _text: string,
                cb: (err: unknown, res: unknown) => void,
            ) => {
                cb(null, { rows: [1] });
            },
        };
        instrumentPoolForDbWake(
            pool as unknown as { query: (...a: unknown[]) => unknown },
            "reader",
            onDbWake,
        );

        const userCb = vi.fn();
        (pool.query as unknown as (t: string, cb: unknown) => unknown)(
            "select 1",
            userCb,
        );

        expect(userCb).toHaveBeenCalledWith(null, { rows: [1] });
        expect(onDbWake).toHaveBeenCalledWith("reader", expect.any(Number));
    });

    it("a rejected first query does NOT consume the latch — the retry re-wakes", async () => {
        const onDbWake = vi.fn();
        let attempt = 0;
        const pool = {
            query: vi.fn(async (..._a: unknown[]) => {
                attempt++;
                if (attempt === 1) throw new Error("cold wake timeout");
                return { rows: [] };
            }),
        };
        instrumentPoolForDbWake(pool, "writer", onDbWake);

        await expect(pool.query("x")).rejects.toThrow(/cold wake timeout/);
        expect(onDbWake).not.toHaveBeenCalled(); // failed attempt: no metric

        await pool.query("x"); // retry succeeds → the real wake
        expect(onDbWake).toHaveBeenCalledTimes(1);
    });
});

describe("instrumentPoolForDbWake — connect()", () => {
    it("wraps connect() on the same shared wake latch", async () => {
        const onDbWake = vi.fn();
        const pool = {
            connect: vi.fn(async (..._a: unknown[]) => ({ release() {} })),
            query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })),
        };
        instrumentPoolForDbWake(pool, "writer", onDbWake);

        await pool.connect();
        // A subsequent query is warm (latch already consumed by connect()).
        await pool.query("select 1");

        expect(onDbWake).toHaveBeenCalledTimes(1);
    });

    it("a throwing metric emitter never breaks the query (fail-open)", async () => {
        const onDbWake = vi.fn(() => {
            throw new Error("emitter boom");
        });
        const pool = {
            query: vi.fn(async (..._a: unknown[]) => ({ rows: [42] })),
        };
        instrumentPoolForDbWake(pool, "reader", onDbWake);

        await expect(pool.query("select 1")).resolves.toEqual({ rows: [42] });
    });
});
