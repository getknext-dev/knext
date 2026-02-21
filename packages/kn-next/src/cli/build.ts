#!/usr/bin/env bun
/**
 * kn-next build - Prepares Next.js app for Knative deployment
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts
 *   2. Generate open-next.config.ts (internal)
 *   3. Run Next.js build
 *   4. Run OpenNext build
 *   5. Upload static assets to storage (GCS/S3)
 *   6. Copy adapters to .open-next
 *   7. Generate knative-service.yaml
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import type { KnativeNextConfig } from "../config";
import { generateKnativeManifest } from "../generators/knative-manifest";
import {
    generateOpenNextConfig,
    getRequiredEnvVars,
} from "../generators/open-next-config";
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
    const adaptersToCopy = [];

    if (storageProvider === "gcs") {
        adaptersToCopy.push("gcs-cache.ts");
    }

    if (cacheProvider === "redis") {
        adaptersToCopy.push("redis-tag-cache.ts");
    }

    // Always copy node-server wrapper
    // adaptersToCopy.push("node-server.ts");

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
    console.info("🔨 kn-next build\n");

    const workDir = process.cwd();
    const outputDir = join(workDir, ".open-next");

    // 1. Load config
    console.info("📋 Loading configuration...");
    const config = await loadConfig();
    console.info(`   App: ${config.name}`);
    console.info(
        `   Storage: ${config.storage.provider} (${config.storage.bucket})`,
    );
    console.info(`   Cache: ${config.cache?.provider ?? "none"}\n`);

    // 2. Generate open-next.config.ts
    console.info("⚙️  Generating OpenNext config...");
    mkdirSync(outputDir, { recursive: true });
    generateOpenNextConfig({
        config,
        outputDir: workDir, // Root of project for open-next to find it
        enableKafkaQueue: options.enableKafkaQueue,
    });

    // 3. Run Next.js build
    if (!options.skipNextBuild) {
        console.info("📦 Building Next.js...");
        await $`npm run build`.quiet();
        console.info("   ✅ Next.js build complete\n");
    }

    // 4. Run OpenNext build
    console.info("⚡ Building OpenNext...");
    await $`npx open-next build`.quiet();
    console.info("   ✅ OpenNext build complete\n");

    // 5. Upload static assets
    console.info("☁️  Uploading static assets...");
    await uploadAssets(config);
    console.info("   ✅ Assets uploaded\n");

    // 6. Copy adapters
    console.info("📂 Copying adapters...");
    await copyAdapters(
        outputDir,
        config.storage.provider,
        config.cache?.provider ?? "redis",
    );

    // 7. Generate Knative manifest
    console.info("🌐 Generating Knative manifest...");
    generateKnativeManifest({
        config,
        outputDir,
        enableKafkaQueue: options.enableKafkaQueue,
    });

    // 7. Show required env vars
    console.info("\n📝 Required environment variables:");
    const envVars = getRequiredEnvVars(config);
    for (const [key, value] of Object.entries(envVars)) {
        console.info(`   ${key}=${value}`);
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
