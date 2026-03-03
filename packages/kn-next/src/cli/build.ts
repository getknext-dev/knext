#!/usr/bin/env bun
/**
 * kn-next build - Prepares Next.js app for Knative deployment using Vinext
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts
 *   2. Run Vinext build (via npm run build)
 *   3. Upload static assets to storage (GCS/S3)
 *   4. Copy adapters to dist
 *   5. Generate knative-service.yaml
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import type { KnativeNextConfig } from "../config";
import { generateKnativeManifest } from "../generators/knative-manifest";
import { uploadAssets } from "../utils/asset-upload";

const CONFIG_FILE = "kn-next.config.ts";

interface BuildOptions {
    enableKafkaQueue?: boolean;
    skipNextBuild?: boolean;
}

async function loadConfig(): Promise<KnativeNextConfig> {
    const configPath = resolve(process.cwd(), CONFIG_FILE);

    if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const module = await import(configPath);
    return module.default;
}

async function copyAdapters(
    outputDir: string,
    storageProvider: string,
    cacheProvider: string,
) {
    const adaptersDir = join(outputDir, "adapters");
    mkdirSync(adaptersDir, { recursive: true });

    const sourceDir = resolve(dirname(import.meta.path), "..", "adapters");

    // Copy relevant adapters based on config
    const adaptersToCopy = ["bytecode-metrics.ts"];

    // Node-server adapter used to intercept requests for /metrics and pass them to Vinext handler
    adaptersToCopy.push("node-server.ts");

    for (const adapter of adaptersToCopy) {
        const src = join(sourceDir, adapter);
        const dest = join(adaptersDir, adapter);
        if (existsSync(src)) {
            copyFileSync(src, dest);
            console.info(`   Copied ${adapter}`);
        }
    }
}

export async function build(options: BuildOptions = {}) {
    console.info("🔨 kn-next build (Vinext)\n");

    const workDir = process.cwd();
    // Vinext output directory is typically dist
    const outputDir = join(workDir, "dist");

    // 1. Load config
    console.info("📋 Loading configuration...");
    const config = await loadConfig();
    console.info(`   App: ${config.name}`);
    console.info(
        `   Storage: ${config.storage.provider} (${config.storage.bucket})`,
    );
    console.info(`   Cache: ${config.cache?.provider ?? "none"}\n`);

    // 2. Run Vinext build
    if (!options.skipNextBuild) {
        console.info("📦 Building Vinext app...");
        await $`npm run build`.quiet();
        console.info("   ✅ Vinext build complete\n");
    }

    // 3. Upload static assets
    console.info("☁️  Uploading static assets...");
    // We pass dist/client/assets to asset-upload, but we need to verify uploadAssets logic
    await uploadAssets(config);
    console.info("   ✅ Assets uploaded\n");

    // 4. Copy adapters
    console.info("📂 Copying adapters...");
    await copyAdapters(
        outputDir,
        config.storage.provider,
        config.cache?.provider ?? "redis",
    );

    // 5. Generate Knative manifest
    console.info("🌐 Generating Knative manifest...");
    generateKnativeManifest({
        config,
        outputDir,
        enableKafkaQueue: options.enableKafkaQueue,
    });

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
