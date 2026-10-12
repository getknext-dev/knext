import { afterEach, describe, expect, it } from "bun:test";
import {
    captureLog,
    cloudflareEnv,
    type FakeCdn,
    fakeClock,
    fakeRedis,
    PREFIX,
    routeFetch,
    startFakeCdn,
} from "./helpers/cdn-purge-fixtures";

/**
 * First-ready purge, deduped across the cluster (ADR-0068 D7).
 *
 * `SET knext:cdn:purged:<p>:<buildId> 1 NX EX 604800` in the app's own Redis.
 * The pod that wins purges the app tag `kn-<p>`; the rest do nothing. A pod
 * local flag would purge on every scale-to-zero wake. Without Redis there is
 * NO first-ready purge.
 */
const PURGE: string = "../adapters/cdn-purge/index.js";
// biome-ignore lint/suspicious/noExplicitAny: the module is untyped plain JS
type Any = any;

const servers: FakeCdn[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** One "pod": its own purger, its own queue and log, sharing the fake CDN. */
async function pod(
    cdn: FakeCdn,
    env: Record<string, string | undefined>,
    mod: Any,
) {
    const clock = fakeClock();
    const logs = captureLog();
    const metrics = mod.createMetricsRegistry();
    const purger = mod.createCdnPurger({
        env,
        fetch: routeFetch(cdn.port),
        now: clock.now,
        sleep: clock.sleep,
        log: logs.log,
        metrics,
        flushIntervalMs: 60_000,
    });
    return { purger, logs, metrics };
}

async function fixture() {
    const cdn = await startFakeCdn();
    servers.push(cdn);
    const mod: Any = await import(PURGE);
    const { env } = cloudflareEnv();
    return { cdn, mod, env };
}

const KEY = (build: string) => `knext:cdn:purged:${PREFIX}:${build}`;

describe("first-ready purge dedup (ADR-0068 D7)", () => {
    for (const shape of ["ioredis", "native"] as const) {
        it(`two pods start at once on a ${shape} client -> exactly one purge of the app tag`, async () => {
            const { cdn, mod, env } = await fixture();
            const redis = fakeRedis(shape);
            const a = await pod(cdn, env, mod);
            const b = await pod(cdn, env, mod);

            const [ra, rb] = await Promise.all([
                a.purger.firstReady("build-1", redis.client),
                b.purger.firstReady("build-1", redis.client),
            ]);
            await Promise.all([a.purger.flush(), b.purger.flush()]);

            expect([ra.purged, rb.purged].sort()).toEqual([false, true]);
            expect(cdn.requests.length).toBe(1);
            expect((cdn.requests[0]?.json as Any).tags).toEqual([
                `kn-${PREFIX}`,
            ]);
            expect(redis.store.has(KEY("build-1"))).toBe(true);
        });
    }

    it("claims with SET NX EX 604800 on the exact key from the ADR", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        await a.purger.firstReady("build-9", redis.client);
        await a.purger.flush();
        expect(redis.calls.length).toBe(1);
        expect(redis.calls[0]?.key).toBe(KEY("build-9"));
        const args = (redis.calls[0]?.args ?? []).map((x) => x.toUpperCase());
        expect(args).toContain("NX");
        expect(args.join(" ")).toContain("EX 604800");
    });

    it("a later wake of the same build (new process) does NOT purge again", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const first = await pod(cdn, env, mod);
        await first.purger.firstReady("build-1", redis.client);
        await first.purger.flush();
        const woken = await pod(cdn, env, mod);
        const r = await woken.purger.firstReady("build-1", redis.client);
        await woken.purger.flush();
        expect(r.purged).toBe(false);
        expect(cdn.requests.length).toBe(1);
    });

    it("a NEW build purges once more", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        await a.purger.firstReady("build-1", redis.client);
        const b = await pod(cdn, env, mod);
        await b.purger.firstReady("build-2", redis.client);
        await Promise.all([a.purger.flush(), b.purger.flush()]);
        expect(cdn.requests.length).toBe(2);
    });

    it("is once per process: a second call for the same build never touches Redis again", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        await a.purger.firstReady("build-1", redis.client);
        const again = await a.purger.firstReady("build-1", redis.client);
        expect(again.purged).toBe(false);
        expect(redis.calls.length).toBe(1);
    });

    it("the winner's purge goes through the same bounded pipeline (counted ok)", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        await a.purger.firstReady("b", redis.client);
        await a.purger.flush();
        expect(
            a.metrics.get("knext_cdn_purge_total", {
                provider: "cloudflare",
                result: "ok",
            }),
        ).toBe(1);
    });
});

