// Storage providers
export type StorageProvider = "s3" | "gcs" | "azure" | "minio";

export interface StorageConfig {
    provider: StorageProvider;
    bucket: string;
    region?: string;
    endpoint?: string; // For MinIO/S3-compatible
    publicUrl: string; // Public CDN URL where assets are served from (e.g. https://storage.googleapis.com/my-bucket)
    accessKey?: string; // Optional, use IAM when possible
    secretKey?: string;
    // #93 skew protection (ADR-0011): number of recent BUILD_IDs whose
    // `_next/static/<buildId>/` prefixes are retained in the object store after a
    // new deploy. A build still serving traffic (NextApp.Status.CurrentTraffic) is
    // ALWAYS kept regardless of this window. Default DEFAULT_RETAIN (3). Higher =
    // safer for long-lived clients, more storage.
    assetRetention?: number;
}

// Cache adapters.
// NOTE: `dynamodb` is schema-only DEAD surface — there is NO DynamoDB runtime in
// `cache-handler.js` (Redis + in-memory only) or in the operator. It is REJECTED
// at config validation (`cli/validate.ts`) so users are not lured into a provider
// that silently does nothing (CLAUDE.md §9). The type is retained only so existing
// references compile; do not implement it without a real, tested runtime.
export type CacheProvider = "redis" | "dynamodb";

export interface RedisCacheConfig {
    provider: "redis";
    url: string;
    keyPrefix?: string;
    tls?: boolean;
}

/**
 * @deprecated UNIMPLEMENTED — schema-only, rejected by `validateConfig`. There is
 * no DynamoDB cache runtime. Use {@link RedisCacheConfig}.
 */
export interface DynamoDBCacheConfig {
    provider: "dynamodb";
    tableName: string;
    region: string;
    accessKey?: string;
    secretKey?: string;
}

export type CacheConfig = RedisCacheConfig | DynamoDBCacheConfig;

// Queue providers for ISR revalidation
export type QueueProvider = "kafka" | "none";

export interface KafkaQueueConfig {
    provider: "kafka";
    brokerUrl: string;
    topic?: string; // Defaults to '{name}-isr-revalidation'
    clientId?: string;
}

export interface NoQueueConfig {
    provider: "none";
}

export type QueueConfig = KafkaQueueConfig | NoQueueConfig;

// Infrastructure services (deployed as Knative services)
export interface PostgresConfig {
    enabled: boolean;
    version?: string; // Default: "16"
    storage?: string; // Default: "1Gi"
}

export interface RedisInfraConfig {
    enabled: boolean;
    version?: string; // Default: "7"
}

export interface MinioInfraConfig {
    enabled: boolean;
    storage?: string; // Default: "10Gi"
    accessKey?: string; // Default: "minioadmin"
    secretKey?: string; // Default: "minioadmin"
}

export interface InfrastructureConfig {
    postgres?: PostgresConfig;
    redis?: RedisInfraConfig;
    minio?: MinioInfraConfig;
}

// #415 — a single scheduled warm-floor window (ADR-0030), mirroring the
// operator's WarmWindow (nextapp_types.go). During [start, end) (evaluated in
// `timezone`, 5-field cron expressions) the operator holds the ksvc min-scale
// floor at `replicas` so a known traffic peak does not pay a cold start. This
// is owner-authored SCHEDULING, not learned prediction. Outside every window
// the floor reverts to `scaling.minScale` (default 0) — scale-to-zero is
// preserved. Cron syntax is validated by the operator at admission, not here.
export interface WarmWindow {
    start: string; // 5-field cron expression when the warm floor begins (e.g. "0 8 * * 1-5")
    end: string; // 5-field cron expression when the warm floor ends (e.g. "0 20 * * 1-5")
    replicas: number; // Warm-pod floor held during the window; must be >= 1 (operator-enforced)
    timezone?: string; // IANA timezone the cron schedules are evaluated in. Default: "UTC"
}

// Knative autoscaling configuration
export interface ScalingConfig {
    minScale?: number; // Default: 0 (scale to zero)
    maxScale?: number; // Default: 10
    cpuRequest?: string; // Default: "250m"
    memoryRequest?: string; // Default: "512Mi"
    cpuLimit?: string; // Default: "1000m"
    memoryLimit?: string; // Default: "1Gi"

    // #415 — the following 6 knobs mirror the NextApp CRD's ScalingSpec
    // (packages/kn-next-operator/api/v1alpha1/nextapp_types.go) 1:1. All are
    // optional and back-compat: unset ⇒ omitted from the emitted NextApp CR
    // ⇒ the operator's own default applies exactly as before these fields
    // existed. The operator (admission webhook + fail-closed reconciler)
    // remains the single source of validation truth for cross-field
    // invariants (e.g. `maxScale × poolMax ≤ 80`) — this config layer only
    // types the values, it does not re-derive that math.

    // Knative `containerConcurrency`: concurrent requests per pod before
    // Knative adds another pod (ADR-0028). Default (operator): 20.
    containerConcurrency?: number;

