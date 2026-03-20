import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";
import {
    generateKafkaEventingManifest,
    generateKnativeManifest,
} from "../generators/knative-manifest";

/* ------------------------------------------------------------------ */
/*  Type-safe helpers for parsed YAML manifests                       */
/* ------------------------------------------------------------------ */

interface EnvEntry {
    name: string;
    value?: string;
    valueFrom?: Record<string, Record<string, string>>;
}

interface K8sContainer {
    image: string;
    ports: { containerPort: number }[];
    env: EnvEntry[];
    envFrom?: { secretRef: { name: string } }[];
    volumeMounts?: { name: string; mountPath: string }[];
    resources: {
        requests: Record<string, string>;
        limits: Record<string, string>;
    };
    readinessProbe: {
        httpGet: { path: string; port: number };
        initialDelaySeconds: number;
        periodSeconds: number;
    };
    livenessProbe: {
        httpGet: { path: string; port: number };
        initialDelaySeconds: number;
        periodSeconds: number;
    };
}

interface K8sDoc {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string };
    spec: Record<string, unknown>;
}

interface KnativeServiceDoc extends K8sDoc {
    spec: {
        template: {
            metadata: { annotations: Record<string, string> };
            spec: {
                containers: K8sContainer[];
                volumes?: {
                    name: string;
                    persistentVolumeClaim?: { claimName: string };
                }[];
            };
        };
    };
}

/**
 * Parse multi-document YAML file into typed documents.
 */
function parseYamlDocs(filePath: string): K8sDoc[] {
    const raw = readFileSync(filePath, "utf-8");
    return YAML.parseAllDocuments(raw).map((doc) =>
        (doc as YAML.Document).toJSON(),
    ) as K8sDoc[];
}

function findService(docs: K8sDoc[]): KnativeServiceDoc | undefined {
    return docs.find((d) => d.kind === "Service") as
        | KnativeServiceDoc
        | undefined;
}

function envNames(env: EnvEntry[]): string[] {
    return env.map((e) => e.name);
}

function findEnv(env: EnvEntry[], name: string): EnvEntry | undefined {
    return env.find((e) => e.name === name);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Knative Manifest Generator", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "kn-next-test-"));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("should generate knative-service.yaml with correct metadata", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
            imageTag: "v1.0.0",
        });

        expect(existsSync(outputPath)).toBe(true);

        const docs = parseYamlDocs(outputPath);
        const ksvc = findService(docs);

        expect(ksvc).toBeDefined();
        expect(ksvc!.apiVersion).toBe("serving.knative.dev/v1");
        expect(ksvc!.metadata.name).toBe("my-app");
        expect(ksvc!.spec.template.spec.containers[0].image).toBe(
            "gcr.io/test-project/my-app:v1.0.0",
        );
    });

    it("should include environment variables for adapters", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            cache: {
                provider: "redis",
                url: "redis://redis:6379",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });

        const docs = parseYamlDocs(outputPath);
        const ksvc = findService(docs);
        const env = ksvc!.spec.template.spec.containers[0].env;
        const names = envNames(env);

        expect(names).toContain("GCS_BUCKET_NAME");
        expect(names).toContain("REDIS_URL");
    });

    it("should include Kafka env vars when enabled", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
            enableKafkaQueue: true,
        });

        const docs = parseYamlDocs(outputPath);
        const ksvc = findService(docs);
        const names = envNames(ksvc!.spec.template.spec.containers[0].env);

        expect(names).toContain("KAFKA_BROKER_URL");
        expect(names).toContain("KAFKA_REVALIDATION_TOPIC");
    });

    it("should set correct container resources", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });

        const docs = parseYamlDocs(outputPath);
        const container = findService(docs)!.spec.template.spec.containers[0];

        expect(container.ports[0].containerPort).toBe(3000);
        expect(container.resources.requests.memory).toBe("512Mi");
        expect(container.resources.requests.cpu).toBe("250m");
        expect(container.resources.limits.memory).toBe("1Gi");
        expect(container.resources.limits.cpu).toBe("1000m");
    });

    it("should use correct probe values (safer defaults)", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });

        const docs = parseYamlDocs(outputPath);
        const container = findService(docs)!.spec.template.spec.containers[0];

        expect(container.readinessProbe.initialDelaySeconds).toBe(2);
        expect(container.readinessProbe.periodSeconds).toBe(3);
        expect(container.livenessProbe.initialDelaySeconds).toBe(5);
        expect(container.livenessProbe.periodSeconds).toBe(10);
    });

    describe("Image Cache", () => {
        it("should generate Image cache manifest", () => {
            const config: KnativeNextConfig = {
                name: "my-app",
                storage: {
                    provider: "gcs",
                    bucket: "test-bucket",
                    publicUrl: "https://storage.googleapis.com/test-bucket",
                },
                registry: "gcr.io/test-project",
            };

            generateKnativeManifest({
                config,
                outputDir: tempDir,
                imageTag: "v1.0.0",
            });

            const imageCachePath = join(tempDir, "knative-image-cache.yaml");
            expect(existsSync(imageCachePath)).toBe(true);

            const content = readFileSync(imageCachePath, "utf-8");
            const doc = YAML.parse(content) as K8sDoc & {
                spec: { image: string };
            };
            expect(doc.kind).toBe("Image");
            expect(doc.spec.image).toBe("gcr.io/test-project/my-app:v1.0.0");
        });
    });

    describe("Secrets", () => {
        it("should include envFrom for whole-secret injection", () => {
            const config: KnativeNextConfig = {
                name: "my-app",
                storage: {
                    provider: "gcs",
                    bucket: "test-bucket",
                    publicUrl: "https://storage.googleapis.com/test-bucket",
                },
                registry: "gcr.io/test-project",
                secrets: {
                    envFrom: ["my-secret-1", "my-secret-2"],
                },
            };

            const outputPath = generateKnativeManifest({
                config,
                outputDir: tempDir,
            });

            const docs = parseYamlDocs(outputPath);
            const container =
                findService(docs)!.spec.template.spec.containers[0];

            expect(container.envFrom).toEqual([
                { secretRef: { name: "my-secret-1" } },
                { secretRef: { name: "my-secret-2" } },
            ]);
        });
    });
});

