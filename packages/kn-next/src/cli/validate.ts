/**
 * Config validation — runs at load time, fails fast with clear errors.
 */

import {
    BUILDERS,
    type BuilderAdapter,
    AVAILABLE_BUILDERS as CONTRACT_AVAILABLE,
    DEFAULT_BUILDER_ID,
    DEFAULT_RUNTIME_ID,
    explainIncompatibility,
    RUNTIMES,
    type RuntimeAdapter,
} from "../adapters/artifact-contract";
import type { KnativeNextConfig } from "../config";
import { validateCompileConfig } from "./compile-config";
import { keyPrefixProblem } from "./redis-key-prefix";

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

/**
 * Builders the `build` axis knows about (B2).
 *
 * Two lists, deliberately, because "we have never heard of this" and "this is
 * real but you cannot use it here" are different user errors with different
 * fixes. Collapsing them would tell someone selecting `vinext` to check their
 * spelling.
 *
 * `AVAILABLE_BUILDERS` is derived from the artifact contract's registry rather
 * than restated, so a builder becomes selectable by being implemented — not by
 * someone also remembering to edit this file. That is the failure mode the
 * contract exists to end.
 */
/**
 * Is this build/runtime pairing executable, per the artifact contract?
 * Returns the reason it is not, or null.
 *
 * EXPORTED and pure so it can be exercised directly. That started as a
 * workaround and is now belt-and-braces, and the difference matters enough to
 * record rather than leave a stale sentence in place.
 *
 * WHAT THIS COMMENT USED TO SAY, AND WHY IT WAS WRONG (sprint-2 §4.2). It named
 * `turbopack` as the sole selectable builder and concluded that NO reachable
 * config could produce an incompatible pairing, so the direct unit test was the
 * only way to exercise the seam. That inverted under ADR-0048, and #1167
 * (ADR-0054) moved it again: as of #1167 BOTH `turbopack` and `vinext` are
 * `available: true`, `vinext` is still the default, and the incompatible pairing
 * — `vinext` + `node` — is exactly what a user writes when they keep a
 * `runtime: "node"` from before the migration. It is reachable from
 * `validateConfig` (see the `checkPairing` call below), so the production caller
 * a design gate asked for is real.
 *
 * The direct unit test stays anyway. A check reachable through one caller is
 * one refactor away from being reachable through none, and that is the state
 * this comment spent a sprint describing.
 *
 * #1260 moved it once more. vinext now describes a node-preset shape for
 * `runtime: node`, so every shipped runtime × builder cell is compatible and
 * NO shipped config reaches a refusal — the pre-ADR-0048 state again. The
 * contract is therefore injectable (`contract`, defaulting to the shipped
 * registry): the tests hand in a registry whose runtime cannot run the shape
 * and assert the refusal through `validateConfig`, so deleting or muting the
 * call below still fails a test about OUTPUT.
 */
export function checkPairing(
    build: string | undefined,
    runtime: string | undefined,
    contract: PairingContract = SHIPPED_CONTRACT,
): string | null {
    const builder = contract.builders.find(
        (b) => b.id === (build ?? DEFAULT_BUILDER_ID),
    );
    const rt = contract.runtimes.find(
        (r) => r.id === (runtime ?? DEFAULT_RUNTIME_ID),
    );
    if (!builder || !rt) return null; // shape/enum errors are reported elsewhere
    // Root is irrelevant to shape compatibility; "." keeps it pure. The runtime
    // IS relevant: vinext's shape depends on it (#1260).
    return explainIncompatibility(rt, builder.describeArtifact(".", rt.id));
}

/** The registry `checkPairing` consults. Injectable only so tests can reach a refusal. */
export interface PairingContract {
    readonly builders: readonly BuilderAdapter[];
    readonly runtimes: readonly RuntimeAdapter[];
}

const SHIPPED_CONTRACT: PairingContract = {
    builders: BUILDERS,
    runtimes: RUNTIMES,
};

const KNOWN_BUILDERS = BUILDERS.map((b) => b.id);
const AVAILABLE_BUILDERS = CONTRACT_AVAILABLE.map((b) => b.id);

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

/**
 * Discriminator carried by a schema-invalid config. Same string-`code`
 * reasoning as shared.ts's CONFIG_NOT_FOUND_CODE: the CLI ships as a tsup
 * bundle whose subcommands are dynamic-imported chunks, so two copies of the
 * class can exist in one process and `instanceof` would silently stop
 * matching. `knext validate` renders this error as its verdict by checking
 * the code.
 */
