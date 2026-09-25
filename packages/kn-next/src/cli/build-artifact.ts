/**
 * Where `knext build` should expect this app's output to land.
 *
 * `build.ts` used to hardcode `.next/standalone` in five places: two log lines,
 * the bun-exports heal, the bytecode pass, and a warning that names
 * `output:'standalone'` as the likely cause when the directory is missing. All
 * correct for turbopack, all wrong for anything else — a vinext build would be
 * told to check a Next.js config option that has nothing to do with it.
 *
 * Asking the contract instead means adding a builder does not require auditing
 * every path literal in the build command. That is the difference the artifact
 * contract is for.
 *
 * NOTE on what `knext build` actually does: it does NOT run `next build`
 * itself. It runs the app's own `npm run build` (see `project-build.ts`), so an
 * app configured for vinext already builds with vinext today. What was missing
 * was knext knowing where to LOOK afterwards, and which post-build steps still
 * apply. This module supplies exactly that.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    BUILDERS,
    type BuildArtifact,
    type BuilderAdapter,
    DEFAULT_BUILDER_ID,
    DEFAULT_RUNTIME_ID,
} from "../adapters/artifact-contract";
import {
    type HealResult,
    healBunExportTargets,
} from "../adapters/standalone-bun-exports";
import type { KnativeNextConfig } from "../config";
import { UsageError } from "./shared";
import {
    buildStandaloneExecutable,
    standaloneExecFileName,
} from "./standalone-exec-build";
import { buildVinextExecutable } from "./vinext-build";

export interface ResolvedBuild {
    readonly builder: BuilderAdapter;
    readonly artifact: BuildArtifact;
}

/**
 * Resolve the builder and its artifact for this config.
 *
 * Throws on an unknown builder rather than falling back to the default. A
 * silent fallback would build one thing, look for another, and report success
 * — the #857 shape, where `next build` exited 0 the whole way while emitting a
 * server nothing could find. `validateConfig` normally rejects this first; the
 * throw is the backstop for a bypassed validator, not a duplicate of it.
 */
export function resolveBuildArtifact(
    config: KnativeNextConfig,
    root: string,
): ResolvedBuild {
    const id = config.build ?? DEFAULT_BUILDER_ID;
    const builder = BUILDERS.find((b) => b.id === id);
    if (!builder) {
        // UsageError, not a plain Error: this is a config mistake, and the
        // CLI renders that family as a friendly message + exit 1 rather than
        // `log.fatal({ err })` with a stack and a dist chunk path
        // (cli-dispatch-contract.test.ts enforces the distinction).
        throw new UsageError(
            `Unknown build system '${id}' in kn-next.config.ts. Known: ${BUILDERS.map((b) => b.id).join(", ")}.`,
        );
    }
    // The runtime is threaded through because vinext's shape depends on it
    // (#1260: the nitro preset IS the runtime choice). Builders whose shape
    // does not vary ignore it.
    return {
        builder,
        artifact: builder.describeArtifact(root, config.runtime),
    };
}

/**
 * Do the standalone-tree post-build steps apply to this artifact?
 *
 * The bun-condition export heal and the Bun bytecode pass both walk a
 * `.next/standalone` tree. Keyed on the SHAPE rather than on the builder id, so
 * a future builder that also emits a standalone tree inherits them, and one
 * that does not is never handed a step that cannot mean anything for it.
 */
export function standaloneStepsApply(artifact: BuildArtifact): boolean {
    return artifact.shape === "next-standalone";
}

/**
 * The target arch `knext deploy`/`preview` build images for — always
 * `linux/amd64` (`dockerBuildxArgs`'s `--platform`), regardless of the host.
 * Shared with `build.ts`'s own `SHIP_ARCH` so the two names never drift.
 */
export const DEPLOY_SHIP_ARCH = "linux-x64";

export interface CompileForDeployResult {
    /** Whether this config's target needed a compile step at all. */
    readonly compiled: boolean;
    /** Path to the compiled binary, when `compiled` is true. */
    readonly binaryPath?: string;
    /**
     * The bun-exports heal's own result, present only when the standalone
     * shape applies AND `.next/standalone` existed to heal. `undefined`
     * (not run) is itself informative to a caller deciding what to log.
     */
    readonly healed?: HealResult;
}

/**
 * Compile the executable `knext deploy`/`preview` need for the CURRENT
 * config's resolved target, sharing the EXACT logic `knext build` uses
 * (build.ts steps 2b/2b'/2c) — #1339 review finding #1 (jev 0.90, BLOCKER).
 *
 * Before this, `deploy()`/`defaultBuildAndPush()` ran the app's own
 * `npm run build` and stopped there. For `build: "vinext"` and for the
 * standalone-on-bun cell (`build: "turbopack"`/`"webpack"` + `runtime: "bun"`
 * — the DEFAULT since #1183), the staged Dockerfile does an UNCONDITIONAL
 * `COPY knext-standalone-exec-<arch>` / `COPY knext-exec-<arch>` of a binary
 * NEITHER caller ever produced — only `knext build` did. A bare-config
 * `knext deploy` therefore either failed the docker build outright (no
 * such file) or, worse, silently shipped a STALE binary left over from an
 * earlier `knext build` run in the same checkout.
 *
 * Called UNCONDITIONALLY whenever `deploy`/`preview` run a fresh project
 * build (i.e. NOT under `--skip-build`) — never gated on "does a binary
 * already exist", the same policy `knext build` itself follows, so
 * staleness cannot occur on this path by construction: every call recompiles
 * from the tree the project build JUST produced. The `--skip-build` path
 * (deploy only; preview has no such flag) instead uses
 * `assertCompiledArtifactFresh` below, which fails closed rather than
 * silently reusing whatever happens to be on disk.
 */
