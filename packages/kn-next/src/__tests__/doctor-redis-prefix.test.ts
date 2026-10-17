import { describe, expect, it } from "bun:test";
import { runDoctor } from "../cli/doctor";
import {
    defaultRedisKeyPrefix,
    redisPrefixCheck,
} from "../cli/doctor/checks/redis-prefix";
import type { CheckContext, KubectlFn } from "../cli/doctor/types";

/**
 * `knext doctor` flags NextApps whose Redis key prefixes collide.
 *
 * Two apps under one prefix on a shared Redis read each other's entries, share
 * each other's tag invalidations, and — before the runtime refused it — one
 * app's outage collapse deleted the other's whole cache. The operator now gives
 * every app without `cache.keyPrefix` its own derived prefix, so a collision
 * takes an explicit choice: the same `keyPrefix` (or `REDIS_KEY_PREFIX`) twice,
 * the shared fallback `kn-next` set on purpose, or one prefix nested inside
 * another's sweep pattern (`shop` sweeps `shop:cache:*`, which holds every key
 * of an app prefixed `shop:cache`).
 */

type App = {
    name: string;
    namespace?: string;
    cache?: { provider?: string; url?: string; keyPrefix?: string };
    env?: Record<string, string>;
    envMap?: Record<string, { secretName: string; secretKey: string }>;
};

function ctxWith(apps: App[] | "fail"): CheckContext {
    const kubectl: KubectlFn = (args) => {
        if (args.join(" ") !== "kubectl get nextapps --all-namespaces -o json")
            return { ok: false, stdout: "", stderr: "unexpected" };
        if (apps === "fail")
            return { ok: false, stdout: "", stderr: "forbidden" };
        return {
            ok: true,
            stderr: "",
            stdout: JSON.stringify({
                items: apps.map((a) => ({
                    metadata: {
                        name: a.name,
                        namespace: a.namespace ?? "default",
                    },
                    spec: {
                        cache: a.cache,
                        env: a.env,
                        secrets: a.envMap ? { envMap: a.envMap } : undefined,
                    },
                })),
            }),
        };
    };
    return {
        // biome-ignore lint/suspicious/noExplicitAny: only kubectl is read
        deps: {} as any,
        kubectl,
        skipAll: false,
    };
}

const redis = (keyPrefix?: string) => ({
    provider: "redis",
    url: "redis://shared:6379",
    ...(keyPrefix ? { keyPrefix } : {}),
});

