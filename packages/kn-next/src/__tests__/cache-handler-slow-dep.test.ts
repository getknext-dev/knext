import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRedis } from "./helpers/fake-redis";

/**
 * Redis half of the ledger row-3 discrimination instrument.
 *
 * Row 3 left three compatible readings for the ~1-in-8 first-request stall, two
 * of which live on the cache path and are indistinguishable in today's logs:
 *
 *   (2) the lazy first connect is retransmit-delayed but SUCCEEDS (TCP phase);
 *   (3) the connect handshakes fast and the ready-check `INFO` is slow but
 *       stays inside the command budget (post-handshake server responsiveness).
 *
 * Both end with the same silence — the handler never logs `failing open`,
 * because nothing failed. So the two phases must be timed SEPARATELY: the
 * `connect` event splits them, and each side gets its own dep class.
 *
 * Behaviour is untouched: no new timers, no new budget, listeners only.
 */

type WarnSpy = ReturnType<typeof vi.fn>;

const slowLines = (warn: WarnSpy): string[] =>
    warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l) => l.startsWith("[slow-dep] "));

const parse = (line: string): Record<string, unknown> =>
    JSON.parse(line.slice("[slow-dep] ".length));

describe("slow-dep-log — the redis connect/ready split (unit)", () => {
    let warn: WarnSpy;

    beforeEach(() => {
        vi.resetModules();
        process.env.SLOW_DEP_LOG_MS = "50";
        warn = vi.fn();
        vi.spyOn(console, "warn").mockImplementation(
            warn as unknown as typeof console.warn,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.env.SLOW_DEP_LOG_MS = undefined;
        delete process.env.SLOW_DEP_LOG_MS;
    });

    /** A stand-in for the ioredis client: only the events the timer observes. */
    const fakeClient = () => new EventEmitter();

    it("attributes a slow TCP connect to `redis-connect` and nothing else", async () => {
        const { instrumentConnectTiming } = await import(
            "../adapters/slow-dep-log.js"
        );
        let now = 1000;
        const client = fakeClient();
        instrumentConnectTiming(client, () => now);

        now = 3400; // 2.4 s in the TCP phase — row 3's stall size
        client.emit("connect");
        now = 3410; // ready-check itself was quick
        client.emit("ready");

        const found = slowLines(warn);
        expect(found).toHaveLength(1);
        expect(parse(found[0])).toMatchObject({
            dep: "redis-connect",
            durationMs: 2400,
        });
    });

    it("attributes a slow ready-check to `redis-ready` and nothing else", async () => {
        const { instrumentConnectTiming } = await import(
            "../adapters/slow-dep-log.js"
        );
        let now = 1000;
        const client = fakeClient();
        instrumentConnectTiming(client, () => now);

        now = 1010; // handshake was fast …
        client.emit("connect");
        now = 3400; // … and the INFO ready-check was not
        client.emit("ready");

        const found = slowLines(warn);
        expect(found).toHaveLength(1);
        expect(parse(found[0])).toMatchObject({
            dep: "redis-ready",
            durationMs: 2390,
        });
    });

    it("emits NOTHING when both phases are fast (the other half)", async () => {
        const { instrumentConnectTiming } = await import(
            "../adapters/slow-dep-log.js"
        );
        let now = 1000;
        const client = fakeClient();
        instrumentConnectTiming(client, () => now);

        now = 1005;
        client.emit("connect");
        now = 1012;
        client.emit("ready");

        expect(slowLines(warn)).toHaveLength(0);
    });

    it("names both phases when both are slow — the readings are not exclusive", async () => {
        const { instrumentConnectTiming } = await import(
            "../adapters/slow-dep-log.js"
        );
        let now = 0;
        const client = fakeClient();
        instrumentConnectTiming(client, () => now);

        now = 900;
        client.emit("connect");
        now = 2000;
        client.emit("ready");

        expect(slowLines(warn).map((l) => parse(l).dep)).toEqual([
            "redis-connect",
            "redis-ready",
        ]);
    });

    it("stops timing once detached, and never logs the Redis URL", async () => {
        const { instrumentConnectTiming } = await import(
            "../adapters/slow-dep-log.js"
        );
        let now = 0;
        const client = fakeClient();
        const detach = instrumentConnectTiming(client, () => now);

        detach();
        now = 9000;
        client.emit("connect");
        client.emit("ready");

        expect(slowLines(warn)).toHaveLength(0);
        expect(client.listenerCount("connect")).toBe(0);
        expect(client.listenerCount("ready")).toBe(0);
    });
});

describe("cache-handler — a slow ready-check against a REAL socket is attributed", () => {
    const original = { ...process.env };
    let warn: WarnSpy;
    let fake: Awaited<ReturnType<typeof startFakeRedis>> | undefined;

    beforeEach(() => {
        vi.resetModules();
        process.env.REDIS_KEY_PREFIX = "slowdep-app";
        process.env.SLOW_DEP_LOG_MS = "80";
        warn = vi.fn();
        vi.spyOn(console, "warn").mockImplementation(
            warn as unknown as typeof console.warn,
        );
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it("logs `redis-ready` when the handshake is fast and INFO is slow-but-inside-budget", async () => {
        // The ready-check INFO is delayed 250 ms, then answered normally: the
        // connection SUCCEEDS, no `failing open` line — exactly reading (3),
        // which is invisible in today's logs.
        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                if (cmd === "info") {
                    await new Promise((r) => setTimeout(r, 250));
                }
            },
        });
        process.env.REDIS_URL = fake.url;
        process.env.REDIS_COMMAND_TIMEOUT_MS = "5000";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "5000";

        const mod = await import("../adapters/cache-handler.js");
        const CacheHandler = mod.default as new (
            o: unknown,
        ) => {
            get(k: string): Promise<unknown>;
        };
        const handler = new CacheHandler({});
        await handler.get("some-page");

        // No fail-open happened — the connection was healthy, just slow.
        const errors = (console.error as unknown as WarnSpy).mock.calls.map(
            (c: unknown[]) => String(c[0]),
        );
        expect(errors.some((l) => l.includes("failing open"))).toBe(false);

        const found = slowLines(warn);
        expect(found.map((l) => parse(l).dep)).toContain("redis-ready");
        const ready = found.map(parse).find((f) => f.dep === "redis-ready");
        expect(ready?.durationMs as number).toBeGreaterThanOrEqual(80);
        expect(found.join("\n")).not.toContain("redis://");
    });

    it("emits NO slow-dep line when the same handler connects promptly (the other half)", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        process.env.REDIS_COMMAND_TIMEOUT_MS = "5000";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "5000";

        const mod = await import("../adapters/cache-handler.js");
        const CacheHandler = mod.default as new (
            o: unknown,
        ) => {
            get(k: string): Promise<unknown>;
        };
        const handler = new CacheHandler({});
        await handler.get("some-page");

        // Not a vacuous pass: the handler really reached this server (the GET
        // arrived) and never failed open against it — so the silence is "fast",
        // not "dead". The port filter is load-bearing: a client left retrying by
        // an earlier test in this file logs `failing open` for its OWN (closed)
        // port, and an unfiltered assertion would read that as this test's.
        expect(fake.received).toContain("get");
        const errors = (console.error as unknown as WarnSpy).mock.calls
            .map((c: unknown[]) => String(c[0]))
            .filter((l) => l.includes(String(fake?.port)));
        expect(errors.some((l) => l.includes("failing open"))).toBe(false);
        expect(slowLines(warn)).toHaveLength(0);
    });
});
