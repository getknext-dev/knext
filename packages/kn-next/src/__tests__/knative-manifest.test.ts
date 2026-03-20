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

/**
 * Helper: parse multi-document YAML file and return array of JS objects.
 */
function parseYamlDocs(filePath: string): Record<string, any>[] {
	const raw = readFileSync(filePath, "utf-8");
	return YAML.parseAllDocuments(raw).map((doc: any) => doc.toJSON());
}

/**
 * Helper: find document by kind in parsed YAML array.
 */
function findByKind(docs: Record<string, any>[], kind: string) {
	return docs.find((d) => d?.kind === kind);
}

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
		const ksvc = findByKind(docs, "Service");

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
		const ksvc = findByKind(docs, "Service");
		const env = ksvc!.spec.template.spec.containers[0].env;
		const envNames = env.map((e: any) => e.name);

		expect(envNames).toContain("GCS_BUCKET_NAME");
		expect(envNames).toContain("REDIS_URL");
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
		const ksvc = findByKind(docs, "Service");
		const env = ksvc!.spec.template.spec.containers[0].env;
		const envNames = env.map((e: any) => e.name);

		expect(envNames).toContain("KAFKA_BROKER_URL");
		expect(envNames).toContain("KAFKA_REVALIDATION_TOPIC");
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
		const ksvc = findByKind(docs, "Service");
		const container = ksvc!.spec.template.spec.containers[0];

		expect(container.ports[0].containerPort).toBe(3000);
		expect(container.resources.requests.memory).toBe("512Mi");
		expect(container.resources.requests.cpu).toBe("250m");
		expect(container.resources.limits.memory).toBe("1Gi");
		expect(container.resources.limits.cpu).toBe("1000m");
	});

	it("should use correct probe values (Fix #3: safer defaults)", () => {
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
		const ksvc = findByKind(docs, "Service");
		const container = ksvc!.spec.template.spec.containers[0];

		expect(container.readinessProbe.initialDelaySeconds).toBe(2);
		expect(container.readinessProbe.periodSeconds).toBe(3);
		expect(container.livenessProbe.initialDelaySeconds).toBe(5);
		expect(container.livenessProbe.periodSeconds).toBe(10);
	});

	// Bytecode cache tests
	describe("bytecode caching", () => {
		it("should NOT include bytecode cache resources when disabled", () => {
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
			const ksvc = findByKind(docs, "Service");
			const pvc = findByKind(docs, "PersistentVolumeClaim");
			const container = ksvc!.spec.template.spec.containers[0];
			const envNames = container.env.map((e: any) => e.name);

			expect(envNames).not.toContain("NODE_COMPILE_CACHE");
			expect(container.volumeMounts).toBeUndefined();
			expect(pvc).toBeUndefined();
		});

		it("should NOT include bytecode cache when bytecodeCache is undefined", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: undefined,
			};

			const outputPath = generateKnativeManifest({
				config,
				outputDir: tempDir,
			});

			const docs = parseYamlDocs(outputPath);
			const pvc = findByKind(docs, "PersistentVolumeClaim");
			const ksvc = findByKind(docs, "Service");
			const envNames = ksvc!.spec.template.spec.containers[0].env.map(
				(e: any) => e.name,
			);

			expect(envNames).not.toContain("NODE_COMPILE_CACHE");
			expect(pvc).toBeUndefined();
		});

		it("should include NODE_COMPILE_CACHE env var when enabled", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: { enabled: true },
			};

			const outputPath = generateKnativeManifest({
				config,
				outputDir: tempDir,
				imageTag: "v2.0.0",
			});

			const docs = parseYamlDocs(outputPath);
			const ksvc = findByKind(docs, "Service");
			const env = ksvc!.spec.template.spec.containers[0].env;
			const compileCacheVar = env.find(
				(e: any) => e.name === "NODE_COMPILE_CACHE",
			);

			expect(compileCacheVar).toBeDefined();
			expect(compileCacheVar.value).toBe("/cache/bytecode/v2.0.0");
		});

		it("should include PVC manifest when bytecode cache is enabled", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: { enabled: true },
			};

			const outputPath = generateKnativeManifest({
				config,
				outputDir: tempDir,
				namespace: "production",
			});

			const docs = parseYamlDocs(outputPath);
			const pvc = findByKind(docs, "PersistentVolumeClaim");

			expect(pvc).toBeDefined();
			expect(pvc!.metadata.name).toBe("my-app-bytecode-cache");
			expect(pvc!.metadata.namespace).toBe("production");
			expect(pvc!.spec.accessModes).toContain("ReadWriteOnce");
			expect(pvc!.spec.resources.requests.storage).toBe("512Mi");
		});

		it("should use custom storage size for PVC", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: { enabled: true, storageSize: "1Gi" },
			};

			const outputPath = generateKnativeManifest({
				config,
				outputDir: tempDir,
			});

			const docs = parseYamlDocs(outputPath);
			const pvc = findByKind(docs, "PersistentVolumeClaim");

			expect(pvc!.spec.resources.requests.storage).toBe("1Gi");
		});

		it("should include volume mount on the container", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: { enabled: true },
			};

			const outputPath = generateKnativeManifest({
				config,
				outputDir: tempDir,
			});

			const docs = parseYamlDocs(outputPath);
			const ksvc = findByKind(docs, "Service");
			const container = ksvc!.spec.template.spec.containers[0];

			expect(container.volumeMounts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "bytecode-cache",
						mountPath: "/cache/bytecode",
					}),
				]),
			);

			const volumes = ksvc!.spec.template.spec.volumes;
			expect(volumes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "bytecode-cache",
						persistentVolumeClaim: {
							claimName: "my-app-bytecode-cache",
						},
					}),
				]),
			);
		});

		it("should key cache path by imageTag", () => {
			const config: KnativeNextConfig = {
				name: "my-app",
				storage: {
					provider: "gcs",
					bucket: "test-bucket",
					publicUrl: "https://storage.googleapis.com/test-bucket",
				},
				registry: "gcr.io/test-project",
				bytecodeCache: { enabled: true },
			};

			const path1 = generateKnativeManifest({
				config,
				outputDir: tempDir,
				imageTag: "abc123",
			});
			const docs1 = parseYamlDocs(path1);
			const env1 = findByKind(docs1, "Service")!.spec.template.spec
				.containers[0].env;
			expect(
				env1.find((e: any) => e.name === "NODE_COMPILE_CACHE").value,
			).toBe("/cache/bytecode/abc123");

			const path2 = generateKnativeManifest({
				config,
				outputDir: tempDir,
				imageTag: "def456",
			});
			const docs2 = parseYamlDocs(path2);
			const env2 = findByKind(docs2, "Service")!.spec.template.spec
				.containers[0].env;
			expect(
				env2.find((e: any) => e.name === "NODE_COMPILE_CACHE").value,
			).toBe("/cache/bytecode/def456");
		});
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
			const doc = YAML.parse(content);
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
			const ksvc = findByKind(docs, "Service");
			const container = ksvc!.spec.template.spec.containers[0];

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
		const ksvc = findByKind(docs, "Service");
		const annotations = ksvc!.spec.template.metadata.annotations;

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
		const ksvc = findByKind(docs, "Service");
		const annotations = ksvc!.spec.template.metadata.annotations;

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
		const ksvc = findByKind(docs, "Service");
		const env = ksvc!.spec.template.spec.containers[0].env;
		const appName = env.find((e: any) => e.name === "KN_APP_NAME");

		expect(appName).toBeDefined();
		expect(appName.value).toBe("my-app");
	});

	it("should generate ServiceMonitor and Grafana dashboard ConfigMap", async () => {
		const { generateObservabilityManifest } = await import(
			"../generators/infrastructure"
		);

		const manifest = generateObservabilityManifest("my-app", {
			enabled: true,
			prometheus: { scrapeInterval: "30s" },
		});

		// ServiceMonitor
		expect(manifest).toContain("ServiceMonitor");
		expect(manifest).toContain("my-app-metrics");
		expect(manifest).toContain("30s");
		expect(manifest).toContain("/metrics");

		// Grafana ConfigMap
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
