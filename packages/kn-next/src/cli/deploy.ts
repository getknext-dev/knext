#!/usr/bin/env bun
/**
 * kn-next CLI - Knative Next.js Deployment Automation (Vinext)
 *
 * Usage:
 *   npx kn-next deploy [options]
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import type { KnativeNextConfig } from "../config";
import { generateInfrastructure } from "../generators/infrastructure";
import { generateKnativeManifest } from "../generators/knative-manifest";
import { getAssetPrefix, uploadAssets } from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { copyAdapters, getNitroPreset, loadConfig } from "./shared";

const log = createLogger({ module: "deploy" });

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
        log.info("Help output omitted for brevity");
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

async function deploy() {
    const options = parseCliArgs();

    log.info({ dryRun: options.dryRun }, "🚀 kn-next deploy");

    // Load config with validation
    const baseConfig = await loadConfig();
    const config = applyOverrides(baseConfig, options);

    const outputDir = join(process.cwd(), ".output");

    if (!options.skipBuild) {
        const assetPrefix = getAssetPrefix(config.storage);
        process.env.ASSET_PREFIX = assetPrefix;
        const preset = getNitroPreset(config);
        log.info({ preset, assetPrefix }, "Building Vinext app with Nitro");
        await $`NITRO_PRESET=${preset} npm run build`.quiet();
        log.info("Vinext build complete");
    }

    // Always copy adapters after build
    await copyAdapters(outputDir);

    const imageTag = options.tag || `${Date.now()}`;
    const imageName = `${config.registry}/${config.name}:${imageTag}`;

    log.info({ image: imageName }, "Image tag resolved");

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        if (!options.skipUpload) {
            log.info("Running parallel tasks: asset upload + Docker build");
            tasks.push(
                (async () => {
                    await uploadAssets(config);
                    log.info("Assets uploaded");
                })(),
            );
        }

        log.info("Building & pushing Docker image");
        tasks.push(
            (async () => {
                const repoRoot = resolve(process.cwd(), "../..");
                await $`docker buildx build --platform linux/amd64 -f ${process.cwd()}/Dockerfile -t ${imageName} --push ${repoRoot}`;
                log.info("Docker image built and pushed");
            })(),
        );

        await Promise.all(tasks);
    }

    let infraEnvVars: Record<string, string> = {};
    const hasInfra = config.infrastructure || config.observability?.enabled;
    if (hasInfra && !options.skipInfra && !options.dryRun) {
        log.info("Deploying infrastructure services...");
        const { manifests, envVars } = generateInfrastructure(
            config,
            outputDir,
        );
        infraEnvVars = envVars;

        for (const manifest of manifests) {
            await $`kubectl apply -f ${manifest} -n ${options.namespace}`;
        }
        log.info("Infrastructure deployed");
    }

    if (process.env.KN_DATABASE_URL) {
        infraEnvVars.DATABASE_URL = process.env.KN_DATABASE_URL;
    }

    log.info("Generating Knative manifest...");
    generateKnativeManifest({
        config,
        outputDir,
        imageTag,
        namespace: options.namespace,
        additionalEnvVars: infraEnvVars,
    });
    const manifestPath = join(outputDir, "knative-service.yaml");
    const imageCachePath = join(outputDir, "knative-image-cache.yaml");
    log.info({ manifest: manifestPath }, "Manifest generated");

    if (!options.dryRun) {
        log.info("Applying to cluster...");
        await $`kubectl apply -f ${manifestPath} -f ${imageCachePath} -n ${options.namespace}`;
        const result =
            await $`kubectl get ksvc ${config.name} -n ${options.namespace} -o jsonpath='{.status.url}'`.text();
        log.info({ url: result.replace(/'/g, "") }, "✨ Deployment complete!");
    } else {
        log.info("✅ Dry run complete - manifest generated");
    }
}

try {
    await deploy();
} catch (err) {
    log.fatal({ err }, "Deployment failed");
    process.exit(1);
}
