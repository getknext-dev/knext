#!/usr/bin/env bun
/**
 * kn-next CLI - Knative Next.js Deployment Automation
 *
 * Usage:
 *   npx kn-next deploy [options]
 *
 * Options:
 *   --registry <url>     Override container registry
 *   --bucket <name>      Override storage bucket
 *   --tag <tag>          Override image tag (default: timestamp)
 *   --namespace <ns>     Kubernetes namespace (default: default)
 *   --skip-build         Skip Next.js and OpenNext build
 *   --skip-upload        Skip asset upload to storage
 *   --skip-infra         Skip infrastructure deployment
 *   --dry-run            Generate manifests without deploying
 *   --help               Show help
 *
 * Environment Variables (for CI/CD):
 *   KN_REGISTRY          Container registry URL
 *   KN_BUCKET            Storage bucket name
 *   KN_IMAGE_TAG         Docker image tag
 *   KN_NAMESPACE         Kubernetes namespace
 *   KN_REDIS_URL         Redis connection URL (overrides config)
 *   KN_DATABASE_URL      Database connection URL (overrides config)
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
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

/**
 * Patches the OpenNext standalone output to fix known Next.js 16 trace omissions.
 *
 * Issue: Next.js 16's standalone trace can miss `next/dist/compiled/babel/code-frame.js`
 * (a 1-line redirect to `babel-code-frame/`), causing MODULE_NOT_FOUND at container startup.
 * This is especially common in pnpm monorepos where the trace doesn't follow all symlinks.
 *
 * Fix: Walk all `babel-code-frame` directories in the standalone output and create the
 * missing `babel/code-frame.js` redirect file if it doesn't exist.
 */
/**
 * Recursively find target files in a directory matching a predicate.
 */
