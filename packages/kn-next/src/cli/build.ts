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
 * NOTE: the project's own `npm run build` produces the bundle (vinext's
 * `vite build` on the default target, `next build` + output:'standalone' on
 * the retired turbopack shape); for the vinext shape this command then
 * compiles the single executable (ADR-0048 — see step 2c).
 *
 * ADR-0001: build does NOT emit raw Knative/infrastructure manifests. The
 * operator is the single source of truth for cluster desired-state and
 * reconciles everything from the NextApp CR emitted by `deploy`.
 */

import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { healBunExportTargets } from "../adapters/standalone-bun-exports";
import {
    hasStorage,
    NO_STORAGE_MODE_NOTICE,
    uploadAssets,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import { resolveBuildArtifact, standaloneStepsApply } from "./build-artifact";
import { isEntrypoint } from "./exec";
import { runPostCompileSmoke } from "./postcompile-smoke";
import { runProjectBuild } from "./project-build";
import {
    handleConfigNotFound,
    handleUsageError,
    loadConfig,
    UsageError,
} from "./shared";
import {
    buildVinextExecutable,
    hostSmokeArch,
    smokeBinaryPlan,
} from "./vinext-build";

const log = createLogger({ module: "build" });

/**
 * The arch the IMAGE ships. `kn-next deploy` builds a linux/amd64 image whose
 * Dockerfile expects `knext-exec-linux-x64` in the build context.
 */
const SHIP_ARCH = "linux-x64";

interface BuildOptions {
    skipNextBuild?: boolean;
    /**
     * Skip the post-compile smoke (#894). EXPLICIT only — nothing infers it —
     * and loud when used, because what it turns off is the one check that the
     * artifact this build produced can actually serve, scrape, and drain.
     */
    skipSmoke?: boolean;
}

/**
 * Boot the freshly compiled binary and assert the three RuntimeContract
 * obligations, or fail the build naming the one that is missing.
 *
 * ## Which binary
 *
 * Not the one the image ships: that is `bun-linux-x64-musl`, which neither a
 * darwin host nor a glibc linux host can execute. The issue's two options were
 * a container run or a host-arch smoke build; this takes the host-arch build,
 * because a container run would put docker on the critical path of every
 * `kn-next build`, and because the cross-compiled musl artifact already has a
 * container gate of its own (`alpine-image.docker-e2e.test.ts`). When the host
 * IS the ship target, no second compile happens.
 *
 * ## What this therefore does NOT prove
 *
 * That the SHIPPED binary boots — only that the entry compiled from this
 * `.output` honours the contract on this machine's arch. The alpine e2e is what
 * covers the cross-target half, and it is a separate gate on purpose.
 */
async function smokeCompiledBinary(
    config: { healthCheckPath?: string },
    skipSmoke: boolean,
): Promise<void> {
    if (skipSmoke) {
        // LOUD, and it names what is now unverified rather than merely saying a
        // step was skipped — "a step was skipped" is ignorable in a build log.
        log.warn(
            "⚠️  POST-COMPILE SMOKE SKIPPED (--skip-smoke): the compiled executable was NOT booted, " +
                "so its health route, its metrics exposition, and its SIGTERM drain are UNVERIFIED. " +
                "A binary that cannot serve or drain will fail on the cluster instead of here.",
        );
        return;
    }

    const plan = smokeBinaryPlan(SHIP_ARCH, hostSmokeArch());
    if (!plan.reuseShipBinary) {
        log.info(
            { arch: plan.arch },
            "Compiling a host-arch binary for the post-compile smoke (the ship binary is linux-musl and cannot run here)...",
        );
        buildVinextExecutable({
            cwd: process.cwd(),
            arch: plan.arch,
            outFile: plan.outFile,
            skipViteBuild: true,
        });
    }

    log.info("Smoking the compiled executable (health, metrics, SIGTERM)...");
    const result = await runPostCompileSmoke({
        binaryPath: join(process.cwd(), plan.outFile),
        cwd: process.cwd(),
        healthPath: config.healthCheckPath,
    });
    log.info(
        {
            bootMs: result.bootMs,
            termMs: result.termMs,
            health: result.healthStatus,
            metrics: result.metricsStatus,
        },
        "Post-compile smoke passed",
    );
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
            { builder: config.build ?? "vinext" },
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
    //     at runtime.
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

    // 2c. Single-executable compile (the vinext shape — ADR-0048).
    //     Bytecode belongs to ONE builder: the vinext bundle is compiled
    //     whole (`bun build --compile --minify --bytecode`) into the binary
    //     the Dockerfile ships. The retired per-file bytecode pass that used
    //     to sit here transformed the standalone tree file-by-file — it bought
    //     cold start (554ms vs 703ms) but COST throughput (537 vs 714 req/s,
    //     the per-module CJS conversion taxing every module boundary), while
    //     the whole-bundle compile wins both axes at once (61ms, 1103 req/s).
    //     Keyed on the artifact SHAPE, not on config.runtime: the shape is
    //     what says "this app's server is one compiled binary".
    //     Compiles for linux-x64 regardless of the host — `kn-next deploy`
    //     builds a linux/amd64 image whose Dockerfile expects
    //     `knext-exec-linux-x64` in the build context.
    if (artifact.shape === "nitro-output-bun") {
        log.info(
            "Compiling the single executable (bun, bytecode, minified)...",
        );
        const binary = buildVinextExecutable({
            cwd: process.cwd(),
            arch: SHIP_ARCH,
            skipViteBuild: true, // step 2 (the project's own `vite build`) already produced .output
        });
        log.info({ binary }, "Single executable compiled");

        // 2d. Post-compile RuntimeContract smoke (#894).
        //     The compile bakes `.output/server/index.mjs` WHATEVER it contains,
        //     and the obligations the operator depends on — the health route it
        //     probes, the :9091 exposition the PodMonitor scrapes, the SIGTERM
        //     drain — live in the app's own entry. So an app that swapped or
        //     broke that entry compiles, deploys, and never goes Ready. This
        //     boots the binary and checks all three HERE, before the assets are
        //     uploaded and long before a cluster sees it.
        await smokeCompiledBinary(config, options.skipSmoke === true);
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

export const BUILD_HELP = `kn-next build — run the build + asset-upload steps, without deploying

Usage:
  kn-next build [--skip-next] [--skip-smoke]

Runs the project's build script (\`next build\`, output:'standalone'), heals the
standalone output, and uploads static assets to the configured bucket. It makes
NO cluster writes — \`kn-next deploy\` is what hands the app to the operator.

Options:
  --skip-next           Reuse an existing .next/ build instead of running it again
  --skip-smoke          Do NOT boot the compiled executable to check its health
                        route, metrics port, and SIGTERM drain. For CI that
                        cannot execute the binary (a foreign-arch runner). The
                        artifact ships UNVERIFIED and the build says so loudly.
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
    const KNOWN = new Set(["--skip-next", "--skip-smoke"]);
    for (const a of argv) {
        if (!KNOWN.has(a)) {
            throw new UsageError(
                a.startsWith("-")
                    ? `unknown flag "${a}" (see kn-next build --help)`
                    : `unexpected positional ${JSON.stringify(a)} — build takes no arguments (see kn-next build --help)`,
            );
        }
    }
    await build({
        skipNextBuild: argv.includes("--skip-next"),
        skipSmoke: argv.includes("--skip-smoke"),
    });
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
