/**
 * ISR build-scoping must not ping-pong under a long-lived canary split (#2254).
 *
 * ## The defect
 *
 * `scopeWindowToBuild` (#1888) withholds the stored revalidate window of an
 * entry ANOTHER build wrote, so a redeploy never honours the previous build's
 * window. Next then treats the entry as stale, serves the body and regenerates
 * it in the background, and the regenerated entry is written back under its OWN
 * build id. ISR keys are route paths shared by every revision of the app, so
 * under `spec.traffic.canaryPercent` (two builds serving the same keys for as
 * long as the split lasts) build A strips B's window and rewrites the entry as A,
 * then B strips A's and rewrites it as B: a regeneration on nearly every read,
 * ISR effectively off, for as long as the canary runs, which is during a
 * rollback, when the fleet is least healthy.
 *
 * ## The fix under test
 *
 * A foreign entry's window is honoured while the build that wrote it is LIVE
 * (it refreshed a short-lived `build-live` key recently) and withheld otherwise.
 * A canary peer is live, so nothing ping-pongs; a build that has been replaced
 * is not, so the #1888 guarantee holds once the rollout (or rollback) completes.
 *
 * Real Next (the version pinned here): two `IncrementalCache`s, one per build id,
 * each over its own handler module instance (module state is per process) and
 * both over ONE shared fake Redis, alternating read-then-regenerate-if-stale.
 */
// The cache handler's mutating test seams fail closed on a published subpath.
process.env.KNEXT_TEST_SEAMS = "1";

import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    setSystemTime,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { IncrementalCache } =
    require("next/dist/server/lib/incremental-cache/index.js") as {
        IncrementalCache: new (
            opts: Record<string, unknown>,
        ) => {
            get: (
                key: string,
                ctx: Record<string, unknown>,
            ) => Promise<{
                isStale?: boolean | -1;
                cacheControl?: { revalidate: number | false };
            } | null>;
            set: (
                key: string,
                data: unknown,
                ctx: Record<string, unknown>,
            ) => Promise<void>;
        };
    };
const { SharedCacheControls } =
    require("next/dist/server/lib/incremental-cache/shared-cache-controls.external.js") as {
        SharedCacheControls: { cacheControls: Map<string, unknown> };
    };

const ONE_YEAR_S = 31536000;
const BUILD_A = "build-A";
const BUILD_B = "build-B";

// Next reads "now" as `performance.timeOrigin + performance.now()`, which
// `setSystemTime` does not move. Make it follow `Date.now()` so the test clock
// steps the handler and Next together.
const realPerformanceNow = performance.now.bind(performance);
performance.now = () => Date.now() - performance.timeOrigin;

const tempRoots: string[] = [];
afterAll(() => {
    performance.now = realPerformanceNow;
    setSystemTime();
    for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
});

function distWithBuildId(id: string): string {
    const root = mkdtempSync(join(tmpdir(), "knext-2254-"));
    tempRoots.push(root);
    const next = join(root, ".next");
    mkdirSync(join(next, "server"), { recursive: true });
    writeFileSync(join(next, "BUILD_ID"), `${id}\n`);
    return join(next, "server");
}
const DIST = {
    [BUILD_A]: distWithBuildId(BUILD_A),
    [BUILD_B]: distWithBuildId(BUILD_B),
};

function emptyManifest() {
    return {
        version: 4,
        routes: {},
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: {
            previewModeId: "x",
            previewModeSigningKey: "y",
            previewModeEncryptionKey: "z",
        },
    };
}

const PAGE = {
    kind: "APP_PAGE",
    isRoutePPREnabled: false,
    isFallback: false,
    route: { kind: "APP_PAGE", sourceRoute: "/isr/[id]" },
};

