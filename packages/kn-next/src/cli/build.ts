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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { healBunExportTargets } from "../adapters/standalone-bun-exports";
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

    // 2b. Heal Bun-condition export targets in the standalone output (#188).
    //     `next build` traces under Node, so exports targets behind a "bun"
    //     condition (react-dom's `./server` → server.bun.js — shipped by the
    //     published package) are missing from .next/standalone while its exports
    //     map still points at them; Bun then fails the whole specifier and every
    //     pages-router SSR/API render 500s. The adapter's onBuildComplete hook
    //     fires BEFORE the standalone tree is emitted at next 16.2, so this
    //     post-build step is the one that reaches users (the Dockerfile COPYs
    //     this tree verbatim). UNCONDITIONAL by design (not gated on
    //     config.runtime): the heal is additive-only, version-checked, and never
    //     throws — on Node it costs a few small file copies and changes nothing
    //     at runtime — while the runtime is a deploy/serve-time knob (the same
    //     image may later be booted under Bun), so gating here would leave the
    //     latent 500 for exactly the users who flip runtimes after building.
    const standaloneDir = join(process.cwd(), ".next", "standalone");
    if (existsSync(standaloneDir)) {
        const healed = healBunExportTargets({
            projectDir: process.cwd(),
            standaloneDir,
            log: (message) => log.info(message),
        });
        log.info(
            { copied: healed.copied, skipped: healed.skipped.length },
            "Bun-condition export heal (standalone output)",
        );
    } else {
        log.warn(
            { standaloneDir },
            "No standalone output found — skipping bun-exports heal (is output:'standalone' set?)",
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
