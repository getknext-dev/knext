/**
 * Config validation — runs at load time, fails fast with clear errors.
 */

import type { KnativeNextConfig } from "../config";

const SUPPORTED_STORAGE_PROVIDERS = ["gcs", "s3", "minio"] as const;

// Cache providers that have a REAL runtime. Only Redis (+ the in-memory dev
// fallback) is implemented in `cache-handler.js`. The `dynamodb` provider is
// schema-only DEAD surface — there is NO DynamoDB code in the cache-handler or
// the operator — so we REJECT it at config time rather than green-lighting a
// provider that silently does nothing (CLAUDE.md §9; "don't ship aspirational
// surface"). To re-enable: ship the implementation first, then move it here.
const IMPLEMENTED_CACHE_PROVIDERS = ["redis"] as const;
// Schema still carries `dynamodb` (config.ts), but the runtime was never built.
// Listed separately so the error can be honest ("not implemented") vs "unknown".
const UNIMPLEMENTED_CACHE_PROVIDERS = ["dynamodb"] as const;

// Queue providers for ISR revalidation. `kafka` is NOT dead surface: it is the
// ADR-0016 deferred-but-WIRED path — the operator provisions a KafkaSource behind
// an explicit opt-in and surfaces an observable `RevalidationDeferred` status
// condition; ADR-0016 explicitly REJECTED "drop the Kafka path entirely". So both
// `kafka` and `none` validate here; the deferral is observable at reconcile time.
const SUPPORTED_QUEUE_PROVIDERS = ["kafka", "none"] as const;
const SUPPORTED_RUNTIMES = ["bun", "node"] as const;

export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(`[kn-next] Config validation failed: ${message}`);
        this.name = "ConfigValidationError";
    }
}

/**
 * Validates a KnativeNextConfig at load time.
 * Throws ConfigValidationError with clear messages on invalid config.
 */
export function validateConfig(config: KnativeNextConfig): void {
    const errors: string[] = [];

    // Required fields
    if (!config.name || typeof config.name !== "string") {
        errors.push("'name' is required and must be a non-empty string");
    }

    if (!config.registry || typeof config.registry !== "string") {
        errors.push(
            "'registry' is required (e.g. 'us-central1-docker.pkg.dev/my-project/my-repo')",
        );
    }

    // Storage validation
    if (!config.storage) {
        errors.push("'storage' is required");
    } else {
        if (
            !(SUPPORTED_STORAGE_PROVIDERS as readonly string[]).includes(
                config.storage.provider,
            )
        ) {
            errors.push(
                `Storage provider '${config.storage.provider}' is not supported. Supported: ${SUPPORTED_STORAGE_PROVIDERS.join(", ")}`,
            );
        }
        if (!config.storage.bucket) {
            errors.push("'storage.bucket' is required");
        }
    }

    // Cache validation (optional, but must be valid if present)
    if (config.cache) {
        const cacheProvider = config.cache.provider;
        if (
            (UNIMPLEMENTED_CACHE_PROVIDERS as readonly string[]).includes(
                cacheProvider,
            )
        ) {
            // Honest, actionable error: the provider is recognized by the schema
            // but has no runtime. Tell the user to use the implemented one.
            errors.push(
                `Cache provider '${cacheProvider}' is not implemented (schema-only, no runtime). ` +
                    `Use 'redis' (the only implemented cache provider) or omit 'cache' for the in-memory dev fallback.`,
            );
        } else if (
            !(IMPLEMENTED_CACHE_PROVIDERS as readonly string[]).includes(
                cacheProvider,
            )
        ) {
            errors.push(
                `Cache provider '${cacheProvider}' is not supported. Supported: ${IMPLEMENTED_CACHE_PROVIDERS.join(", ")}`,
            );
        }
        if (cacheProvider === "redis" && !config.cache.url) {
            errors.push(
                "'cache.url' is required when using Redis cache provider",
            );
        }
    }

    // Queue (ISR-revalidation) validation. Only the ADR-0016 kafka path and
    // 'none' are valid; anything else is an unknown provider.
    if (config.queue) {
        if (
            !(SUPPORTED_QUEUE_PROVIDERS as readonly string[]).includes(
                config.queue.provider,
            )
        ) {
            errors.push(
                `Queue provider '${config.queue.provider}' is not supported. Supported: ${SUPPORTED_QUEUE_PROVIDERS.join(", ")}`,
            );
        }
        if (config.queue.provider === "kafka" && !config.queue.brokerUrl) {
            errors.push(
                "'queue.brokerUrl' is required when using the Kafka revalidation queue",
            );
        }
    }

    // Runtime validation
    if (
        config.runtime &&
        !(SUPPORTED_RUNTIMES as readonly string[]).includes(config.runtime)
    ) {
        errors.push(
            `Runtime '${config.runtime}' is not supported. Supported: ${SUPPORTED_RUNTIMES.join(", ")}`,
        );
    }

    // Scaling validation
    if (config.scaling) {
        if (
            config.scaling.minScale !== undefined &&
            config.scaling.minScale < 0
        ) {
            errors.push("'scaling.minScale' must be >= 0");
        }
        if (
            config.scaling.maxScale !== undefined &&
            config.scaling.maxScale < 1
        ) {
            errors.push("'scaling.maxScale' must be >= 1");
        }
        if (
            config.scaling.minScale !== undefined &&
            config.scaling.maxScale !== undefined &&
            config.scaling.minScale > config.scaling.maxScale
        ) {
            errors.push(
                "'scaling.minScale' cannot be greater than 'scaling.maxScale'",
            );
        }
    }

    if (errors.length > 0) {
        throw new ConfigValidationError(`\n  - ${errors.join("\n  - ")}`);
    }
}
