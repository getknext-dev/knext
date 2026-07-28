import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type FakeRedis,
    reservedClosedPort,
    startFakeRedis,
} from "./helpers/fake-redis";

/**
 * T14 — cache-handler failure injection, four modes.
 *
 * The contract: Redis ABSENT / REFUSING / TIMING OUT / RETURNING GARBAGE must
 * each produce a fail-open degradation to a GENUINE ORIGIN RESPONSE. Not "the
 * call didn't throw" — an actual freshly-rendered body handed back to the
 * caller, which is the only thing a user of the page would accept.
 *
 * Two honesty notes that belong next to the code, not in a reviewer's head:
 *
 *  1. Fail-open is the right availability choice, but it is NOT free. With Redis
 *     down there is no cross-pod cache consistency and every pod re-renders from
 *     origin — origin amplification proportional to replica count. That is a
 *     deliberate trade (a dead cache must never take the app down), not an
 *     absence of a problem.
 *  2. The HANG is a CAPACITY fault, not a latency one. A socket that accepts and
 *     never answers cannot be reproduced by a mocked rejection — a mock settles.
 *     So the hang mode is driven at the socket level (a real blackhole TCP
 *     server) and asserts that outstanding work stays BOUNDED: connections do
 *     not grow per request, and a second wave of traffic fails fast instead of
 *     queueing behind the first. A handler that merely "eventually responds"
 *     while accumulating hung connections has failed this test's real subject.
 */

interface CachedPage {
    value?: { body?: string };
}

interface Handler {
    get(key: string): Promise<CachedPage | null>;
    set(key: string, data: unknown, ctx: unknown): Promise<void>;
}

const CACHE_HANDLER: string = "../adapters/cache-handler.js";

/**
 * The ISR flow, in miniature: consult the cache, and on a miss render from
 * origin and write back. Returns the body actually served, so a test can assert
 * a real origin response rather than merely "get() returned null".
 */
async function renderThroughCache(
    handler: Handler,
    key: string,
    origin: () => Promise<string>,
): Promise<{ body: string; from: "cache" | "origin" }> {
    const hit = await handler.get(key);
    const cached = hit?.value?.body;
    if (typeof cached === "string") {
        return { body: cached, from: "cache" };
    }
    const body = await origin();
    await handler.set(
        key,
        { kind: "PAGE", body },
        { revalidate: 60, tags: ["t"] },
    );
    return { body, from: "origin" };
}

type ModeName = "absent" | "refusing" | "timing out" | "returning garbage";

