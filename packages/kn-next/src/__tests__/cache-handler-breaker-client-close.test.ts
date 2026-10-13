import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * A breaker trip CLOSES the client it drops, on both Redis clients.
 *
 * `markUnhealthy` drops the current client and calls `disconnect()` on it.
 * ioredis has that method. Bun's native client does not: its API is `close()`
 * (bun-types 1.4.2, `redis.d.ts`), and the budgeted proxy in front of it
 * forwarded `disconnect` as `undefined`. The resulting TypeError was swallowed
 * by a bare `catch {}`, so the dropped native client stayed connected (with
 * `autoReconnect: true`) while the next connect built a new one. Every trip
 * leaked one connection, so a flapping Redis grew connections without bound.
 *
 * The fake server counts the TCP connections it holds open, which is what a
 * leak is. Asserting on a spy would only prove a method was called.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const COOLDOWN_MS = 150;
const TRIPS = 5;

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error("waitFor: timed out");
        await sleep(10);
    }
}

const CLIENTS = [
    { name: "ioredis", selector: "ioredis" as string | undefined },
    { name: "Bun native", selector: undefined },
];

for (const client of CLIENTS) {
    describe(`breaker trip closes the dropped client (${client.name})`, () => {
        const original = { ...process.env };
        let fake: FakeRedis | undefined;
        let gen = 0;
        let failGets = false;

        beforeEach(() => {
            gen += 1;
            failGets = false;
            process.env.REDIS_KEY_PREFIX = "breaker-close";
            process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
            if (client.selector)
                process.env.KNEXT_CACHE_REDIS_CLIENT = client.selector;
            else delete process.env.KNEXT_CACHE_REDIS_CLIENT;
            spyOn(console, "error").mockImplementation(() => {});
            spyOn(console, "warn").mockImplementation(() => {});
            spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(async () => {
            await fake?.close();
            fake = undefined;
            process.env = { ...original };
            jest.restoreAllMocks();
        });

        async function handler(): Promise<Any> {
            fake = await startFakeRedis({
                // A command that FAILS on a live connection: the server stays
                // up, so only the client can close the socket.
                errorFor: (cmd) =>
                    failGets && cmd === "get" ? "boom" : undefined,
            });
            process.env.REDIS_URL = fake.url;
            const mod = await import(
                `${CACHE_HANDLER}?breaker-close=${client.name}-${gen}`
            );
            return new mod.default({});
        }

        it(`${TRIPS} trips leave at most one open connection, and each dropped client is closed`, async () => {
            const h = await handler();
            const f = fake as FakeRedis;
            // A healthy read connects: one client, one connection.
            expect(await h.get("/warm", { kind: "APP_PAGE" })).toBeNull();
            expect(f.openConnections()).toBe(1);

            for (let trip = 1; trip <= TRIPS; trip++) {
                failGets = true;
                // The read faults, which trips the breaker and drops the client.
                expect(await h.get("/fault", { kind: "APP_PAGE" })).toBeNull();
                failGets = false;

                // The dropped client is CLOSED, not merely forgotten: the server
                // sees its socket go before any reconnect happens.
                await waitFor(() => f.openConnections() === 0, 1000).catch(
                    () => {},
                );
                expect(
                    f.openConnections(),
                    `trip ${trip}: the dropped client's connection is still open`,
                ).toBe(0);

                // After the cooldown the next read builds a new client.
                await sleep(COOLDOWN_MS + 30);
                expect(await h.get("/after", { kind: "APP_PAGE" })).toBeNull();
                expect(
                    f.openConnections(),
                    `trip ${trip}: open connections after the cooldown`,
                ).toBeLessThanOrEqual(1);
            }

            // One connection per client the handler built: the first, plus one
            // per trip. A leak shows up above, not here; this pins that every
            // cooldown really did reconnect, so the loop measured something.
            expect(f.connections).toBe(TRIPS + 1);
            expect(f.openConnections()).toBe(1);
        });

        // The `'use cache'` handler shares the ISR handler's client and breaker
        // (`core`), so a trip it causes must close the client the same way.
        it("a trip through the 'use cache' handler closes the dropped client too", async () => {
            await handler();
            const f = fake as FakeRedis;
            const mod = await import(
                `${CACHE_HANDLER}?breaker-close=${client.name}-${gen}`
            );
            const uc = mod.default.forUseCache("default");

            for (let trip = 1; trip <= TRIPS; trip++) {
                expect(await uc.get(`k${trip}`, [])).toBeUndefined();
                expect(f.openConnections()).toBe(1);
                failGets = true;
                expect(await uc.get(`k${trip}`, [])).toBeUndefined();
                failGets = false;
                await waitFor(() => f.openConnections() === 0, 1000).catch(
                    () => {},
                );
                expect(
                    f.openConnections(),
                    `trip ${trip}: the dropped client's connection is still open`,
                ).toBe(0);
                await sleep(COOLDOWN_MS + 30);
            }
            expect(f.connections).toBe(TRIPS);
        });
    });
}

/**
 * A client that cannot be closed is a leak the operator must hear about, once.
 *
 * The old `catch {}` swallowed exactly the TypeError that hid this bug. A
 * failure to close is now reported at error level, a single time per module
 * instance: the breaker can trip every few seconds, and the message says the
 * same thing each time.
 */
describe("a client that cannot be closed is reported, once", () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    it("logs the close failure on the first trip and stays quiet after", async () => {
        process.env.KNEXT_TEST_SEAMS = "1";
        process.env.REDIS_RETRY_COOLDOWN_MS = "0";
        delete process.env.REDIS_URL;
        const errors: unknown[][] = [];
        spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            errors.push(args);
        });
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
        const mod = await import(
            `${CACHE_HANDLER}?breaker-close=uncloseable-${Math.random()}`
        );
        const h = new mod.default({});
        const closeFailures = () =>
            errors.filter((a) =>
                String(a[0]).includes("could not close the Redis client"),
            );

        for (let trip = 0; trip < 3; trip++) {
            // Native-shaped (no `.on`), connected, every command faults, and
            // it has neither `close` nor `disconnect`.
            mod.__setRedisClientForTests({
                connected: true,
                send: async () => {
                    throw new Error("boom");
                },
            });
            expect(await h.get("/x", { kind: "APP_PAGE" })).toBeNull();
        }

        expect(closeFailures()).toHaveLength(1);
        expect(String(closeFailures()[0])).toContain("TypeError");
    });
});
