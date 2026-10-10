/**
 * PPR resume state is build-scoped (#2084).
 *
 * Redis keys are scoped by app, not by build, so a PPR entry (an APP_PAGE with
 * `postponed` state) written by build A is still in Redis when build B serves
 * the route. Resuming A's postponed state against B's changed shell makes React
 * log "Expected the resume to render <Suspense> ... fallback to client
 * rendering" on every request. A postponed entry written by a different build
 * must therefore read as a MISS. Plain ISR HTML (no postponed state) stays
 * shared across builds: it is only stale, never resumed.
 */
process.env.KNEXT_TEST_SEAMS = "1";

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];
afterAll(() => {
    for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
});

function distWithBuildId(id: string): string {
    const root = mkdtempSync(join(tmpdir(), "knext-2084-"));
    tempRoots.push(root);
    const next = join(root, ".next");
    mkdirSync(join(next, "server"), { recursive: true });
    writeFileSync(join(next, "BUILD_ID"), `${id}\n`);
    return join(next, "server");
}

const BUILD_A = "build-A";
const BUILD_B = "build-B";
const DIST_B = distWithBuildId(BUILD_B);

function stored(opts: { buildId: string | null; postponed?: string }) {
    return JSON.stringify({
        ...(opts.buildId !== null && { buildId: opts.buildId }),
        value: {
            kind: "APP_PAGE",
            html: "<p>shell</p>",
            headers: {},
            status: 200,
            ...(opts.postponed !== undefined && { postponed: opts.postponed }),
        },
        lastModified: Date.now(),
        tags: [],
        cacheControl: { revalidate: 3600, expire: 31536000 },
    });
}

/** Build B's process reading `raw` from Redis. */
async function buildBReads(raw: string) {
    const mod = (await import(
        `../adapters/cache-handler.js?ppr=${Math.random()}`
    )) as {
        default: new (
            o: unknown,
        ) => {
            get: (k: string, c: unknown) => Promise<unknown>;
        };
        __setRedisClientForTests: (c: unknown) => void;
    };
    const client = {
        connected: true,
        async connect() {},
        async get() {
            return raw;
        },
        async send() {
            return "OK";
        },
    };
    const handler = new mod.default({ serverDistDir: DIST_B });
    mod.__setRedisClientForTests(client);
    return handler.get("/dyn", { kind: "APP_PAGE" });
}

describe("PPR resume state is build-scoped (#2084)", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
    });

    it("treats another build's postponed entry as a MISS", async () => {
        const got = await buildBReads(
            stored({ buildId: BUILD_A, postponed: '{"x":1}' }),
        );
        expect(got).toBeNull();
    });

    it("treats a postponed entry with no recorded build as a MISS", async () => {
        const got = await buildBReads(
            stored({ buildId: null, postponed: '{"x":1}' }),
        );
        expect(got).toBeNull();
    });

    it("still serves this build's own postponed entry", async () => {
        const got = (await buildBReads(
            stored({ buildId: BUILD_B, postponed: '{"x":1}' }),
        )) as { value?: { postponed?: string } } | null;
        expect(got?.value?.postponed).toBe('{"x":1}');
    });

    it("keeps sharing plain ISR HTML (no postponed state) across builds", async () => {
        const got = await buildBReads(stored({ buildId: BUILD_A }));
        expect(got).not.toBeNull();
    });
});
/** A dist whose `.next/BUILD_ID` is Next's constant id (deployment id set). */
const CONSTANT_ID = "build-TfctsWXpff2fKS";
const DIST_CONSTANT = distWithBuildId(CONSTANT_ID);

/** A dist with no readable BUILD_ID. */
function distWithoutBuildId(): string {
    const root = mkdtempSync(join(tmpdir(), "knext-2084-"));
    tempRoots.push(root);
    mkdirSync(join(root, ".next", "server"), { recursive: true });
    return join(root, ".next", "server");
}
const DIST_NONE = distWithoutBuildId();

