/**
 * An ISR entry read STALE on the first request after a scale-to-zero wake,
 * though it was well inside its revalidate window (#1888).
 *
 * ## Why (Next 16.3.6, `dist/server/lib/incremental-cache/index.js`)
 *
 * On the Next standalone path the handler does NOT decide freshness. Next's
 * `IncrementalCache.get` takes only `lastModified` and `value` from what the
 * handler returns and computes staleness itself:
 *
 *   - `calculateRevalidate` (:154-163) reads the route's window from
 *     `this.cacheControls` — a `SharedCacheControls` (:130) whose backing Map is
 *     a PROCESS-GLOBAL static, filled only by `IncrementalCache.set` (:537-538)
 *     or, failing that, by the prerender manifest
 *     (`shared-cache-controls.external.js` `get`, keyed by the CONCRETE route).
 *   - With neither, it falls back to a 1-second window (:160), so
 *     `isStale = revalidateAfter < now` (:451) is `true` for any entry older than
 *     a second.
 *
 * A path rendered at runtime (`/isr/[id]` without `generateStaticParams`, the
 * rc.2 report's `/isr/a`) is in no manifest. Its window lived only in the pod
 * that rendered it; the woken pod's Map is empty, so the entry read STALE and
 * regenerated. knext's handler persisted `cacheControl.revalidate` with the
 * entry all along, but nothing handed it back to Next.
 *
 * ## What this asserts
 *
 * The REAL Next `IncrementalCache` (the version pinned here), with the shared
 * Map cleared to model a freshly woken process, reading through knext's
 * handler on its Redis path (fake client, the shape #886's tests use).
 *
 * The seed is BUILD-SCOPED: Redis keys outlive a redeploy, and an old build's
 * window must not make the new build serve its entry fresh. Only an entry whose
 * recorded build id equals this process's `.next/BUILD_ID` is seeded.
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
import { NEXT_CONSTANT_BUILD_ID } from "../cli/build-id-env";

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
                cacheControl?: { revalidate: number | false; expire?: number };
            } | null>;
        };
    };
const { SharedCacheControls } =
    require("next/dist/server/lib/incremental-cache/shared-cache-controls.external.js") as {
        SharedCacheControls: { cacheControls: Map<string, unknown> };
    };

const SEVEN_MINUTES_MS = 7 * 60 * 1000;
const ONE_YEAR_S = 31536000;

/** An empty prerender manifest: the route was generated at runtime. */
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

/** Temp roots created by `distWithBuildId`, removed after the file runs. */
const tempRoots: string[] = [];
afterAll(() => {
    for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
});

/** A `.next` with `BUILD_ID` = `id`; returns the `serverDistDir` Next would pass. */
function distWithBuildId(id: string): string {
    const root = mkdtempSync(join(tmpdir(), "knext-1888-"));
    tempRoots.push(root);
    const next = join(root, ".next");
    mkdirSync(join(next, "server"), { recursive: true });
    writeFileSync(join(next, "BUILD_ID"), `${id}\n`);
    return join(next, "server");
}
const THIS_BUILD = "build-B";
const OTHER_BUILD = "build-A";
const THIS_DIST = distWithBuildId(THIS_BUILD);

/**
 * A Redis entry as knext's `set` writes it, `ageMs` before now, by build
 * `buildId` (`null` = an entry written before build ids were recorded).
 */
function storedEntry(
    cacheControl: Record<string, unknown>,
    ageMs: number,
    buildId: string | null = THIS_BUILD,
) {
    return JSON.stringify({
        ...(buildId !== null && { buildId }),
        value: {
            kind: "APP_PAGE",
            html: "<p>stamp</p>",
            headers: {},
            status: 200,
        },
        lastModified: Date.now() - ageMs,
        tags: [],
        cacheControl,
    });
}

/** A woken pod: a fresh IncrementalCache over knext's handler, Redis holding `stored`. */
async function wokenPod(
    stored: string,
    /** `null` = Next passed no serverDistDir (an explicit `undefined` would take the default). */
    serverDistDir: string | null = THIS_DIST,
) {
    const mod = (await import(
        `../adapters/cache-handler.js?wake=${Math.random()}`
    )) as {
        default: new (o: unknown) => object;
        __setRedisClientForTests: (c: unknown) => void;
    };
    const client = {
        connected: true,
        async connect() {},
        async get() {
            return stored;
        },
        async send() {
            return "OK";
        },
    };
    class Handler extends mod.default {
        constructor(options: unknown) {
            super(options);
            mod.__setRedisClientForTests(client);
        }
    }
    return new IncrementalCache({
        dev: false,
        minimalMode: false,
        requestHeaders: {},
        getPrerenderManifest: emptyManifest,
        CurCacheHandler: Handler,
        serverDistDir: serverDistDir ?? undefined,
    });
}

const PAGE = { kind: "APP_PAGE", isRoutePPREnabled: false, isFallback: false };

