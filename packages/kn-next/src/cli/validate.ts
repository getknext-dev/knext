/**
 * Config validation — runs at load time, fails fast with clear errors.
 */

import type { KnativeNextConfig } from "../config";

const SUPPORTED_STORAGE_PROVIDERS = ["gcs", "s3", "minio"] as const;
const SUPPORTED_CACHE_PROVIDERS = ["redis", "dynamodb"] as const;
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
		errors.push("'registry' is required (e.g. 'us-central1-docker.pkg.dev/my-project/my-repo')");
	}

	// Storage validation
	if (!config.storage) {
		errors.push("'storage' is required");
	} else {
		if (!SUPPORTED_STORAGE_PROVIDERS.includes(config.storage.provider as any)) {
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
		if (!SUPPORTED_CACHE_PROVIDERS.includes(config.cache.provider as any)) {
			errors.push(
				`Cache provider '${config.cache.provider}' is not supported. Supported: ${SUPPORTED_CACHE_PROVIDERS.join(", ")}`,
			);
		}
		if (config.cache.provider === "redis" && !config.cache.url) {
			errors.push("'cache.url' is required when using Redis cache provider");
		}
	}

	// Runtime validation
	if (config.runtime && !SUPPORTED_RUNTIMES.includes(config.runtime as any)) {
		errors.push(
			`Runtime '${config.runtime}' is not supported. Supported: ${SUPPORTED_RUNTIMES.join(", ")}`,
		);
	}

	// Scaling validation
	if (config.scaling) {
		if (config.scaling.minScale !== undefined && config.scaling.minScale < 0) {
			errors.push("'scaling.minScale' must be >= 0");
		}
		if (config.scaling.maxScale !== undefined && config.scaling.maxScale < 1) {
			errors.push("'scaling.maxScale' must be >= 1");
		}
		if (
			config.scaling.minScale !== undefined &&
			config.scaling.maxScale !== undefined &&
			config.scaling.minScale > config.scaling.maxScale
		) {
			errors.push("'scaling.minScale' cannot be greater than 'scaling.maxScale'");
		}
	}

	if (errors.length > 0) {
		throw new ConfigValidationError(
			`\n  - ${errors.join("\n  - ")}`,
		);
	}
}
