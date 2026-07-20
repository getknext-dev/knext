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

// #186 — config.env local validation, MIRRORING the NextApp CRD's CEL rules
// (api/v1alpha1/nextapp_types.go). The cluster rejects these at `kubectl
// apply`; validating here fails fast at validate/deploy time instead.
// Keep both lists in lock-step with the operator.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_NAMES = [
    "HOSTNAME", // operator-injected 0.0.0.0 bind fix — overriding it resurrects the pod-IP-bind outage (#178/#184)
    "PORT", // Knative-reserved
    "K_SERVICE",
    "K_REVISION",
    "K_CONFIGURATION",
] as const;

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

    // #431 bytecode (V8 compile) cache — orthogonal to the data cache above.
    // Cheap SINGLE-FIELD check only: the operator stays the single source of
    // validation truth (ValidateNextAppSpec parses this with
    // resource.ParseQuantity and fails the CR as a status condition). This is
    // the early, CLI-side copy so the user learns about a typo at `kn-next
    // deploy` time instead of from a rejected CR.
    //
    // The suffix set mirrors the Kubernetes quantity grammar EXACTLY
    // (apimachinery pkg/api/resource/quantity.go) — getting it wrong in either
    // direction is a real bug, so:
    //   binarySI        Ki | Mi | Gi | Ti | Pi | Ei   (uppercase, always "i")
    //   decimalSI       n | u | m | "" | k | M | G | T | P | E
    //                   NOTE: decimal kilo is lowercase `k`; there is NO `K`,
    //                   so "512K" is invalid (it would be rejected by the
    //                   operator's parser) while "500k" is valid.
    //   decimalExponent e|E followed by a signed integer, e.g. "1e3"
    if (config.bytecodeCache?.size !== undefined) {
        if (
            !/^\+?(\d+(\.\d+)?|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]|[eE][+-]?\d+)?$/.test(
                config.bytecodeCache.size,
            )
        ) {
            errors.push(
                `'bytecodeCache.size' ("${config.bytecodeCache.size}") is not a valid Kubernetes quantity ` +
                    `(e.g. "512Mi", "1Gi"). Omit it to use the operator default of 512Mi.`,
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

        // #415 — cheap, SINGLE-FIELD range checks for the 6 new knobs,
        // mirroring the operator's own single-field rules
        // (containerConcurrency/poolMax >= 0, internal/validation/validate.go)
        // and the CRD's `+kubebuilder:validation` markers on the *int32
        // fields. Deliberately NOT the `maxScale × poolMax ≤ 80` cross-field
        // wall — that stays the operator's job (admission + reconciler).
        if (
            config.scaling.containerConcurrency !== undefined &&
            config.scaling.containerConcurrency < 0
        ) {
            errors.push("'scaling.containerConcurrency' must be >= 0");
        }
        if (
            config.scaling.poolMax !== undefined &&
            config.scaling.poolMax < 0
        ) {
            errors.push("'scaling.poolMax' must be >= 0");
        }
        if (
            config.scaling.targetBurstCapacity !== undefined &&
            config.scaling.targetBurstCapacity < -1
        ) {
            errors.push("'scaling.targetBurstCapacity' must be -1 or >= 0");
        }
        if (
            config.scaling.panicWindowPercentage !== undefined &&
            (config.scaling.panicWindowPercentage < 1 ||
                config.scaling.panicWindowPercentage > 100)
        ) {
            errors.push(
                "'scaling.panicWindowPercentage' must be between 1 and 100",
            );
        }
        if (
            config.scaling.panicThresholdPercentage !== undefined &&
            config.scaling.panicThresholdPercentage < 110
        ) {
            errors.push("'scaling.panicThresholdPercentage' must be >= 110");
        }
    }

    // Database binding validation (#417) — the ONE cheap check mirroring the
    // operator's CRD XValidation on DatabaseSpec (nextapp_types.go):
    // `!has(self.roSecretRef) || has(self.secretRef)`. Everything else
    // (Secret existence, DSN correctness) stays the operator's job —
    // envMap/secretKeyRef semantics, not re-implemented here.
    if (config.database?.roSecretRef && !config.database?.secretRef) {
        errors.push(
            "'database.roSecretRef' requires 'database.secretRef' (mirrors the NextApp CRD's XValidation)",
        );
    }

    // Env validation (#186) — plain NON-SECRET env vars. Mirror the operator's
    // CRD CEL rules so a bad name fails HERE (validate/deploy time) instead of
    // only at `kubectl apply`.
    if (config.env) {
        for (const name of Object.keys(config.env)) {
            if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) {
                errors.push(
                    `'env.${name}' is a reserved name (managed by the operator/Knative). ` +
                        `Reserved: ${RESERVED_ENV_NAMES.join(", ")}. The cluster would reject this at apply time.`,
                );
            } else if (!ENV_NAME_RE.test(name)) {
                errors.push(
                    `'env' name '${name}' is not a valid environment variable name ` +
                        `(must match ${ENV_NAME_RE.source}). The cluster would reject this at apply time.`,
                );
            }
        }
    }

    if (errors.length > 0) {
        throw new ConfigValidationError(`\n  - ${errors.join("\n  - ")}`);
    }
}
