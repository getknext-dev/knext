/**
 * Config validation — runs at load time, fails fast with clear errors.
 */

import type { KnativeNextConfig } from "../config";

// Storage providers with a real, tested upload/verify path in `asset-upload.ts`.
// Kept in lock-step with the `StorageProvider` type (config.ts) and the
// `uploadAssets` switch — `asset-upload.test.ts` exercises this exact set. Azure
// (AKS) is supported (#474); it was promoted from a coded-but-blocked path.
export const SUPPORTED_STORAGE_PROVIDERS = [
    "gcs",
    "s3",
    "minio",
    "azure",
] as const;

// Cache providers that have a REAL runtime. Only Redis (+ the in-memory dev
// fallback) is implemented in `cache-handler.js`. The former `dynamodb` schema-only
// surface was trimmed (#476, CLAUDE.md §9 "don't ship aspirational surface"); any
// unknown provider now falls through to the generic "not supported" rejection.
const IMPLEMENTED_CACHE_PROVIDERS = ["redis"] as const;

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

// The Kubernetes quantity grammar (apimachinery pkg/api/resource/quantity.go),
// mirrored EXACTLY so the CLI agrees with the operator's resource.ParseQuantity:
//   binarySI        Ki | Mi | Gi | Ti | Pi | Ei   (uppercase, always "i")
//   decimalSI       n | u | m | "" | k | M | G | T | P | E
//                   NOTE: decimal kilo is lowercase `k`; there is NO `K`.
//   decimalExponent e|E followed by a signed integer, e.g. "1e3"
// A leading `-` is intentionally NOT matched, so a negative quantity fails as
// "not parseable" (the same net result the operator reaches by Sign() <= 0).
//
// The mantissa's fraction is `\.\d*`, NOT `\.\d+`: apimachinery accepts the
// TRAILING-DOT form ("1.", "1.Gi", "1.e3", "+123456.e3"). #455 found this as
// live drift — the earlier `\.\d+` made the CLI reject 22 values the cluster
// accepts, i.e. it blocked deploys that would have worked. The shared fixture
// (packages/kn-next-operator/test/fixtures/quantity-grammar.json) now walks the
// sign × mantissa × suffix cross-product, so this class cannot hide again.
// Self-grouping (`(?:…)`), so the top-level `|` cannot escape into whatever
// wraps it. Both current call sites happen to add their own parentheses; that is
// a property of the callers, not of this string, and a third one would be a
// silent bug.
const MANTISSA_RE_SRC = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;

// #635 — the decimal exponent is BOUNDED, and this is the one place the mirror
// is deliberately NARROWER than apimachinery. `resource.ParseQuantity` does not
// return for some exponents a user can type: MEASURED, "1e999999" parses in
// ~1 µs but "1e2147483648" was still running after 45 s, so the operator now
// refuses any exponent beyond ±9999 before parsing
// (kn-next-operator/internal/validation/quantity.go). The CLI mirrors that bound
// so `kn-next deploy` fails on the value instead of shipping it to a cluster.
// `0*` first, so leading zeros are not counted: "1e0000009" is exponent 9 and
// stays valid, while "1e00000002147483648" does not.
const MAX_EXPONENT_DIGITS = 4;
// Same reason, second cost axis: a mantissa long enough to be slow on its own
// (MEASURED: a 1,000,000-digit mantissa parses in ~1.2 s). The longest quantity
// anyone writes is ~20 characters ("9223372036854775807Ki" is 21).
const MAX_QUANTITY_LENGTH = 64;
const QUANTITY_RE = new RegExp(
    `^\\+?${MANTISSA_RE_SRC}(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]|[eE][+-]?0*\\d{1,${MAX_EXPONENT_DIGITS}})?$`,
);

/**
 * checkQuantity mirrors the operator's two-step quantity gate: is the value a
 * parseable Kubernetes quantity, and is it strictly positive (Sign() > 0)?
 * The mantissa (leading numeric run) determines the sign — a suffix/exponent
 * cannot turn a zero mantissa non-zero. The operator stays the single source of
 * truth; this is fast, CLI-side pre-flight feedback.
 */
function checkQuantity(value: string): {
    parseable: boolean;
    positive: boolean;
} {
    // #635: length bound FIRST, so an adversarially long value never reaches
    // the regex engine either.
    if (value.length > MAX_QUANTITY_LENGTH || !QUANTITY_RE.test(value)) {
        return { parseable: false, positive: false };
    }
    // Same mantissa source as QUANTITY_RE — shared so the two cannot drift
    // from each other (a value the pattern admits but this fails to extract
    // would read as "not positive" and be rejected for the wrong reason).
    const mantissa = value.match(new RegExp(`^\\+?(${MANTISSA_RE_SRC})`));
    const positive = mantissa != null && Number.parseFloat(mantissa[1]) > 0;
    return { parseable: true, positive };
}

/**
 * Validates a KnativeNextConfig at load time.
 * Throws ConfigValidationError with clear messages on invalid config.
 */