/** A Redis the two builds share: strings with TTLs, sets, MULTI/EXEC. */
function sharedRedis() {
    const strings = new Map<
        string,
        { value: string; expiresAt: number | null }
    >();
    const sets = new Map<string, Set<string>>();
    const reads: string[] = [];
    const setKeys: string[] = [];
    const failReadsOf: string[] = [];
    let txn: string[][] | null = null;

    const live = (key: string) => {
        const slot = strings.get(key);
        if (!slot) return undefined;
        if (slot.expiresAt !== null && slot.expiresAt <= Date.now()) {
            strings.delete(key);
            return undefined;
        }
        return slot;
    };
    const apply = (command: string, args: string[]) => {
        switch (command) {
            case "SET": {
                const [key, value, flag, ttl] = args;
                setKeys.push(key);
                strings.set(key, {
                    value,
                    expiresAt:
                        flag === "EX" ? Date.now() + Number(ttl) * 1000 : null,
                });
                return "OK";
            }
            case "SADD": {
                const set = sets.get(args[0]) ?? new Set<string>();
                set.add(args[1]);
                sets.set(args[0], set);
                return 1;
            }
            case "DEL":
                for (const key of args) {
                    strings.delete(key);
                    sets.delete(key);
                }
                return 1;
            default:
                return "OK";
        }
    };

    const client = {
        connected: true,
        async connect() {},
        async get(key: string) {
            reads.push(key);
            if (failReadsOf.some((part) => key.includes(part)))
                throw new Error("simulated redis fault");
            return live(key)?.value ?? null;
        },
        async smembers(key: string) {
            return [...(sets.get(key) ?? [])];
        },
        async send(command: string, args: string[] = []) {
            if (command === "MULTI") {
                txn = [];
                return "OK";
            }
            if (command === "DISCARD") {
                txn = null;
                return "OK";
            }
            if (command === "EXEC") {
                const queued = txn ?? [];
                txn = null;
                return queued.map(([c, ...a]) => apply(c, a));
            }
            if (txn) {
                txn.push([command, ...args]);
                return "QUEUED";
            }
            return apply(command, args);
        },
    };
    return {
        client,
        strings,
        reads,
        setKeys,
        failReadsOf,
        ttlSeconds: (key: string) => {
            const slot = live(key);
            if (!slot) return undefined;
            return slot.expiresAt === null
                ? Infinity
                : (slot.expiresAt - Date.now()) / 1000;
        },
    };
}
type Redis = ReturnType<typeof sharedRedis>;

type HandlerModule = {
    default: new (o: unknown) => object;
    __setRedisClientForTests: (c: unknown) => void;
};

/** One pod of `build`: its own handler module (its own process state) over `redis`. */
async function pod(redis: Redis, build: typeof BUILD_A | typeof BUILD_B) {
    const mod = (await import(
        `../adapters/cache-handler.js?canary=${build}-${Math.random()}`
    )) as HandlerModule;
    class Handler extends mod.default {
        constructor(options: unknown) {
            super(options);
            mod.__setRedisClientForTests(redis.client);
        }
    }
    const cache = new IncrementalCache({
        dev: false,
        minimalMode: false,
        requestHeaders: {},
        prerenderManifest: emptyManifest(),
        previewProps: emptyManifest().preview,
        CurCacheHandler: Handler,
        serverDistDir: DIST[build],
    });
    let regenerations = 0;
    let reads = 0;
    return {
        cache,
        get regenerations() {
            return regenerations;
        },
        get reads() {
            return reads;
        },
        /**
         * One request: read, and (as Next does for a miss or a stale entry)
         * regenerate. Next's per-process window map is cleared first: each pod
         * has its own, and sharing it here would mask the handler's behaviour.
         */
        async request(path: string, window: number | false = 3600) {
            reads++;
            SharedCacheControls.cacheControls.clear();
            const entry = await cache.get(path, PAGE);
            const stale = !entry || !!entry.isStale;
            if (stale) {
                regenerations++;
                SharedCacheControls.cacheControls.clear();
                await cache.set(
                    path,
                    {
                        kind: "APP_PAGE",
                        html: `<p>${build}</p>`,
                        headers: {},
                        status: 200,
                    },
                    {
                        cacheControl: {
                            revalidate: window,
                            expire: ONE_YEAR_S,
                        },
                        isRoutePPREnabled: false,
                        isFallback: false,
                        route: PAGE.route,
                    },
                );
            }
            return { entry, stale };
        },
    };
}

