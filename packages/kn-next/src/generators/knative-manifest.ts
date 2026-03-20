import { writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";

/**
 * Provider-specific environment variable generators.
 * Following Open/Closed Principle: add new providers without modifying existing code.
 */
type EnvVarGenerator<T> = (
	config: T,
	appName: string,
) => Record<string, string>;

// biome-ignore lint/suspicious/noExplicitAny: intentional
const storageEnvVarGenerators: Record<string, EnvVarGenerator<any>> = {
	gcs: (storage, appName) => ({
		GCS_BUCKET_NAME: storage.bucket,
		GCS_BUCKET_KEY_PREFIX: appName,
	}),
	s3: (storage) => ({
		CACHE_BUCKET_NAME: storage.bucket,
		CACHE_BUCKET_REGION: storage.region ?? "us-east-1",
		...(storage.endpoint ? { S3_ENDPOINT: storage.endpoint } : {}),
	}),
	minio: (storage) => ({
		CACHE_BUCKET_NAME: storage.bucket,
		CACHE_BUCKET_REGION: storage.region ?? "us-east-1",
		...(storage.endpoint ? { S3_ENDPOINT: storage.endpoint } : {}),
	}),
};

// biome-ignore lint/suspicious/noExplicitAny: intentional
const cacheEnvVarGenerators: Record<string, EnvVarGenerator<any>> = {
	redis: (cache, appName) => ({
		REDIS_URL: cache.url,
		REDIS_KEY_PREFIX: cache.keyPrefix ?? appName,
	}),
	dynamodb: (cache) => ({
		CACHE_DYNAMO_TABLE: cache.tableName,
		CACHE_BUCKET_REGION: cache.region,
	}),
};

/**
 * Generates environment variables configuration for the adapters.
 * Uses provider-specific generators for extensibility.
 */
export function getRequiredEnvVars(
	config: KnativeNextConfig,
): Record<string, string> {
	const storageGenerator = storageEnvVarGenerators[config.storage.provider];
	const cacheGenerator = config.cache
		? cacheEnvVarGenerators[config.cache.provider]
		: null;

	return {
		...(storageGenerator?.(config.storage, config.name) ?? {}),
		...(cacheGenerator?.(config.cache, config.name) ?? {}),
	};
}

export interface GenerateKnativeManifestOptions {
	config: KnativeNextConfig;
	outputDir: string;
	imageTag?: string;
	namespace?: string;
	enableKafkaQueue?: boolean;
	additionalEnvVars?: Record<string, string>; // Infrastructure connection vars
}

/**
 * Builds the Knative Service manifest as a structured JS object.
 * No string templates — safe from indentation bugs, structurally testable.
 */
function buildKnativeServiceObject(
	options: GenerateKnativeManifestOptions,
): Record<string, unknown> {
	const {
		config,
		imageTag = "latest",
		namespace = "default",
		enableKafkaQueue = false,
		additionalEnvVars = {},
	} = options;

	const envVars = { ...getRequiredEnvVars(config), ...additionalEnvVars };

	// Add Kafka env vars if enabled
	if (enableKafkaQueue) {
		envVars.KAFKA_BROKER_URL = "${KAFKA_BROKER_URL}";
		envVars.KAFKA_REVALIDATION_TOPIC = `${config.name}-revalidation`;
	}

	// Add NODE_COMPILE_CACHE env var if bytecode caching is enabled
	const bytecodeCacheEnabled = config.bytecodeCache?.enabled === true;
	if (bytecodeCacheEnabled) {
		envVars.NODE_COMPILE_CACHE = `/cache/bytecode/${imageTag}`;
	}

	// Add observability env vars
	const observabilityEnabled = config.observability?.enabled === true;
	if (observabilityEnabled) {
		envVars.KN_APP_NAME = config.name;
	}

	// Build env array
	const env: Record<string, string>[] = [
		{ name: "HOSTNAME", value: "0.0.0.0" },
		{ name: "NODE_ENV", value: "production" },
		...Object.entries(envVars).map(([name, value]) => ({ name, value })),
	];

	// Build envFrom array for whole-secret injection
	const envFrom = config.secrets?.envFrom?.map((secretName) => ({
		secretRef: { name: secretName },
	}));

	// Build env entries for mapped secret keys
	if (config.secrets?.envMap) {
		for (const [envName, ref] of Object.entries(config.secrets.envMap)) {
			env.push({
				name: envName,
				valueFrom: {
					secretKeyRef: {
						name: ref.name,
						key: ref.key ?? envName,
					},
				},
			} as any);
		}
	}

	// Build annotations
	const annotations: Record<string, string> = {
		"autoscaling.knative.dev/min-scale": `${config.scaling?.minScale ?? 0}`,
		"autoscaling.knative.dev/max-scale": `${config.scaling?.maxScale ?? 10}`,
	};
	if (observabilityEnabled) {
		annotations["prometheus.io/scrape"] = "true";
		annotations["prometheus.io/port"] = "9091";
		annotations["prometheus.io/path"] = "/metrics";
	}

	// Container definition
	const container: Record<string, unknown> = {
		image: `${config.registry}/${config.name}:${imageTag}`,
		ports: [{ containerPort: 3000 }],
		env,
		...(envFrom?.length ? { envFrom } : {}),
		resources: {
			requests: {
				cpu: config.scaling?.cpuRequest ?? "250m",
				memory: config.scaling?.memoryRequest ?? "512Mi",
			},
			limits: {
				cpu: config.scaling?.cpuLimit ?? "1000m",
				memory: config.scaling?.memoryLimit ?? "1Gi",
			},
		},
		readinessProbe: {
			httpGet: {
				path: config.healthCheckPath ?? "/api/health",
				port: 3000,
			},
			initialDelaySeconds: 2,
			periodSeconds: 3,
		},
		livenessProbe: {
			httpGet: {
				path: config.healthCheckPath ?? "/api/health",
				port: 3000,
			},
			initialDelaySeconds: 5,
			periodSeconds: 10,
		},
	};

	// Add volume mounts if bytecode cache enabled
	if (bytecodeCacheEnabled) {
		container.volumeMounts = [
			{ name: "bytecode-cache", mountPath: "/cache/bytecode" },
		];
	}

	// Template spec
	const templateSpec: Record<string, unknown> = {
		serviceAccountName: `${config.name}-sa`,
		containerConcurrency: 100,
		timeoutSeconds: 300,
		containers: [container],
	};

	if (bytecodeCacheEnabled) {
		templateSpec.volumes = [
			{
				name: "bytecode-cache",
				persistentVolumeClaim: {
					claimName: `${config.name}-bytecode-cache`,
				},
			},
		];
	}

	return {
		apiVersion: "serving.knative.dev/v1",
		kind: "Service",
		metadata: {
			name: config.name,
			namespace,
			labels: {
				app: config.name,
				"generated-by": "kn-next",
			},
		},
		spec: {
			template: {
				metadata: { annotations },
				spec: templateSpec,
			},
		},
	};
}

/**
 * Generates Knative Service manifest from kn-next.config.ts.
 * Uses structured JS objects serialized to YAML — no string templates.
 */
export function generateKnativeManifest(
	options: GenerateKnativeManifestOptions,
): string {
	const {
		config,
		outputDir,
		imageTag = "latest",
		namespace = "default",
	} = options;

	const bytecodeCacheEnabled = config.bytecodeCache?.enabled === true;

	// Build all YAML documents
	const documents: Record<string, unknown>[] = [];

	// 1. Knative Service
	documents.push(buildKnativeServiceObject(options));

	// 2. PVC for bytecode cache (if enabled)
	if (bytecodeCacheEnabled) {
		documents.push({
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: {
				name: `${config.name}-bytecode-cache`,
				namespace,
				labels: {
					app: config.name,
					"generated-by": "kn-next",
				},
			},
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: {
					requests: {
						storage:
							config.bytecodeCache?.storageSize ?? "512Mi",
					},
				},
			},
		});
	}

	// 3. ServiceAccount
	documents.push({
		apiVersion: "v1",
		kind: "ServiceAccount",
		metadata: {
			name: `${config.name}-sa`,
			namespace,
		},
		automountServiceAccountToken: false,
	});

	// Serialize all documents to YAML with --- separators
	const yamlContent = documents
		.map(
			(doc) =>
				`# AUTO-GENERATED by kn-next build - DO NOT EDIT\n${YAML.stringify(doc)}`,
		)
		.join("---\n");

	const outputPath = path.join(outputDir, "knative-service.yaml");
	writeFileSync(outputPath, yamlContent, "utf-8");

	// Generate Image cache manifest
	const imageCacheDoc = {
		apiVersion: "caching.internal.knative.dev/v1alpha1",
		kind: "Image",
		metadata: {
			name: `${config.name}-image-cache`,
			namespace,
			labels: {
				app: config.name,
				"generated-by": "kn-next",
			},
		},
		spec: {
			image: `${config.registry}/${config.name}:${imageTag}`,
		},
	};
	const imageCachePath = path.join(outputDir, "knative-image-cache.yaml");
	writeFileSync(
		imageCachePath,
		`# Image Cache - Pre-pulls the docker image on nodes for faster cold starts\n${YAML.stringify(imageCacheDoc)}`,
		"utf-8",
	);

	console.info(`[kn-next] Generated ${outputPath}`);
	console.info(`[kn-next] Generated ${imageCachePath}`);
	if (bytecodeCacheEnabled) {
		console.info(
			`[kn-next] Bytecode caching enabled (NODE_COMPILE_CACHE=/cache/bytecode/${imageTag})`,
		);
	}
	return outputPath;
}

