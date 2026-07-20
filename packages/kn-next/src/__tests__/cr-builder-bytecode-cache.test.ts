import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #431 — decouple bytecode caching from the DATA-cache provider.
 *
 * Bytecode caching is a V8 compile cache on a PVC that governs SERVER BOOT
 * SPEED (`NODE_COMPILE_CACHE`); the cache *provider* is about ISR/data
 * caching. They are orthogonal, but `cr-builder` used to derive one from the
 * other (`enableBytecodeCache: config.cache.provider === "redis"`) AND only
 * emitted `spec.cache` at all when a `cache` block existed — so an app with
 * GCS storage and no Redis silently paid a fully-uncached ~2s Node boot on
 * every cold start (measured on OKE, file-manager).
 *
 * Contract asserted here:
 *  - `bytecodeCache.enabled` is authorable INDEPENDENTLY of `cache` — with a
 *    non-Redis provider, and with no `cache` block at all.
 *  - when it is requested without any data-cache provider, `spec.cache` is
 *    emitted anyway, carrying ONLY the bytecode fields (no empty provider/url).
 *  - BACK-COMPAT: a config that does not mention `bytecodeCache` produces a
 *    byte-identical CR to the pre-#431 builder (redis ⇒ on, otherwise the
 *    `spec.cache` key is absent entirely).
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    overrides: Partial<KnativeNextConfig> = {},
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        ...overrides,
    };
}

function specOf(config: KnativeNextConfig) {
    return buildNextAppCRObject(config, IMG, "ns").spec as Record<
        string,
        unknown
    >;
}

function cacheOf(config: KnativeNextConfig) {
    return specOf(config).cache as Record<string, unknown> | undefined;
}

const REDIS: KnativeNextConfig["cache"] = {
    provider: "redis",
    url: "redis://r:6379",
};

describe("#431 bytecode cache — decoupled from the data-cache provider", () => {
    describe("AC1: enablable with no cache block / a non-Redis provider", () => {
        it("emits spec.cache.enableBytecodeCache=true with NO cache block at all", () => {
            const cache = cacheOf(
                baseConfig({ bytecodeCache: { enabled: true } }),
            );
            expect(cache).toBeDefined();
            expect(cache?.enableBytecodeCache).toBe(true);
        });

        it("does NOT invent an empty data-cache provider/url when none is configured", () => {
            // An empty provider would make the operator export CACHE_PROVIDER=""
            // and REDIS_URL="" — emit only the bytecode fields instead.
            const cache = cacheOf(
                baseConfig({ bytecodeCache: { enabled: true } }),
            );
            expect(cache).not.toHaveProperty("provider");
            expect(cache).not.toHaveProperty("url");
            expect(Object.keys(cache ?? {})).toEqual(["enableBytecodeCache"]);
        });

        it("enables it alongside GCS storage (a non-Redis data path)", () => {
            const spec = specOf(
                baseConfig({ bytecodeCache: { enabled: true } }),
            );
            expect((spec.storage as Record<string, unknown>).provider).toBe(
                "gcs",
            );
            expect(
                (spec.cache as Record<string, unknown>).enableBytecodeCache,
            ).toBe(true);
        });

        it("carries bytecodeCacheSize when a size is authored", () => {
            const cache = cacheOf(
                baseConfig({ bytecodeCache: { enabled: true, size: "1Gi" } }),
            );
            expect(cache?.bytecodeCacheSize).toBe("1Gi");
        });

        it("omits bytecodeCacheSize when unset (operator default 512Mi applies)", () => {
            const cache = cacheOf(
                baseConfig({ bytecodeCache: { enabled: true } }),
            );
            expect(cache).not.toHaveProperty("bytecodeCacheSize");
        });
    });

    describe("AC2: round-trip matrix — (no cache | redis) x (on | off | unset)", () => {
        const providers: Array<[string, KnativeNextConfig["cache"]]> = [
            ["no cache block", undefined],
            ["provider=redis", REDIS],
        ];

        for (const [label, cacheBlock] of providers) {
            it(`${label} + bytecodeCache.enabled=true ⇒ enableBytecodeCache true`, () => {
                const cache = cacheOf(
                    baseConfig({
                        cache: cacheBlock,
                        bytecodeCache: { enabled: true },
                    }),
                );
                expect(cache?.enableBytecodeCache).toBe(true);
            });

            it(`${label} + bytecodeCache.enabled=false ⇒ enableBytecodeCache false`, () => {
                const cache = cacheOf(
                    baseConfig({
                        cache: cacheBlock,
                        bytecodeCache: { enabled: false },
                    }),
                );
                if (cacheBlock === undefined) {
                    // Nothing to emit: no data cache AND no bytecode cache.
                    expect(
                        specOf(
                            baseConfig({ bytecodeCache: { enabled: false } }),
                        ),
                    ).not.toHaveProperty("cache");
                } else {
                    expect(cache?.enableBytecodeCache).toBe(false);
                }
            });
        }

        it("explicit false OVERRIDES the legacy redis⇒on inference", () => {
            const cache = cacheOf(
                baseConfig({
                    cache: REDIS,
                    bytecodeCache: { enabled: false },
                }),
            );
            // The data cache is untouched — only the boot-time cache is off.
            expect(cache?.provider).toBe("redis");
            expect(cache?.url).toBe("redis://r:6379");
            expect(cache?.enableBytecodeCache).toBe(false);
        });
    });

    describe("AC3: back-compat — no CR shape change for existing configs", () => {
        it("redis config without `bytecodeCache` keeps enableBytecodeCache=true", () => {
            const cache = cacheOf(baseConfig({ cache: REDIS }));
            expect(cache).toEqual({
                provider: "redis",
                url: "redis://r:6379",
                enableBytecodeCache: true,
            });
        });

        it("redis config with keyPrefix is byte-identical to the pre-#431 shape", () => {
            const cache = cacheOf(
                baseConfig({
                    cache: {
                        provider: "redis",
                        url: "redis://r:6379",
                        keyPrefix: "p:",
                    },
                }),
            );
            // Key ORDER is part of the emitted-YAML contract.
            expect(Object.keys(cache ?? {})).toEqual([
                "provider",
                "url",
                "keyPrefix",
                "enableBytecodeCache",
            ]);
            expect(cache).toEqual({
                provider: "redis",
                url: "redis://r:6379",
                keyPrefix: "p:",
                enableBytecodeCache: true,
            });
        });

        it("a config with neither `cache` nor `bytecodeCache` omits spec.cache entirely", () => {
            const spec = specOf(baseConfig());
            expect(spec).not.toHaveProperty("cache");
        });
    });

    describe("default: OFF unless asked for", () => {
        // Deliberate (#431): the bytecode PVC is ReadWriteOnce and default
        // maxScale is 10, so defaulting ON would leave burst pods unable to
        // attach the volume on a second node; and on a cluster with no default
        // StorageClass the PVC never binds and the pod never starts. Neither
        // may happen to a deployment that works today — so it is opt-in.
        it("does not enable bytecode caching just because storage is configured", () => {
            expect(specOf(baseConfig())).not.toHaveProperty("cache");
        });
    });
});