/**
 * A clock the test steps. Next falls back to a 1 s window for an entry whose
 * window the handler withheld, so requests must be spaced past that for the
 * withheld window to show; real traffic on a hot key is spaced like this too.
 */
function clock() {
    const t0 = Date.now();
    let elapsed = 0;
    return {
        advance(ms: number) {
            elapsed += ms;
            setSystemTime(new Date(t0 + elapsed));
        },
    };
}

describe("ISR under a canary split does not ping-pong (#2254)", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
        setSystemTime();
    });

    for (const [label, first, second] of [
        ["new build is the canary", BUILD_A, BUILD_B],
        ["rolled-back build is the canary", BUILD_B, BUILD_A],
    ] as const) {
        it(`${label}: two builds alternating on one key regenerate a bounded number of times`, async () => {
            const redis = sharedRedis();
            const one = await pod(redis, first);
            const two = await pod(redis, second);
            const time = clock();
            for (let i = 0; i < 20; i++) {
                await one.request("/isr/a");
                time.advance(2000);
                await two.request("/isr/a");
                time.advance(2000);
            }
            const total = one.regenerations + two.regenerations;
            expect(
                total,
                `${total} regenerations for 40 reads inside a 3600 s window: each build keeps stripping the other's window`,
            ).toBeLessThanOrEqual(2);
        });
    }

    it("hands the peer build's window back to Next (fresh, window intact)", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const b = await pod(redis, BUILD_B);
        await a.request("/isr/window");
        clock().advance(5000);
        const { entry } = await b.request("/isr/window");
        expect(entry?.isStale).toBeFalsy();
        expect(entry?.cacheControl?.revalidate).toBe(3600);
    });

    it("also holds for revalidate=false pages", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const b = await pod(redis, BUILD_B);
        const time = clock();
        for (let i = 0; i < 10; i++) {
            await a.request("/static/x", false);
            time.advance(2000);
            await b.request("/static/x", false);
            time.advance(2000);
        }
        expect(a.regenerations + b.regenerations).toBeLessThanOrEqual(2);
    });

    it("keeps regenerating at the page's own cadence: a window that elapses is still regenerated", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const b = await pod(redis, BUILD_B);
        const time = clock();
        await a.request("/isr/cadence", 60);
        time.advance(2000);
        await b.request("/isr/cadence", 60);
        time.advance(61_000);
        await a.request("/isr/cadence", 60);
        time.advance(2000);
        await b.request("/isr/cadence", 60);
        // First write, then exactly one regeneration once 60 s have passed.
        expect(a.regenerations + b.regenerations).toBe(2);
    });

    it("withholds a previous build's window once that build stopped serving (the redeploy guarantee)", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const time = clock();
        await a.request("/isr/rollout", false);
        // Build A's last pod is gone; its liveness lapses well before this.
        time.advance(5 * 60_000);
        const b = await pod(redis, BUILD_B);
        const { entry, stale } = await b.request("/isr/rollout", false);
        expect(entry, "the body is still served meanwhile").not.toBeNull();
        expect(
            stale,
            "A's revalidate=false window must not be honoured by B after A stopped serving",
        ).toBe(true);
    });

    it("bounds how long a replaced build's window is honoured to its liveness TTL", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const time = clock();
        await a.request("/isr/bound", false);
        const b = await pod(redis, BUILD_B);
        time.advance(30_000);
        expect((await b.request("/isr/bound", false)).stale).toBe(false);
        time.advance(90_000);
        // A wrote nothing since; B's own cached lookup of A has expired too.
        expect((await b.request("/isr/bound", false)).stale).toBe(true);
    });

    it("fails closed: a liveness lookup that faults withholds the window, as before the fix", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        await a.request("/isr/fault");
        clock().advance(5000);
        const b = await pod(redis, BUILD_B);
        redis.failReadsOf.push(":build-live:");
        const { entry, stale } = await b.request("/isr/fault");
        expect(entry).not.toBeNull();
        expect(stale).toBe(true);
    });

    it("looks a peer build up once per few seconds, not once per read", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const b = await pod(redis, BUILD_B);
        await a.request("/isr/lookup");
        clock().advance(2000);
        redis.reads.length = 0;
        for (let i = 0; i < 10; i++) await b.request("/isr/lookup");
        expect(
            redis.reads.filter((k) => k.endsWith(`:build-live:${BUILD_A}`)),
        ).toHaveLength(1);
        expect(b.regenerations).toBe(0);
    });

    it("does not look up liveness for an entry this build wrote", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        await a.request("/isr/own");
        redis.reads.length = 0;
        for (let i = 0; i < 5; i++) await a.request("/isr/own");
        expect(redis.reads.filter((k) => k.includes(":build-live:"))).toEqual(
            [],
        );
        expect(a.regenerations).toBe(1);
    });

    it("never honours a legacy entry with no recorded build id, however live the other builds are", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        await a.request("/isr/warm");
        redis.strings.set(
            [...redis.strings.keys()].find((k) => k.includes(":cache:"))!,
            {
                value: JSON.stringify({
                    value: {
                        kind: "APP_PAGE",
                        html: "<p>old</p>",
                        headers: {},
                        status: 200,
                    },
                    lastModified: Date.now() - 60_000,
                    tags: [],
                    cacheControl: { revalidate: 3600, expire: ONE_YEAR_S },
                }),
                expiresAt: null,
            },
        );
        const { stale } = await a.request("/isr/warm");
        expect(stale).toBe(true);
    });

    it("publishes liveness as ONE short-lived key per build, refreshed at a bounded rate", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const time = clock();
        for (let i = 0; i < 50; i++) await a.request("/isr/rate");
        const beats = () =>
            redis.setKeys.filter((k) => k.includes(":build-live:")).length;
        expect(
            beats(),
            "50 requests in one instant publish liveness once",
        ).toBe(1);
        time.advance(31_000);
        await a.request("/isr/rate");
        // The beat is fire-and-forget: let it land.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(beats(), "and again once the refresh interval has passed").toBe(
            2,
        );
        const liveKeys = [...redis.strings.keys()].filter((k) =>
            k.includes(":build-live:"),
        );
        expect(liveKeys).toHaveLength(1);
        expect(liveKeys[0]).toContain(BUILD_A);
        const ttl = redis.ttlSeconds(liveKeys[0]) as number;
        expect(ttl).toBeGreaterThan(0);
        expect(
            ttl,
            "a liveness key must expire, or a replaced build looks alive forever",
        ).toBeLessThanOrEqual(90);
    });

    it("a tag invalidation reaches the entry whichever build wrote it", async () => {
        const redis = sharedRedis();
        const modA = (await import(
            `../adapters/cache-handler.js?canarytag=a-${Math.random()}`
        )) as HandlerModule & {
            default: new (
                o: unknown,
            ) => {
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
                get: (k: string, c?: unknown) => Promise<unknown>;
                revalidateTag: (t: string) => Promise<void>;
            };
        };
        modA.__setRedisClientForTests(redis.client);
        const handlerA = new modA.default({ serverDistDir: DIST[BUILD_A] });
        const modB = (await import(
            `../adapters/cache-handler.js?canarytag=b-${Math.random()}`
        )) as typeof modA;
        modB.__setRedisClientForTests(redis.client);
        const handlerB = new modB.default({ serverDistDir: DIST[BUILD_B] });
        const data = {
            kind: "APP_PAGE",
            html: "x",
            headers: { "x-next-cache-tags": "t-shared" },
            status: 200,
        };
        await handlerA.set("/isr/tagged", data, {
            cacheControl: { revalidate: 60 },
        });
        await handlerB.set("/isr/tagged", data, {
            cacheControl: { revalidate: 60 },
        });
        await handlerA.revalidateTag("t-shared");
        expect(
            await handlerB.get("/isr/tagged", { kind: "APP_PAGE" }),
        ).toBeNull();
        expect(
            await handlerA.get("/isr/tagged", { kind: "APP_PAGE" }),
        ).toBeNull();
    });
});
