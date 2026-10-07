#!/usr/bin/env node

/**
 * knext build — Prepares Next.js app for Knative deployment.
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/build.ts
 *
 * Steps:
 *   1. Load knext.config.ts (with validation)
 *   2. Run `next build` (output:'standalone' set in the app's next.config.ts)
 *   3. Upload static assets to storage (GCS/S3/MinIO)
 *
 * NOTE: the project's own `npm run build` produces the bundle (`next build`
 * + output:'standalone' on the default turbopack/standalone target since
 * #1183 (ADR-0058); vinext's `vite build` on the selectable `build: 'vinext'`
 * target — ADR-0054 item 6); for the vinext shape this command then compiles
 * the single executable (ADR-0048 — see step 2c). Since the project owns that
 * script, selecting `build: 'turbopack'` (or leaving it absent) on an app
 * whose script still runs `vite build` produces no `.next/standalone` — that
 * is a hard, fail-fast error below rather than a warning, for the
 * next-standalone shape only (#1184).
 *
 * ADR-0001: build does NOT emit raw Knative/infrastructure manifests. The
 * operator is the single source of truth for cluster desired-state and
 * reconciles everything from the NextApp CR emitted by `deploy`.
 */

import { existsSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_BUILDER_ID,
    DEFAULT_RUNTIME_ID,
} from "../adapters/artifact-contract";
import {
    hasStorage,
    NO_STORAGE_MODE_NOTICE,
    uploadAssets,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import {
    compileArtifactForDeploy,
    resolveBuildArtifact,
    resolveSelfContained,
    standaloneStepsApply,
} from "./build-artifact";
import { resolveCompileToolchain } from "./bun-toolchain";
import { type CompileToolchain, compileIncludeGlobs } from "./compile-config";
import { isEntrypoint } from "./exec";
import { runPostCompileSmoke } from "./postcompile-smoke";
import { runProjectBuild } from "./project-build";
import {
    selectRuntimeImage,
    stageStandaloneBuildContext,
    stageVinextNodeDockerfile,
} from "./runtime-image";
import {
    handleConfigNotFound,
    handleUsageError,
    loadConfig,
    UsageError,
} from "./shared";
import { diagnoseNestedStandalone } from "./standalone-layout";
import { requireBuildContext } from "./tracing-root";
import {
    buildVinextExecutable,
    hostSmokeArch,
    smokeBinaryPlan,
} from "./vinext-build";
import { assertNodePresetOutput } from "./vinext-node-build";

const log = createLogger({ module: "build" });

/**
 * The arch the IMAGE ships. `knext deploy` builds a linux/amd64 image whose
 * Dockerfile expects `knext-exec-linux-x64` in the build context.
 */
const SHIP_ARCH = "linux-x64";

/**
 * #1814 — where the post-compile smoke's host-arch TWIN stages its own sharp
 * native pair, a cwd-nested sibling of the ship's `native/` (never that
 * directory itself — see `smokeCompiledBinary`'s doc comment for why).
 * Leading-dot: not a Dockerfile `COPY` source, not matched by `.gitignore`'s
 * `native` entry, and cleaned up in the same `finally` as the smoke binary.
 */
export const SMOKE_NATIVE_DIR_NAME = ".knext-smoke-native";

/**
 * The exact `.node` file a sharp-native stage wrote under `nativeDir`, or
 * `undefined` if the app has no sharp (staged dir exists but holds nothing —
 * `stageSharpNative`'s own no-op-for-no-sharp contract). Scans rather than
 * assumes the platform id, so it matches whatever `stageSharpNative` ACTUALLY
 * staged for the arch it was given — the SAME discipline the dlopen shim
 * itself uses at runtime (`sharp-addon-dlopen.mjs`'s `addonPath()`), not a
 * second, independently-typed guess at the directory name.
 */
export function findStagedSharpAddon(nativeDir: string): string | undefined {
    if (!existsSync(nativeDir)) return undefined;
    for (const entry of readdirSync(nativeDir)) {
        if (!entry.startsWith("sharp-") || entry.startsWith("sharp-libvips-")) {
            continue;
        }
        const libDir = join(nativeDir, entry, "lib");
        if (!existsSync(libDir)) continue;
        for (const file of readdirSync(libDir)) {
            if (file.startsWith("sharp-") && file.endsWith(".node")) {
                return join(libDir, file);
            }
        }
    }
    return undefined;
}

interface BuildOptions {
    skipNextBuild?: boolean;
    /**
     * Skip the post-compile smoke (#894). EXPLICIT only — nothing infers it —
     * and loud when used, because what it turns off is the one check that the
     * artifact this build produced can actually serve, scrape, and drain.
     */
    skipSmoke?: boolean;
    /**
     * `--self-contained`: opt in to the self-contained single-executable mode.
     * Overrides the `selfContained` config key. Honoured by both compile paths:
     * the standalone/node target since #1456 (embeds `.next/server`,
     * $bunfs-anchored, proven by apps/file-manager/self-contained-e2e.test.ts
     * on both webpack and turbopack builds), and the vinext/bun-exec target
     * since #1460 (embeds the server runtime and `public/`). Routed to each
     * compile path and recorded in the build log either way, so the flag is
     * never silently swallowed.
     *
     * @experimental may change in a minor release.
     */
    selfContained?: boolean;
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
 * `knext build`, and because the cross-compiled musl artifact already has a
 * container gate of its own (`alpine-image.docker-e2e.test.ts`). When the host
 * IS the ship target, no second compile happens.
 *
 * ## What this therefore does NOT prove
 *
 * That the SHIPPED binary boots — only that the entry compiled from this
 * `.output` honours the contract on this machine's arch. The alpine e2e is what
 * covers the cross-target half, and it is a separate gate on purpose.
 *
 * ## The host-arch twin's own sharp staging (#1814)
 *
 * An app depending on `sharp` needs its native addon staged for WHICHEVER
 * binary is about to boot — the twin's dlopen shim calls `process.dlopen` at
 * the top level of sharp's module slot outside `--self-contained` mode, so a
 * route graph that merely includes the image-optimizer route evaluates it at
 * boot, not lazily on request. The twin is staged into `SMOKE_NATIVE_DIR_NAME`
 * (a `cwd`-nested sibling of the ship's `native/`), never into `native/`
 * itself: `stageSharpNative` clears its destination before writing, so
 * staging the twin's arch into the SAME directory the ship build already
 * staged silently replaces the ship's pair with the twin's — measured on a
 * live glibc CI runner, where the shipped alpine image then failed to dlopen
 * a glibc `.node` it should never have carried. `KNEXT_SHARP_ADDON` points the
 * twin's own dlopen shim at its isolated file; both the dir and the env var
 * are scoped to this smoke run and cleaned up in the `finally` below.
 */
async function smokeCompiledBinary(
    config: { healthCheckPath?: string },
    skipSmoke: boolean,
    selfContained: boolean,
    include: readonly string[] = [],
    toolchain: CompileToolchain = {},
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
    // #1814 — a cwd-nested sibling of the ship's `native/`, never that
    // directory itself. See this function's doc comment: staging the twin's
    // arch into the SAME dir the ship build staged clobbers it.
    const smokeNativeDir = join(process.cwd(), SMOKE_NATIVE_DIR_NAME);
    const binaryPath = join(process.cwd(), plan.outFile);
    try {
        let smokeSharpAddon: string | undefined;
        if (!plan.reuseShipBinary) {
            log.info(
                { arch: plan.arch },
                "Compiling a host-arch binary for the post-compile smoke (the ship binary is linux-musl and cannot run here)...",
            );
            // #1814 round 4 — INSIDE the try: a throw here (a bad compile, a
            // failed sharp-addon fetch) must still hit the `finally` below, or
            // a FAILING build leaves `smokeNativeDir` behind — exactly the
            // retry-blocks-itself shape `stageSharpNative`'s own ownership
            // refusal exists to catch for `native/`, reintroduced here for its
            // cwd-nested sibling if this call sat outside the try.
            buildVinextExecutable({
                cwd: process.cwd(),
                arch: plan.arch,
                outFile: plan.outFile,
                skipViteBuild: true,
                nativeDir: SMOKE_NATIVE_DIR_NAME,
                // The smoke must boot a binary built with the SAME mode as the
                // shipped one, or it misses the one property the mode changes.
                ...(selfContained ? { selfContained: true } : {}),
                // ...and with the same embedded `compile.include` modules,
                // compiled by the same toolchain.
                ...(include.length > 0 ? { include } : {}),
                ...(toolchain.bin ? { compilerBin: toolchain.bin } : {}),
            });
            // Self-contained mode embeds the staged tree at compile time and
            // extracts it lazily at runtime — it never consults
            // KNEXT_SHARP_ADDON, so finding a file for it here would be inert,
            // not merely harmless.
            if (!selfContained) {
                smokeSharpAddon = findStagedSharpAddon(smokeNativeDir);
            }
        }

        log.info(
            "Smoking the compiled executable (health, metrics, SIGTERM)...",
        );
        const result = await runPostCompileSmoke({
            binaryPath,
            cwd: process.cwd(),
            healthPath: config.healthCheckPath,
            ...(smokeSharpAddon
                ? { env: { KNEXT_SHARP_ADDON: smokeSharpAddon } }
                : {}),
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
    } finally {
        // The smoke binary is ~60-90 MB of build scratch that nothing ships and
        // no ignore list covers — neither `.gitignore`'s `knext-exec*` nor the
        // template `.dockerignore`. Leaving it in the app root is how a blob
        // gets staged and wedges someone's `git add -A`, and the docker context
        // grows by that much on every build. `finally`, so a FAILING smoke — the
        // case where a developer runs the build repeatedly — cleans up too.
        if (!plan.reuseShipBinary) {
            rmSync(binaryPath, { force: true });
            // The smoke-only native tree (#1814) — same reasoning, same
            // lifecycle: it exists only for this run's boot check.
            rmSync(smokeNativeDir, { recursive: true, force: true });
        }
    }
}

/**
 * Stage the standalone docker build context (Dockerfile.standalone + entry
 * shims) and tell the user where it is and how to build it. Reuses
 * `stageStandaloneBuildContext` exactly as `deploy` does — no second copy.
 */
function stageImageContext(config: Parameters<typeof selectRuntimeImage>[0]) {
    const selection = selectRuntimeImage(config, process.cwd());
    if (selection.kind !== "standalone") return;
    let buildContext: string;
    try {
        buildContext = requireBuildContext(process.cwd());
    } catch (err) {
        log.warn(
            { reason: err instanceof Error ? err.message.split("\n")[0] : err },
            "Not staging the docker build context (no lockfile to anchor it); `knext deploy` will require one",
        );
        return;
    }
    // A staging failure FAILS the build (not a warning): a user building the
    // image on a remote builder relies on this context, and a silently
    // missing/half-written one surfaces later as an opaque COPY error there.
    let dockerfile: string;
    try {
        ({ dockerfile } = stageStandaloneBuildContext({
            cwd: process.cwd(),
            buildContext,
        }));
    } catch (err) {
        throw new Error(
            `Could not stage the docker build context: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    log.info(
        {
            buildContext,
            dockerfile,
            // Template: substitute your registry/image ref; --push publishes it.
            command: `docker buildx build --platform linux/amd64 --target ${selection.target} -f ${dockerfile} -t <image-ref> --push ${buildContext}`,
        },
        "Staged the docker build context — build the image on your own builder from it (replace <image-ref>)",
    );
}

export async function build(options: BuildOptions = {}) {
    log.info("🔨 knext build (Next.js official adapter + standalone)");

    // 1. Load config (validates at load time)
    log.info("Loading configuration...");
    const config = await loadConfig({ phase: "build" });
    log.info(
        {
            app: config.name,
            storage: config.storage
                ? `${config.storage.provider} (${config.storage.bucket})`
                : "none — assets served from the image",
            cache: config.cache?.provider ?? "none",
            runtime: config.runtime ?? DEFAULT_RUNTIME_ID,
            selfContained: resolveSelfContained(config, options.selfContained),
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
            { builder: config.build ?? DEFAULT_BUILDER_ID },
            "Running the project build...",
        );
        // UX ledger row 4 (4c): the seam translates a deps-not-installed failure
        // (`next: command not found`, exit 127) into plain npm-install guidance.
        // requireEsm gates the vinext ESM preflight: only the vinext target
        // needs `"type":"module"`; a node app builds CommonJS fine. Resolved
        // against DEFAULT_BUILDER_ID, not hardcoded — an absent `build` no
        // longer means vinext (#1183).
        runProjectBuild({
            requireEsm: (config.build ?? DEFAULT_BUILDER_ID) === "vinext",
            builderId: config.build ?? DEFAULT_BUILDER_ID,
            runtimeId: config.runtime ?? DEFAULT_RUNTIME_ID,
        });
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
    // assumed — see build-artifact.ts. `knext build` runs the app's OWN
    // `npm run build`, so a vinext-configured app already builds with vinext;
    // what knext needs to know is where to look afterwards and which post-build
    // steps still mean anything.
    const { builder, artifact } = resolveBuildArtifact(config, process.cwd());
    const artifactPath = join(artifact.root, artifact.entry);
    if (!options.skipNextBuild && !existsSync(artifactPath)) {
        // #857 is the precedent for catching this here, BEFORE the
        // upload/image steps, rather than letting it surface at `docker run`
        // on a cluster.
        if (standaloneStepsApply(artifact)) {
            // HARD fail-fast (#1184), next-standalone shape ONLY: a
            // `build: 'turbopack'` app whose own build script still runs
            // something other than `next build` (e.g. a `knext create`
            // app's default `vite build`) emits no `.next/standalone` at all,
            // and used to only `log.warn` here — the first HARD failure was an
            // opaque `COPY .next/standalone` error inside `docker buildx` at
            // deploy time. UsageError (not a bare warn): this is a config
            // mistake the user can act on immediately, same family as
            // `resolveBuildArtifact`'s unknown-builder throw above.
            // The commonest cause is not a missing `output: 'standalone'` but a
            // parent lockfile that moved Next's workspace root, nesting the
            // server one directory down. Say so, rather than blame a setting
            // that is correctly set.
            const nested = diagnoseNestedStandalone(process.cwd());
            if (nested !== null) {
                throw new UsageError(
                    `The ${builder.id} build finished but '${artifact.entry}' is not there.\n\n${nested}`,
                );
            }
            throw new UsageError(
                `The ${builder.id} build finished but '${artifact.entry}' is not there — the image ` +
                    "would start a server that does not exist. `build: 'turbopack'` requires this " +
                    "app's build script to run `next build` with `output: 'standalone'` set in " +
                    "next.config — check both before deploying.",
            );
        }
        // Any other shape (e.g. vinext/nitro): still loud, but not fail-fast
        // yet — #1184 scopes the hard failure to the next-standalone shape.
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
    }

    // 2b/2b'/2c: heal + compile, via the SAME shared step `knext deploy`/
    // `preview` now call (#1339 review finding #1, build-artifact.ts) — this
    // is the one place that logic lives; build.ts only adds its own logging
    // around the returned result.
    //
    //   - Heal (#188): bun-condition export targets in `.next/standalone`.
    //     UNCONDITIONAL on the shape (not gated on `config.runtime`) — it is
    //     additive-only, version-checked, and never throws.
    //   - Standalone-on-Bun compile (turbopack × bun): bytecode caching is
    //     mandatory for every runtime cell; on Bun that means the standalone
    //     server ships as a `bun build --compile --bytecode` executable, which
    //     the bun image runs in place of `bun server.js`. Resolved against
    //     DEFAULT_RUNTIME_ID ("bun", #1183) — an unset runtime means bun too,
    //     the actual ADR-0054 default cell. `buildStandaloneExecutable` itself
    //     throws when there is no tree to compile (no separate check needed).
    //   - vinext single-executable compile (ADR-0048): the vinext bundle
    //     compiled whole (`bun build --compile --minify --bytecode`) into the
    //     binary the Dockerfile ships. `skipViteBuild: true` inside the shared
    //     step — step 2 above (the project's own `vite build`) already
    //     produced `.output`.
    // The opt-in patched Bun toolchain (`compile.bun: 'knext-patched'`):
    // downloaded and sha256-verified here, BEFORE any compile, failing the
    // build closed on any mismatch. The default config resolves to `{}`.
    const toolchain = await resolveCompileToolchain(config);
    if (toolchain.bin) {
        log.info(
            { bun: toolchain.bin },
            "Compile step uses the knext-patched Bun toolchain (sha256 verified)",
        );
    }
    const compileResult = compileArtifactForDeploy(config, process.cwd(), {
        arch: SHIP_ARCH,
        selfContained: options.selfContained,
        ...(toolchain.bin ? { toolchain } : {}),
    });

    if (standaloneStepsApply(artifact)) {
        if (compileResult.healed) {
            log.info(
                {
                    copied: compileResult.healed.copied,
                    skipped: compileResult.healed.skipped.length,
                },
                "Bun-condition export heal (standalone output)",
            );
        } else {
            log.warn(
                { standaloneDir },
                "No standalone output found — skipping bun-exports heal (is output:'standalone' set?)",
            );
        }
        if (compileResult.compiled) {
            log.info(
                { binary: compileResult.binaryPath },
                "Standalone executable compiled (bytecode verified)",
            );
        }
    }

    // 2c. Single-executable compile (the vinext shape — ADR-0048). The
    //     retired per-file bytecode pass that used to sit here transformed the
    //     standalone tree file-by-file — it bought cold start (554ms vs
    //     703ms) but COST throughput (537 vs 714 req/s, the per-module CJS
    //     conversion taxing every module boundary), while the whole-bundle
    //     compile wins both axes at once (61ms, 1103 req/s). Compiles for
    //     linux-x64 regardless of the host — `knext deploy` builds a
    //     linux/amd64 image whose Dockerfile expects `knext-exec-linux-x64`
    //     in the build context.
    if (artifact.shape === "nitro-output-bun") {
        log.info(
            { binary: compileResult.binaryPath },
            "Single executable compiled",
        );

        // 2d. Post-compile RuntimeContract smoke (#894).
        //     The compile bakes `.output/server/index.mjs` WHATEVER it contains,
        //     and the obligations the operator depends on — the health route it
        //     probes, the :9091 exposition the PodMonitor scrapes, the SIGTERM
        //     drain — live in the app's own entry. So an app that swapped or
        //     broke that entry compiles, deploys, and never goes Ready. This
        //     boots the binary and checks all three HERE, before the assets are
        //     uploaded and long before a cluster sees it.
        await smokeCompiledBinary(
            config,
            options.skipSmoke === true,
            resolveSelfContained(config, options.selfContained),
            compileIncludeGlobs(config),
            toolchain,
        );
    }

    // 2c'. vinext × node (#1260). Nothing to compile: node runs `.output`
    //      directly, and this cell's bytecode caching is the V8 compile cache
    //      the IMAGE bakes (ADR-0035, `Dockerfile.vinext-node`). What the build
    //      owes it is proof that `.output` is really the node preset — an older
    //      scaffold's vite.config hardcodes the bun one, which exits 1 under
    //      node — and the image recipe in the build context. BEFORE the upload,
    //      so a wrong preset ships nothing.
    if (artifact.shape === "nitro-output-node") {
        assertNodePresetOutput(process.cwd());
        const { dockerfile, staged } = stageVinextNodeDockerfile({
            cwd: process.cwd(),
        });
        log.info(
            { dockerfile, staged },
            staged
                ? "Staged the vinext-node image recipe (bakes the V8 compile cache at docker build)"
                : "Using the app's existing vinext-node image recipe",
        );
        // #1298: nitro's own trace into `.output/server/node_modules` copies
        // the BUILD HOST's sharp addon (wrong platform for the alpine/musl
        // image). `compileArtifactForDeploy` above already replaced it with
        // the image-platform package (and staged next/og's HarfBuzz binary),
        // shared with deploy/preview; only the logging is here.
        const sharpStaged = compileResult.vinextNode?.sharpStaged ?? false;
        if (sharpStaged) {
            log.info(
                "Staged sharp's linuxmusl-x64 package into the vinext-node image's .output/server/node_modules",
            );
        }
        const og = compileResult.vinextNode?.og ?? { staged: [], warnings: [] };
        if (og.staged.length > 0) {
            log.info(
                { staged: og.staged },
                "Staged HarfBuzz's hb.wasm for next/og into .output/server",
            );
        }
        for (const warning of og.warnings) log.warn(warning);
    }

    // 2e. Stage the standalone docker build context — the SAME function
    //     `knext deploy`/`preview` call right before their local docker build —
    //     so the image can be built on any builder (Cloud Build, CI) from the
    //     directory printed below. Standalone targets only: vinext uses its own
    //     scaffolded Dockerfile (app-dockerfile), which deploy does not stage
    //     either. Soft when no lockfile fixes a build context: `build` has
    //     never required one, and `deploy` still does.
    stageImageContext(config);

    // 3. Upload static assets — only when a storage block is configured.
    if (hasStorage(config)) {
        log.info("Uploading static assets...");
        // NO build id, deliberately (#892). `knext build` exports no
        // NEXT_DEPLOYMENT_ID and creates no revision, so there is nothing for
        // the operator to stamp `apps.kn-next.dev/build-id` on and nothing the
        // asset GC could ever resolve as live. Passing an id here — or letting
        // the staging code discover one from the tree — would write a
        // `.knext-build` marker keyed on a value no revision label can carry,
        // making the prefix a prune CANDIDATE that is permanently
        // unprotectable: the over-delete direction ADR-0011 forbids. Absent an
        // id the upload is unmarked and therefore over-kept forever, which is
        // the safe direction. `uploadAssets` warns about it on every run.
        await uploadAssets(config);
        log.info("Assets uploaded");
    } else {
        // ADR-0047 condition 1: an announced no-op, never a silent skip.
        log.info(NO_STORAGE_MODE_NOTICE);
    }

    log.info(
        "✨ Build complete! Run `knext deploy` to push the image and apply the NextApp CR.",
    );
}

export const BUILD_HELP = `knext build — run the build + asset-upload steps, without deploying

Usage:
  knext build [--skip-next] [--skip-smoke] [--self-contained]

Runs the project's build script (\`next build\`, output:'standalone'), heals the
standalone output, and uploads static assets to the configured bucket. It makes
NO cluster writes — \`knext deploy\` is what hands the app to the operator.

Options:
  --skip-next           Reuse an existing .next/ build instead of running it again
  --skip-smoke          Do NOT boot the compiled executable to check its health
                        route, metrics port, and SIGTERM drain. For CI that
                        cannot execute the binary (a foreign-arch runner). The
                        artifact ships UNVERIFIED and the build says so loudly.
  --verbose             Print every compile/closure note instead of a one-line
                        count. Real warnings and errors always print.
  --self-contained      Opt in to the self-contained single-executable mode
                        (overrides \`selfContained\` in knext.config.ts).
                        Experimental. Honoured by the standalone/node build
                        target (embeds the Next build output into the
                        executable) and the vinext target (embeds everything
                        it serves).
  -h, --help            Show this help
`;

/**
 * The flags `knext build` accepts. Exported so a guard can hold reference-app
 * and template `package.json` scripts to the real parser (`--target` was removed
 * with ADR-0048, and a script still passing it fails with `unknown flag`; the
 * two selectable targets are chosen by the `build` config key, never by a flag).
 * `-h`/`--help` are handled separately
 * above, so they are not in this set.
 */
export const ACCEPTED_BUILD_FLAGS: ReadonlySet<string> = new Set([
    "--skip-next",
    "--skip-smoke",
    "--self-contained",
    "--verbose",
]);

/**
 * argv entry for `knext build`.
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
    // The compile steps are child processes (inherited env): this is how the
    // flag reaches them, and how an already-set KNEXT_VERBOSE=1 does too.
    if (argv.includes("--verbose")) process.env.KNEXT_VERBOSE = "1";
    const KNOWN = ACCEPTED_BUILD_FLAGS;
    for (const a of argv) {
        if (!KNOWN.has(a)) {
            throw new UsageError(
                a.startsWith("-")
                    ? `unknown flag "${a}" (see knext build --help)`
                    : `unexpected positional ${JSON.stringify(a)} — build takes no arguments (see knext build --help)`,
            );
        }
    }
    await build({
        skipNextBuild: argv.includes("--skip-next"),
        skipSmoke: argv.includes("--skip-smoke"),
        // Only when passed: absent must defer to the config key, not force off.
        ...(argv.includes("--self-contained") ? { selfContained: true } : {}),
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