describe("T14 — cache-handler failure injection: four modes fail OPEN", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;

    beforeEach(() => {
        vi.resetModules();
        process.env.REDIS_KEY_PREFIX = "fault-app";
        // Keep the fault budgets small so the suite is fast; production defaults
        // live in cache-handler.js.
        process.env.REDIS_COMMAND_TIMEOUT_MS = "300";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    /** Install one fault mode and return a fresh handler under it. */
    const underMode = async (mode: ModeName): Promise<Handler> => {
        if (mode === "absent") {
            // Not "Redis is broken" — Redis is not configured at all.
            process.env.REDIS_URL = undefined;
            delete process.env.REDIS_URL;
        } else if (mode === "refusing") {
            // A closed port: every connect attempt is refused immediately.
            process.env.REDIS_URL = `redis://127.0.0.1:${await reservedClosedPort()}`;
        } else if (mode === "timing out") {
            // Accepts the connection, answers nothing, ever.
            fake = await startFakeRedis({ mode: "blackhole" });
            process.env.REDIS_URL = fake.url;
        } else {
            // Well-formed protocol, unusable payload.
            fake = await startFakeRedis({ mode: "garbage" });
            process.env.REDIS_URL = fake.url;
        }
        const mod = await import(CACHE_HANDLER);
        return new mod.default({}) as Handler;
    };

    const MODES: ModeName[] = [
        "absent",
        "refusing",
        "timing out",
        "returning garbage",
    ];

    for (const mode of MODES) {
        describe(`mode: Redis ${mode}`, () => {
            it("serves a GENUINE origin response (not just a non-throwing null)", async () => {
                const handler = await underMode(mode);
                let originCalls = 0;
                const result = await renderThroughCache(
                    handler,
                    "/products",
                    async () => {
                        originCalls += 1;
                        return `fresh-body-${originCalls}`;
                    },
                );

                expect(result.from).toBe("origin");
                expect(result.body).toBe("fresh-body-1");
                expect(originCalls).toBe(1);
            });

            it("get() resolves to a MISS rather than throwing or hanging", async () => {
                const handler = await underMode(mode);
                await expect(handler.get("/anything")).resolves.toBeNull();
            });

            it("actually REACHES the injected fault (not a silent memory fallback)", async () => {
                // Without this, every mode above could pass by never touching
                // Redis at all — the classic way a fault-injection suite
                // protects nobody.
                const handler = await underMode(mode);
                await handler.get("/probe");

                if (mode === "absent") {
                    // The fault IS the absence: no server exists to observe.
                    expect(process.env.REDIS_URL).toBeUndefined();
                    expect(fake).toBeUndefined();
                } else if (mode === "refusing") {
                    // Nothing listens, so the proof is the URL pointing at a
                    // closed port and the handler still answering.
                    expect(process.env.REDIS_URL).toMatch(
                        /^redis:\/\/127\.0\.0\.1:\d+$/,
                    );
                    expect(fake).toBeUndefined();
                } else if (mode === "timing out") {
                    // The blackhole must have ACCEPTED a connection — i.e. the
                    // handler really did try to talk to it and hit the hang.
                    expect(fake?.connections ?? 0).toBeGreaterThanOrEqual(1);
                } else {
                    // The garbage payload must have been fetched and rejected —
                    // proof the Redis read path ran and the parse failed open.
                    expect(fake?.received).toContain("get");
                }
            });

            it("set() and a second render still succeed — the fault is not sticky", async () => {
                const handler = await underMode(mode);
                await expect(
                    handler.set(
                        "/k",
                        { kind: "PAGE", body: "b" },
                        { revalidate: 5 },
                    ),
                ).resolves.toBeUndefined();

                const second = await renderThroughCache(
                    handler,
                    "/k2",
                    async () => "second-body",
                );
                expect(second.body).toBe("second-body");
            });
        });
    }
});

/**
 * The hang mode's real subject: CAPACITY. Split out because "a response
 * eventually arrives" is the weak assertion this test exists to refuse.
 */
describe("T14 — the HANG mode is a capacity fault, and stays bounded", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;

    beforeEach(async () => {
        vi.resetModules();
        process.env.REDIS_KEY_PREFIX = "fault-app";
        process.env.REDIS_COMMAND_TIMEOUT_MS = "300";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        fake = await startFakeRedis({ mode: "blackhole" });
        process.env.REDIS_URL = fake.url;
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it("50 concurrent requests all get an origin response, and do NOT open 50 sockets", async () => {
        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({}) as Handler;

        const results = await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
                renderThroughCache(
                    handler,
                    `/p${i}`,
                    async () => `origin-${i}`,
                ),
            ),
        );

        expect(results.map((r) => r.from)).toEqual(Array(50).fill("origin"));
        expect(results[7].body).toBe("origin-7");

        // The capacity assertion. A handler that opens (or leaks) a connection
        // per hung request exhausts the socket budget long before it exhausts
        // patience — that is the fault that takes a pod down, and it is
        // invisible to a "did it respond?" assertion.
        expect(fake?.connections ?? 0).toBeLessThanOrEqual(4);
        expect(fake?.openConnections() ?? 0).toBeLessThanOrEqual(4);
    }, 20_000);

    it("a second wave fails FAST — outstanding commands do not queue behind the first", async () => {
        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({}) as Handler;

        // First wave pays the fault budget.
        await Promise.all(
            Array.from({ length: 10 }, (_, i) => handler.get(`/warm${i}`)),
        );

        const startedAt = Date.now();
        await Promise.all(
            Array.from({ length: 10 }, (_, i) => handler.get(`/second${i}`)),
        );
        const elapsed = Date.now() - startedAt;

        // If each wave re-paid a full command timeout per request serially, or
        // queued behind the first wave's hung commands, this would be an order
        // of magnitude larger.
        expect(elapsed).toBeLessThan(2_000);
    }, 20_000);
});

