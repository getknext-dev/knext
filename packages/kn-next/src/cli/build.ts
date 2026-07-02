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
import { precompileBunBytecode } from "../adapters/standalone-bun-bytecode";
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
    //     at runtime. Contrast with step 2c below: node→bun flips DO happen
    //     without a rebuild, and the heal keeps them safe for free — whereas
    //     the bytecode pass is the one build step that deliberately ENDS
    //     flippability (bun→node then needs a rebuild), which is why 2c is
    //     opt-in via config.runtime and guards the entry loudly.
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

    // 2c. Per-file Bun bytecode precompilation (runtime=bun only).
    //     Each server-side .js in the standalone tree is transformed
    //     individually (`--external '*'` keeps the require graph untouched)
    //     with a companion .jsc that Bun's runtime consumes on require() —
    //     measured -47% startup on a real next@16.2.4 standalone tree.
    //     GATED on config.runtime === "bun", the inverse of the heal's
    //     unconditionality: this pass ENDS runtime flippability (transformed
    //     files are Bun-only and do not load under Node), so it must be an
    //     explicit build-time commitment — and the pass injects a fail-fast
    //     guard into the untransformed entry server.js so `node server.js` on
    //     a bytecode-built image exits 1 with a FATAL message instead of
    //     CrashLooping silently. Flipping back to node requires a rebuild.
    //     Opt out with KNEXT_BUN_BYTECODE=0. Fail-open: per-file failures skip
    //     that file; a failed capability probe (Bun <1.1.30, no bun binary)
    //     disables the pass; never throws. Cost: one bun-build spawn per file
    //     (~12s for a ~970-file tree), paid on every runtime=bun build.
    if (
        (config.runtime ?? "node") === "bun" &&
        process.env.KNEXT_BUN_BYTECODE !== "0" &&
        existsSync(standaloneDir)
    ) {
        const pass = precompileBunBytecode({
            standaloneDir,
            log: (message) => log.debug(message),
        });
        if (pass.skipped.length > 0) {
            // full per-file reasons at debug so a noisy tree doesn't flood builds
            log.debug(
                { skipped: pass.skipped },
                "Bun bytecode per-file skip reasons",
            );
        }
        log.info(
            {
                compiled: pass.compiled,
                skipped: pass.skipped.length,
                guarded: pass.guarded.length,
                ...(pass.disabled ? { disabled: pass.disabled } : {}),
            },
            "Bun bytecode precompilation (standalone output)",
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