export function compileArtifactForDeploy(
    config: KnativeNextConfig,
    cwd: string,
    opts: { arch?: string } = {},
): CompileForDeployResult {
    const arch = opts.arch ?? DEPLOY_SHIP_ARCH;
    const { artifact } = resolveBuildArtifact(config, cwd);

    if (standaloneStepsApply(artifact)) {
        const standaloneDir = join(cwd, ".next", "standalone");
        // Heal is unconditional on the shape (build.ts step 2b) — additive
        // and version-checked, so it costs nothing on the node leg.
        const healed = existsSync(standaloneDir)
            ? healBunExportTargets({ projectDir: cwd, standaloneDir })
            : undefined;
        if ((config.runtime ?? DEFAULT_RUNTIME_ID) !== "bun") {
            return { compiled: false, healed };
        }
        // `buildStandaloneExecutable` ALSO throws a UsageError when there is
        // no server.js — this check runs first anyway, deliberately: it fails
        // BEFORE shelling out to `bun build`, not after, and it holds even
        // when a caller injects its own `buildStandaloneExecutable` (a test
        // double, say) that does not replicate that internal check.
        if (!existsSync(join(standaloneDir, "server.js"))) {
            throw new UsageError(
                `No standalone server at ${join(standaloneDir, "server.js")} to compile.\n\n` +
                    "The standalone-on-Bun image runs a compiled executable of that server. " +
                    "Check that next.config sets output: 'standalone' and that the project build ran.",
            );
        }
        const binaryPath = buildStandaloneExecutable({ cwd, arch });
        return { compiled: true, binaryPath, healed };
    }

    if (artifact.shape === "nitro-output-bun") {
        // skipViteBuild: the caller's OWN project build (runProjectBuild /
        // `npm run build`) already produced `.output` — mirrors build.ts's
        // step 2c comment exactly.
        const binaryPath = buildVinextExecutable({
            cwd,
            arch,
            skipViteBuild: true,
        });
        return { compiled: true, binaryPath };
    }

    // node runtime (standalone), or vinext × node: nothing to compile —
    // the V8 compile cache is baked at `docker build` time instead.
    return { compiled: false };
}

/**
 * Where the compiled exec this config's target needs is expected to land,
 * and the artifact it must be at least as fresh as — or `null` if this
 * target needs no compile step at all (node runtime, or vinext × node).
 */
export function compiledExecPathFor(
    config: KnativeNextConfig,
    cwd: string,
    arch: string = DEPLOY_SHIP_ARCH,
): { execPath: string; sourcePath: string } | null {
    const { artifact } = resolveBuildArtifact(config, cwd);

    if (
        standaloneStepsApply(artifact) &&
        (config.runtime ?? DEFAULT_RUNTIME_ID) === "bun"
    ) {
        return {
            execPath: join(cwd, standaloneExecFileName(arch)),
            sourcePath: join(cwd, ".next", "standalone", "server.js"),
        };
    }
    if (artifact.shape === "nitro-output-bun") {
        return {
            execPath: join(cwd, `knext-exec-${arch}`),
            sourcePath: join(cwd, ".output", "server", "index.mjs"),
        };
    }
    return null;
}

/**
 * Fail-closed guard for `knext deploy --skip-build`: the ONE path where
 * `compileArtifactForDeploy` above is never called, so nothing here
 * recompiles fresh. Mirrors the BUILD_ID/asset-prefix lock-step guards
 * already in `deploy.ts` (T2a/Defect-A) — loud on a stale or missing
 * artifact, never a silent reuse.
 *
 * Missing: the exec was never compiled (drop `--skip-build`, or run
 * `knext build` first). Stale: the exec's mtime predates the standalone
 * server / vinext output it should have been compiled FROM — an earlier
 * `knext build` compiled it, the project was rebuilt since, and the
 * executable was never refreshed. Both throw a `UsageError` naming the
 * one-line fix, the same "actionable, not a stack dump" family as the
 * #1184 fail-fast check above.
 *
 * A no-op when this target needs no compile step (node runtime, vinext ×
 * node) or when the source artifact itself does not exist yet — that is a
 * DIFFERENT, already-reported failure (the #1184 check / the vinext static-
 * prefix guard), and double-reporting it here would bury the real cause.
 */
export function assertCompiledArtifactFresh(
    config: KnativeNextConfig,
    cwd: string,
    arch: string = DEPLOY_SHIP_ARCH,
): void {
    const target = compiledExecPathFor(config, cwd, arch);
    if (!target) return;
    if (!existsSync(target.sourcePath)) return;

    if (!existsSync(target.execPath)) {
        throw new UsageError(
            `${target.execPath} is missing, and --skip-build means knext will not compile it.\n\n` +
                "Drop --skip-build, or run `knext build` first to produce it.",
        );
    }

    const execMtime = statSync(target.execPath).mtimeMs;
    const sourceMtime = statSync(target.sourcePath).mtimeMs;
    if (execMtime < sourceMtime) {
        throw new UsageError(
            `${target.execPath} is OLDER than ${target.sourcePath} — it was compiled from an ` +
                "earlier build and --skip-build means knext will not recompile it.\n\n" +
                "Drop --skip-build, or run `knext build` to refresh the executable before deploying.",
        );
    }
}