describe("doctor: Redis key prefixes", () => {
    it("derives the operator's default prefix (lockstep vector with the Go operator)", () => {
        expect(defaultRedisKeyPrefix("default", "shop")).toBe(
            "kn-5be479caf0c0",
        );
        expect(defaultRedisKeyPrefix("team-b", "shop")).toBe("kn-d8bd7dc33539");
    });

    it("contributes NO row when no app uses a Redis cache (and when the list cannot be read)", () => {
        expect(redisPrefixCheck(ctxWith([]))).toEqual([]);
        expect(
            redisPrefixCheck(
                ctxWith([{ name: "a", cache: { provider: "memory" } }]),
            ),
        ).toEqual([]);
        expect(redisPrefixCheck(ctxWith("fail"))).toEqual([]);
        expect(redisPrefixCheck({ ...ctxWith([]), skipAll: true })).toEqual([]);
    });

    it("PASS: apps without keyPrefix get distinct derived prefixes, even with the same name in two namespaces", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                { name: "shop", cache: redis() },
                { name: "shop", namespace: "team-b", cache: redis() },
                { name: "blog", cache: redis("blog") },
            ]),
        );
        expect(row?.id).toBe("redis-prefix");
        expect(row?.status).toBe("pass");
    });

    it("WARN: two apps set the same keyPrefix — names both apps and the prefix", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                { name: "shop", cache: redis("shared") },
                { name: "blog", namespace: "team-b", cache: redis("shared") },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("'shared'");
        expect(row?.detail).toContain("default/shop");
        expect(row?.detail).toContain("team-b/blog");
        expect(row?.hint).toBeDefined();
    });

    it("WARN: a REDIS_KEY_PREFIX in spec.env counts as the app's prefix", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                { name: "shop", cache: redis("p1") },
                {
                    name: "blog",
                    cache: redis(),
                    env: { REDIS_KEY_PREFIX: "p1" },
                },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("default/blog");
    });

    it("WARN: the shared fallback 'kn-next' set explicitly, even by one app", () => {
        const [row] = redisPrefixCheck(
            ctxWith([{ name: "shop", cache: redis("kn-next") }]),
        );
        expect(row?.status).toBe("warn");
        // The CRD's admission rule refuses a stored 'kn-next' keyPrefix, so the
        // "refused by the cluster" note alone would also say 'kn-next' and warn.
        // Only the shared-fallback finding says the cache is never swept; pin
        // that sentence so removing the finding goes red, not just the note.
        expect(row?.detail).toContain(
            "default/shop uses the shared fallback 'kn-next' (its cache is never swept after an outage)",
        );
    });

    it("WARN: the shared fallback 'kn-next' via spec.env REDIS_KEY_PREFIX (admission never sees it), even by one app", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                {
                    name: "shop",
                    cache: redis(),
                    env: { REDIS_KEY_PREFIX: "kn-next" },
                },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain(
            "default/shop uses the shared fallback 'kn-next' (its cache is never swept after an outage)",
        );
        // Not also reported as a keyPrefix the cluster refuses: that is stored
        // spec.cache.keyPrefix only, so this finding stands on its own.
        expect(row?.detail).not.toContain("the cluster now refuses it");
    });

    it("WARN: two apps on the shared fallback are named together, in the plural", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                {
                    name: "shop",
                    cache: redis(),
                    env: { REDIS_KEY_PREFIX: "kn-next" },
                },
                {
                    name: "blog",
                    cache: redis(),
                    env: { REDIS_KEY_PREFIX: "kn-next" },
                },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain(
            "default/shop, default/blog use the shared fallback 'kn-next'",
        );
    });

    it("WARN: a prefix nested under the shared fallback ('kn-next:cache'), even by one app", () => {
        const [row] = redisPrefixCheck(
            ctxWith([{ name: "shop", cache: redis("kn-next:cache") }]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("'kn-next:cache'");
        expect(row?.detail).toContain("shared fallback 'kn-next'");
        // A prefix that only starts with the letters is its own keyspace.
        const [own] = redisPrefixCheck(
            ctxWith([{ name: "shop", cache: redis("kn-nextapp") }]),
        );
        expect(own?.status).toBe("pass");
    });

    it("WARN: one prefix nested in another's sweep pattern ('shop' vs 'shop:cache')", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                { name: "shop", cache: redis("shop") },
                { name: "other", cache: redis("shop:cache") },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("'shop:cache'");
    });

    it("an empty spec.env REDIS_KEY_PREFIX is unset: resolved to the derived default, as the operator renders it (lockstep vector)", () => {
        // default/shop with REDIS_KEY_PREFIX: "" runs under kn-5be479caf0c0
        // (redis_key_prefix_test.go, TestRedisKeyPrefix_EmptyUserEnvIsUnset), so
        // an app that sets that prefix explicitly shares its keyspace.
        const [row] = redisPrefixCheck(
            ctxWith([
                {
                    name: "shop",
                    cache: redis(),
                    env: { REDIS_KEY_PREFIX: "" },
                },
                { name: "blog", cache: redis("kn-5be479caf0c0") },
            ]),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("'kn-5be479caf0c0'");
        expect(row?.detail).toContain("default/shop");
        expect(row?.detail).toContain("default/blog");
    });

    it("an envMap REDIS_KEY_PREFIX cannot be read (a Secret): reported as unverified, not as a collision", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                { name: "shop", cache: redis() },
                {
                    name: "blog",
                    cache: redis(),
                    envMap: {
                        REDIS_KEY_PREFIX: { secretName: "s", secretKey: "k" },
                    },
                },
            ]),
        );
        expect(row?.status).toBe("pass");
        expect(row?.detail).toContain("default/blog");
    });

    it("is wired into runDoctor: a reachable cluster with colliding prefixes reports the row", async () => {
        const apps = ctxWith([
            { name: "shop", cache: redis("shared") },
            { name: "blog", cache: redis("shared") },
        ]);
        const report = await runDoctor({
            kubectl: (args) =>
                args.join(" ") === "kubectl get --raw /version"
                    ? { ok: true, stdout: "{}", stderr: "" }
                    : apps.kubectl(args),
            probeImage: async () => "ok",
        });
        const row = report.checks.find((c) => c.id === "redis-prefix");
        expect(row?.status).toBe("warn");
    });
});