    // Per-pod DATABASE_URL connection-pool maximum (ADR-0028/ADR-0029). When
    // set (> 0) the operator enforces `maxScale × poolMax ≤ 80` (the app
    // connection budget) at admission, and injects `KNEXT_DB_POOL_MAX` so
    // `@knext/lib`'s `getDbPool()` caps the pg pool at runtime. Default
    // (operator): unset — no check, no env.
    poolMax?: number;

    // Scheduled warm-floor windows (ADR-0030): during each window the app is
    // pre-warmed to a floor of `replicas` pods. See {@link WarmWindow}.
    // Default (operator): none — pure scale-to-zero, unaffected.
    warmSchedule?: WarmWindow[];

    // Knative `autoscaling.knative.dev/target-burst-capacity` (ADR-0032):
    // whether the activator stays in the request path as a burst buffer for
    // an UNPREDICTED spike. `-1` = always keep the activator in the path
    // (max burst tolerance); `>= 0` = the buffered request count before the
    // activator is removed from the path. Default (operator): unset — the
    // annotation is not stamped and the Knative cluster default (200)
    // applies unmanaged.
    targetBurstCapacity?: number;

    // Knative `autoscaling.knative.dev/panic-window-percentage` (ADR-0033):
    // how fast the KPA reacts to an unpredicted surge, as a percentage of
    // the stable window (1-100; smaller = more reactive). Default
    // (operator): unset — the Knative cluster default (10%) applies
    // unmanaged.
    panicWindowPercentage?: number;

    // Knative `autoscaling.knative.dev/panic-threshold-percentage`
    // (ADR-0033): the overshoot, as a percentage of the steady-state target,
    // that trips KPA panic mode (>= 110; lower = trips sooner). Default
    // (operator): unset — the Knative cluster default (200%) applies
    // unmanaged.
    panicThresholdPercentage?: number;
}

// Observability — Prometheus metrics + Grafana dashboards
export interface ObservabilityConfig {
    enabled: boolean;
    prometheus?: {
        scrapeInterval?: string; // Default: "15s"
    };
    grafana?: {
        enabled?: boolean; // Default: true (deploy dashboard ConfigMap)
    };
    // RUM (#94): self-hosted Web Vitals → Prometheus/Grafana. Default OFF.
    // When enabled, the operator sets NEXT_PUBLIC_RUM_ENABLED so the client
    // beacon (WebVitalsReporter) POSTs Core Web Vitals to /api/rum.
    rum?: {
        enabled?: boolean; // Default: false
        sampleRate?: number; // 0..1, default 1 (client-side sampling)
    };
    // OTel tracing (#30): server-side distributed tracing via OTLP/gRPC → a
    // self-hostable backend (Tempo/Jaeger, ADR-0012). Default OFF. When enabled,
    // the operator sets OTEL_TRACING_ENABLED so the runtime instrumentation hook
    // (resolveOtelOptions → registerOTel) initializes the exporter. Zero overhead
    // when disabled (the hook returns without registering OTel).
    tracing?: {
        enabled?: boolean; // Default: false
        endpoint?: string; // OTLP/gRPC collector endpoint; operator default applies if unset
        sampleRate?: number; // 0..1, default 1 (head-based trace sampling)
    };
}

// Kubernetes Native Secrets Binding
export interface SecretRef {
    name: string; // Name of the Kubernetes Secret resource
    key?: string; // Specific key within the Secret (if mapping a single env var)
}

export interface SecretsConfig {
    envFrom?: string[]; // Array of Secret names to inject fully as environment variables
    envMap?: Record<string, SecretRef>; // Map of explicit ENV_VAR -> { name, key } Secret mapping
}

// Main Knative-Next config (subset of OpenNext we support)
export interface KnativeNextConfig {
    name: string;
    storage: StorageConfig;
    cache?: CacheConfig;
    queue?: QueueConfig; // For ISR revalidation (Kafka for Knative Eventing)
    registry: string;
    runtime?: "bun" | "node"; // Runtime to execute the Next.js standalone server.js: 'bun' or 'node' (default)
    infrastructure?: InfrastructureConfig; // Deploy PostgreSQL, Redis, MinIO as Knative services
    scaling?: ScalingConfig; // Knative autoscaling options
    observability?: ObservabilityConfig; // Prometheus metrics + Grafana dashboards
    healthCheckPath?: string; // Default: "/api/health"
    secrets?: SecretsConfig; // Kubernetes Native Secrets Binding
    // Plain, NON-SECRET environment variables (name → value) for the app
    // container — configuration flags like KNEXT_CACHE_CONTROL_NORMALIZE: "0".
    // Values are stored verbatim in the NextApp CR; anything sensitive belongs
    // in `secrets` instead. Reserved names (HOSTNAME, PORT, K_SERVICE,
    // K_REVISION, K_CONFIGURATION) are rejected by the operator's CRD
    // validation, and operator-managed system env always wins on collision.
    env?: Record<string, string>;
}
