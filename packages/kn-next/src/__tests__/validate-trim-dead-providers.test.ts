import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * P1 — trim the DEAD provider surface.
 *
 * CLAUDE.md §9 + the DB-engine-scope rule ("don't ship aspirational surface"):
 * a provider that config-VALIDATES but has NO runtime implementation lures users
 * into a dead end. The DynamoDB cache provider is exactly that — there is no
 * DynamoDB code in the cache-handler (Redis + in-memory only) and none in the
 * operator. Config validation must REJECT it with a clear, honest error rather
 * than green-light a provider that silently does nothing.
 *
 * NOTE on Kafka (intentionally NOT rejected here): the Kafka ISR-revalidation
 * queue is NOT dead aspirational surface — it is an ADR-0016 *deferred-but-wired*
 * path. The operator provisions a KafkaSource behind an explicit opt-in and
 * surfaces an observable `RevalidationDeferred` status condition; ADR-0016
 * explicitly REJECTED "drop the Kafka path entirely". So `queue: "kafka"` stays
 * valid at the config layer (the deferral is observable at reconcile time), while
 * the truly-unimplemented DynamoDB cache is trimmed.
 */
describe("validateConfig trims dead provider surface", () => {
    function baseConfig(): KnativeNextConfig {
        return {
            name: "shop",
            registry: "us-docker.pkg.dev/p/r",
            storage: {
                provider: "gcs",
                bucket: "b",
                publicUrl: "https://example.test/b",
            },
        } as KnativeNextConfig;
    }

    it("rejects the trimmed DynamoDB cache provider with a clear error", () => {
        const cfg = baseConfig();
        // `dynamodb` is no longer part of the CacheProvider type (trimmed dead
        // surface, #476) — a stale config that still names it must be rejected as
        // an unsupported provider, not silently green-lit.
        // biome-ignore lint/suspicious/noExplicitAny: deliberately trimmed provider.
        cfg.cache = {
            provider: "dynamodb",
            tableName: "t",
            region: "us-east-1",
        } as any;

        expect(() => validateConfig(cfg)).toThrow(ConfigValidationError);
        // The message must name the provider and point at the supported set.
        expect(() => validateConfig(cfg)).toThrow(/dynamodb/i);
        expect(() => validateConfig(cfg)).toThrow(/not supported|redis/i);
    });

    it("still accepts the implemented Redis cache provider", () => {
        const cfg = baseConfig();
        cfg.cache = {
            provider: "redis",
            url: "redis://localhost:6379",
        };
        expect(() => validateConfig(cfg)).not.toThrow();
    });

    it("rejects an unknown/garbage cache provider", () => {
        const cfg = baseConfig();
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid provider.
        cfg.cache = { provider: "memcached" } as any;
        expect(() => validateConfig(cfg)).toThrow(ConfigValidationError);
    });

    it("accepts the ADR-0016 deferred-but-wired Kafka queue (not dead surface)", () => {
        const cfg = baseConfig();
        cfg.queue = {
            provider: "kafka",
            brokerUrl: "kafka:9092",
        };
        expect(() => validateConfig(cfg)).not.toThrow();
    });

    it("accepts queue 'none'", () => {
        const cfg = baseConfig();
        cfg.queue = { provider: "none" };
        expect(() => validateConfig(cfg)).not.toThrow();
    });

    it("rejects an unknown/garbage queue provider", () => {
        const cfg = baseConfig();
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid provider.
        cfg.queue = { provider: "rabbitmq" } as any;
        expect(() => validateConfig(cfg)).toThrow(ConfigValidationError);
    });
});