describe("ISR freshness survives a scale-to-zero wake on the Next path (#1888)", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
        // A freshly woken process: Next has learnt no route's window yet.
        SharedCacheControls.cacheControls.clear();
    });

    it("reads a 7-min-old entry with revalidate=3600 as FRESH, not STALE", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
            ),
        );
        const entry = await cache.get("/isr/a", PAGE);
        expect(entry, "the body is in Redis").not.toBeNull();
        expect(
            entry?.isStale,
            "Next fell back to its 1 s default window: the persisted revalidate was never handed back",
        ).toBeFalsy();
        expect(entry?.cacheControl?.revalidate).toBe(3600);
    });

    it("still reads an entry past its persisted window as STALE (the other half)", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 60, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
            ),
        );
        const entry = await cache.get("/isr/b", PAGE);
        expect(entry?.isStale).toBe(true);
        expect(entry?.cacheControl?.revalidate).toBe(60);
    });

    it("reads a revalidate=false entry as FRESH after a wake", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: false, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
            ),
        );
        const entry = await cache.get("/static/a", PAGE);
        expect(entry?.isStale).toBeFalsy();
    });

    it("does NOT seed an entry another build wrote: an old window stays stale after a redeploy", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
                OTHER_BUILD,
            ),
        );
        const entry = await cache.get("/isr/redeploy", PAGE);
        expect(entry, "the body is still served").not.toBeNull();
        expect(
            entry?.isStale,
            "the previous build's window must not apply",
        ).toBe(true);
        expect(SharedCacheControls.cacheControls.has("/isr/redeploy")).toBe(
            false,
        );
    });

    it("does NOT seed another build's revalidate=false (it would be fresh forever)", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: false, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
                OTHER_BUILD,
            ),
        );
        const entry = await cache.get("/static/old", PAGE);
        expect(entry?.isStale).toBe(true);
        expect(SharedCacheControls.cacheControls.has("/static/old")).toBe(
            false,
        );
    });

    it("does NOT seed a legacy entry that carries no build id", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
                null,
            ),
        );
        const entry = await cache.get("/isr/legacy", PAGE);
        expect(entry?.isStale).toBe(true);
        expect(SharedCacheControls.cacheControls.has("/isr/legacy")).toBe(
            false,
        );
    });

    it("does NOT seed when this process has no build id (no serverDistDir), even for a legacy entry", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
                null,
            ),
            null,
        );
        const entry = await cache.get("/isr/nobuild", PAGE);
        expect(entry?.isStale).toBe(true);
        expect(SharedCacheControls.cacheControls.has("/isr/nobuild")).toBe(
            false,
        );
    });

    it("records this build's id on a Redis write", async () => {
        const mod = (await import(
            `../adapters/cache-handler.js?wakewrite=${Math.random()}`
        )) as {
            default: new (
                o: unknown,
            ) => {
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
            };
            __setRedisClientForTests: (c: unknown) => void;
        };
        const sent: string[][] = [];
        const handler = new mod.default({ serverDistDir: THIS_DIST });
        mod.__setRedisClientForTests({
            connected: true,
            async connect() {},
            async get() {
                return null;
            },
            async send(command: string, args: string[] = []) {
                sent.push([command, ...args]);
                return command === "EXEC" ? [] : "OK";
            },
        });
        await handler.set(
            "/isr/write",
            { kind: "APP_PAGE", html: "x", headers: {}, status: 200 },
            { cacheControl: { revalidate: 3600 } },
        );
        const set = sent.find((c) => c[0] === "SET");
        expect(set, `no SET issued: ${JSON.stringify(sent)}`).toBeTruthy();
        expect(JSON.parse((set as string[])[2]).buildId).toBe(THIS_BUILD);
    });

    it("does NOT seed when both the entry and this process carry Next's CONSTANT build id", async () => {
        const constantDist = distWithBuildId(NEXT_CONSTANT_BUILD_ID);
        const cache = await wokenPod(
            storedEntry(
                { revalidate: false, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
                NEXT_CONSTANT_BUILD_ID,
            ),
            constantDist,
        );
        const entry = await cache.get("/isr/constant", PAGE);
        expect(
            entry?.isStale,
            "every deploy with a deployment id shares this id — it must not count as 'same build'",
        ).toBe(true);
        expect(SharedCacheControls.cacheControls.has("/isr/constant")).toBe(
            false,
        );
    });

    it("does NOT record Next's CONSTANT build id on a write", async () => {
        const mod = (await import(
            `../adapters/cache-handler.js?constwrite=${Math.random()}`
        )) as {
            default: new (
                o: unknown,
            ) => {
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
            };
            __setRedisClientForTests: (c: unknown) => void;
        };
        const sent: string[][] = [];
        const handler = new mod.default({
            serverDistDir: distWithBuildId(NEXT_CONSTANT_BUILD_ID),
        });
        mod.__setRedisClientForTests({
            connected: true,
            async connect() {},
            async get() {
                return null;
            },
            async send(command: string, args: string[] = []) {
                sent.push([command, ...args]);
                return command === "EXEC" ? [] : "OK";
            },
        });
        await handler.set(
            "/isr/constwrite",
            { kind: "APP_PAGE", html: "x", headers: {}, status: 200 },
            { cacheControl: { revalidate: 3600 } },
        );
        const set = sent.find((c) => c[0] === "SET");
        expect(set, `no SET issued: ${JSON.stringify(sent)}`).toBeTruthy();
        expect(JSON.parse((set as string[])[2]).buildId).toBeUndefined();
    });

    it("keeps the handler's copy of the constant in lockstep with the CLI's", async () => {
        const mod = (await import(
            "../adapters/cache-handler.js"
        )) as unknown as {
            __NEXT_CONSTANT_BUILD_ID: string;
        };
        expect(mod.__NEXT_CONSTANT_BUILD_ID).toBe(NEXT_CONSTANT_BUILD_ID);
    });

    it("does not override a window this process already knows", async () => {
        SharedCacheControls.cacheControls.set("/isr/c", {
            revalidate: 10,
            expire: ONE_YEAR_S,
        });
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
            ),
        );
        const entry = await cache.get("/isr/c", PAGE);
        expect(entry?.cacheControl?.revalidate).toBe(10);
        expect(entry?.isStale).toBe(true);
    });

    it("maps Next's normalized `/index` key to the `/` route, as Next's toRoute does", async () => {
        const cache = await wokenPod(
            storedEntry(
                { revalidate: 3600, expire: ONE_YEAR_S },
                SEVEN_MINUTES_MS,
            ),
        );
        const entry = await cache.get("/", PAGE);
        expect(entry?.isStale).toBeFalsy();
        expect(SharedCacheControls.cacheControls.has("/")).toBe(true);
    });

    it("never seeds a window for a FETCH (data-cache) entry", async () => {
        const mod = (await import(
            `../adapters/cache-handler.js?wakefetch=${Math.random()}`
        )) as {
            default: new (
                o: unknown,
            ) => {
                get: (k: string, ctx?: unknown) => Promise<unknown>;
            };
            __setRedisClientForTests: (c: unknown) => void;
        };
        const handler = new mod.default({ serverDistDir: THIS_DIST });
        mod.__setRedisClientForTests({
            connected: true,
            async connect() {},
            async get() {
                return JSON.stringify({
                    buildId: THIS_BUILD,
                    value: { kind: "FETCH", data: {}, revalidate: 30 },
                    lastModified: Date.now(),
                    tags: [],
                    cacheControl: { revalidate: 30 },
                });
            },
            async send() {
                return "OK";
            },
        });
        // A slash-led key, so the kind guard (not the key shape) is what is tested.
        await handler.get("/fetch-like", { kind: "FETCH" });
        expect(SharedCacheControls.cacheControls.size).toBe(0);
    });
});