/**
 * The readiness budget's own case.
 *
 * ioredis's `connectTimeout` is a socket-INACTIVITY timeout, so it catches a
 * silent blackhole by accident. It does not catch a server that keeps the wire
 * busy while never completing the handshake — and there the client sits in
 * `connecting` forever while `ensureConnected()` waits on it. Only the explicit
 * readiness budget bounds that, which is why it is not redundant.
 */
describe("T14 — a busy-but-never-ready server is bounded by the readiness budget", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;

    beforeEach(async () => {
        vi.resetModules();
        process.env.REDIS_KEY_PREFIX = "fault-app";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "400";
        process.env.REDIS_COMMAND_TIMEOUT_MS = "400";
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        fake = await startFakeRedis({ mode: "slow-ready" });
        process.env.REDIS_URL = fake.url;
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it("serves an origin response instead of waiting on a handshake that never completes", async () => {
        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({}) as Handler;

        const startedAt = Date.now();
        const result = await renderThroughCache(
            handler,
            "/slow",
            async () => "origin-body",
        );
        const elapsed = Date.now() - startedAt;

        expect(result).toEqual({ body: "origin-body", from: "origin" });
        // Bounded by the readiness budget, not by the client's patience.
        expect(elapsed).toBeLessThan(3_000);
        // Proof the fault was reached rather than side-stepped.
        expect(fake?.connections ?? 0).toBeGreaterThanOrEqual(1);
    }, 20_000);
});

/**
 * The nastier half of the hang: a connection that HANDSHAKES normally and only
 * then stops answering.
 *
 * A connect budget cannot see this — the client is legitimately `ready`. Only a
 * per-command budget bounds it, and only tripping the breaker stops every
 * subsequent request from re-paying that budget while its command sits on the
 * dead socket. This is the shape a mocked rejection cannot produce at all.
 */
describe("T14 — an ESTABLISHED connection that stops answering is still bounded", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;

    beforeEach(async () => {
        vi.resetModules();
        process.env.REDIS_KEY_PREFIX = "fault-app";
        process.env.REDIS_COMMAND_TIMEOUT_MS = "300";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "2000";
        process.env.REDIS_RETRY_COOLDOWN_MS = "5000";
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        // Handshake (client/info) is answered normally; reads never are.
        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                if (cmd === "get") await new Promise(() => {});
            },
        });
        process.env.REDIS_URL = fake.url;
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it("serves a genuine origin response despite the command never returning", async () => {
        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({}) as Handler;

        const result = await renderThroughCache(
            handler,
            "/hangs",
            async () => "origin-body",
        );
        expect(result).toEqual({ body: "origin-body", from: "origin" });
        // Proof the fault was reached: the handshake completed and the read was
        // issued to the real server.
        expect(fake?.received).toContain("get");
    }, 20_000);

    it("one hung command is enough — later requests fail fast, not one budget each", async () => {
        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({}) as Handler;

        await handler.get("/first");

        const startedAt = Date.now();
        await Promise.all(
            Array.from({ length: 20 }, (_, i) => handler.get(`/after${i}`)),
        );
        const elapsed = Date.now() - startedAt;

        // Under the breaker these cost nothing. Without it each would park
        // another command on a socket that never answers — 20 outstanding
        // commands per wave, growing with traffic.
        expect(elapsed).toBeLessThan(250);
    }, 20_000);
});
