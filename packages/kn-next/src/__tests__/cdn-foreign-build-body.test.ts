// @vitest-environment node
//
// A body another build wrote is never edge-cached (ADR-0068 D9, Amendment 2).

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { edge } from "./cdn-edge-untyped";
import {
    buildKindApp,
    cleanupKindApp,
    getRaw,
    KIND_PREFIX,
    serveKindApp,
} from "./cdn-kind-app-harness";
import {
    artifact,
    CDN_ENV,
    type RawResponse,
    rawRequest,
} from "./cdn-test-harness";
import {
    EMULATOR_ENDPOINT,
    type FakeCdn,
    PREFIX,
    startFakeCdn,
} from "./helpers/cdn-purge-fixtures";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * ISR HTML is shared across builds by design (ADR-0066): the Redis key is per
 * app, not per build. After a rollout the new build's cache handler returns the
 * previous build's entry, Next answers `HIT` with the OLD body until that
 * entry's own `revalidate` elapses, and before this fix the preload marked it
 * edge-cacheable for the full TTL, tagged with the NEW build's build tag. So
 * the first-ready purge (D7) was followed by an edge refill with old-build HTML,
 * and a hand purge of the old build's tag (D9) missed it.
 *
 * The fix (lead decision on the issue, option B): the cache handler records,
 * through the CDN request seam, that the entry it served was written by another
 * build (`record({ kind, tags, foreignBuild: true })`, the same build-identity
 * rule as the build-scoped revalidate window: a different build id, none
 * recorded, or none resolved here). The preload then refuses the edge directive
 * with `reason="foreign_build_body"`. Once the entry is regenerated under the
 * current build, the page is edge-cached again. Cross-build ISR sharing is
 * kept; what it costs is edge hit rate after a deploy, on the pages the new
 * build has not yet rendered itself.
 *
 * The origin half (#2305): once the previous build stops serving, the handler
 * hands such an entry to Next with an expired window, so Next serves it once as
 * `STALE` and re-renders it in the background, for `revalidate: false` pages
 * too (section 4). Before that, Next applied the new build's prerender-manifest
 * window to the old entry and kept answering `HIT` with the old body for the
 * page's whole window.
 *
 * Four layers: the pure decision and seam; the REAL cache handler in separate
 * processes (one per build) on a shared real-TCP fake Redis; the preload in
 * front of the real handler over http on Node and Bun; and the issue's repro on
 * a real `next build` of the CDN-3a fixture, two builds, one Redis.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HANDLER = resolve(here, "../adapters/cache-handler.js");
const PRELOAD = resolve(here, "../adapters/cache-control-normalize.cjs");
const POD = resolve(here, "fixtures/cdn-wire-in-pod.mjs");
const TWO_BUILD_SERVER = resolve(here, "fixtures/cdn-two-build-server.mjs");
const EDGE = "cloudflare-cdn-cache-control";

const { decideEdge, loadCdnConfig, ensureSeam, captureRequest } = edge;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
});
afterAll(cleanupKindApp, 120_000);

// ---------------------------------------------------------------------------
// 1. The pure decision and the seam
// ---------------------------------------------------------------------------

function base(over: Record<string, unknown> = {}) {
    return {
        cfg: loadCdnConfig(CDN_ENV),
        artifact: edge.parseRoutingArtifact(artifact()),
        method: "GET",
        status: 200,
        originCacheControl: "s-maxage=60, stale-while-revalidate=31535940",
        hasSetCookie: false,
        hasAuthorization: false,
        hasDraftCookie: false,
        rawTarget: "/blog",
        rsc: { header: false, router: false, param: false },
        contentType: "text/html; charset=utf-8",
        ownTags: ["_N_T_/blog", "posts"],
        fetchTags: [],
        buildId: "build-xyz",
        ...over,
    };
}

describe("the decision: a foreign-build body is refused", () => {
    it("foreignBuild => not edge-cacheable, reason foreign_build_body", () => {
        expect(decideEdge(base({ foreignBuild: true }))).toEqual({
            edge: false,
            result: "skipped",
            reason: "foreign_build_body",
        });
    });

    it("the same input from this build is edge-cached (control)", () => {
        expect(decideEdge(base({ foreignBuild: false })).edge).toBe(true);
        expect(decideEdge(base()).edge).toBe(true);
    });

    it("an immutable asset is not affected (it is never tagged or refused)", () => {
        const d = decideEdge(
            base({
                foreignBuild: true,
                originCacheControl: "public, max-age=31536000, immutable",
            }),
        );
        expect(d.result).toBe("immutable");
    });
});