describe("no Redis / bad Redis -> no first-ready purge, never a throw", () => {
    it("no client at all", async () => {
        const { cdn, mod, env } = await fixture();
        const a = await pod(cdn, env, mod);
        for (const none of [undefined, null]) {
            const r = await a.purger.firstReady("b", none);
            expect(r.purged).toBe(false);
        }
        await a.purger.flush();
        expect(cdn.requests.length).toBe(0);
    });

    it("a client getter that resolves nothing (cache handler's memory fallback)", async () => {
        const { cdn, mod, env } = await fixture();
        const a = await pod(cdn, env, mod);
        const r = await a.purger.firstReady("b", async () => null);
        expect(r.purged).toBe(false);
        expect(cdn.requests.length).toBe(0);
    });

    it("a client getter that resolves a client works", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        const r = await a.purger.firstReady("b", async () => redis.client);
        await a.purger.flush();
        expect(r.purged).toBe(true);
        expect(cdn.requests.length).toBe(1);
    });

    it("Redis throwing fails closed: no purge, no throw (the edge TTL bounds staleness)", async () => {
        const { cdn, mod, env } = await fixture();
        const a = await pod(cdn, env, mod);
        const broken = {
            set: async () => {
                throw new Error("ECONNRESET");
            },
        };
        const r = await a.purger.firstReady("b", broken);
        await a.purger.flush();
        expect(r.purged).toBe(false);
        expect(cdn.requests.length).toBe(0);
    });

    it("a getter that throws is also swallowed", async () => {
        const { cdn, mod, env } = await fixture();
        const a = await pod(cdn, env, mod);
        const r = await a.purger.firstReady("b", async () => {
            throw new Error("boom");
        });
        expect(r.purged).toBe(false);
    });

    it("a missing build id never claims the key", async () => {
        const { cdn, mod, env } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        for (const bad of [undefined, null, ""]) {
            const r = await a.purger.firstReady(bad, redis.client);
            expect(r.purged).toBe(false);
        }
        expect(redis.calls.length).toBe(0);
    });
});

describe("providers that cannot purge do not consume the claim", () => {
    it("deferred row: Redis untouched, no purge", async () => {
        const { cdn, mod } = await fixture();
        const { env } = cloudflareEnv({ KNEXT_CDN_PROVIDER: "cloudfront" });
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        const r = await a.purger.firstReady("b", redis.client);
        expect(r.purged).toBe(false);
        expect(redis.calls.length).toBe(0);
    });

    it("no credential: Redis untouched (the claim must stay available to a pod that can purge)", async () => {
        const { cdn, mod } = await fixture();
        const { env } = cloudflareEnv({ KNEXT_CDN_PURGE_TOKEN: undefined });
        const redis = fakeRedis();
        const a = await pod(cdn, env, mod);
        const r = await a.purger.firstReady("b", redis.client);
        expect(r.purged).toBe(false);
        expect(redis.calls.length).toBe(0);
    });

    it("CDN disabled: Redis untouched", async () => {
        const { cdn, mod } = await fixture();
        const redis = fakeRedis();
        const a = await pod(cdn, {}, mod);
        const r = await a.purger.firstReady("b", redis.client);
        expect(r.purged).toBe(false);
        expect(redis.calls.length).toBe(0);
    });
});
