import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import {
    createUseCacheHandler,
    REPLAY_STAMPS_SCRIPT,
    type UseCacheCore,
} from "../adapters/use-cache-handler.js";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";
import { replayStampsModel } from "./helpers/replay-stamps-model";

/**
 * `'use cache'` tag stamps an outage kept from Redis are replayed when the
 * breaker closes.
 *
 * `updateTags` writes the tag stamps every pod compares its entries with. With
 * the Redis breaker open (or Redis faulting under the write) that write cannot
 * land, and before the replay it was simply lost: the ISR page re-rendered once
 * its own invalidation was replayed, but a `'use cache'` function inside it kept
 * returning its cached value until that entry's TTL (24 h by default).
 *
 * Same shape as the ISR replay (cache-handler-breaker-invalidation-replay):
 * per process, deduplicated, bounded at 1000 tags with a collapse past it, one
 * run at a time off the request path, a probe at the moment the breaker
 * closes, and a generation check so a drop recorded mid-replay is kept. The
 * stamps are written at REPLAY time, so they are never older than the call
 * they replay, and by a compare-and-set script, so a replay never undoes a
 * stamp that landed first: an expiry already in effect is never moved into the
 * future, a pending one is never pushed later, and a stale stamp only moves
 * forward.
 *
 * Two layers: against a real RESP server through BOTH Redis clients (ioredis
 * and Bun's native client, which production uses on Bun), with each "pod" a
 * fresh evaluation of cache-handler.js; and against a scripted core for the
 * races a real socket cannot hold still.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const REGISTRY: string = "../adapters/cache-write-registry.js";
const PREFIX = "ucr";
const TAGS_KEY = `${PREFIX}:uc:tags`;
const COOLDOWN_MS = 300;
const BOUND = 1000;
const BATCH = 100;

// biome-ignore lint/suspicious/noExplicitAny: the handler modules are untyped plain JS
type Any = any;
interface WriteRegistry {
    drainCacheWrites(timeoutMs?: number): Promise<void>;
    inFlightCacheWriteCount(): number;
}
interface UseCacheHandler {
    get(cacheKey: string, softTags?: string[]): Promise<Any>;
    set(cacheKey: string, pending: Promise<Any>): Promise<void>;
    getExpiration(tags: string[]): Promise<number>;
    updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error("waitFor: timed out");
        await sleep(10);
    }
}

/** Next's clock for an entry's `timestamp`: `performance`, not `Date.now`. */
const nextNow = () => Math.round(performance.timeOrigin + performance.now());

function entryOf(tags: string[]) {
    return {
        value: new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode("cached"));
                c.close();
            },
        }),
        tags,
        stale: 300,
        timestamp: nextNow(),
        expire: 3600,
        revalidate: 900,
    };
}

const counters = () =>
    ((globalThis as Record<symbol, unknown>)[
        Symbol.for("knext.cache.useCache.counters")
    ] ?? {}) as Record<string, number>;

/**
 * Wait until the fake's clock (`TIME` is `Date.now`) is well past `stamp`.
 *
 * Each pod estimates its offset to the Redis clock from one `TIME` round trip,
 * so two pods' estimates can differ by up to half a round trip plus the reply's
 * 1 ms resolution. A stamp pod A wrote a moment ago can therefore still be a
 * millisecond or two in pod B's future, and an expiry in the future does not
 * expire yet (Next's own rule). Reading only once the server clock is clearly
 * past the stamp makes a cross-pod read deterministic.
 */
async function pastServerTime(stamp: number) {
    await waitFor(() => Date.now() > stamp + 50);
}

const CLIENTS = [
    { name: "ioredis", selector: "ioredis" as string | undefined },
    { name: "Bun native", selector: undefined },
];