describe("the seam carries the foreign-build mark", () => {
    const fresh = () =>
        captureRequest({ url: "/blog", method: "GET", headers: {} });

    it("a request starts unmarked", () => {
        expect(fresh().foreignBuild).toBe(false);
    });

    it("a page or route entry from another build marks the request, sticky", () => {
        const seam = ensureSeam();
        for (const kind of ["page", "route"]) {
            const s = fresh();
            seam.als.run(s, () => {
                expect(
                    seam.record({
                        kind,
                        tags: ["_N_T_/blog"],
                        foreignBuild: true,
                    }),
                ).toBe(true);
                seam.record({ kind, tags: ["_N_T_/blog"] });
            });
            expect(s.foreignBuild, kind).toBe(true);
            expect(s.own, kind).toEqual(["_N_T_/blog", "_N_T_/blog"]);
        }
    });

    it("the mark needs no tags: a foreign entry with none still marks the request", () => {
        const seam = ensureSeam();
        const s = fresh();
        seam.als.run(s, () => {
            expect(
                seam.record({ kind: "page", tags: [], foreignBuild: true }),
            ).toBe(true);
        });
        expect(s.foreignBuild).toBe(true);
    });

    it("a fetch (data) entry from another build does not: the page body is this build's", () => {
        const seam = ensureSeam();
        const s = fresh();
        seam.als.run(s, () => {
            seam.record({ kind: "fetch", tags: ["data"], foreignBuild: true });
        });
        expect(s.foreignBuild).toBe(false);
        expect(s.fetch).toEqual(["data"]);
    });

    it("only `true` marks (a truthy non-boolean does not)", () => {
        const seam = ensureSeam();
        const s = fresh();
        seam.als.run(s, () => {
            seam.record({
                kind: "page",
                tags: ["_N_T_/x"],
                foreignBuild: "yes",
            });
        });
        expect(s.foreignBuild).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. The real cache handler, one process per build, one Redis
// ---------------------------------------------------------------------------

type Action =
    | { op: "set"; key: string; tags: string[] }
    | { op: "get"; key: string };

interface PodOut {
    recorded: { kind: string; tags: string[]; foreignBuild?: true }[];
    results: { op: string; key: string; hit?: boolean }[];
}

const RUNTIMES: [string, string][] = [
    [process.versions.bun ? "bun" : "node", process.execPath],
    ...(process.versions.bun ? ([["node", "node"]] as [string, string][]) : []),
];

async function world() {
    const redis: FakeRedis = await startFakeRedis();
    const cdn: FakeCdn = await startFakeCdn();
    cleanups.push(
        () => redis.close(),
        () => cdn.close(),
    );
    return { redis, cdn };
}

function pod(
    runtime: string,
    w: { redis: FakeRedis; cdn: FakeCdn },
    buildId: string,
    actions: Action[],
    extra: Record<string, string | undefined> = {},
): Promise<PodOut> {
    const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        REDIS_URL: w.redis.url,
        REDIS_KEY_PREFIX: "cdn-fb",
        KNEXT_BUILD_ID: buildId,
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: PREFIX,
        KNEXT_CDN_PURGE_TARGET: "zone-1",
        KNEXT_CDN_EMULATOR_ENDPOINT: EMULATOR_ENDPOINT,
        POD_HANDLER: HANDLER,
        POD_CDN_PORT: String(w.cdn.port),
        POD_SEAM: "1",
        POD_ACTIONS: JSON.stringify(actions),
        ...extra,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return new Promise((resolvePod, reject) => {
        const child = spawn(runtime, [POD], {
            env: env as NodeJS.ProcessEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
            out += d;
        });
        child.stderr.on("data", (d) => {
            err += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const line = out.trim().split("\n").pop() ?? "";
            if (code !== 0 || !line.startsWith("{")) {
                reject(
                    new Error(
                        `pod exited ${code}\nstdout:${out}\nstderr:${err}`,
                    ),
                );
                return;
            }
            resolvePod(JSON.parse(line) as PodOut);
        });
    });
}

const PAGE: Action = { op: "set", key: "/tagged", tags: ["_N_T_/tagged"] };
const READ: Action = { op: "get", key: "/tagged" };

describe.each(
    RUNTIMES,
)("the cache handler marks a foreign-build read -- %s", (_l, runtime) => {
    it("build 2 reading build 1's entry records foreignBuild; its own entry does not", async () => {
        const w = await world();
        const b1 = await pod(runtime, w, "build-one", [PAGE, READ]);
        // The writing build reads its own entry: no mark.
        expect(b1.recorded).toEqual([
            { kind: "page", tags: ["_N_T_/tagged"] },
            { kind: "page", tags: ["_N_T_/tagged"] },
        ]);
        const b2 = await pod(runtime, w, "build-two", [READ]);
        expect(b2.results).toEqual([{ op: "get", key: "/tagged", hit: true }]);
        expect(b2.recorded).toEqual([
            { kind: "page", tags: ["_N_T_/tagged"], foreignBuild: true },
        ]);
        // Build 2 regenerates the entry; from then on its reads are its own.
        const again = await pod(runtime, w, "build-two", [PAGE, READ]);
        expect(again.recorded).toEqual([
            { kind: "page", tags: ["_N_T_/tagged"] },
            { kind: "page", tags: ["_N_T_/tagged"] },
        ]);
    }, 30_000);

    it("an entry with no recorded build id (written before build ids were) counts as foreign", async () => {
        const w = await world();
        await pod(runtime, w, "build-one", [PAGE]);
        const key = [...w.redis.strings.keys()].find((k) =>
            k.endsWith(":cache:/tagged"),
        );
        expect(key).toBeDefined();
        const entry = JSON.parse(w.redis.strings.get(key as string) as string);
        expect(entry.buildId).toBe("build-one");
        delete entry.buildId;
        w.redis.strings.set(key as string, JSON.stringify(entry));
        const out = await pod(runtime, w, "build-one", [READ]);
        expect(out.recorded).toEqual([
            { kind: "page", tags: ["_N_T_/tagged"], foreignBuild: true },
        ]);
    }, 30_000);

    it("a process with no build id cannot prove a body is its own: fail closed, Redis or memory", async () => {
        const w = await world();
        for (const extra of [{}, { REDIS_URL: undefined }]) {
            const out = await pod(runtime, w, "", [PAGE, READ], {
                KNEXT_BUILD_ID: undefined,
                ...extra,
            });
            expect(out.results.at(-1)).toEqual({
                op: "get",
                key: "/tagged",
                hit: true,
            });
            // The write records plain tags; the READ of it is marked.
            expect(out.recorded).toEqual([
                { kind: "page", tags: ["_N_T_/tagged"] },
                { kind: "page", tags: ["_N_T_/tagged"], foreignBuild: true },
            ]);
        }
    }, 30_000);

    it("the in-memory store (no Redis) marks nothing for this build's own entry", async () => {
        const w = await world();
        const out = await pod(runtime, w, "build-one", [PAGE, READ], {
            REDIS_URL: undefined,
        });
        expect(out.recorded).toEqual([
            { kind: "page", tags: ["_N_T_/tagged"] },
            { kind: "page", tags: ["_N_T_/tagged"] },
        ]);
    }, 30_000);

    it("no seam (CDN off) means no change: the foreign entry is still served", async () => {
        const w = await world();
        await pod(runtime, w, "build-one", [PAGE]);
        const out = await pod(runtime, w, "build-two", [READ], {
            POD_SEAM: undefined,
            KNEXT_CDN_PROVIDER: undefined,
        });
        expect(out.results).toEqual([{ op: "get", key: "/tagged", hit: true }]);
        expect(out.recorded).toEqual([]);
    }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. The preload in front of the real handler, over http, Node and Bun
// ---------------------------------------------------------------------------

interface BuildServer {
    port: number;
    stop(): void;
}

async function startBuild(
    runtime: "node" | "bun",
    redis: FakeRedis,
    buildId: string,
): Promise<BuildServer> {
    const dir = mkdtempSync(join(tmpdir(), "knext-cdn-two-build-"));
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "knext-cdn-routing.json"), artifact());
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        REDIS_URL: redis.url,
        REDIS_KEY_PREFIX: "cdn-fb-http",
        KNEXT_BUILD_ID: buildId,
        KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL: "1",
        POD_HANDLER: HANDLER,
        ...CDN_ENV,
    };
    const child: ChildProcess = spawn(
        runtime === "bun" ? process.execPath : "node",
        ["--require", PRELOAD, TWO_BUILD_SERVER],
        {
            cwd: dir,
            env: env as NodeJS.ProcessEnv,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let buf = "";
    const port = await new Promise<number>((res, rej) => {
        const timer = setTimeout(
            () => rej(new Error(`no PORT: ${buf}`)),
            20_000,
        );
        const on = (d: Buffer) => {
            buf += String(d);
            const m = /PORT (\d+)/.exec(buf);
            if (m) {
                clearTimeout(timer);
                res(Number(m[1]));
            }
        };
        child.stdout?.on("data", on);
        child.stderr?.on("data", (d: Buffer) => {
            buf += String(d);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            rej(new Error(`server exited ${code}: ${buf}`));
        });
    });
    const stop = () => {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
    };
    cleanups.push(stop);
    return { port, stop };
}

function req(port: number, target: string): Promise<RawResponse> {
    return rawRequest(
        port,
        `GET ${target} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n`,
    );
}

for (const runtime of ["node", "bun"] as const) {
    describe(`two builds, one Redis, the preload in front of the real handler (${runtime})`, () => {
        it("build 2 serving build 1's body: no edge directive, counted foreign_build_body; its own body: edge-cached", async () => {
            const redis = await startFakeRedis();
            cleanups.push(() => redis.close());
            const one = await startBuild(runtime, redis, "build-one");
            expect((await req(one.port, "/write?key=/tagged")).status).toBe(
                204,
            );
            const own1 = await req(one.port, "/read?key=/tagged");
            expect(own1.body).toContain("build-one");
            // A same-build HIT is edge-cached, tagged with this build's tag.
            expect(own1.header(EDGE), own1.head).toBe("max-age=30");
            one.stop();

            const two = await startBuild(runtime, redis, "build-two");
            const foreign = await req(two.port, "/read?key=/tagged");
            expect(foreign.status).toBe(200);
            // The repro's precondition: build 2 really serves build 1's body.
            expect(foreign.body).toContain("build-one");
            expect(foreign.header(EDGE), foreign.head).toBeUndefined();
            expect(foreign.header("cache-tag"), foreign.head).toBeUndefined();
            const m = (await req(two.port, "/metrics")).body;
            expect(m).toContain(
                'knext_cdn_edge_decision_total{result="skipped",reason="foreign_build_body"} 1',
            );

            // Once build 2 regenerates the entry, the page is edge-cached again.
            expect((await req(two.port, "/write?key=/tagged")).status).toBe(
                204,
            );
            const own2 = await req(two.port, "/read?key=/tagged");
            expect(own2.body).toContain("build-two");
            expect(own2.header(EDGE), own2.head).toBe("max-age=30");
        }, 60_000);
    });
}

// ---------------------------------------------------------------------------
// 4. THE ISSUE'S REPRO: two real `next build`s of the CDN-3a fixture, one Redis
// ---------------------------------------------------------------------------

function buildMark(r: RawResponse): string | undefined {
    return /<p id="build">([^<]*)<\/p>/.exec(r.body)?.[1];
}

/**
 * Build 1 has stopped serving: its liveness record (a `build-live:<id>` key
 * with a 90 s TTL, refreshed by its cache reads and writes) has lapsed. The
 * fake Redis records TTLs but never expires a key, so the lapse is the key's
 * removal. While the record is there build 1 counts as a live canary peer and
 * its window is honoured (cache-handler-isr-canary-ping-pong.test.ts).
 */
function lapseLiveness(redis: FakeRedis, buildId: string): void {
    const keys = [...redis.strings.keys()].filter((k) =>
        k.endsWith(`:build-live:${buildId}`),
    );
    expect(keys, `build ${buildId} published no liveness record`).toHaveLength(
        1,
    );
    redis.strings.delete(keys[0]);
}

/**
 * Ask until build 2 answers with its OWN render. After a stale response Next
 * re-renders in the background, so a request right behind it may still race
 * that render. A bounded wait, never a skip: if build 2 keeps serving build 1's
 * HTML, every response it gave is returned and the caller's assertion fails.
 */
async function untilOwnRender(
    port: number,
    path: string,
    mark: string,
): Promise<RawResponse[]> {
    const seen: RawResponse[] = [];
    const deadline = Date.now() + 20_000;
    for (let k = 0; ; k++) {
        const r = await getRaw(port, `${path}?settle=${k}`);
        seen.push(r);
        if (buildMark(r) === mark || Date.now() > deadline) return seen;
        await new Promise((res) => setTimeout(res, 250));
    }
}

const served = (r: RawResponse) =>
    `${buildMark(r)} ${r.header("x-nextjs-cache")} edge=${r.header(EDGE) ?? "-"}`;

for (const runtime of ["node", "bun"] as const) {
    describe(`after a rollout, real Next on a shared Redis (${runtime})`, () => {
        it("the new build serves the previous build's ISR HTML only as STALE and off the edge, then its own render (revalidate = 3600 and revalidate: false)", async () => {
            const redis = await startFakeRedis();
            cleanups.push(() => redis.close());
            const env = {
                REDIS_URL: redis.url,
                REDIS_KEY_PREFIX: `cdn-fb-next-${runtime}`,
            };
            const [b1, b2] = await Promise.all([
                buildKindApp("knext-build-one"),
                buildKindApp("knext-build-two"),
            ]);
            // /tagged is `revalidate = 3600`, /static-mark `revalidate: false`.
            // Both are in the prerender manifest, so with no window from the
            // handler Next applies the manifest's: an hour, or forever.
            const PAGES = ["/tagged", "/static-mark"];

            // Build 1 serves both pages; its own HIT is edge-cached.
            const s1 = await serveKindApp(b1, runtime, env);
            try {
                for (const path of PAGES) {
                    await getRaw(s1.port, path);
                    const own = await getRaw(s1.port, path);
                    expect(own.status, s1.log()).toBe(200);
                    expect(buildMark(own), own.head).toBe("knext-build-one");
                    expect(own.header("x-nextjs-cache"), own.head).toBe("HIT");
                    expect(own.header(EDGE), own.head).toBe("max-age=30");
                    expect(own.header("cache-tag"), own.head).toContain(
                        `kn-${KIND_PREFIX}`,
                    );
                }
            } finally {
                s1.stop();
            }
            lapseLiveness(redis, "knext-build-one");
            // A build whose liveness lapsed last wrote at least 90 s ago (every
            // write refreshes it), so its entries are older than the 1 s window
            // the handler hands back. The removed key skipped those 90 s; this
            // keeps the entries' age realistic.
            await new Promise((res) => setTimeout(res, 1500));

            // Build 2 on the same Redis.
            const s2 = await serveKindApp(b2, runtime, env);
            try {
                for (const path of PAGES) {
                    // The first request still gets build 1's body (the
                    // precondition: Redis holds it), served STALE, so Next
                    // re-renders it in the background. Never a blocking miss,
                    // never edge-cacheable.
                    const old = await getRaw(s2.port, `${path}?any`);
                    expect(old.status, s2.log()).toBe(200);
                    expect(buildMark(old), old.head).toBe("knext-build-one");
                    expect(old.header("x-nextjs-cache"), old.head).toBe(
                        "STALE",
                    );
                    expect(old.header(EDGE), old.head).toBeUndefined();
                    expect(old.header("cache-tag"), old.head).toBeUndefined();

                    // Build 2's own render follows. Before the fix Next kept
                    // answering HIT with build 1's body for the page's whole
                    // window (an hour for /tagged, forever for /static-mark).
                    const seen = await untilOwnRender(
                        s2.port,
                        path,
                        "knext-build-two",
                    );
                    const trail = seen.map(served);
                    expect(
                        buildMark(seen[seen.length - 1]),
                        `${path}: build 2 kept serving build 1's HTML: ${trail.join(" | ")}`,
                    ).toBe("knext-build-two");
                    // Any build 1 body that raced the re-render was STALE and
                    // off the edge, never a HIT.
                    for (const r of seen.filter(
                        (x) => buildMark(x) === "knext-build-one",
                    )) {
                        expect(served(r), trail.join(" | ")).toBe(
                            "knext-build-one STALE edge=-",
                        );
                    }

                    // From then on it is build 2's own HIT, edge-cached again
                    // under its own tags.
                    const after = await getRaw(s2.port, `${path}?after`);
                    expect(served(after), after.head).toBe(
                        "knext-build-two HIT edge=max-age=30",
                    );
                    expect(after.header("cache-tag"), after.head).toContain(
                        `kn-${KIND_PREFIX}`,
                    );
                }

                // Control on the same server: a page build 2 rendered itself is
                // a same-build HIT and IS edge-cached.
                await getRaw(s2.port, "/variant-a");
                const own = await getRaw(s2.port, "/variant-a");
                expect(own.status, s2.log()).toBe(200);
                expect(own.header("x-nextjs-cache"), own.head).toBe("HIT");
                expect(own.header(EDGE), own.head).toBe("max-age=30");
                expect(own.header("cache-tag"), own.head).toContain(
                    `kn-${KIND_PREFIX}`,
                );
            } finally {
                s2.stop();
            }
        }, 600_000);
    });
}
