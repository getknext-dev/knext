#!/usr/bin/env bun
/**
 * kn-next build - Prepares Next.js app for Knative deployment using Vinext
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts (with validation)
 *   2. Run Vinext build via Nitro (preset from config.runtime)
 *   3. Upload static assets to storage (GCS/S3)
 *   4. Copy adapters to dist
 *   5. Generate knative-service.yaml
 */

import { join, resolve } from "node:path";
import { $ } from "bun";
import {
	generateEntrypoint,
	generateKnativeManifest,
} from "../generators/knative-manifest";
import { uploadAssets } from "../utils/asset-upload";
import { copyAdapters, getNitroPreset, loadConfig } from "./shared";

interface BuildOptions {
	enableKafkaQueue?: boolean;
	skipNextBuild?: boolean;
}

export async function build(options: BuildOptions = {}) {
	console.info("🔨 kn-next build (Vinext + Nitro)\n");

	const workDir = process.cwd();
	// Nitro output directory is .output
	const outputDir = join(workDir, ".output");

	// 1. Load config (validates at load time)
	console.info("📋 Loading configuration...");
	const config = await loadConfig();
	console.info(`   App: ${config.name}`);
	console.info(
		`   Storage: ${config.storage.provider} (${config.storage.bucket})`,
	);
	console.info(`   Cache: ${config.cache?.provider ?? "none"}`);
	console.info(`   Runtime: ${config.runtime ?? "bun"}\n`);

	// 2. Run Vinext build with the correct Nitro preset from config
	if (!options.skipNextBuild) {
		const preset = getNitroPreset(config);
		console.info(`📦 Building Vinext app with Nitro (preset: ${preset})...`);
		await $`NITRO_PRESET=${preset} npm run build`.quiet();
		console.info("   ✅ Vinext build complete\n");
	}

	// 3. Upload static assets
	console.info("☁️  Uploading static assets...");
	await uploadAssets(config);
	console.info("   ✅ Assets uploaded\n");

	// 4. Copy adapters
	console.info("📂 Copying adapters...");
	await copyAdapters(outputDir);

	// 5. Generate Knative manifest
	console.info("🌐 Generating Knative manifest...");
	generateKnativeManifest({
		config,
		outputDir,
		enableKafkaQueue: options.enableKafkaQueue,
	});

	if (config.bytecodeCache?.enabled) {
		generateEntrypoint({ config, outputDir });
	}

	console.info("\n✨ Build complete!");
	console.info(`   Output: ${outputDir}`);
	console.info(`   Manifest: ${join(outputDir, "knative-service.yaml")}`);
}

// Run if executed directly
if (import.meta.main) {
	build({
		// Kafka is the default for Knative ISR, use --no-kafka to disable
		enableKafkaQueue: process.argv.includes("--no-kafka")
			? false
			: undefined,
		skipNextBuild: process.argv.includes("--skip-next"),
	}).catch((err) => {
		console.error("❌ Build failed:", err.message);
		process.exit(1);
	});
}