for (const client of CLIENTS) {
    describe(`'use cache' tag replay after a breaker outage (${client.name})`, () => {
        const original = { ...process.env };
        let fake: FakeRedis | undefined;
        let gen = 0;
        let failNextGet = false;
        let errorFor: (cmd: string, args: string[]) => string | undefined =
            () => undefined;

        beforeEach(() => {
            failNextGet = false;
            errorFor = () => undefined;
            process.env.REDIS_KEY_PREFIX = PREFIX;
            process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
            if (client.selector)
                process.env.KNEXT_CACHE_REDIS_CLIENT = client.selector;
            else delete process.env.KNEXT_CACHE_REDIS_CLIENT;
            spyOn(console, "error").mockImplementation(() => {});
            spyOn(console, "warn").mockImplementation(() => {});
            spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(async () => {
            // Let any probe/replay of this case settle before its server goes.
            await sleep(COOLDOWN_MS + 50);
            await fake?.close();
            fake = undefined;
            process.env = { ...original };
            jest.restoreAllMocks();
        });

        async function withRedis() {
            fake = await startFakeRedis({
                scripts: {
                    [REPLAY_STAMPS_SCRIPT]: (keys, argv, { hashes }) => {
                        const h =
                            hashes.get(keys[0] as string) ??
                            new Map<string, string>();
                        hashes.set(keys[0] as string, h);
                        return `:${replayStampsModel(h, argv, Date.now())}\r\n`;
                    },
                },
                errorFor: (cmd, args) => {
                    if (failNextGet && cmd === "get") {
                        failNextGet = false;
                        return "boom";
                    }
                    return errorFor(cmd, args);
                },
            });
            process.env.REDIS_URL = fake.url;
            return fake;
        }

        /** A pod: a fresh evaluation of cache-handler.js (its own breaker and backlog). */
        async function pod(kind: "default" | "remote" = "default") {
            gen += 1;
            const mod = await import(
                `${CACHE_HANDLER}?ucreplay=${client.name}-${gen}`
            );
            return (
                mod.CacheHandler as {
                    forUseCache(kind: string): UseCacheHandler;
                }
            ).forUseCache(kind);
        }

        /** Both kinds of ONE pod: they share its breaker and its backlog. */
        async function podWithBothKinds() {
            gen += 1;
            const mod = await import(
                `${CACHE_HANDLER}?ucreplay=${client.name}-${gen}`
            );
            const handlers = mod.CacheHandler as {
                forUseCache(kind: string): UseCacheHandler;
            };
            return {
                a: handlers.forUseCache("default"),
                remote: handlers.forUseCache("remote"),
            };
        }

        /** Open this pod's breaker with one faulting read; Redis is healthy again after. */
        async function openBreaker(h: UseCacheHandler) {
            failNextGet = true;
            expect(await h.get("never-stored", [])).toBeUndefined();
            expect(failNextGet).toBe(false);
        }

        const stamp = (field: string) => {
            const v = fake?.hashes.get(TAGS_KEY)?.get(field);
            return v === undefined ? undefined : Number(v);
        };
        /** The replay's writes: one compare-and-set EVAL per batch. */
        const replayWrites = () =>
            (fake?.commands ?? []).filter(
                (c) =>
                    c.cmd === "eval" &&
                    c.args[0] === REPLAY_STAMPS_SCRIPT &&
                    c.args[2] === TAGS_KEY,
            );

        it("breaker open during updateTags, then closed: another pod's read misses with no TTL wait and no further request", async () => {
            await withRedis();
            const a = await pod();
            const b = await pod();
            await a.set("x", Promise.resolve(entryOf(["t"])));
            expect(await b.get("x", [])).toBeDefined();

            await openBreaker(a);
            const calledAt = Date.now();
            await a.updateTags(["t"]);
            // The breaker was open: nothing reached Redis.
            expect(stamp("e:t")).toBeUndefined();

            // No request on pod A after the outage: the replay is driven by
            // the handler itself, at the moment the breaker closes.
            await waitFor(() => stamp("e:t") !== undefined);
            const written = stamp("e:t") as number;
            // Never older than the call it replays.
            expect(written).toBeGreaterThanOrEqual(calledAt);
            await pastServerTime(written);
            expect(
                await b.get("x", []),
                "the replayed invalidation reaches the other pod",
            ).toBeUndefined();
            // Replayed once, then forgotten.
            await sleep(COOLDOWN_MS + 100);
            expect(replayWrites()).toHaveLength(1);
        });

        it("never replays while the breaker is still open", async () => {
            await withRedis();
            const a = await pod();
            await openBreaker(a);
            await a.updateTags(["t"]);
            await sleep(COOLDOWN_MS / 3);
            expect(replayWrites()).toHaveLength(0);
            await waitFor(() => stamp("e:t") !== undefined);
        });

        it("replays the stamps the call would have written: stale + expire window, stale only, or expire now", async () => {
            await withRedis();
            const a = await pod();
            await openBreaker(a);
            await a.updateTags(["win"], { expire: 60 });
            await a.updateTags(["soft"], {});
            await a.updateTags(["hard"]);
            await waitFor(() => replayWrites().length > 0);
            const s = stamp("s:win") as number;
            expect(s).toBeGreaterThan(0);
            expect(stamp("e:win")).toBe(s + 60_000);
            // No `expire` in the profile: the existing expiry is left alone.
            expect(stamp("s:soft")).toBe(s);
            expect(stamp("e:soft")).toBeUndefined();
            // No durations at all: expired at once, the stale stamp untouched.
            expect(stamp("e:hard")).toBe(s);
            expect(stamp("s:hard")).toBeUndefined();
        });

        it("deduplicates: one tag dropped many times, by both kinds of one process, is replayed once in one write", async () => {
            await withRedis();
            const { a, remote } = await podWithBothKinds();
            const before = counters().tagsReplayed ?? 0;
            await openBreaker(a);
            // Next calls updateTags on every configured kind for one revalidateTag.
            for (let i = 0; i < 5; i++) {
                await a.updateTags(["x", "y"]);
                await remote.updateTags(["x", "y"]);
            }
            await waitFor(() => replayWrites().length > 0);
            await sleep(50);
            expect(replayWrites()).toHaveLength(1);
            const fields = replayWrites()[0]?.args.slice(3) ?? [];
            expect(fields.filter((f) => f === "e:x")).toHaveLength(1);
            expect(fields.filter((f) => f === "e:y")).toHaveLength(1);
            expect((counters().tagsReplayed ?? 0) - before).toBe(2);
        });

        it(`the bound: ${BOUND} dropped tags are each stamped, in batches, and no entry is deleted`, async () => {
            await withRedis();
            const a = await pod();
            await a.set("keep", Promise.resolve(entryOf(["unrelated"])));
            await openBreaker(a);
            const tags = Array.from({ length: BOUND }, (_, i) => `t${i}`);
            await a.updateTags(tags);
            await waitFor(() => stamp(`e:t${BOUND - 1}`) !== undefined, 8000);
            expect(stamp("e:t0")).toBeDefined();
            expect(replayWrites()).toHaveLength(BOUND / BATCH);
            expect((fake?.commands ?? []).some((c) => c.cmd === "scan")).toBe(
                false,
            );
            expect(fake?.strings.has(`${PREFIX}:uc:default:keep`)).toBe(true);
        });

        it(`past the bound (${BOUND + 1} tags) the backlog collapses: every 'use cache' entry of this app is deleted, once`, async () => {
            await withRedis();
            const a = await pod();
            const remote = await pod("remote");
            const before = counters().tagsCollapsed ?? 0;
            await a.set("p", Promise.resolve(entryOf(["t0"])));
            await remote.set("q", Promise.resolve(entryOf(["unrelated"])));
            fake?.hashes.set(TAGS_KEY, new Map([["e:old", "1"]]));
            // An ISR entry of this app, and another app on the same Redis.
            fake?.strings.set(`${PREFIX}:cache:/isr`, "{}");
            fake?.strings.set("other-app:uc:default:z", "{}");
            await openBreaker(a);
            await a.updateTags(
                Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
            );
            const warned = (
                console.warn as unknown as { mock: { calls: unknown[][] } }
            ).mock.calls.filter((c) => String(c[0]).includes("replay"));
            expect(warned).toHaveLength(1);

            await waitFor(() => (counters().tagsCollapsed ?? 0) - before === 1);
            expect(fake?.strings.has(`${PREFIX}:uc:default:p`)).toBe(false);
            expect(fake?.strings.has(`${PREFIX}:uc:remote:q`)).toBe(false);
            expect(fake?.strings.has(`${PREFIX}:cache:/isr`)).toBe(true);
            expect(fake?.strings.has("other-app:uc:default:z")).toBe(true);
            // The stamp hash is never swept, and the lost tags are not stamped
            // one by one: the collapse replaces the list.
            const deleted = (fake?.commands ?? [])
                .filter((c) => c.cmd === "del")
                .flatMap((c) => c.args);
            expect(deleted).not.toContain(TAGS_KEY);
            expect(replayWrites()).toHaveLength(0);
            await sleep(COOLDOWN_MS + 100);
            expect((counters().tagsCollapsed ?? 0) - before).toBe(1);
        });

        it("a fault during the replay stops it at once (no storm); the rest is replayed after the next cooldown", async () => {
            await withRedis();
            const a = await pod();
            await openBreaker(a);
            const tags = Array.from(
                { length: 2 * BATCH + 50 },
                (_, i) => `f${i}`,
            );
            await a.updateTags(tags);
            // Batch 2 faults as a dead link would: the script AND the
            // read-then-write it falls back to.
            let faults = 0;
            errorFor = (cmd, args) => {
                if (
                    (cmd === "eval" || cmd === "hset") &&
                    args.includes(`e:f${BATCH}`) &&
                    faults < 2
                ) {
                    faults += 1;
                    return "boom";
                }
                return undefined;
            };
            await waitFor(
                () => stamp(`e:f${2 * BATCH + 49}`) !== undefined,
                6000,
            );
            const firsts = replayWrites().map((c) => c.args[3]);
            // Batch 1 done, batch 2 faulted -> stop (batch 3 not tried); then 2, 3.
            expect(firsts).toEqual([
                "e:f0",
                `e:f${BATCH}`,
                `e:f${BATCH}`,
                `e:f${2 * BATCH}`,
            ]);
        });

        it("a tag write that faults with the breaker closed is replayed too", async () => {
            await withRedis();
            const a = await pod();
            const b = await pod();
            await a.set("x", Promise.resolve(entryOf(["t"])));
            let faults = 0;
            errorFor = (cmd) => {
                if (cmd === "hset" && faults === 0) {
                    faults += 1;
                    return "boom";
                }
                return undefined;
            };
            await a.updateTags(["t"]);
            expect(stamp("e:t")).toBeUndefined();
            await waitFor(() => stamp("e:t") !== undefined);
            await pastServerTime(stamp("e:t") as number);
            expect(await b.get("x", [])).toBeUndefined();
        });

        it("a hard updateTags another pod lands first is not undone by the late replay of an earlier stale-with-window drop", async () => {
            await withRedis();
            const a = await pod();
            const b = await pod();
            await b.set("x", Promise.resolve(entryOf(["t"])));
            await openBreaker(a);
            // Pod A drops a revalidateTag(t, profile) ...
            await a.updateTags(["t"], { expire: 3600 });
            expect(stamp("s:t")).toBeUndefined();
            // ... then pod B, whose breaker never opened, expires t outright.
            await b.updateTags(["t"]);
            const hard = stamp("e:t") as number;
            expect(hard).toBeGreaterThan(0);
            // A's replay lands after B's write.
            await waitFor(() => stamp("s:t") !== undefined);
            expect(
                stamp("e:t"),
                "an expiry already in effect is never moved into the future",
            ).toBe(hard);
            await pastServerTime(hard);
            expect(
                await b.get("x", []),
                "an entry made before the hard invalidation stays a miss",
            ).toBeUndefined();
        });

        it("a Redis that refuses scripts: the replay lands by read-then-write under the same rule, and the refusal never trips the breaker", async () => {
            await withRedis();
            errorFor = (cmd) =>
                cmd === "eval" ? "scripts disabled" : undefined;
            const a = await pod();
            const b = await pod();
            await b.set("x", Promise.resolve(entryOf(["t"])));
            const t0 = Date.now();
            const old = t0 - 10_000;
            const far = t0 + 10_000_000;
            const ahead = t0 + 600_000;
            // w: a pending expiry far out and a stale stamp ahead of now;
            // h: an expiry long in effect.
            fake?.hashes.set(
                TAGS_KEY,
                new Map([
                    ["e:w", String(far)],
                    ["s:w", String(ahead)],
                    ["e:h", String(old)],
                ]),
            );
            await openBreaker(a);
            await a.updateTags(["t", "u", "w"], { expire: 3600 });
            await a.updateTags(["h"]);
            await b.updateTags(["t"]);
            const hard = stamp("e:t") as number;
            await waitFor(() => stamp("s:u") !== undefined);
            const at = stamp("s:u") as number;
            // Same rule as the script: the expiry in effect is kept, a tag
            // with none gets the profile's window, a pending one is only
            // brought forward, a stale stamp never moves back, and
            // expire-now lands at the replay time.
            expect(stamp("e:t")).toBe(hard);
            expect(stamp("s:t")).toBe(at);
            expect(stamp("e:u")).toBe(at + 3_600_000);
            expect(stamp("e:w")).toBe(at + 3_600_000);
            expect(stamp("s:w")).toBe(ahead);
            expect(stamp("e:h")).toBe(at);
            await pastServerTime(hard);
            expect(await b.get("x", [])).toBeUndefined();
            // The refused EVAL did not open pod A's breaker: a write right
            // after the replay reaches Redis.
            await a.set("after", Promise.resolve(entryOf(["v"])));
            expect(fake?.strings.has(`${PREFIX}:uc:default:after`)).toBe(true);
            await sleep(COOLDOWN_MS + 100);
            expect(replayWrites()).toHaveLength(1);
        });
    });
}

/**
 * A scripted `core`: the connection, breaker and commands under the test's
 * hand, so the races a real socket cannot hold still are reached on purpose.
 * `open = true` is a breaker that hands out no client.
 */
function scriptedCore(
    opts: { redisConfigured?: boolean; retryMs?: number } = {},
) {
    const hashes = new Map<string, string>();
    const strings = new Map<string, string>();
    const log: { name: string; args: string[] }[] = [];
    const everSeen: string[] = [];
    let held: { name: string; release: () => void } | undefined;
    let holdNext: string | undefined;
    const state = {
        open: false,
        retryMs: opts.retryMs ?? 20,
        configured: opts.redisConfigured ?? true,
        failWrite: (_args: string[]) => false,
    };
    const clientToken = { scripted: true };
    const core: UseCacheCore & { retryInMs(): number } = {
        ensureConnected: async () => (state.open ? null : clientToken),
        redisCall: async <T>(fn: () => Promise<T>) => {
            try {
                return await fn();
            } catch (err) {
                state.open = true;
                throw err;
            }
        },
        command: async (_c: unknown, name: string, args: string[]) => {
            log.push({ name, args });
            if (holdNext === name) {
                holdNext = undefined;
                await new Promise<void>((release) => {
                    held = { name, release };
                });
            }
            switch (name) {
                case "TIME": {
                    const us = Date.now() * 1000;
                    return [String(Math.floor(us / 1e6)), String(us % 1e6)];
                }
                case "HSET":
                    // A faulted command; the client stays usable, so only the
                    // replay's own loop can be what stops the run.
                    if (state.failWrite(args)) throw new Error("boom");
                    for (let i = 1; i + 1 < args.length; i += 2)
                        hashes.set(args[i] as string, args[i + 1] as string);
                    return 1;
                case "EVAL":
                    if (args[0] !== REPLAY_STAMPS_SCRIPT)
                        throw new Error("unknown script");
                    if (state.failWrite(args)) throw new Error("boom");
                    // The script's own TIME: when it RUNS, not when it was sent.
                    return replayStampsModel(hashes, args.slice(3), Date.now());
                case "HMGET":
                    return args.slice(1).map((f) => hashes.get(f) ?? null);
                case "SCAN": {
                    const cursor = Number(args[0]);
                    // A stable keyspace order, as a real SCAN cursor gives: a
                    // key deleted mid-iteration does not shift later pages.
                    for (const k of strings.keys())
                        if (!everSeen.includes(k)) everSeen.push(k);
                    const keys = [...everSeen, "p:uc:tags"];
                    const page = keys.slice(cursor, cursor + 2);
                    const next = cursor + 2 >= keys.length ? 0 : cursor + 2;
                    return [String(next), page];
                }
                case "DEL":
                    for (const k of args) strings.delete(k);
                    return args.length;
                default:
                    return null;
            }
        },
        keyPrefix: () => "p",
        buildId: () => undefined,
        redisConfigured: () => state.configured,
        retryInMs: () => state.retryMs,
    };
    return {
        core,
        state,
        hashes,
        strings,
        log,
        holdNext: (name: string) => {
            holdNext = name;
        },
        isHeld: () => held !== undefined,
        release: () => {
            const h = held;
            held = undefined;
            h?.release();
        },
        count: (name: string) => log.filter((c) => c.name === name).length,
    };
}

describe("'use cache' tag replay races (scripted core)", () => {
    beforeEach(() => {
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("a drop of the same tag recorded while that tag's replay write is in flight is not forgotten", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        const before = counters().tagsReplayed ?? 0;
        s.state.open = true;
        await h.updateTags(["x"]);
        s.holdNext("EVAL");
        s.state.open = false;
        await waitFor(s.isHeld);
        // The replay's write of x is in flight. A newer updateTags(x) finds
        // the breaker open again and is dropped: recorded mid-replay.
        s.state.open = true;
        await h.updateTags(["x"]);
        s.state.open = false;
        s.release();
        // The first write completed; the newer drop is replayed again.
        await waitFor(() => s.count("EVAL") >= 2);
        await sleep(100);
        expect(s.count("EVAL")).toBe(2);
        // Counted once, when it is finally forgotten, not once per write.
        expect((counters().tagsReplayed ?? 0) - before).toBe(1);
    });

    it("the same pod's newer hard updateTags, landing while its replay is in flight, is not undone by that replay", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(["t"], { expire: 3600 });
        s.holdNext("EVAL");
        s.state.open = false;
        await waitFor(s.isHeld);
        await sleep(5);
        // A live revalidate on this pod: the breaker is closed, so it writes.
        await h.updateTags(["t"]);
        const hard = Number(s.hashes.get("e:t"));
        expect(hard).toBeGreaterThan(0);
        s.release();
        await waitFor(() => s.hashes.has("s:t"));
        expect(Number(s.hashes.get("e:t"))).toBe(hard);
    });

    it("a replay never moves an expiry in effect into the future, never delays a pending one, and only moves a stale stamp forward", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        const t0 = Date.now();
        const old = t0 - 10_000;
        const far = t0 + 10_000_000;
        const soon = t0 + 2_000;
        const ahead = t0 + 50_000;
        for (const [f, v] of [
            ["e:past", old],
            ["e:far", far],
            ["e:soon", soon],
            ["e:hardPast", old],
            ["e:hardFar", far],
            ["s:ahead", ahead],
        ] as const)
            s.hashes.set(f, String(v));
        s.state.open = true;
        await h.updateTags(["past", "far", "soon", "fresh", "ahead"], {
            expire: 60,
        });
        await h.updateTags(["hardPast", "hardFar"]);
        s.state.open = false;
        await h.getExpiration(["unrelated"]);
        await waitFor(() => s.hashes.has("s:fresh"));
        const at = Number(s.hashes.get("s:fresh"));
        expect(at).toBeGreaterThanOrEqual(t0);
        // In effect: kept (the entries it expired stay expired).
        expect(Number(s.hashes.get("e:past"))).toBe(old);
        expect(Number(s.hashes.get("s:past"))).toBe(at);
        // Pending: the earlier of the two deadlines.
        expect(Number(s.hashes.get("e:far"))).toBe(at + 60_000);
        expect(Number(s.hashes.get("e:soon"))).toBe(soon);
        // None yet: the profile's window.
        expect(Number(s.hashes.get("e:fresh"))).toBe(at + 60_000);
        // A stale stamp is never moved back.
        expect(Number(s.hashes.get("s:ahead"))).toBe(ahead);
        // Expire-now always lands at the replay time.
        expect(Number(s.hashes.get("e:hardPast"))).toBe(at);
        expect(Number(s.hashes.get("e:hardFar"))).toBe(at);
    });

    it("a drop recorded during the collapse sweep keeps the collapse for another sweep", async () => {
        const s = scriptedCore();
        for (let i = 0; i < 5; i++) s.strings.set(`p:uc:default:k${i}`, "{}");
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        const before = counters().tagsCollapsed ?? 0;
        s.state.open = true;
        await h.updateTags(
            Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
        );
        s.holdNext("SCAN");
        s.state.open = false;
        await waitFor(s.isHeld);
        s.state.open = true;
        await h.updateTags(["z"]);
        s.state.open = false;
        s.release();
        // z's entries may predate pages already swept: a second sweep runs,
        // from the first page, rather than z being forgotten.
        await waitFor(() => (counters().tagsCollapsed ?? 0) - before >= 2);
        const fromStart = s.log.filter(
            (c) => c.name === "SCAN" && c.args[0] === "0",
        ).length;
        expect(fromStart).toBe(2);
        // The stamp hash is never part of a sweep's delete.
        const deleted = s.log
            .filter((c) => c.name === "DEL")
            .flatMap((c) => c.args);
        expect(deleted).not.toContain("p:uc:tags");
        expect(s.strings.size).toBe(0);
        expect(s.hashes.has("e:z")).toBe(false);
    });

    it("the replay is off the request path, and in the SIGTERM drain registry", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(["x"]);
        s.holdNext("EVAL");
        s.state.open = false;
        // A request after the close starts the replay without waiting on it.
        const t0 = Date.now();
        await h.getExpiration(["unrelated"]);
        expect(Date.now() - t0).toBeLessThan(500);
        await waitFor(s.isHeld);
        const registry = (await import(REGISTRY)) as unknown as WriteRegistry;
        expect(registry.inFlightCacheWriteCount()).toBeGreaterThan(0);
        s.release();
        await registry.drainCacheWrites(2000);
        expect(s.hashes.has("e:x")).toBe(true);
    });

    it("the first request that finds the breaker closed starts the replay, ahead of the probe", async () => {
        // A probe a minute away: only the request can be what starts it.
        const s = scriptedCore({ retryMs: 60_000 });
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(["x"]);
        s.state.open = false;
        await h.get("unrelated", []);
        await waitFor(() => s.hashes.has("e:x"), 2000);
    });

    it("the probe is armed for the moment the breaker closes, and unref'd", async () => {
        const retryMs = 45_678;
        const s = scriptedCore({ retryMs });
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        const realSetTimeout = globalThis.setTimeout;
        const armed: { delay: number; timer: Any }[] = [];
        globalThis.setTimeout = ((
            fn: () => void,
            delay?: number,
            ...rest: unknown[]
        ) => {
            const timer = realSetTimeout(fn, delay, ...rest);
            armed.push({ delay: Number(delay), timer });
            return timer;
        }) as unknown as typeof setTimeout;
        try {
            await h.updateTags(["x"]);
            await sleep(20);
        } finally {
            globalThis.setTimeout = realSetTimeout;
        }
        const probes = armed.filter((a) => a.delay === retryMs);
        expect(probes).toHaveLength(1);
        expect(probes[0]?.timer.hasRef()).toBe(false);
        clearTimeout(probes[0]?.timer);
    });

    it("with no Redis configured nothing is kept and nothing is replayed", async () => {
        const s = scriptedCore({ redisConfigured: false });
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(["x"]);
        // Not even a backlog to overflow: no replay warning past the bound.
        await h.updateTags(
            Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
        );
        const warned = (
            console.warn as unknown as { mock: { calls: unknown[][] } }
        ).mock.calls.filter((c) => String(c[0]).includes("replay"));
        expect(warned).toEqual([]);
        s.state.open = false;
        await h.getExpiration(["y"]);
        await sleep(100);
        expect(s.count("HSET") + s.count("EVAL")).toBe(0);
    });

    it("a Redis client that can no longer be loaded at all drops the backlog: nothing left to replay into", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(["x"]);
        // The pod falls back to no Redis before the probe fires.
        s.state.configured = false;
        await sleep(100);
        s.state.configured = true;
        s.state.open = false;
        await h.getExpiration(["y"]);
        await sleep(100);
        expect(s.count("HSET") + s.count("EVAL")).toBe(0);
    });

    it("a fault part-way through the replay stops the run there, even with the client still usable", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        await h.updateTags(
            Array.from({ length: 2 * BATCH + 50 }, (_, i) => `f${i}`),
        );
        let faults = 0;
        // Batch 2 faults as a dead link would: the script AND the
        // read-then-write it falls back to.
        s.state.failWrite = (args) =>
            args.includes(`e:f${BATCH}`) && faults++ < 2;
        s.state.open = false;
        // The fault trips the scripted breaker; close it again for the next run.
        await waitFor(() => s.state.open);
        s.state.open = false;
        await waitFor(() => s.hashes.has(`e:f${2 * BATCH + 49}`));
        const firsts = s.log
            .filter((c) => c.name === "EVAL")
            .map((c) => c.args[3]);
        // Batch 2 faulted: batch 3 waits for the next run, after batch 2.
        expect(firsts).toEqual([
            "e:f0",
            `e:f${BATCH}`,
            `e:f${BATCH}`,
            `e:f${2 * BATCH}`,
        ]);
    });

    it("drops of one tag merge in call order, as consecutive writes would", async () => {
        const s = scriptedCore();
        const h = createUseCacheHandler({ kind: "default", core: s.core });
        s.state.open = true;
        // Expire-now, then a stale-with-window: the window wins (last write).
        await h.updateTags(["a"]);
        await h.updateTags(["a"], { expire: 30 });
        // Stale-with-window, then expire-now: expired at once, still stale.
        await h.updateTags(["b"], { expire: 30 });
        await h.updateTags(["b"]);
        s.state.open = false;
        await h.getExpiration(["unrelated"]);
        await waitFor(() => s.count("EVAL") >= 1);
        const now = Number(s.hashes.get("s:a"));
        expect(Number(s.hashes.get("e:a"))).toBe(now + 30_000);
        expect(Number(s.hashes.get("s:b"))).toBe(now);
        expect(Number(s.hashes.get("e:b"))).toBe(now);
    });
});
