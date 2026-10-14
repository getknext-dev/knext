import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { REPLAY_STAMPS_SCRIPT } from "../adapters/use-cache-handler.js";
import { replayStampsModel } from "./helpers/replay-stamps-model";

/**
 * The `'use cache'` tag replay's compare-and-set Lua, run EXACTLY as shipped on
 * a REAL Redis.
 *
 * Every other replay test answers `REPLAY_STAMPS_SCRIPT` with a JavaScript model
 * (helpers/replay-stamps-model.ts): the fake Redis has no Lua engine, and it
 * keys the model by the imported script constant, so a mutated script is still
 * answered by the unmutated model and the suite stays green. This file is where
 * the Lua itself executes. Each case seeds a stamp hash relative to the server's
 * own clock, EVALs the script, and requires the result to equal the model's.
 *
 * The script reads `TIME` itself, so its `now` is not observable. It is bounded
 * instead: the server clock is read just before and just after the EVAL, and
 * the model is run at both bounds. A case is only meaningful if the model makes
 * the same decisions at both (seeds sit tens of seconds from now, far outside
 * the window); every value the script wrote must then lie between the two model
 * results, and all of them must be offset from the lower bound by the SAME
 * amount -- one `now` per EVAL, in milliseconds.
 *
 * Boundaries (`cur == now`, `want == now`, `want == cur`) cannot be seeded from
 * outside the script, since its `now` is unknown. They are reached from inside
 * one EVAL instead: a field repeated in ARGV is read back at the value the first
 * occurrence wrote, at the script's own `now`.
 *
 * LIVE LANE. Runs only with `KNEXT_REDIS_LIVE_URL` set; skipped otherwise, like
 * the `@getknext/db` live-Postgres lane. CI sets it in the dedicated
 * `use-cache-lua-live-redis` job (a digest-pinned Redis service container), and
 * `tests/use-cache-lua-live-workflow.test.ts` keeps that job a blocking gate
 * that runs this file with the variable set. Set, it FAILS on an unreachable
 * Redis rather than skipping. It never reads `REDIS_URL`, so it cannot be
 * pointed at an app's Redis by accident, and it refuses a non-loopback host.
 *
 *   redis-server --port 6399 --save '' &
 *   KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6399 \
 *     bun test packages/kn-next/src/__tests__/use-cache-replay-script-live-redis.test.ts
 */

const LIVE_URL = process.env.KNEXT_REDIS_LIVE_URL ?? "";
const LIVE = LIVE_URL !== "";

const SEC = 1000;
const DAY = 86_400 * SEC;

type Seed = Record<string, number>;

interface Case {
    name: string;
    /** Field -> offset from the server clock read before the EVAL. */
    seed: Seed;
    argv: string[];
    /** What the model must return for this case (fields written). */
    written: number;
}

const CASES: Case[] = [
    {
        name: "a fresh tag: s: to now, e: to now + ms",
        seed: {},
        argv: ["s:fresh", "0", "e:fresh", String(60 * SEC)],
        written: 2,
    },
    {
        name: "an expiry already in effect is kept, its s: moves forward to now",
        seed: { "s:past": -60 * SEC, "e:past": -60 * SEC },
        argv: ["s:past", "0", "e:past", String(60 * SEC)],
        written: 1,
    },
    {
        name: "a far pending expiry is brought forward to now + ms",
        seed: { "e:far": DAY },
        argv: ["e:far", String(60 * SEC)],
        written: 1,
    },
    {
        name: "a sooner pending expiry is kept (never pushed later)",
        seed: { "e:soon": 30 * SEC },
        argv: ["e:soon", String(60 * SEC)],
        written: 0,
    },
    {
        name: "an s: stamp ahead of now is kept (never moved back)",
        seed: { "s:ahead": 60 * SEC },
        argv: ["s:ahead", "0"],
        written: 0,
    },
    {
        name: "expire-now brings an expiry in effect up to now",
        seed: { "e:now-past": -60 * SEC },
        argv: ["e:now-past", "0"],
        written: 1,
    },
    {
        name: "expire-now brings a pending expiry forward to now",
        seed: { "e:now-future": 60 * SEC },
        argv: ["e:now-future", "0"],
        written: 1,
    },
    {
        name: "a mixed batch is decided field by field, untouched fields kept",
        seed: {
            "s:a": -60 * SEC,
            "e:a": -60 * SEC,
            "s:b": 60 * SEC,
            "e:b": DAY,
            "e:c": 30 * SEC,
            "e:d": -60 * SEC,
            "e:untouched": DAY,
        },
        argv: [
            "s:a",
            "0",
            "e:a",
            String(60 * SEC),
            "s:b",
            "0",
            "e:b",
            String(60 * SEC),
            "e:c",
            String(60 * SEC),
            "e:d",
            "0",
            "s:new",
            "0",
            "e:new",
            String(5 * SEC),
        ],
        written: 5,
    },
    {
        name: "boundary cur == now on an e: (expire-now twice): the second still writes now",
        seed: {},
        argv: ["e:twice", "0", "e:twice", "0"],
        written: 2,
    },
    {
        name: "boundary cur == now on an s:: the second does not write",
        seed: {},
        argv: ["s:twice", "0", "s:twice", "0"],
        written: 1,
    },
    {
        name: "boundary want == cur on a pending e:: the second does not write",
        seed: {},
        argv: ["e:same", String(60 * SEC), "e:same", String(60 * SEC)],
        written: 1,
    },
    {
        name: "boundary cur == now then a window: an expiry in effect is not moved into the future",
        seed: {},
        argv: ["e:then", "0", "e:then", String(60 * SEC)],
        written: 1,
    },
];