/**
 * Generates Knative Eventing resources for ISR revalidation via Kafka.
 */
export function generateKafkaEventingManifest(options: {
	config: KnativeNextConfig;
	outputDir: string;
	kafkaBroker: string;
}): string {
	const { config, outputDir, kafkaBroker } = options;
	const topic = `${config.name}-revalidation`;

	const documents = [
		{
			apiVersion: "sources.knative.dev/v1beta1",
			kind: "KafkaSource",
			metadata: {
				name: `${config.name}-revalidation-source`,
			},
			spec: {
				consumerGroup: `${config.name}-revalidation`,
				bootstrapServers: [kafkaBroker],
				topics: [topic],
				sink: {
					ref: {
						apiVersion: "serving.knative.dev/v1",
						kind: "Service",
						name: `${config.name}-revalidator`,
					},
				},
			},
		},
		{
			apiVersion: "serving.knative.dev/v1",
			kind: "Service",
			metadata: {
				name: `${config.name}-revalidator`,
			},
			spec: {
				template: {
					spec: {
						containers: [
							{
								image: `${config.registry}/${config.name}-revalidator:latest`,
								env: [
									{
										name: "TARGET_HOST",
										value: `${config.name}.default.svc.cluster.local`,
									},
								],
							},
						],
					},
				},
			},
		},
	];

	const yamlContent = documents
		.map(
			(doc) =>
				`# AUTO-GENERATED by kn-next build - DO NOT EDIT\n${YAML.stringify(doc)}`,
		)
		.join("---\n");

	const outputPath = path.join(outputDir, "knative-eventing.yaml");
	writeFileSync(outputPath, yamlContent, "utf-8");

	console.info(`[kn-next] Generated ${outputPath}`);
	return outputPath;
}