/** A process whose handler is built with `options`, reading `raw` from Redis. */
async function readsWith(options: unknown, raw: string) {
    const mod = (await import(
        `../adapters/cache-handler.js?ppr=${Math.random()}`
    )) as {
        default: new (
            o: unknown,
        ) => { get: (k: string, c: unknown) => Promise<unknown> };
        __setRedisClientForTests: (c: unknown) => void;
    };
    const client = {
        connected: true,
        async connect() {},
        async get() {
            return raw;
        },
        async send() {
            return "OK";
        },
    };
    const handler = new mod.default(options);
    mod.__setRedisClientForTests(client);
    return handler.get("/dyn", { kind: "APP_PAGE" });
}

const ID_ENV = ["KNEXT_BUILD_ID", "NEXT_DEPLOYMENT_ID"] as const;

describe("PPR build scope falls back to the env build id (#2084)", () => {
    beforeEach(() => {
        delete process.env.REDIS_URL;
        for (const k of ID_ENV) delete process.env[k];
    });
    afterAll(() => {
        for (const k of ID_ENV) delete process.env[k];
    });

    const foreign = () => stored({ buildId: BUILD_A, postponed: '{"x":1}' });

    it("uses KNEXT_BUILD_ID when there is no serverDistDir (vinext)", async () => {
        process.env.KNEXT_BUILD_ID = BUILD_B;
        expect(await readsWith({}, foreign())).toBeNull();
    });

    it("uses KNEXT_BUILD_ID when BUILD_ID is unreadable", async () => {
        process.env.KNEXT_BUILD_ID = BUILD_B;
        expect(
            await readsWith({ serverDistDir: DIST_NONE }, foreign()),
        ).toBeNull();
    });

    it("uses the env id when BUILD_ID is Next's constant id", async () => {
        process.env.KNEXT_BUILD_ID = BUILD_B;
        expect(
            await readsWith({ serverDistDir: DIST_CONSTANT }, foreign()),
        ).toBeNull();
    });

    it("falls back to NEXT_DEPLOYMENT_ID when KNEXT_BUILD_ID is unset", async () => {
        process.env.NEXT_DEPLOYMENT_ID = BUILD_B;
        expect(
            await readsWith({ serverDistDir: DIST_CONSTANT }, foreign()),
        ).toBeNull();
    });

    it("still serves this build's own entry under the env id", async () => {
        process.env.KNEXT_BUILD_ID = BUILD_B;
        const got = await readsWith(
            {},
            stored({ buildId: BUILD_B, postponed: '{"x":1}' }),
        );
        expect(got).not.toBeNull();
    });

    it("ignores an env id equal to Next's constant id", async () => {
        process.env.KNEXT_BUILD_ID = CONSTANT_ID;
        expect(
            await readsWith({ serverDistDir: DIST_NONE }, foreign()),
        ).not.toBeNull();
    });

    it("FAILS OPEN with no id anywhere: the foreign entry is served (pinned)", async () => {
        expect(
            await readsWith({ serverDistDir: DIST_NONE }, foreign()),
        ).not.toBeNull();
        expect(await readsWith({}, foreign())).not.toBeNull();
    });

    it("applies on the in-memory get path too", async () => {
        const mod = (await import(
            `../adapters/cache-handler.js?ppr=${Math.random()}`
        )) as {
            default: new (
                o: unknown,
            ) => {
                get: (k: string, c: unknown) => Promise<unknown>;
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
            };
        };
        const page = {
            kind: "APP_PAGE",
            html: "<p>shell</p>",
            headers: {},
            status: 200,
            postponed: '{"x":1}',
        };
        // Build A writes (no Redis -> memory); then the same entry is read by
        // A (served) and by B (a miss).
        process.env.KNEXT_BUILD_ID = BUILD_A;
        await new mod.default({}).set("/dyn", page, {
            revalidate: 3600,
            tags: [],
        });
        expect(
            await new mod.default({}).get("/dyn", { kind: "APP_PAGE" }),
        ).not.toBeNull();
        process.env.KNEXT_BUILD_ID = BUILD_B;
        expect(
            await new mod.default({}).get("/dyn", { kind: "APP_PAGE" }),
        ).toBeNull();
    });
});
