#!/usr/bin/env bun
/**
 * kn-next CLI - Knative Next.js Deployment Automation (Vinext)
 *
 * Usage:
 *   npx kn-next deploy [options]
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import type { KnativeNextConfig } from "../config";
import { generateInfrastructure } from "../generators/infrastructure";
import {
    generateEntrypoint,
    generateKnativeManifest,
} from "../generators/knative-manifest";
import { getAssetPrefix, uploadAssets } from "../utils/asset-upload";

const CONFIG_FILE = "kn-next.config.ts";

interface DeployOptions {
    registry?: string;
    bucket?: string;
    tag?: string;
    namespace: string;
    skipBuild: boolean;
    skipUpload: boolean;
    skipInfra: boolean;
    dryRun: boolean;
}

function parseCliArgs(): DeployOptions {
    const { values } = parseArgs({
        options: {
            registry: { type: "string", short: "r" },
            bucket: { type: "string", short: "b" },
            tag: { type: "string", short: "t" },
            namespace: { type: "string", short: "n", default: "default" },
            "skip-build": { type: "boolean", default: false },
            "skip-upload": { type: "boolean", default: false },
            "skip-infra": { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });

    if (values.help) {
        console.info(`Help output omitted for brevity`);
        process.exit(0);
    }

    return {
        registry: values.registry || process.env.KN_REGISTRY,
        bucket: values.bucket || process.env.KN_BUCKET,
        tag: values.tag || process.env.KN_IMAGE_TAG,
        namespace: values.namespace || process.env.KN_NAMESPACE || "default",
        skipBuild: values["skip-build"] ?? false,
        skipUpload: values["skip-upload"] ?? false,
        skipInfra: values["skip-infra"] ?? false,
        dryRun: values["dry-run"] ?? false,
    };
}

async function loadConfig(): Promise<KnativeNextConfig> {
    const configPath = resolve(process.cwd(), CONFIG_FILE);

    if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const module = await import(configPath);
    return module.default;
}

function applyOverrides(
    config: KnativeNextConfig,
    options: DeployOptions,
): KnativeNextConfig {
    const overridden = { ...config };

    if (options.registry) {
        overridden.registry = options.registry;
    }
    if (options.bucket) {
        overridden.storage = { ...overridden.storage, bucket: options.bucket };
    }

    if (process.env.KN_REDIS_URL && overridden.cache?.provider === "redis") {
        overridden.cache = {
            ...overridden.cache,
            url: process.env.KN_REDIS_URL,
        };
    }

    return overridden;
}

async function copyAdapters(outputDir: string) {
    const adaptersDir = join(outputDir, "adapters");
    mkdirSync(adaptersDir, { recursive: true });

    // Assuming we're running from packages/kn-next/src/cli/deploy.ts
    const sourceDir = resolve(import.meta.dir, "..", "adapters");

    const adaptersToCopy = ["bytecode-metrics.ts", "node-server.ts"];

    for (const adapter of adaptersToCopy) {
        const src = join(sourceDir, adapter);
        const dest = join(adaptersDir, adapter);
        if (existsSync(src)) {
            copyFileSync(src, dest);
            console.info(`   Copied adapter: ${adapter}`);
        }
    }

    // Copy custom cache handler if it exists
    const cacheHandlerSrc = join(process.cwd(), "cache-handler.js");
    if (existsSync(cacheHandlerSrc)) {
        copyFileSync(cacheHandlerSrc, join(adaptersDir, "cache-handler.js"));
        console.info(`   Copied cache-handler.js`);
    }
}

async function deploy() {
    const options = parseCliArgs();

    console.info("🚀 kn-next deploy\n");

    if (options.dryRun) {
        console.info("⚠️  DRY RUN MODE - No actual deployment\n");
    }

    const baseConfig = await loadConfig();
    const config = applyOverrides(baseConfig, options);

    const outputDir = join(process.cwd(), ".output");

    if (!options.skipBuild) {
        const assetPrefix = getAssetPrefix(config.storage);
        process.env.ASSET_PREFIX = assetPrefix;
        console.info(`📦 Building Vinext app with Nitro (assetPrefix: ${assetPrefix})...`);
        await $`NITRO_PRESET=bun npm run build`.quiet();
        console.info("   ✅ Vinext build complete\n");
    }

    // Always copy adapters after build (or if skipping build, ensure they are there)
    await copyAdapters(outputDir);

    const imageTag = options.tag || `${Date.now()}`;
    const imageName = `${config.registry}/${config.name}:${imageTag}`;

    console.info(`📌 Image: ${imageName}\n`);

    if (config.bytecodeCache?.enabled) {
        generateEntrypoint({ config, outputDir });
    }

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        if (!options.skipUpload) {
            console.info("🔀 Running in parallel:");
            console.info(`   - Uploading assets to ${config.storage.provider}`);
            tasks.push(
                (async () => {
                    await uploadAssets(config);
                    console.info("   ✅ Assets uploaded");
                })(),
            );
        }

        console.info("   - Building & pushing Docker image\n");
        tasks.push(
            (async () => {
                const repoRoot = resolve(process.cwd(), "../..");
                await $`docker buildx build --platform linux/amd64 -f ${process.cwd()}/Dockerfile -t ${imageName} --push ${repoRoot}`;
                console.info("   ✅ Docker image built and pushed");
            })(),
        );

        await Promise.all(tasks);
        console.info("");
    }

    let infraEnvVars: Record<string, string> = {};
    const hasInfra = config.infrastructure || config.observability?.enabled;
    if (hasInfra && !options.skipInfra && !options.dryRun) {
        console.info("🏗️  Deploying infrastructure services...");
        const { manifests, envVars } = generateInfrastructure(
            config,
            outputDir,
        );
        infraEnvVars = envVars;

        for (const manifest of manifests) {
            await $`kubectl apply -f ${manifest} -n ${options.namespace}`;
        }
        console.info("   ✅ Infrastructure deployed\n");
    }

    if (process.env.KN_DATABASE_URL) {
        infraEnvVars.DATABASE_URL = process.env.KN_DATABASE_URL;
    }

    console.info("🌐 Generating Knative manifest...");
    generateKnativeManifest({
        config,
        outputDir,
        imageTag,
        namespace: options.namespace,
        additionalEnvVars: infraEnvVars,
    });
    const manifestPath = join(outputDir, "knative-service.yaml");
    const imageCachePath = join(outputDir, "knative-image-cache.yaml");
    console.info(`   📄 Manifest: ${manifestPath}`);

    if (!options.dryRun) {
        console.info("   Applying to cluster...");
        await $`kubectl apply -f ${manifestPath} -f ${imageCachePath} -n ${options.namespace}`;
        const result =
            await $`kubectl get ksvc ${config.name} -n ${options.namespace} -o jsonpath='{.status.url}'`.text();
        console.info("\n✨ Deployment complete!");
        console.info(`🔗 URL: ${result.replace(/'/g, "")}`);
    } else {
        console.info("\n✅ Dry run complete - manifest generated");
    }
}

deploy().catch((err) => {
    console.error("❌ Deployment failed:", err.message);
    process.exit(1);
});
