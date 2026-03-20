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

import { join } from "node:path";
import { $ } from "bun";
import { generateKnativeManifest } from "../generators/knative-manifest";
import { uploadAssets } from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { copyAdapters, getNitroPreset, loadConfig } from "./shared";

const log = createLogger({ module: "build" });

interface BuildOptions {
    enableKafkaQueue?: boolean;
    skipNextBuild?: boolean;
}

export async function build(options: BuildOptions = {}) {
    log.info("🔨 kn-next build (Vinext + Nitro)");

    const workDir = process.cwd();
    const outputDir = join(workDir, ".output");

    // 1. Load config (validates at load time)
    log.info("Loading configuration...");
    const config = await loadConfig();
    log.info(
        {
            app: config.name,
            storage: `${config.storage.provider} (${config.storage.bucket})`,
            cache: config.cache?.provider ?? "none",
            runtime: config.runtime ?? "bun",
        },
        "Configuration loaded",
    );

    // 2. Run Vinext build with the correct Nitro preset from config
    if (!options.skipNextBuild) {
        const preset = getNitroPreset(config);
        log.info({ preset }, "Building Vinext app with Nitro");
        await $`NITRO_PRESET=${preset} npm run build`.quiet();
        log.info("Vinext build complete");
    }

    // 3. Upload static assets
    log.info("Uploading static assets...");
    await uploadAssets(config);
    log.info("Assets uploaded");

    // 4. Copy adapters
    log.info("Copying adapters...");
    await copyAdapters(outputDir);

    // 5. Generate Knative manifest
    log.info("Generating Knative manifest...");
    generateKnativeManifest({
        config,
        outputDir,
        enableKafkaQueue: options.enableKafkaQueue,
    });

    log.info(
        {
            output: outputDir,
            manifest: join(outputDir, "knative-service.yaml"),
        },
        "✨ Build complete!",
    );
}

// Run if executed directly
if (import.meta.main) {
    try {
        await build({
            enableKafkaQueue: process.argv.includes("--no-kafka")
                ? false
                : undefined,
            skipNextBuild: process.argv.includes("--skip-next"),
        });
    } catch (err) {
        log.fatal({ err }, "Build failed");
        process.exit(1);
    }
}
