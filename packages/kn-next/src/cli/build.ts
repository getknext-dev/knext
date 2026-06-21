#!/usr/bin/env node

/**
 * kn-next build — Prepares Next.js app for Knative deployment.
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts (with validation)
 *   2. Run `next build` (output:'standalone' set in the app's next.config.ts)
 *   3. Upload static assets to storage (GCS/S3/MinIO)
 *
 * NOTE: The Vinext/Nitro build orchestration was removed in the official
 * Next.js Adapter migration. The CLI now delegates to the project's
 * `npm run build` script which runs `next build` with output:'standalone'.
 *
 * ADR-0001: build does NOT emit raw Knative/infrastructure manifests. The
 * operator is the single source of truth for cluster desired-state and
 * reconciles everything from the NextApp CR emitted by `deploy`.
 */

import { uploadAssets } from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { isEntrypoint, runQuiet } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "build" });

interface BuildOptions {
    skipNextBuild?: boolean;
}

export async function build(options: BuildOptions = {}) {
    log.info("🔨 kn-next build (Next.js official adapter + standalone)");

    // 1. Load config (validates at load time)
    log.info("Loading configuration...");
    const config = await loadConfig();
    log.info(
        {
            app: config.name,
            storage: `${config.storage.provider} (${config.storage.bucket})`,
            cache: config.cache?.provider ?? "none",
            runtime: config.runtime ?? "node",
        },
        "Configuration loaded",
    );

    // 2. Run `next build` via the project's build script.
    //    The app's next.config.ts must set output:'standalone'.
    if (!options.skipNextBuild) {
        log.info("Running next build (output:standalone)...");
        runQuiet(["npm", "run", "build"]);
        log.info(
            "Next.js build complete — standalone output in .next/standalone/",
        );
    }

    // 3. Upload static assets
    log.info("Uploading static assets...");
    await uploadAssets(config);
    log.info("Assets uploaded");

    log.info(
        "✨ Build complete! Run `kn-next deploy` to push the image and apply the NextApp CR.",
    );
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
// Node-correct replacement for Bun's `import.meta.main`.
if (isEntrypoint(import.meta.url)) {
    try {
        await build({
            skipNextBuild: process.argv.includes("--skip-next"),
        });
    } catch (err) {
        log.fatal({ err }, "Build failed");
        process.exit(1);
    }
}