function findFiles(
    dir: string,
    predicate: (name: string) => boolean,
): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findFiles(fullPath, predicate));
        } else if (predicate(entry.name)) {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Patch a collection of files using the provided patching logic.
 * The patchLogic function should return the patched content, or null if no changes.
 */
function patchFiles(
    files: string[],
    patchLogic: (content: string) => string | null,
): number {
    let patchedCount = 0;
    for (const filePath of files) {
        try {
            const content = readFileSync(filePath, "utf-8");
            const patchedContent = patchLogic(content);
            if (patchedContent !== null && patchedContent !== content) {
                writeFileSync(filePath, patchedContent);
                patchedCount++;
            }
        } catch {
            // Skip files that can't be read or parsed
        }
    }
    return patchedCount;
}

/**
 * Patch assetPrefix in OpenNext output.
 * OpenNext strips assetPrefix from required-server-files.json and server.js during build.
 * Next.js standalone server.js hardcodes the config at build time, so we must patch
 * both the JSON config files AND the server.js bundles to inject the CDN URL.
 */
function patchAssetPrefix(appDir: string, assetPrefix: string): number {
    const openNextDir = join(appDir, ".open-next");
    if (!existsSync(openNextDir)) return 0;

    let patched = 0;

    // 1. Patch required-server-files.json (runtime config)
    patched += patchFiles(
        findFiles(openNextDir, (name) => name === "required-server-files.json"),
        (content) => {
            const parsed = JSON.parse(content);
            if (parsed.config && parsed.config.assetPrefix !== assetPrefix) {
                parsed.config.assetPrefix = assetPrefix;
                return JSON.stringify(parsed);
            }
            return null;
        },
    );

    // 2. Patch server.js (hardcoded config in standalone bundle)
    // Next.js embeds the config as `"assetPrefix":""` in the minified server.js
    const emptyPrefix = '"assetPrefix":""';
    const patchedPrefix = `"assetPrefix":"${assetPrefix}"`;
    patched += patchFiles(
        findFiles(openNextDir, (name) => name === "server.js"),
        (content) =>
            content.includes(emptyPrefix)
                ? content.replace(emptyPrefix, patchedPrefix)
                : null,
    );

    // 3. Patch client-reference-manifest.js (rewrite chunk paths to absolute CDN URLs)
    //
    // Architecture: The manifest's clientModules.chunks arrays contain relative paths
    // like "/_next/static/chunks/...". These chunk paths flow to TWO consumers:
    //   a) SSR HTML <script> tags: `moduleLoading.prefix + chunk_path`
    //   b) RSC flight data I[moduleId, [chunks], ...]: chunk paths emitted AS-IS
    //
    // The client-side React Flight client has moduleLoading=null (Turbopack quirk),
    // so it uses chunk paths directly. Therefore chunk paths MUST be absolute CDN URLs.
    // With absolute chunk paths, moduleLoading.prefix MUST stay empty to avoid
    // double-prefixing in the HTML <script> tags.
    patched += patchFiles(
        findFiles(openNextDir, (name) =>
            name.endsWith("_client-reference-manifest.js"),
        ),
        (content) =>
            content.replaceAll(
                '"/_next/static/',
                `"${assetPrefix}/_next/static/`,
            ),
    );

    // 4. Patch Turbopack runtime chunk (dynamic chunk loading base path)
    // Turbopack's runtime has a hardcoded `let t="/_next/"` used as the base URL
    // for dynamically imported chunks. Initial <script> tags have explicit GCS URLs
    // in their src, but any chunks loaded AFTER page load (client components, lazy
    // imports, etc.) use this base path — causing silent 404s and hydration failure.
    const turbopackBase = 'let t="/_next/"';
    const turbopackPatchedBase = `let t="${assetPrefix}/_next/"`;
    patched += patchFiles(
        findFiles(
            openNextDir,
            (name) => name.includes("turbopack-") && name.endsWith(".js"),
        ),
        (content) =>
            content.includes(turbopackBase)
                ? content.replaceAll(turbopackBase, turbopackPatchedBase)
                : null,
    );

    // 5. Patch Turbopack SSR runtime (ASSET_PREFIX for RSC flight data)
    // The SSR Turbopack runtime has `const ASSET_PREFIX = "/_next/"` which is used
    // to construct client chunk URLs in RSC flight data (I[moduleId, [chunks], ...]).
    // Without this patch, RSC flight data contains relative /_next/ paths that the
    // client cannot resolve (404 from local server → silent hydration failure).
    const ssrAssetPrefix = 'const ASSET_PREFIX = "/_next/"';
    const ssrPatchedPrefix = `const ASSET_PREFIX = "${assetPrefix}/_next/"`;
    patched += patchFiles(
        findFiles(
            openNextDir,
            (name) =>
                name.includes("[turbopack]_runtime") && name.endsWith(".js"),
        ),
        (content) =>
            content.includes(ssrAssetPrefix)
                ? content.replaceAll(ssrAssetPrefix, ssrPatchedPrefix)
                : null,
    );

    return patched;
}

async function patchStandaloneOutput(appDir: string): Promise<void> {
    const serverFunctionsDir = join(
        appDir,
        ".open-next",
        "server-functions",
        "default",
    );

    if (!existsSync(serverFunctionsDir)) {
        console.info(
            "   ⚠️  No server-functions/default directory found, skipping patch",
        );
        return;
    }

    // Find all babel-code-frame directories and ensure sibling babel/code-frame.js exists
    const result =
        await $`find ${serverFunctionsDir} -path "*/next/dist/compiled/babel-code-frame" -type d`.text();
    const dirs = result.trim().split("\n").filter(Boolean);
    let patched = 0;

    for (const babelCodeFrameDir of dirs) {
        // The redirect file lives at ../babel/code-frame.js (sibling directory)
        const compiledDir = resolve(babelCodeFrameDir, "..");
        const redirectDir = join(compiledDir, "babel");
        const redirectFile = join(redirectDir, "code-frame.js");

        if (!existsSync(redirectFile)) {
            mkdirSync(redirectDir, { recursive: true });
            writeFileSync(
                redirectFile,
                "module.exports = require('next/dist/compiled/babel-code-frame');\n",
            );
            patched++;
        }
    }

    if (patched > 0) {
        console.info(
            `   🔧 Patched ${patched} missing babel/code-frame.js redirect(s)`,
        );
    }

    // Patch cache.cjs: OpenNext drops segmentData in APP_PAGE set().
    // The get() side already knows how to read it (Object<string, base64> → Map<string, Buffer>).
    // We just need to include it in the stored payload.
    const cacheFiles =
        await $`find ${serverFunctionsDir} -name "cache.cjs" -type f`.text();
    const cachePaths = cacheFiles.trim().split("\n").filter(Boolean);
    let cachePatched = 0;

    for (const cacheFile of cachePaths) {
        let content = readFileSync(cacheFile, "utf8");

        // Original: case"APP_PAGE":{let{html:s,rscData:l,headers:r,status:c}=t;
        //   await globalThis.incrementalCache.set(e,{type:"app",html:s,rsc:l.toString("utf8"),
        //   meta:{status:c,headers:r},revalidate:o},"cache");break}
        //
        // We need to also destructure segmentData from t and include it in the stored object.
        // segmentData is a Map<string, Buffer>, we serialize it as Object<string, base64-string>.
        const appPageSetPattern =
            /case"APP_PAGE":\{let\{html:(\w+),rscData:(\w+),headers:(\w+),status:(\w+)\}=(\w+);await globalThis\.incrementalCache\.set\((\w+),\{type:"app",html:\1,rsc:\2\.toString\("utf8"\),meta:\{status:\4,headers:\3\},revalidate:(\w+)\},"cache"\);break\}/;

        const match = content.match(appPageSetPattern);
        if (match) {
            const [fullMatch, html, rsc, headers, status, src, key, reval] =
                match;
            // Destructure segmentData alongside existing fields and serialize it
            const replacement = `case"APP_PAGE":{let{html:${html},rscData:${rsc},headers:${headers},status:${status},segmentData:__sd}=${src};let __sdObj;if(__sd instanceof Map){__sdObj={};for(let[__k,__v]of __sd)__sdObj[__k]=__v.toString("base64")}await globalThis.incrementalCache.set(${key},{type:"app",html:${html},rsc:${rsc}.toString("utf8"),meta:{status:${status},headers:${headers}},revalidate:${reval},segmentData:__sdObj},"cache");break}`;
            content = content.replace(fullMatch, replacement);
            writeFileSync(cacheFile, content);
            cachePatched++;
        }
    }

    if (cachePatched > 0) {
        console.info(
            `   🔧 Patched ${cachePatched} cache.cjs file(s) to preserve segmentData`,
        );
    }

    // Patch missing Turbopack instrumentation chunks
    // Next.js standalone tracing natively drops Turbopack chunks dynamically imported by instrumentation.js
    const srcChunksDir = join(appDir, ".next", "server", "chunks");
    if (existsSync(srcChunksDir)) {
        try {
            const destDirs =
                await $`find ${serverFunctionsDir} -type d -path "*/.next/server/chunks"`.text();
            const targetDirs = destDirs.trim().split("\n").filter(Boolean);

            for (const targetDir of targetDirs) {
                // Turbopack outputs dynamic node_modules chunks (e.g., @vercel_otel) that are completely
                // missed by the standalone NFT trace if they are lazy loaded from instrumentation.js
                await $`cp -n ${srcChunksDir}/*.js ${targetDir}/ 2>/dev/null || true`.quiet();
            }
            console.info(
                "   🔧 Synced missing Turbopack instrumentation chunks to standalone output",
            );
        } catch {}
    }
}

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
        console.info(`
kn-next deploy - Deploy Next.js to Knative

USAGE:
  npx kn-next deploy [options]

OPTIONS:
  -r, --registry <url>   Override container registry
  -b, --bucket <name>    Override storage bucket  
  -t, --tag <tag>        Image tag (default: timestamp)
  -n, --namespace <ns>   Kubernetes namespace (default: default)
  --skip-build           Skip Next.js/OpenNext build
  --skip-upload          Skip asset upload
  --skip-infra           Skip infrastructure deployment
  --dry-run              Generate manifests only

ENVIRONMENT VARIABLES:
  KN_REGISTRY            Container registry URL
  KN_BUCKET              Storage bucket name
  KN_IMAGE_TAG           Docker image tag
  KN_NAMESPACE           Kubernetes namespace
  KN_REDIS_URL           Redis connection URL
  KN_DATABASE_URL        Database connection URL

EXAMPLES:
  # Deploy with defaults from config
  npx kn-next deploy

  # Deploy to production with specific tag
  npx kn-next deploy --tag v1.2.3 --namespace production

  # CI/CD: Use environment variables
  KN_REGISTRY=gcr.io/prod KN_IMAGE_TAG=\${CI_COMMIT_SHA} npx kn-next deploy

  # Preview manifest without deploying
  npx kn-next deploy --dry-run
`);
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

    // Apply CLI/env overrides
    if (options.registry) {
        overridden.registry = options.registry;
    }
    if (options.bucket) {
        overridden.storage = { ...overridden.storage, bucket: options.bucket };
    }

    // Apply Redis URL override from environment
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

    console.info("🚀 kn-next deploy\n");

    if (options.dryRun) {
        console.info("⚠️  DRY RUN MODE - No actual deployment\n");
    }

    // 1. Load and merge config
    console.info("📋 Loading configuration...");
    const baseConfig = await loadConfig();
    const config = applyOverrides(baseConfig, options);

    console.info(`   App: ${config.name}`);
    console.info(
        `   Storage: ${config.storage.provider} (${config.storage.bucket})`,
    );
    console.info(`   Registry: ${config.registry}`);
    console.info(`   Namespace: ${options.namespace}`);
    if (options.skipBuild) console.info("   ⏭️  Skipping build");
    if (options.skipUpload) console.info("   ⏭️  Skipping upload");
    if (options.skipInfra) console.info("   ⏭️  Skipping infrastructure");
    console.info("");

    // 2. Build Next.js (unless skipped)
    if (!options.skipBuild) {
        // Inject ASSET_PREFIX so next.config.ts picks up the CDN URL at build time
        // Set via process.env so turbo inherits it (shell inline vars get stripped by turbo)
        const assetPrefix = getAssetPrefix(config.storage);
        process.env.ASSET_PREFIX = assetPrefix;
        console.info(`📦 Building Next.js (assetPrefix: ${assetPrefix})...`);
        await $`npm run build`.quiet();
        console.info("   ✅ Next.js build complete\n");

        // 3. Build OpenNext
        console.info("⚡ Building OpenNext...");
        await $`npx open-next build`;
        console.info("   ✅ OpenNext build complete");

        // 3b. Restore assetPrefix in OpenNext output
        // OpenNext strips assetPrefix from required-server-files.json during build.
        // We must patch it back so the server renders HTML with CDN-prefixed asset URLs.
        if (assetPrefix) {
            console.info("🔧 Patching assetPrefix in OpenNext output...");
            const patchedCount = patchAssetPrefix(process.cwd(), assetPrefix);
            if (patchedCount > 0) {
                console.info(
                    `   ✅ Patched assetPrefix in ${patchedCount} file(s)`,
                );
            }
        }

        // 4. Patch standalone output for known Next.js trace omissions
        console.info("🔧 Patching standalone output...");
        await patchStandaloneOutput(process.cwd());
        console.info("   ✅ Standalone output patched\n");
    }

    // 4. PARALLEL: Asset upload + Docker build/push
    const imageTag = options.tag || `${Date.now()}`;
    const imageName = `${config.registry}/${config.name}:${imageTag}`;

    console.info(`📌 Image: ${imageName}\n`);

    // Generate entrypoint.sh for bytecode cache PVC permissions fix
    if (config.bytecodeCache?.enabled) {
        const outputDir = join(
            process.cwd(),
            ".open-next",
            "server-functions",
            "default",
        );
        generateEntrypoint({ config, outputDir });
    }

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        // Asset upload (unless skipped)
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

        // Docker build + push
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

    // 5. Deploy infrastructure & observability (unless skipped)
    let infraEnvVars: Record<string, string> = {};
    const hasInfra = config.infrastructure || config.observability?.enabled;
    if (hasInfra && !options.skipInfra && !options.dryRun) {
        console.info("🏗️  Deploying infrastructure services...");
        const outputDir = join(process.cwd(), ".open-next");
        const { manifests, envVars } = generateInfrastructure(
            config,
            outputDir,
        );
        infraEnvVars = envVars;

        for (const manifest of manifests) {
            await $`kubectl apply -f ${manifest} -n ${options.namespace}`;
        }

        if (config.observability?.enabled) {
            console.info(
                "   📊 Observability: ServiceMonitor + Grafana dashboard deployed",
            );
        }
        console.info("   ✅ Infrastructure deployed\n");

        // Wait for services to be ready
        if (config.infrastructure?.postgres?.enabled) {
            console.info("   Waiting for PostgreSQL...");
            await $`kubectl wait --for=condition=ready pod -l app=${config.name}-postgres -n ${options.namespace} --timeout=120s`.quiet();
        }
        if (config.infrastructure?.redis?.enabled) {
            console.info("   Waiting for Redis...");
            await $`kubectl wait --for=condition=ready pod -l app=${config.name}-redis -n ${options.namespace} --timeout=60s`.quiet();
        }
        if (config.infrastructure?.minio?.enabled) {
            console.info("   Waiting for MinIO...");
            await $`kubectl wait --for=condition=ready pod -l app=${config.name}-minio -n ${options.namespace} --timeout=120s`.quiet();
        }
        console.info("   ✅ Infrastructure ready\n");
    }

    // Inject DATABASE_URL from environment if provided
    if (process.env.KN_DATABASE_URL) {
        infraEnvVars.DATABASE_URL = process.env.KN_DATABASE_URL;
    }

    // 6. Generate and deploy Knative manifest
    console.info("🌐 Generating Knative manifest...");
    const outputDir = join(process.cwd(), ".open-next");
    generateKnativeManifest({
        config,
        outputDir,
        imageTag,
        namespace: options.namespace,
        additionalEnvVars: infraEnvVars,
    });
    const manifestPath = join(outputDir, "knative-service.yaml");
    console.info(`   📄 Manifest: ${manifestPath}`);

    if (!options.dryRun) {
        console.info("   Applying to cluster...");
        await $`kubectl apply -f ${manifestPath} -n ${options.namespace}`;

        // Get service URL
        const result =
            await $`kubectl get ksvc ${config.name} -n ${options.namespace} -o jsonpath='{.status.url}'`.text();

        console.info("\n✨ Deployment complete!");
        console.info(`🔗 URL: ${result.replace(/'/g, "")}`);
    } else {
        console.info("\n✅ Dry run complete - manifest generated");
        console.info(`   View: cat ${manifestPath}`);
    }
}

// Run
deploy().catch((err) => {
    console.error("❌ Deployment failed:", err.message);
    process.exit(1);
});
