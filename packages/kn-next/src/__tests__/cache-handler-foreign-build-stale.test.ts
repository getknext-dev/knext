/**
 * A previous build's ISR entry is served ONCE, as stale, then re-rendered by
 * the new build (#2305).
 *
 * ## The defect
 *
 * ISR keys are shared across builds (ADR-0066), and `scopeWindowToBuild`
 * (#1888) withholds the revalidate window an entry another build wrote. The
 * claim was that Next then treats the entry as stale. It does not, for a route
 * in the prerender manifest: with no `cacheControl` from the handler,
 * `IncrementalCache.get` falls back to the NEW build's manifest window and
 * computes `revalidateAfter = revalidate * 1000 + lastModified`. A page with
 * `revalidate = 3600` whose entry the old build wrote a minute ago is a fresh
 * HIT for another ~59 minutes, and a `revalidate: false` page is never stale.
 * Only a route with NO manifest entry falls back to Next's default 1 s window,
 * which is why the canary test (empty manifest) never saw it.
 *
 * ## The fix under test
 *
 * For a page or route entry another build wrote, once that build is no longer
 * live, the handler hands Next an EXPIRED window (`revalidate: 1`, the writer's
 * own `expire`). Next 16.4 applies a handler's `cacheControl` directly, so the
 * entry is STALE: Next serves it once and regenerates it in the background
 * (stale-while-revalidate, no stampede of blocking renders), and the new build
 * writes its own copy. Keys stay shared; a live canary peer's window is still
 * honoured (#2254).
 *
 * Real Next (the pinned version), with a prerender manifest that lists the
 * routes, over one shared fake Redis.
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

type Window = { revalidate: number | false; expire?: number };
type NextEntry = {
    isStale?: boolean | -1;
    cacheControl?: Window;
    value?: { kind: string; html?: string; body?: unknown };
} | null;

const { IncrementalCache } =
    require("next/dist/server/lib/incremental-cache/index.js") as {
        IncrementalCache: new (
            opts: Record<string, unknown>,
        ) => {
            get: (
                key: string,
                ctx: Record<string, unknown>,
            ) => Promise<NextEntry>;
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
// `setSystemTime` does not move. Make it follow `Date.now()`.
const realPerformanceNow = performance.now.bind(performance);
performance.now = () => Date.now() - performance.timeOrigin;

const tempRoots: string[] = [];
afterAll(() => {
    performance.now = realPerformanceNow;
    setSystemTime();
    for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
});

function distWithBuildId(id: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "knext-2305-"));
    tempRoots.push(root);
    const next = join(root, ".next");
    mkdirSync(join(next, "server"), { recursive: true });
    if (id !== undefined) writeFileSync(join(next, "BUILD_ID"), `${id}\n`);
    return join(next, "server");
}
const DIST = {
    [BUILD_A]: distWithBuildId(BUILD_A),
    [BUILD_B]: distWithBuildId(BUILD_B),
    none: distWithBuildId(undefined),
};

/** A manifest that LISTS the routes: the case the canary test never covered. */
function manifest() {
    const route = (path: string, revalidate: number | false) => ({
        initialRevalidateSeconds: revalidate,
        initialExpireSeconds: ONE_YEAR_S,
        srcRoute: path,
        dataRoute: `${path}.rsc`,
        allowHeader: [],
    });
    return {
        version: 4,
        routes: {
            "/isr/hour": route("/isr/hour", 3600),
            "/isr/never": route("/isr/never", false),
            "/isr/expire": route("/isr/expire", 3600),
            "/isr/legacy": route("/isr/legacy", 3600),
            "/isr/peer": route("/isr/peer", 3600),
            "/isr/peer-never": route("/isr/peer-never", false),
            "/isr/noid": route("/isr/noid", 3600),
        },
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: {
            previewModeId: "x",
            previewModeSigningKey: "y",
            previewModeEncryptionKey: "z",
        },
    };
}

const pageCtx = (path: string) => ({
    kind: "APP_PAGE",
    isRoutePPREnabled: false,
    isFallback: false,
    route: { kind: "APP_PAGE", sourceRoute: path },
});

