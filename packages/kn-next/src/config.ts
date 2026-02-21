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
}

// Cache adapters
export type CacheProvider = "redis" | "dynamodb";

export interface RedisCacheConfig {
    provider: "redis";
    url: string;
    keyPrefix?: string;
    tls?: boolean;
}

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

// Knative autoscaling configuration
export interface ScalingConfig {
    minScale?: number; // Default: 0 (scale to zero)
    maxScale?: number; // Default: 10
    cpuRequest?: string; // Default: "250m"
    memoryRequest?: string; // Default: "512Mi"
    cpuLimit?: string; // Default: "1000m"
    memoryLimit?: string; // Default: "1Gi"
}

// V8 bytecode caching via NODE_COMPILE_CACHE
export interface BytecodeCacheConfig {
    enabled: boolean;
    storageSize?: string; // PVC size, default: "512Mi"
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
    infrastructure?: InfrastructureConfig; // Deploy PostgreSQL, Redis, MinIO as Knative services
    scaling?: ScalingConfig; // Knative autoscaling options
    bytecodeCache?: BytecodeCacheConfig; // V8 compile cache for faster cold starts
    observability?: ObservabilityConfig; // Prometheus metrics + Grafana dashboards
    healthCheckPath?: string; // Default: "/api/health"
    secrets?: SecretsConfig; // Kubernetes Native Secrets Binding
}