/**
 * Config keys that have been REMOVED, mapped to the migration message.
 *
 * A removed key is not the same as an unknown one. `bytecodeCache` was a real,
 * documented setting; after the PVC-backed bytecode cache was deleted, nothing read
 * it any more — so a config still carrying it validated clean, emitted a CR without
 * it, and deployed successfully while SILENTLY DROPPING a setting the author believed
 * was in force. The docs said that combination would fail the deploy. It did not.
 *
 * Silently ignoring a user's storage request is precisely how the removed 512Mi PVC
 * came back the first time, so a removed key is rejected loudly and told where to go.
 * Unknown keys generally are NOT rejected here — only ones we deliberately deleted,
 * because those are the ones a user has a reasonable belief about.
 */
const REMOVED_CONFIG_KEYS: Record<string, string> = {
    bytecodeCache:
        "'bytecodeCache' has been removed. The V8 compile cache is now baked into your " +
        "image at build time, so there is nothing to enable, size, or mount — delete the " +
        "'bytecodeCache' block from your config. (Removing it does not disable bytecode " +
        "caching: the cache in your image is always active.)",
};

export function validateConfig(config: KnativeNextConfig): void {
    const errors: string[] = [];

    // Removed keys first: if the author is working from a stale config, say so before
    // burying it under unrelated complaints about the rest of the file.
    for (const [key, message] of Object.entries(REMOVED_CONFIG_KEYS)) {
        if ((config as unknown as Record<string, unknown>)[key] !== undefined) {
            errors.push(message);
        }
    }

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
            !(IMPLEMENTED_CACHE_PROVIDERS as readonly string[]).includes(
                cacheProvider,
            )
        ) {
            // Honest error naming the provider + the supported set. A stale config
            // still naming the trimmed `dynamodb` (#476) lands here.
            errors.push(
                `Cache provider '${cacheProvider}' is not supported. Supported: ${IMPLEMENTED_CACHE_PROVIDERS.join(", ")}. ` +
                    `Omit 'cache' for the in-memory dev fallback.`,
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

        // ADR-0045 — scaleDownDelay: SYNTAX ONLY, deliberately.
        //
        // The operator validates this field by handing it to Knative's own
        // `autoscaling.ValidateAnnotations`, precisely so the platform and the
        // cluster cannot disagree about what "0s-1h at second precision"
        // means. Re-deriving that range here would reintroduce exactly the
        // divergence class the Go side removed by delegating — and in a layer
        // that never sees which Knative is installed. So this check only
        // catches the typo a user can see for themselves ("5min"), and the
        // semantics stay with the one authority, reached by
        // `preflightCRSchema`'s server-side dry-run before any cluster write.
        //
        // The check may only ever be MORE permissive than Go's ParseDuration —
        // locally rejecting a value the webhook accepts IS the divergence bug.
        // Hence the shapes a first draft missed: an optional sign, bare "0"
        // (Go's zero-duration special case), ".5s" / "1.s" fractions, and the
        // U+00B5/U+03BC micro-sign pair. The accepted corpus is pinned to the
        // operator's own agreement test, not to this regex — see
        // validate-scaling-knobs.test.ts. "" is treated as unset, matching the
        // CRD field's omitempty.
        if (config.scaling.scaleDownDelay) {
            const GO_DURATION =
                /^[+-]?(0|(([0-9]+(\.[0-9]*)?|\.[0-9]+)(ns|us|µs|μs|ms|s|m|h))+)$/;
            if (!GO_DURATION.test(config.scaling.scaleDownDelay)) {
                errors.push(
                    `'scaling.scaleDownDelay' must be a Go duration string (e.g. "5m", "30s", "1h"), got '${config.scaling.scaleDownDelay}'`,
                );
            }
        }

        // #435 — cheap, SINGLE-FIELD checks for the four resource quantities
        // that flow into the CR's spec.resources. The OPERATOR stays the single
        // source of validation truth (internal/validation/validate.go rejects
        // malformed / non-positive quantities AND the request>limit cross-field
        // rule); this early copy just gives fast `kn-next deploy`-time feedback
        // on a typo like "1GB" / "0.5 CPU" / "0". Deliberately NOT the
        // request>limit cross-field wall — that stays the operator's job.
        for (const field of [
            "cpuRequest",
            "memoryRequest",
            "cpuLimit",
            "memoryLimit",
        ] as const) {
            const value = config.scaling[field];
            if (value === undefined) continue;
            const q = checkQuantity(value);
            if (!q.parseable) {
                errors.push(
                    `'scaling.${field}' ("${value}") is not a valid Kubernetes quantity ` +
                        `(e.g. CPU "250m"/"1", memory "512Mi"/"1Gi").`,
                );
            } else if (!q.positive) {
                errors.push(
                    `'scaling.${field}' ("${value}") must be a positive quantity ` +
                        `(a zero or negative request/limit is invalid).`,
                );
            }
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