/** A Redis the builds share: strings with TTLs, sets, MULTI/EXEC. */
function sharedRedis() {
    const strings = new Map<
        string,
        { value: string; expiresAt: number | null }
    >();
    const sets = new Map<string, Set<string>>();
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
    return { client, strings };
}
type Redis = ReturnType<typeof sharedRedis>;

type HandlerModule = {
    default: new (
        o: unknown,
    ) => {
        get: (
            k: string,
            c?: unknown,
        ) => Promise<Record<string, unknown> | null>;
        set: (k: string, d: unknown, c: unknown) => Promise<void>;
    };
    __setRedisClientForTests: (c: unknown) => void;
};

async function handlerModule(redis: Redis): Promise<HandlerModule> {
    const mod = (await import(
        `../adapters/cache-handler.js?stale=${Math.random()}`
    )) as HandlerModule;
    mod.__setRedisClientForTests(redis.client);
    return mod;
}

/**
 * Let a write's fire-and-forget liveness beat land BEFORE the test moves the
 * clock: landing after it, the beat would make the writer look live at the
 * moved time (a canary peer), which is not the case under test.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One pod of `build` (own module state) behind real Next, over `redis`. */
async function pod(redis: Redis, build: keyof typeof DIST) {
    const mod = await handlerModule(redis);
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
        prerenderManifest: manifest(),
        previewProps: manifest().preview,
        CurCacheHandler: Handler,
        serverDistDir: DIST[build],
    });
    return {
        /** A read as Next makes it; Next's per-process window map is per pod. */
        async read(path: string): Promise<NextEntry> {
            SharedCacheControls.cacheControls.clear();
            return cache.get(path, pageCtx(path));
        },
        /** A render of `path` by this build, written with the page's window. */
        async render(path: string, window: Window) {
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
                        revalidate: window.revalidate,
                        expire: window.expire ?? ONE_YEAR_S,
                    },
                    isRoutePPREnabled: false,
                    isFallback: false,
                    route: pageCtx(path).route,
                },
            );
            await settle();
        },
    };
}

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

/** Long enough for build A's liveness record (90 s) and B's lookup (5 s) to lapse. */
const A_STOPPED_MS = 5 * 60_000;