export const CONFIG_INVALID_CODE = "ERR_KN_CONFIG_INVALID";

export class ConfigValidationError extends Error {
    readonly code = CONFIG_INVALID_CODE;

    constructor(message: string) {
        super(`[knext] Config validation failed: ${message}`);
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
// so `knext deploy` fails on the value instead of shipping it to a cluster.
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

/**
 * Mirrors the CRD's CEL rules on spec.networking.publicHosts[*] (kept in
 * lockstep with api/v1alpha1/nextapp_types.go): a lowercase RFC 1123 hostname
 * of at most 253 characters, not the wildcard bind address, at most 32 entries.
 */
const PUBLIC_HOST_PATTERN =
    /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;
const WILDCARD_BIND_PATTERN = /^0+(\.0+){0,3}$/;
const PUBLIC_HOSTS_MAX_ITEMS = 32;

function validatePublicHosts(hosts: unknown): string[] {
    if (hosts === undefined) return [];
    if (!Array.isArray(hosts)) {
        return [
            "'networking.publicHosts' must be an array of hostnames, e.g. [\"www.example.com\"]",
        ];
    }
    const errors: string[] = [];
    if (hosts.length > PUBLIC_HOSTS_MAX_ITEMS) {
        errors.push(
            `'networking.publicHosts' lists ${hosts.length} hosts; the maximum is ${PUBLIC_HOSTS_MAX_ITEMS}`,
        );
    }
    for (const host of hosts) {
        if (
            typeof host !== "string" ||
            host.length > 253 ||
            !PUBLIC_HOST_PATTERN.test(host) ||
            WILDCARD_BIND_PATTERN.test(host)
        ) {
            errors.push(
                `'networking.publicHosts' entries must be lowercase DNS hostnames with no scheme, port, path, userinfo, wildcard or comma, and not 0.0.0.0, got ${JSON.stringify(host)}`,
            );
        }
    }
    return errors;
}

/**
 * Mirrors the CRD's schema on spec.backends (kept in lockstep with
 * api/v1alpha1/nextapp_types.go; `validate-backends.test.ts` reads the shipped
 * CRD and fails when either side moves alone). A binding name has the shape of
 * a function name, a service is a DNS label, at most 64 entries, the list is
 * keyed by name, and each BackendService may be bound at most once.
 */
const BACKEND_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const BACKEND_SERVICE_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const BACKEND_NAME_MAX_LENGTH = 63;
const BACKENDS_MAX_ITEMS = 64;
const BACKEND_IMAGE_PATTERN = /^@sha256:[a-f0-9]{64}$/;
const BACKEND_IMAGE_MAX_LENGTH = 72;
const BACKEND_SPEC_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BACKEND_SPEC_DIGEST_MAX_LENGTH = 71;
const BACKEND_KEYS = ["name", "service", "image", "specDigest"];

function validateBackends(backends: unknown): string[] {
    if (backends === undefined) return [];
    if (!Array.isArray(backends)) {
        return [
            "'backends' must be an array of functions, e.g. [{ name: \"user-profile\" }]",
        ];
    }
    const errors: string[] = [];
    if (backends.length > BACKENDS_MAX_ITEMS) {
        errors.push(
            `'backends' lists ${backends.length} functions; the maximum is ${BACKENDS_MAX_ITEMS}`,
        );
    }
    const names = new Set<string>();
    const services = new Set<string>();
    const reported = new Set<string>();
    backends.forEach((entry, i) => {
        const at = `backends[${i}]`;
        if (!isPlainObject(entry)) {
            errors.push(
                `'${at}' must be an object like { name: "user-profile" }, got ${JSON.stringify(entry)}`,
            );
            return;
        }
        for (const key of Object.keys(entry)) {
            if (!BACKEND_KEYS.includes(key)) {
                errors.push(
                    `'${at}.${key}' is not a known key (known: ${BACKEND_KEYS.join(", ")})`,
                );
            }
        }
        const { name } = entry;
        if (
            typeof name !== "string" ||
            name.length > BACKEND_NAME_MAX_LENGTH ||
            !BACKEND_NAME_PATTERN.test(name)
        ) {
            errors.push(
                `'${at}.name' must be lowercase letters and digits in parts joined by single '-', starting with a letter, at most ${BACKEND_NAME_MAX_LENGTH} characters, got ${JSON.stringify(name)}`,
            );
        } else if (names.has(name) && !reported.has(`name:${name}`)) {
            reported.add(`name:${name}`);
            errors.push(
                `'backends' lists the name "${name}" more than once; each binding name must be unique`,
            );
        } else {
            names.add(name);
        }
        const image = entry.image;
        if (
            image !== undefined &&
            (typeof image !== "string" ||
                image.length > BACKEND_IMAGE_MAX_LENGTH ||
                !BACKEND_IMAGE_PATTERN.test(image))
        ) {
            errors.push(
                `'${at}.image' must be the image digest only, "@sha256:" followed by 64 lowercase hex characters (not a full image reference; \`knext deploy function\` prints the exact entry), got ${JSON.stringify(image)}`,
            );
        }
        const specDigest = entry.specDigest;
        if (
            specDigest !== undefined &&
            (typeof specDigest !== "string" ||
                specDigest.length > BACKEND_SPEC_DIGEST_MAX_LENGTH ||
                !BACKEND_SPEC_DIGEST_PATTERN.test(specDigest))
        ) {
            errors.push(
                `'${at}.specDigest' must be "sha256:" followed by 64 lowercase hex characters, the digest of the function's spec (\`knext deploy function\` prints the exact entry), got ${JSON.stringify(specDigest)}`,
            );
        }
        const service = entry.service;
        if (service !== undefined) {
            if (
                typeof service !== "string" ||
                service.length > BACKEND_NAME_MAX_LENGTH ||
                !BACKEND_SERVICE_PATTERN.test(service)
            ) {
                errors.push(
                    `'${at}.service' must be a DNS label (lowercase letters, digits and '-'), at most ${BACKEND_NAME_MAX_LENGTH} characters, got ${JSON.stringify(service)}`,
                );
                return;
            }
        }
        const bound = service ?? name;
        if (typeof bound === "string" && BACKEND_SERVICE_PATTERN.test(bound)) {
            if (services.has(bound) && !reported.has(`service:${bound}`)) {
                reported.add(`service:${bound}`);
                errors.push(
                    `'backends' has the function "${bound}" bound more than once; each function may be bound at most once`,
                );
            }
            services.add(bound);
        }
    });
    return errors;
}

/**
 * Mirrors the CRD's schema + CEL on spec.cdn (kept in lockstep with
 * api/v1alpha1/nextapp_types.go; the shared boundary table
 * __tests__/fixtures/cdn-validation-cases.json is read by both validators).
 */
const CDN_PROVIDERS = [
    "cloudflare",
    "google-cloud-cdn",
    "cloudfront",
    "azure-front-door",
    "emulator",
] as const;
const CDN_KEYS = [
    "provider",
    "htmlTTLSeconds",
    "staleWhileRevalidateSeconds",
    "excludePaths",
    "includePaths",
    "purge",
    "emulatorEndpoint",
];
const CDN_PURGE_KEYS = ["secretRef", "target", "requestsPerMinute"];
const CDN_PATH_RE = /^\/[^,\s]*$/;
const CDN_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CDN_EMULATOR_ENDPOINT_RE =
    /^https?:\/\/[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\.svc\.cluster\.local(:[0-9]{1,5})?$/;
/** The operator-reserved env namespace (ADR-0068 D3). */
const CDN_ENV_PREFIX = "KNEXT_CDN_";

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intInRange(
    value: unknown,
    min: number,
    max: number,
    label: string,
    errors: string[],
): void {
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
    ) {
        errors.push(
            `'${label}' must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`,
        );
    }
}

function validatePathList(
    value: unknown,
    label: string,
    errors: string[],
): void {
    if (!Array.isArray(value)) {
        errors.push(`'${label}' must be an array of path prefixes`);
        return;
    }
    if (value.length > 64) {
        errors.push(
            `'${label}' lists ${value.length} paths; the maximum is 64`,
        );
    }
    for (const p of value) {
        if (typeof p !== "string" || p.length > 512 || !CDN_PATH_RE.test(p)) {
            errors.push(
                `'${label}' entries must start with "/" and contain no comma or whitespace (max 512 characters), got ${JSON.stringify(p)}`,
            );
        }
    }
}

function validateCdn(cdn: unknown): string[] {
    if (cdn === undefined) return [];
    if (!isPlainObject(cdn)) {
        return ["'cdn' must be an object, e.g. { provider: \"cloudflare\" }"];
    }
    const errors: string[] = [];
    for (const key of Object.keys(cdn)) {
        if (!CDN_KEYS.includes(key)) {
            errors.push(
                `'cdn.${key}' is not a known key (known: ${CDN_KEYS.join(", ")}). The tag prefix is derived by the operator and cannot be set.`,
            );
        }
    }
    const provider = cdn.provider;
    if (
        typeof provider !== "string" ||
        !(CDN_PROVIDERS as readonly string[]).includes(provider)
    ) {
        errors.push(
            `'cdn.provider' must be one of ${CDN_PROVIDERS.join(", ")}, got ${JSON.stringify(provider)}`,
        );
    }
    if (cdn.htmlTTLSeconds !== undefined) {
        intInRange(cdn.htmlTTLSeconds, 1, 3600, "cdn.htmlTTLSeconds", errors);
    }
    if (cdn.staleWhileRevalidateSeconds !== undefined) {
        intInRange(
            cdn.staleWhileRevalidateSeconds,
            0,
            3600,
            "cdn.staleWhileRevalidateSeconds",
            errors,
        );
    }
    if (cdn.excludePaths !== undefined) {
        validatePathList(cdn.excludePaths, "cdn.excludePaths", errors);
    }
    if (cdn.includePaths !== undefined) {
        validatePathList(cdn.includePaths, "cdn.includePaths", errors);
    }
    if (cdn.purge !== undefined) {
        const purge = cdn.purge;
        if (!isPlainObject(purge)) {
            errors.push("'cdn.purge' must be an object");
        } else {
            for (const key of Object.keys(purge)) {
                if (!CDN_PURGE_KEYS.includes(key)) {
                    errors.push(`'cdn.purge.${key}' is not a known key`);
                }
            }
            const ref = purge.secretRef;
            if (
                !isPlainObject(ref) ||
                typeof ref.name !== "string" ||
                ref.name.length < 1 ||
                ref.name.length > 253 ||
                typeof ref.key !== "string" ||
                ref.key.length < 1 ||
                ref.key.length > 253
            ) {
                errors.push(
                    "'cdn.purge.secretRef' must be { name, key }: a Secret name and key (1-253 characters each) in the app's namespace",
                );
            }
            if (
                typeof purge.target !== "string" ||
                purge.target.length > 128 ||
                !CDN_TARGET_RE.test(purge.target)
            ) {
                errors.push(
                    `'cdn.purge.target' must be 1-128 characters of letters, numerals and . _ : - (starting with a letter or numeral), got ${JSON.stringify(purge.target)}`,
                );
            }
            if (purge.requestsPerMinute !== undefined) {
                intInRange(
                    purge.requestsPerMinute,
                    1,
                    6000,
                    "cdn.purge.requestsPerMinute",
                    errors,
                );
            }
        }
    }
    const endpoint = cdn.emulatorEndpoint;
    if (endpoint !== undefined && provider !== "emulator") {
        errors.push(
            "'cdn.emulatorEndpoint' is only allowed with provider \"emulator\"",
        );
    }
    if (provider === "emulator" && endpoint === undefined) {
        errors.push(
            "'cdn.provider' \"emulator\" requires 'cdn.emulatorEndpoint'",
        );
    }
    if (
        endpoint !== undefined &&
        (typeof endpoint !== "string" ||
            endpoint.length > 253 ||
            !CDN_EMULATOR_ENDPOINT_RE.test(endpoint))
    ) {
        errors.push(
            `'cdn.emulatorEndpoint' must be http(s)://<host>.svc.cluster.local[:port] with no path, userinfo or query, got ${JSON.stringify(endpoint)}`,
        );
    }
    return errors;
}

export function validateConfig(
    config: KnativeNextConfig,
    /** Test seam for the pairing check — see `checkPairing`. */
    contract: PairingContract = SHIPPED_CONTRACT,
    /**
     * `build` skips requirements that only matter at deploy time (the redis
     * `cache.url`, which the scaffold supplies via REDIS_URL at deploy). The
     * default is the strict `deploy` phase so every other caller keeps the
     * full gate.
     */
    options: { phase?: "build" | "deploy" } = {},
): void {
    const phase = options.phase ?? "deploy";
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

    // Storage validation. ABSENCE IS VALID (ADR-0047): omitted storage is the
    // announced image-served static mode (assets ship in the container image,
    // `next start` semantics), not a config mistake — deploy/build/doctor
    // announce the mode loudly (NO_STORAGE_MODE_NOTICE). A PRESENT block is
    // still fully validated: optional never means unvalidated. This mirror
    // and loader.ts MUST stay in lock-step (the both-halves defect class).
    if (config.storage) {
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
        if (
            phase === "deploy" &&
            cacheProvider === "redis" &&
            !config.cache.url
        ) {
            errors.push(
                "'cache.url' is required when using Redis cache provider — " +
                    "set REDIS_URL (or KN_REDIS_URL) in your environment when you run `knext deploy` " +
                    "(it is not needed at build time)",
            );
        }
        // Early copy of the CRD's admission rule (the apiserver stays the
        // authority; redis-key-prefix.ts is lockstep-tested against the CRD).
        const keyPrefix = config.cache.keyPrefix;
        if (typeof keyPrefix === "string") {
            const problem = keyPrefixProblem(keyPrefix);
            if (problem) {
                errors.push(
                    `'cache.keyPrefix' '${keyPrefix}' ${problem}; the cluster refuses it`,
                );
            }
        }
    }

    // #431 bytecode (V8 compile) cache — orthogonal to the data cache above.
    // Cheap SINGLE-FIELD check only: the operator stays the single source of
    // validation truth (ValidateNextAppSpec parses this with
    // resource.ParseQuantity and fails the CR as a status condition). This is
    // the early, CLI-side copy so the user learns about a typo at `knext
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

    // selfContained (opt-in): a boolean or absent. A string like "false" is
    // truthy in JS, so silently accepting one would turn the mode ON.
    if (
        (config as { selfContained?: unknown }).selfContained !== undefined &&
        typeof (config as { selfContained?: unknown }).selfContained !==
            "boolean"
    ) {
        errors.push("'selfContained' must be a boolean (true or false)");
    }

    // networking.visibility (#1865): must be exactly the enum value the CRD
    // accepts — a typo here would otherwise surface only as a cluster-side
    // admission rejection at deploy time instead of a local, fast config error.
    if (
        config.networking?.visibility !== undefined &&
        config.networking.visibility !== "public" &&
        config.networking.visibility !== "cluster-local"
    ) {
        errors.push(
            `'networking.visibility' must be "public" or "cluster-local", got "${config.networking.visibility}"`,
        );
    }

    // networking.publicHosts: the same shape the CRD's CEL rule enforces
    // (lowercase RFC 1123 hostnames, <=32 entries, no wildcard bind address),
    // so a typo is a local config error instead of an admission rejection
    // after the image is built.
    errors.push(...validatePublicHosts(config.networking?.publicHosts));

    // backends: the zone's half of a function binding, checked against the
    // CRD's own bounds so a bad name stops here instead of at admission.
    errors.push(...validateBackends(config.backends));

    // cdn (ADR-0068): the same bounds the CRD enforces on spec.cdn.
    errors.push(...validateCdn((config as { cdn?: unknown }).cdn));

    // compile (extra files embedded in the compiled executable).
    errors.push(...validateCompileConfig(config));

    // Runtime validation
    if (
        config.runtime &&
        !(SUPPORTED_RUNTIMES as readonly string[]).includes(config.runtime)
    ) {
        errors.push(
            `Runtime '${config.runtime}' is not supported. Supported: ${SUPPORTED_RUNTIMES.join(", ")}`,
        );
    }

    // Build validation (B2). Independent of `runtime`: the axes are connected
    // by the artifact SHAPE a builder emits and a runtime accepts, never by a
    // rule pairing the two names. See src/adapters/artifact-contract.ts.
    if (
        config.build &&
        !(KNOWN_BUILDERS as readonly string[]).includes(config.build)
    ) {
        errors.push(
            `Build '${config.build}' is not supported. Supported: ${KNOWN_BUILDERS.join(", ")}`,
        );
    } else if (
        config.build &&
        !(AVAILABLE_BUILDERS as readonly string[]).includes(config.build)
    ) {
        // KNOWN but not AVAILABLE. Kept as a separate branch from "unknown" on
        // purpose: telling someone about a real builder that this release cannot
        // run reads as a typo and sends them to the spelling, when the truth is
        // that the builder is real and this build of knext cannot run it.
        //
        // Rejecting here rather than at build time is the whole point: a builder
        // whose toolchain is not a dependency of this release would emit an image
        // with no build output and surface it at `docker run` on a cluster — the
        // #857 ordering, where `next build` exited 0 the whole way while producing
        // a server nothing could find.
        //
        // As of #1167 (ADR-0054 item 6) BOTH shipped builders — `turbopack`
        // (`next build` -> `.next/standalone`) and `vinext` — are available, so
        // this branch guards a FUTURE known-but-unavailable builder rather than
        // any current one. The message is therefore generic (no ADR-0048 "only
        // vinext" wording, which #1167 reversed): it names what IS selectable
        // instead of prescribing a single migration target.
        errors.push(
            `Build '${config.build}' is a known builder but is not available in this ` +
                `release of knext. Selectable builders: ${AVAILABLE_BUILDERS.join(", ")}.`,
        );
    }

    // The PAIRING check — against the artifact contract, which is the point of
    // having one. This is `isCompatible`'s production caller.
    //
    // Runs for any KNOWN builder, deliberately NOT only available ones, and
    // that placement is the whole fix. Three design-gate rounds defeated
    // earlier versions, each time because the enforcement sat somewhere the
    // defect could not reach it:
    //
    //   - inside the available-only branch, no reachable config could produce
    //     an incompatible pairing, so deleting the call broke nothing across
    //     162 files and 1833 tests;
    //   - guarding it with a source scan instead was defeated twice — once by
    //     keeping the call byte-identical and dropping the reporting
    //     (`if (why) { /* not reported */ }`), once by deleting the call and
    //     leaving a TODO comment containing its text, which a raw-source regex
    //     happily matches.
    //
    // Running it for known builders made `build: vinext` + `runtime: node`
    // REACHABLE while the only vinext artifact was bun-preset (it crashes under
    // node). #1260 gave vinext a node-preset shape for node, so every shipped
    // cell now passes — the behavioural guard reaches a refusal through the
    // injectable `contract` instead (validate-build-axis.test.ts). Neutering
    // the enforcement still fails a test about OUTPUT, not about source shape.
    const pairingProblem = checkPairing(config.build, config.runtime, contract);
    if (pairingProblem) errors.push(pairingProblem);

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
        // rule); this early copy just gives fast `knext deploy`-time feedback
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

    // healthCheckPath validation — this value flows into the image-build
    // compile-cache bake as `KNEXT_WARM_PATH`, a COMMA-SEPARATED list of paths
    // (see `knext-compile-cache-bake.mjs.hbs` and the standalone-node/
    // vinext-node entry templates, which split on ","). A comma or whitespace
    // in the configured path corrupts that list, and a value with no leading
    // slash is not a valid path at all — so both are rejected here, before
    // either the CLI's own build-arg passthrough (`runtime-image.ts`) or the
    // bake itself see it. Checked via `!== undefined` (not truthiness) so an
    // explicit empty string is also caught, rather than silently treated the
    // same as "unset".
    if (config.healthCheckPath !== undefined) {
        if (typeof config.healthCheckPath !== "string") {
            errors.push(
                `'healthCheckPath' must be a string (e.g. "/api/health"), got ${typeof config.healthCheckPath}.`,
            );
        } else {
            const path = config.healthCheckPath;
            if (!path.startsWith("/")) {
                errors.push(
                    `'healthCheckPath' ("${path}") must start with a leading slash (e.g. "/api/health").`,
                );
            }
            if (path.includes(",")) {
                errors.push(
                    `'healthCheckPath' ("${path}") must not contain a comma — it is joined into a ` +
                        "comma-separated KNEXT_WARM_PATH list at build time and a comma would split it into two paths.",
                );
            }
            if (/\s/.test(path)) {
                errors.push(
                    `'healthCheckPath' ("${path}") must not contain whitespace (e.g. "/api/health", not "/api health").`,
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
            if (name.startsWith(CDN_ENV_PREFIX)) {
                errors.push(
                    `'env.${name}' is in the ${CDN_ENV_PREFIX}* namespace, which the operator reserves (set 'cdn' instead). The operator would ignore the entry and report it in a CDNReservedEnvIgnored condition.`,
                );
            } else if (
                (RESERVED_ENV_NAMES as readonly string[]).includes(name)
            ) {
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

    for (const name of Object.keys(config.secrets?.envMap ?? {})) {
        if (name.startsWith(CDN_ENV_PREFIX)) {
            errors.push(
                `'secrets.envMap.${name}' is in the ${CDN_ENV_PREFIX}* namespace, which the operator reserves (set 'cdn' instead). The operator would ignore the entry and report it in a CDNReservedEnvIgnored condition.`,
            );
        }
    }

    if (errors.length > 0) {
        throw new ConfigValidationError(`\n  - ${errors.join("\n  - ")}`);
    }
}