describe("Kafka Eventing Manifest Generator", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "kn-next-test-"));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("should generate KafkaSource with correct topic", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
        };

        const outputPath = generateKafkaEventingManifest({
            config,
            outputDir: tempDir,
            kafkaBroker: "kafka:9092",
        });

        expect(existsSync(outputPath)).toBe(true);

        const content = readFileSync(outputPath, "utf-8");
        expect(content).toContain("KafkaSource");
        expect(content).toContain("my-app-revalidation");
        expect(content).toContain("kafka:9092");
    });
});

describe("Observability", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "kn-next-test-"));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("should include Prometheus annotations when observability is enabled", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
            observability: { enabled: true },
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });
        const docs = parseYamlDocs(outputPath);
        const annotations =
            findService(docs)!.spec.template.metadata.annotations;

        expect(annotations["prometheus.io/scrape"]).toBe("true");
        expect(annotations["prometheus.io/port"]).toBe("9091");
        expect(annotations["prometheus.io/path"]).toBe("/metrics");
    });

    it("should NOT include Prometheus annotations when observability is disabled", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
            observability: { enabled: false },
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });
        const docs = parseYamlDocs(outputPath);
        const annotations =
            findService(docs)!.spec.template.metadata.annotations;

        expect(annotations["prometheus.io/scrape"]).toBeUndefined();
    });

    it("should inject KN_APP_NAME env var when observability is enabled", () => {
        const config: KnativeNextConfig = {
            name: "my-app",
            storage: {
                provider: "gcs",
                bucket: "test-bucket",
                publicUrl: "https://storage.googleapis.com/test-bucket",
            },
            registry: "gcr.io/test-project",
            observability: { enabled: true },
        };

        const outputPath = generateKnativeManifest({
            config,
            outputDir: tempDir,
        });
        const docs = parseYamlDocs(outputPath);
        const env = findService(docs)!.spec.template.spec.containers[0].env;
        const appName = findEnv(env, "KN_APP_NAME");

        expect(appName).toBeDefined();
        expect(appName!.value).toBe("my-app");
    });

    it("should generate ServiceMonitor and Grafana dashboard ConfigMap", async () => {
        const { generateObservabilityManifest } = await import(
            "../generators/infrastructure"
        );

        const manifest = generateObservabilityManifest("my-app", {
            enabled: true,
            prometheus: { scrapeInterval: "30s" },
        });

        expect(manifest).toContain("ServiceMonitor");
        expect(manifest).toContain("my-app-metrics");
        expect(manifest).toContain("30s");
        expect(manifest).toContain("/metrics");

        expect(manifest).toContain("ConfigMap");
        expect(manifest).toContain("my-app-grafana-dashboard");
        expect(manifest).toContain("kn_next_startup_duration_seconds");
    });

    it("should skip Grafana ConfigMap when grafana.enabled is false", async () => {
        const { generateObservabilityManifest } = await import(
            "../generators/infrastructure"
        );

        const manifest = generateObservabilityManifest("my-app", {
            enabled: true,
            grafana: { enabled: false },
        });

        expect(manifest).toContain("ServiceMonitor");
        expect(manifest).not.toContain("ConfigMap");
        expect(manifest).not.toContain("grafana_dashboard");
    });
});