describe("the in-memory path (no REDIS_URL) gets the same treatment", () => {
    it("a write 7 min ago by an earlier IncrementalCache reads FRESH after the shared map is lost", async () => {
        delete process.env.REDIS_URL;
        SharedCacheControls.cacheControls.clear();
        const mod = (await import(
            `../adapters/cache-handler.js?wakemem=${Math.random()}`
        )) as { default: new (o: unknown) => object };
        const make = () =>
            new IncrementalCache({
                dev: false,
                minimalMode: false,
                requestHeaders: {},
                getPrerenderManifest: emptyManifest,
                CurCacheHandler: mod.default,
                serverDistDir: THIS_DIST,
            }) as unknown as {
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
                get: (
                    k: string,
                    c: unknown,
                ) => Promise<{ isStale?: unknown } | null>;
            };
        // The rendering pod writes through Next, 7 minutes ago.
        setSystemTime(new Date(Date.now() - SEVEN_MINUTES_MS));
        try {
            await make().set(
                "/isr/mem",
                {
                    kind: "APP_PAGE",
                    html: "<p>x</p>",
                    headers: {},
                    status: 200,
                },
                {
                    cacheControl: { revalidate: 3600, expire: ONE_YEAR_S },
                    isRoutePPREnabled: false,
                    isFallback: false,
                },
            );
        } finally {
            setSystemTime();
        }
        // The pod scaled to zero: Next's process-global map is gone.
        SharedCacheControls.cacheControls.clear();
        const entry = await make().get("/isr/mem", PAGE);
        expect(entry).not.toBeNull();
        expect(entry?.isStale).toBeFalsy();
    });
});

describe("the vinext contract is unchanged by persisting revalidate=false", () => {
    it("persists revalidate=false and labels the entry fresh (no cacheState)", async () => {
        delete process.env.REDIS_URL;
        const mod = (await import(
            `../adapters/cache-handler.js?vinextfalse=${Math.random()}`
        )) as {
            default: new () => {
                get: (k: string) => Promise<Record<string, unknown> | null>;
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
            };
        };
        const handler = new mod.default();
        await handler.set(
            "never-revalidate",
            { kind: "APP_PAGE" },
            {
                cacheControl: { revalidate: false },
            },
        );
        const hit = await handler.get("never-revalidate");
        expect(hit?.cacheControl).toEqual({ revalidate: false });
        expect(hit?.cacheState).toBeUndefined();
    });
});
