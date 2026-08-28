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

import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { precompileBunBytecode } from "../adapters/standalone-bun-bytecode";
import { healBunExportTargets } from "../adapters/standalone-bun-exports";
import {
    hasStorage,
    NO_STORAGE_MODE_NOTICE,
    uploadAssets,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { resolveBuildArtifact, standaloneStepsApply } from "./build-artifact";
import { isEntrypoint } from "./exec";
import { runProjectBuild } from "./project-build";
import {
    handleConfigNotFound,
    handleUsageError,
    loadConfig,
    UsageError,
} from "./shared";

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
            storage: config.storage
                ? `${config.storage.provider} (${config.storage.bucket})`
                : "none — assets served from the image",
            cache: config.cache?.provider ?? "none",
            runtime: config.runtime ?? "node",
        },
        "Configuration loaded",
    );

    if (!hasStorage(config)) {
        // ADR-0047 (review F3): the mode's guarantee is relative asset paths —
        // an ASSET_PREFIX inherited from the shell would bake bucket URLs into
        // HTML that nothing uploads, so clear it BEFORE `next build` reads it.
        // (The mode notice itself prints at the upload step below.)
        delete process.env.ASSET_PREFIX;
    }

    // 2. Run `next build` via the project's build script.
    //    The app's next.config.ts must set output:'standalone'.
    if (!options.skipNextBuild) {
        log.info(
            { builder: config.build ?? "turbopack" },
            "Running the project build...",
        );
        // UX ledger row 4 (4c): the seam translates a deps-not-installed failure
        // (`next: command not found`, exit 127) into plain npm-install guidance.
        runProjectBuild();
        log.info("Project build complete");
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
    // Which artifact should this app have produced? Asked of the contract, not
    // assumed — see build-artifact.ts. `kn-next build` runs the app's OWN
    // `npm run build`, so a vinext-configured app already builds with vinext;
    // what knext needs to know is where to look afterwards and which post-build
    // steps still mean anything.
    const { builder, artifact } = resolveBuildArtifact(config, process.cwd());
    const artifactPath = join(artifact.root, artifact.entry);
    if (!options.skipNextBuild && !existsSync(artifactPath)) {
        // Loud, and BEFORE the upload/image steps. #857 is the precedent: a
        // build that exits 0 while emitting a server nothing can find is
        // discovered at `docker run` on a cluster otherwise.
        log.warn(
            { builder: builder.id, expected: artifactPath },
            `The ${builder.id} build finished but '${artifact.entry}' is not there — the image would start a server that does not exist.`,
        );
    }

    const standaloneDir = join(process.cwd(), ".next", "standalone");
    // Keyed on the artifact SHAPE, not on the directory existing. The old
    // `existsSync` check warned "is output:'standalone' set?" for ANY build
    // without that tree — advice that names a Next.js option a vinext user
    // does not have and cannot act on.
    if (!standaloneStepsApply(artifact)) {
        log.info(
            { builder: builder.id, shape: artifact.shape },
            "Skipping the standalone-tree post-build steps — they do not apply to this artifact shape",
        );
    } else if (existsSync(standaloneDir)) {
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
        // Shape-gated as well as runtime-gated: the pass rewrites files in a
        // `.next/standalone` tree. `runtime: bun` is legal with any builder, so
        // without this it would silently no-op on a nitro artifact via the
        // existsSync below and look like it had run.
        standaloneStepsApply(artifact) &&
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

    // 3. Upload static assets — only when a storage block is configured.
    if (hasStorage(config)) {
        log.info("Uploading static assets...");
        await uploadAssets(config);
        log.info("Assets uploaded");
    } else {
        // ADR-0047 condition 1: an announced no-op, never a silent skip.
        log.info(NO_STORAGE_MODE_NOTICE);
    }

    log.info(
        "✨ Build complete! Run `kn-next deploy` to push the image and apply the NextApp CR.",
    );
}

const BUILD_HELP = `kn-next build — run the build + asset-upload steps, without deploying

Usage:
  kn-next build [--skip-next]

Runs the project's build script (\`next build\`, output:'standalone'), heals the
standalone output, and uploads static assets to the configured bucket. It makes
NO cluster writes — \`kn-next deploy\` is what hands the app to the operator.

Options:
  --skip-next           Reuse an existing .next/ build instead of running it again
  -h, --help            Show this help
`;

/**
 * argv entry for `kn-next build`.
 *
 * Parses its OWN argv — that is the whole point. The first version of the
 * dispatch branch called `build()` directly, so `--help` (and every other flag)
 * was ignored and a user asking for help got a full build + asset upload.
 * Unknown flags are a hard error, matching the promise the docs make for every
 * subcommand and the behaviour of `gc` / `db bind` / `rollback`.
 */
export async function buildMain(argv: readonly string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        // fs.writeSync(1, …) — guaranteed flushed before exit, unlike the async
        // pino transport (same contract as the other subcommand helps, #68).
        writeSync(1, BUILD_HELP);
        return 0;
    }
    for (const a of argv) {
        if (a !== "--skip-next") {
            throw new UsageError(
                a.startsWith("-")
                    ? `unknown flag "${a}" (see kn-next build --help)`
                    : `unexpected positional ${JSON.stringify(a)} — build takes no arguments (see kn-next build --help)`,
            );
        }
    }
    await build({ skipNextBuild: argv.includes("--skip-next") });
    return 0;
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
// SANCTIONED self-entry (#263): this is a DOCUMENTED directly-runnable entry
// (docs-site cli.mdx "Directly runnable entries") with its own tsup entry, so
// it is never inlined into the bin. See the hazard note atop deploy.ts's
// dispatcher before adding self-entry blocks anywhere else.
// Node-correct replacement for Bun's `import.meta.main`.
// Routed through buildMain so the direct entry honours --help too.
if (isEntrypoint(import.meta.url)) {
    try {
        process.exit(await buildMain(process.argv.slice(2)));
    } catch (err) {
        // Expected state, not a crash — see the note in deploy.ts's dispatcher.
        if (handleConfigNotFound(err)) {
            process.exit(1);
        }
        // Same for a usage mistake — a typo renders as a message, not a
        // serialised Error (see the note in deploy.ts's dispatcher).
        if (handleUsageError(err)) {
            process.exit(1);
        }
        log.fatal({ err }, "Build failed");
        process.exit(1);
    }
}
