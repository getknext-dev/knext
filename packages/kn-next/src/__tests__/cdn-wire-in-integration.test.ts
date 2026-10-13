import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    EMULATOR_ENDPOINT,
    type FakeCdn,
    PREFIX,
    startFakeCdn,
} from "./helpers/cdn-purge-fixtures";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * CDN wire-in, end to end across processes (ADR-0068 D5.1, D6, D7).
 *
 * Each "pod" is a separate process running the REAL cache handler
 * (`fixtures/cdn-wire-in-pod.mjs`). The pods share only what replicas share: a
 * real-TCP fake Redis and a fake CDN purge endpoint (the emulator row, reached
 * through a fetch that routes its cluster-local hostname to 127.0.0.1). The
 * request-tag seam is a stub, because the preload that owns it lands
 * separately; the stub has the seam's exact contract (`record({kind, tags})`).
 *
 * Every case runs under the runtime running this file (Bun under `bun test`)
 * AND under Node, since the handler serves both.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HANDLER = resolve(here, "../adapters/cache-handler.js");
const POD = resolve(here, "fixtures/cdn-wire-in-pod.mjs");

const hex = (s: string, n: number) =>
    createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
const appTag = `kn-${PREFIX}`;
const nextTag = (t: string) => `kn-${PREFIX}-t${hex(t, 16)}`;

type Action =
    | { op: "set"; key: string; tags: string[] }
    | { op: "get"; key: string }
    | { op: "revalidate"; tags: string[] };

interface PodOut {
    recorded: { kind: string; tags: string[] }[];
    results: unknown[];
    inFlight: number;
}

const RUNTIMES: [string, string][] = [
    [process.versions.bun ? "bun" : "node", process.execPath],
    ...(process.versions.bun ? ([["node", "node"]] as [string, string][]) : []),
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
});

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
    actions: Action[],
    extra: Record<string, string | undefined> = {},
): Promise<PodOut> {
    const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        REDIS_URL: w.redis.url,
        REDIS_KEY_PREFIX: "cdn-int",
        KNEXT_BUILD_ID: "build-int-1",
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

/** Every tag of every purge request the fake CDN received, one entry per request. */
const purgeBatches = (cdn: FakeCdn) =>
    cdn.requests.map((r) => (r.json as { tags: string[] }).tags);
const requestsCarrying = (cdn: FakeCdn, tag: string) =>
    purgeBatches(cdn).filter((tags) => tags.includes(tag)).length;

describe.each(RUNTIMES)("CDN wire-in across pods -- %s", (_label, runtime) => {
    it("revalidateTag('x') produces exactly one purge request carrying the prefixed tag", async () => {
        const w = await world();
        const out = await pod(runtime, w, [
            { op: "set", key: "/p", tags: ["x", "_N_T_/p"] },
            { op: "revalidate", tags: ["x"] },
        ]);
        expect(out.inFlight).toBe(0);
        expect(requestsCarrying(w.cdn, nextTag("x"))).toBe(1);
        // The raw Next tag never leaves the pod: only its hashed form does.
        expect(JSON.stringify(purgeBatches(w.cdn))).not.toContain('"x"');
        expect(w.cdn.requests[0]?.url).toBe(
            "/client/v4/zones/zone-1/purge_cache",
        );
    }, 30_000);

    it("two pods: one revalidates, both are live -> one purge for the tag, one first-ready purge per build", async () => {
        const w = await world();
        const [a, b] = await Promise.all([
            pod(runtime, w, [
                { op: "set", key: "/p", tags: ["x", "_N_T_/p"] },
                { op: "revalidate", tags: ["x"] },
            ]),
            pod(runtime, w, [
                { op: "set", key: "/q", tags: ["x", "_N_T_/q"] },
                { op: "get", key: "/q" },
            ]),
        ]);
        expect(a.inFlight + b.inFlight).toBe(0);
        expect(requestsCarrying(w.cdn, nextTag("x"))).toBe(1);
        expect(requestsCarrying(w.cdn, appTag)).toBe(1);
        expect(
            w.redis.strings.get(`knext:cdn:purged:${PREFIX}:build-int-1`),
        ).toBe("1");
    }, 30_000);

    it("a pod of a build that already purged does not purge again (scale-from-zero wake)", async () => {
        const w = await world();
        await pod(runtime, w, []);
        await pod(runtime, w, []);
        expect(requestsCarrying(w.cdn, appTag)).toBe(1);
        // A new build purges once more.
        await pod(runtime, w, [], { KNEXT_BUILD_ID: "build-int-2" });
        expect(requestsCarrying(w.cdn, appTag)).toBe(2);
    }, 30_000);

    it("tags recorded on set and get reach the seam, implicit _N_T_ included", async () => {
        const w = await world();
        const out = await pod(runtime, w, [
            {
                op: "set",
                key: "/p",
                tags: ["posts", "_N_T_/layout", "_N_T_/p"],
            },
            { op: "get", key: "/p" },
        ]);
        const want = {
            kind: "page",
            tags: ["posts", "_N_T_/layout", "_N_T_/p"],
        };
        expect(out.recorded).toEqual([want, want]);
    }, 30_000);

    it("KNEXT_CDN_PROVIDER unset: no purge request and no knext:cdn key, even with Redis and a build id", async () => {
        const w = await world();
        const out = await pod(
            runtime,
            w,
            [
                { op: "set", key: "/p", tags: ["x", "_N_T_/p"] },
                { op: "revalidate", tags: ["x"] },
            ],
            { KNEXT_CDN_PROVIDER: undefined, POD_SEAM: undefined },
        );
        expect(out.inFlight).toBe(0);
        expect(out.recorded).toEqual([]);
        expect(w.cdn.requests).toEqual([]);
        expect(
            [...w.redis.strings.keys()].filter((k) =>
                k.startsWith("knext:cdn:"),
            ),
        ).toEqual([]);
    }, 30_000);
});