/**
 * Generates an entrypoint script that fixes PVC ownership for the bytecode cache.
 */
export function generateEntrypoint(options: {
	config: KnativeNextConfig;
	outputDir: string;
}): string {
	const { outputDir } = options;

	const script = `#!/bin/sh
# AUTO-GENERATED by kn-next build - DO NOT EDIT
# Fixes PVC ownership for V8 bytecode cache, then drops to node user.

CACHE_BASE="/cache/bytecode"

if [ -d "$CACHE_BASE" ]; then
  echo "[kn-next] Fixing bytecode cache permissions..."
  chown -R node:node "$CACHE_BASE" 2>/dev/null || true

  if [ -n "$NODE_COMPILE_CACHE" ]; then
    mkdir -p "$NODE_COMPILE_CACHE" 2>/dev/null || true
    chown -R node:node "$NODE_COMPILE_CACHE" 2>/dev/null || true
  fi

  echo "[kn-next] Cache dir ready: $(ls -la $CACHE_BASE | head -5)"
fi

export HOSTNAME=0.0.0.0

NEXT_DIR="$(pwd)/.next"
if [ -d "$NEXT_DIR" ]; then
  mkdir -p "$NEXT_DIR/cache" 2>/dev/null || true
  chown -R node:node "$NEXT_DIR/cache" 2>/dev/null || true
  chown -R node:node "$NEXT_DIR/server" 2>/dev/null || true
  echo "[kn-next] Fixed .next cache permissions"
fi

exec su-exec node node --experimental-strip-types .output/adapters/node-server.ts
`;

	const outputPath = path.join(outputDir, "entrypoint.sh");
	writeFileSync(outputPath, script, { encoding: "utf-8", mode: 0o755 });

	console.info(
		"[kn-next] Generated entrypoint.sh (bytecode cache PVC permissions fix)",
	);
	return outputPath;
}