describe("a previous build's ISR entry is served once as STALE, then re-rendered (#2305)", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
        delete process.env.KNEXT_BUILD_ID;
        delete process.env.NEXT_DEPLOYMENT_ID;
        setSystemTime();
    });

    for (const [label, path, window] of [
        ["revalidate = 3600", "/isr/hour", 3600],
        ["revalidate: false", "/isr/never", false],
    ] as const) {
        it(`${label}: inside the manifest window, build B serves build A's body as stale, then its own render as fresh`, async () => {
            const redis = sharedRedis();
            const a = await pod(redis, BUILD_A);
            const time = clock();
            await a.render(path, { revalidate: window });
            // Build A stopped serving; the entry is well inside its window.
            time.advance(A_STOPPED_MS);
            const b = await pod(redis, BUILD_B);
            const first = await b.read(path);
            expect(
                first,
                "the body is served, not a miss (no stampede)",
            ).not.toBeNull();
            expect(first?.value?.html).toBe(`<p>${BUILD_A}</p>`);
            expect(
                first?.isStale,
                `build A's entry must be STALE to build B (Next would otherwise HIT it for the whole ${label} window)`,
            ).toBe(true);
            expect(first?.cacheControl?.revalidate).toBe(1);

            // The background revalidation Next schedules for a stale entry.
            await b.render(path, { revalidate: window });
            time.advance(2000);
            const second = await b.read(path);
            expect(second?.value?.html).toBe(`<p>${BUILD_B}</p>`);
            expect(second?.isStale).toBeFalsy();
            expect(second?.cacheControl?.revalidate).toBe(window);
        });
    }

    it("a legacy entry with no build id and no stored window is stale too", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        await a.render("/isr/legacy", { revalidate: 3600 });
        // The only page entry written so far.
        const keys = [...redis.strings.keys()].filter((k) =>
            k.includes(":cache:"),
        );
        expect(keys).toHaveLength(1);
        const key = keys[0];
        const stored = JSON.parse(
            redis.strings.get(key as string)?.value as string,
        );
        delete stored.buildId;
        delete stored.cacheControl;
        stored.lastModified = Date.now() - 60_000;
        redis.strings.set(key as string, {
            value: JSON.stringify(stored),
            expiresAt: null,
        });
        const entry = await a.read("/isr/legacy");
        expect(entry).not.toBeNull();
        expect(entry?.isStale).toBe(true);
    });

    it("keeps the writer's expire: past it, Next re-renders before answering (isStale -1)", async () => {
        const redis = sharedRedis();
        const a = await pod(redis, BUILD_A);
        const time = clock();
        await a.render("/isr/expire", { revalidate: 60, expire: 600 });
        time.advance(A_STOPPED_MS);
        const b = await pod(redis, BUILD_B);
        const inside = await b.read("/isr/expire");
        expect(inside?.isStale).toBe(true);
        expect(inside?.cacheControl).toEqual({ revalidate: 1, expire: 600 });
        // Redis evicts the key at `expire`, so a body past it is normally just
        // gone; age the stored body instead, to see what Next does with it.
        const [key] = [...redis.strings.keys()].filter((k) =>
            k.includes(":cache:"),
        );
        const stored = JSON.parse(redis.strings.get(key)?.value as string);
        stored.lastModified = Date.now() - 700_000;
        redis.strings.set(key, {
            value: JSON.stringify(stored),
            expiresAt: null,
        });
        expect((await b.read("/isr/expire"))?.isStale).toBe(-1);
    });

    for (const [path, window] of [
        ["/isr/peer", 3600],
        ["/isr/peer-never", false],
    ] as const) {
        it(`a LIVE peer build's entry keeps its own window (canary, no ping-pong) -- revalidate ${window}`, async () => {
            const redis = sharedRedis();
            const a = await pod(redis, BUILD_A);
            const b = await pod(redis, BUILD_B);
            const time = clock();
            await a.render(path, { revalidate: window });
            time.advance(5000);
            const entry = await b.read(path);
            expect(entry?.isStale).toBeFalsy();
            expect(entry?.cacheControl?.revalidate).toBe(window);
        });
    }

    it("a process with no build id forces nothing stale (it cannot tell a foreign entry from its own)", async () => {
        const redis = sharedRedis();
        const p = await pod(redis, "none");
        const time = clock();
        await p.render("/isr/noid", { revalidate: 3600 });
        time.advance(A_STOPPED_MS);
        const entry = await p.read("/isr/noid");
        expect(entry).not.toBeNull();
        expect(entry?.isStale).toBeFalsy();
    });
});

describe("the stale window is for page and route entries only", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
        setSystemTime();
    });

    async function foreignRead(kind: string, value: Record<string, unknown>) {
        const redis = sharedRedis();
        const modA = await handlerModule(redis);
        const a = new modA.default({ serverDistDir: DIST[BUILD_A] });
        const ctx = kind === "FETCH" ? { kind: "FETCH", tags: [] } : { kind };
        await a.set(
            "/k",
            value,
            kind === "FETCH"
                ? { fetchCache: true, revalidate: 60, tags: [] }
                : { cacheControl: { revalidate: 3600, expire: ONE_YEAR_S } },
        );
        await settle();
        clock().advance(A_STOPPED_MS);
        const modB = await handlerModule(redis);
        const b = new modB.default({ serverDistDir: DIST[BUILD_B] });
        return b.get("/k", ctx);
    }

    for (const [kind, value] of [
        ["APP_PAGE", { kind: "APP_PAGE", html: "x", headers: {}, status: 200 }],
        [
            "APP_ROUTE",
            { kind: "APP_ROUTE", body: "x", headers: {}, status: 200 },
        ],
        [
            "PAGES",
            {
                kind: "PAGES",
                html: "x",
                pageData: {},
                headers: {},
                status: 200,
            },
        ],
    ] as const) {
        it(`${kind}: another build's entry comes back with an expired window`, async () => {
            const got = await foreignRead(kind, value);
            expect(got?.cacheControl).toEqual({
                revalidate: 1,
                expire: ONE_YEAR_S,
            });
        });
    }

    it("FETCH (the data cache) is untouched: its stored window comes back as written", async () => {
        const got = await foreignRead("FETCH", {
            kind: "FETCH",
            data: { headers: {}, body: "x", status: 200 },
            revalidate: 60,
        });
        expect(got).not.toBeNull();
        expect(got?.cacheControl).toEqual({ revalidate: 60 });
    });
});