let client: Redis | undefined;
const KEY = `knext-live-test:{uc-replay}:${randomUUID()}:tags`;

/** The server clock in epoch ms, computed as the script computes its `now`. */
async function serverMs(c: Redis): Promise<number> {
    const [sec, usec] = await c.time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
}

function modelAt(seed: Map<string, string>, argv: string[], now: number) {
    const h = new Map(seed);
    const n = replayStampsModel(h, argv, now);
    return { n, h };
}

describe.skipIf(!LIVE)(
    "REPLAY_STAMPS_SCRIPT on a real Redis (SKIPPED unless KNEXT_REDIS_LIVE_URL is set)",
    () => {
        beforeAll(async () => {
            const host = new URL(LIVE_URL).hostname;
            if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
                throw new Error(
                    `KNEXT_REDIS_LIVE_URL must point at a loopback Redis (got host ${host}); this suite writes to it`,
                );
            }
            client = new Redis(LIVE_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                retryStrategy: () => null,
                enableOfflineQueue: false,
            });
            // Fail closed: an unreachable Redis is a failure, never a skip.
            await client.connect();
        });

        afterAll(async () => {
            if (client) {
                await client.del(KEY).catch(() => {});
                client.disconnect();
            }
        });

        it("reaches the Redis it was pointed at", async () => {
            expect(client).toBeDefined();
            expect(await (client as Redis).ping()).toBe("PONG");
        });

        for (const tc of CASES) {
            it(`${tc.name} -- the script's result equals the model's`, async () => {
                const c = client as Redis;
                await c.del(KEY);
                const base = await serverMs(c);
                const seed = new Map(
                    Object.entries(tc.seed).map(([f, off]) => [
                        f,
                        String(base + off),
                    ]),
                );
                if (seed.size > 0) await c.hset(KEY, Object.fromEntries(seed));

                const lo = await serverMs(c);
                const n = Number(
                    await c.eval(REPLAY_STAMPS_SCRIPT, 1, KEY, ...tc.argv),
                );
                const hi = await serverMs(c);
                const after = new Map(Object.entries(await c.hgetall(KEY)));

                const atLo = modelAt(seed, tc.argv, lo);
                const atHi = modelAt(seed, tc.argv, hi);
                // The case is only decidable if the model decides the same at both bounds.
                expect(atLo.n).toBe(atHi.n);
                expect(atLo.n).toBe(tc.written);
                expect([...atLo.h.keys()].sort()).toEqual(
                    [...atHi.h.keys()].sort(),
                );

                expect(n).toBe(atLo.n);
                expect([...after.keys()].sort()).toEqual(
                    [...atLo.h.keys()].sort(),
                );

                const offsets = new Set<number>();
                for (const [field, value] of after) {
                    expect(value).toMatch(/^\d+$/);
                    const want = atLo.h.get(field) as string;
                    if (want === atHi.h.get(field)) {
                        // Same at both bounds: a stamp the script must have left alone.
                        expect(value).toBe(want);
                        continue;
                    }
                    const v = Number(value);
                    expect(v).toBeGreaterThanOrEqual(Number(want));
                    expect(v).toBeLessThanOrEqual(Number(atHi.h.get(field)));
                    offsets.add(v - Number(want));
                }
                // Every value the script wrote is `now + constant` for ONE `now`.
                expect(offsets.size).toBeLessThanOrEqual(1);
            });
        }
    },
);
