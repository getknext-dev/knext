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

import { createHash } from "node:crypto";
import {
    existsSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    writeFileSync,
} from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The vinext build-output subdirectories the freshness stamp hashes —
 * deliberately NOT the whole `.output` root (see `compiledExecPathFor`'s
 * doc comment). Shared by `compileArtifactForDeploy` (writes the stamp) and
 * `compiledExecPathFor` (reads it back) so the two can never drift to
 * different root sets.
 */
function vinextOutputSourceDirs(cwd: string): readonly string[] {
    return [join(cwd, ".output", "server"), join(cwd, ".output", "public")];
}

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
    const { artifact, builder } = resolveBuildArtifact(config, cwd);
    const runtimeId = config.runtime ?? DEFAULT_RUNTIME_ID;

    if (standaloneStepsApply(artifact)) {
        const standaloneDir = join(cwd, ".next", "standalone");
        // Heal is unconditional on the shape (build.ts step 2b) — additive
        // and version-checked, so it costs nothing on the node leg.
        const healed = existsSync(standaloneDir)
            ? healBunExportTargets({ projectDir: cwd, standaloneDir })
            : undefined;
        if (runtimeId !== "bun") {
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
        // #1351/#1414: stamp the exec with a hash of the WHOLE standalone
        // tree it was JUST compiled from (not just server.js — see
        // `buildStampPathFor`'s doc comment), so a later `--skip-build`
        // deploy can verify it still matches rather than trusting a
        // filesystem mtime.
        writeBuildStamp(binaryPath, standaloneDir, {
            builderId: builder.id,
            runtimeId,
        });
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
        // #1351/#1414 rev-2: same stamp, scoped to `.output/server` +
        // `.output/public` — never the whole `.output` root, which is also
        // where THIS CLI writes its own preflight/CR/buildx-metadata files
        // (see `compiledExecPathFor`'s doc comment for the incident this
        // fixes).
        writeBuildStamp(binaryPath, vinextOutputSourceDirs(cwd), {
            builderId: builder.id,
            runtimeId,
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
 *
 * `sourcePath` is the entry file (`server.js`/`index.mjs`) — used only as the
 * "did the project build even run" existence check and in user-facing
 * messages. `sourceDirs` are the TREE(S) the freshness stamp is hashed over
 * (`#1414`) — the whole standalone directory for the standalone-bun shape,
 * since the entry file alone does not change when only the app's own
 * page/route code changes.
 *
 * vinext (`#1414` rev-2) hashes `.output/server` + `.output/public` SPECIFICALLY
 * — never the whole `.output` root. `.output` is also where THIS CLI writes
 * its own artifacts alongside the build (`nextapp-preflight-cr.yaml`,
 * `nextapp-cr.yaml`, `buildx-metadata.json` — see `deploy.ts`'s
 * `runPrunePreflight` and the CR/buildx-metadata writers). Hashing the whole
 * root meant `deploy --skip-build` wrote its OWN preflight CR into `.output`
 * BEFORE calling `assertCompiledArtifactFresh`, which then hashed a tree
 * containing a file that did not exist when the stamp was written — every
 * non-dry-run vinext `--skip-build` deploy failed as "stale," always, by
 * construction, never actually stale. Scoping to the two real BUILD OUTPUT
 * subdirectories is immune to this by construction: knext's own artifacts
 * never land inside `.output/server` or `.output/public`, so nothing knext
 * itself writes can ever appear in the hashed set, regardless of write
 * order or what future artifact gets added at the `.output` root.
 */
export function compiledExecPathFor(
    config: KnativeNextConfig,
    cwd: string,
    arch: string = DEPLOY_SHIP_ARCH,
): {
    execPath: string;
    sourcePath: string;
    sourceDirs: readonly string[];
    builderId: string;
    runtimeId: string;
} | null {
    const { artifact, builder } = resolveBuildArtifact(config, cwd);
    const runtimeId = config.runtime ?? DEFAULT_RUNTIME_ID;

    if (standaloneStepsApply(artifact) && runtimeId === "bun") {
        return {
            execPath: join(cwd, standaloneExecFileName(arch)),
            sourcePath: join(cwd, ".next", "standalone", "server.js"),
            sourceDirs: [join(cwd, ".next", "standalone")],
            builderId: builder.id,
            runtimeId,
        };
    }
    if (artifact.shape === "nitro-output-bun") {
        return {
            execPath: join(cwd, `knext-exec-${arch}`),
            sourcePath: join(cwd, ".output", "server", "index.mjs"),
            sourceDirs: vinextOutputSourceDirs(cwd),
            builderId: builder.id,
            runtimeId,
        };
    }
    return null;
}

/**
 * `#1351`/`#1414`: the compiled exec's freshness stamp — a SHA-256 over the
 * ENTIRE source tree's content (every file under `.next/standalone` /
 * `.output`, not just the `server.js`/`index.mjs` entry point it launches),
 * plus the knext CLI version and the resolved builder/runtime — written to a
 * sidecar file next to the exec (`<execPath>.buildstamp`) the moment it is
 * compiled. Replaces an mtime comparison (#1183 round 2): mtime is not a
 * content signal — `git checkout`, a container `COPY`, an `rsync` without
 * `-t`, or a tarball extract can all leave a NEWER mtime on an OLDER (or
 * simply DIFFERENT) file with no actual content change, in either direction.
 *
 * `#1414` is a fix-forward on `#1351`'s first cut, which hashed ONLY the
 * entry file. `server.js`/`index.mjs` is a fixed launcher — it does not embed
 * the app's own page/route code or a BUILD_ID, so editing a page and
 * rebuilding left the entry file byte-identical and the stamp still
 * "matched," silently shipping the OLD exec under `--skip-build`. Hashing
 * the whole tree makes any changed file (e.g.
 * `.next/standalone/.next/server/app/page.js`, or a vinext `_ssr`/`_chunks`
 * asset) change the stamp.
 */
export function buildStampPathFor(execPath: string): string {
    return `${execPath}.buildstamp`;
}

/**
 * Reads the knext CLI's own version from its package manifest. Works from
 * both the source layout (`src/cli/build-artifact.ts`) and the bundled
 * layout (`dist/cli/kn-next.js`) — package.json sits two directories up in
 * both cases, mirroring `deploy.ts`'s `getCliVersion`. A separate copy
 * (rather than an import) to avoid a `build-artifact.ts` → `deploy.ts` →
 * `build-artifact.ts` import cycle (`deploy.ts` already imports from this
 * file).
 */
function getCliVersionForStamp(): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkgPath = resolvePath(here, "..", "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
            version?: string;
        };
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/**
 * Every entry under `rootDir` as `{ relPath, kind }` pairs, in a stable
 * (sorted-by-relPath) order — `kind` is `"file"` for a regular file's
 * absolute path, or `"symlink"` for a symlink's TARGET string (read via
 * `readlinkSync`, never followed). Symlinks are hashed by where they POINT,
 * not by walking into the target: `readdirSync`'s `Dirent` reports a
 * symlink as neither a file nor a directory, so re-pointing one between two
 * existing targets inside the tree was previously invisible to the stamp
 * entirely (the entry was silently skipped) — hashing the link string
 * closes that.
 */
function collectEntriesSorted(
    rootDir: string,
): { relPath: string; kind: "file" | "symlink"; value: string }[] {
    const out: { relPath: string; kind: "file" | "symlink"; value: string }[] =
        [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                out.push({
                    relPath: relative(rootDir, full),
                    kind: "symlink",
                    value: readlinkSync(full),
                });
            } else if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                out.push({
                    relPath: relative(rootDir, full),
                    kind: "file",
                    value: full,
                });
            }
        }
    };
    walk(rootDir);
    out.sort((a, b) =>
        a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
    );
    return out;
}

export interface BuildIdentityOptions {
    /** The builder id (e.g. `"turbopack"`, `"webpack"`, `"vinext"`). */
    readonly builderId: string;
    /** The resolved runtime id (e.g. `"bun"`, `"node"`). */
    readonly runtimeId: string;
}

/**
 * SHA-256 hex digest of the build identity: the CLI version, the
 * builder/runtime, and a sorted relative-path + content stream over EVERY
 * file in `rootDirs` (`[.next/standalone]` for the standalone-bun shape,
 * `[.output/server, .output/public]` for vinext — never the whole `.output`
 * root; see `compiledExecPathFor`'s doc comment for why) — not just the
 * entry file. See the doc comment on `buildStampPathFor` for why the
 * entry-file-only hash this replaces was a false-negative hazard.
 *
 * A `rootDir` that does not exist (e.g. `.output/public` on a no-storage
 * app that emits no static assets) contributes nothing rather than
 * throwing — a missing directory is not an error here, since which
 * subdirectories a given build actually produces is itself part of the
 * app's config, not a defect.
 */
export function hashBuildIdentity(
    rootDirs: string | readonly string[],
    opts: BuildIdentityOptions,
): string {
    const roots = typeof rootDirs === "string" ? [rootDirs] : rootDirs;
    const hash = createHash("sha256");
    hash.update(`knext-cli-version:${getCliVersionForStamp()}\n`);
    hash.update(`builder:${opts.builderId}\n`);
    hash.update(`runtime:${opts.runtimeId}\n`);
    roots.forEach((rootDir, index) => {
        if (!existsSync(rootDir)) return;
        // Labeled by POSITION, not a path relative to `process.cwd()` — the
        // caller's cwd (an app dir under test, say) need not match this
        // process's actual cwd, and the root ORDER is deterministic per
        // shape (`compiledExecPathFor` always builds the same array for the
        // same target), so the index is a stable, cwd-independent label.
        hash.update(`root:${index}\n`);
        for (const entry of collectEntriesSorted(rootDir)) {
            if (entry.kind === "symlink") {
                hash.update(`symlink:${entry.relPath}->${entry.value}\n`);
                continue;
            }
            hash.update(`file:${entry.relPath}\n`);
            hash.update(readFileSync(entry.value));
            hash.update("\n");
        }
    });
    return hash.digest("hex");
}

/**
 * Write the freshness stamp for a just-compiled exec, from the source
 * TREE(S) it was compiled FROM. Called at the one place both `knext build`
 * and `knext deploy`/`preview` compile through (`compileArtifactForDeploy`
 * below) — so a stamp exists for every exec this CLI itself ever produces,
 * regardless of which command triggered the compile.
 */
function writeBuildStamp(
    execPath: string,
    sourceDirs: string | readonly string[],
    opts: BuildIdentityOptions,
): void {
    writeFileSync(
        buildStampPathFor(execPath),
        hashBuildIdentity(sourceDirs, opts),
    );
}

/**
 * Fail-closed guard for `knext deploy --skip-build`: the ONE path where
 * `compileArtifactForDeploy` above is never called, so nothing here
 * recompiles fresh. Mirrors the BUILD_ID/asset-prefix lock-step guards
 * already in `deploy.ts` (T2a/Defect-A) — loud on a stale or missing
 * artifact, never a silent reuse.
 *
 * Missing: the exec was never compiled (drop `--skip-build`, or run
 * `knext build` first). Stale (`#1351`/`#1414`): the exec's `.buildstamp`
 * sidecar — a SHA-256 of the WHOLE standalone/`.output` tree it was compiled
 * FROM, plus the CLI version and builder/runtime — either does not match a
 * fresh hash of that tree's CURRENT content, or does not exist at all (an
 * exec this check cannot vouch for, e.g. one predating this stamp or copied
 * in from elsewhere). Both "no stamp" and "stamp mismatch" fail closed into
 * the same stale-class error — a filesystem mtime comparison used to stand
 * in for this and was replaced because mtime is not a content signal (see
 * `buildStampPathFor`'s doc comment). All three throw a `UsageError` naming
 * the one-line fix, the same "actionable, not a stack dump" family as the
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

    const stampPath = buildStampPathFor(target.execPath);
    if (!existsSync(stampPath)) {
        throw new UsageError(
            `${target.execPath} has no freshness stamp (${stampPath} is missing) — knext ` +
                `cannot verify it matches the current ${target.sourcePath}, and --skip-build ` +
                "means it will not recompile.\n\n" +
                "Drop --skip-build, or run `knext build` to recompile it with a verifiable stamp.",
        );
    }
    const stampedHash = readFileSync(stampPath, "utf8").trim();
    const currentHash = hashBuildIdentity(target.sourceDirs, {
        builderId: target.builderId,
        runtimeId: target.runtimeId,
    });
    if (stampedHash !== currentHash) {
        throw new UsageError(
            `${target.execPath} is STALE — it was compiled from a different version of ` +
                `${target.sourceDirs.join(", ")} than the one currently on disk, and --skip-build ` +
                "means knext will not recompile it.\n\n" +
                "Drop --skip-build, or run `knext build` to refresh the executable before deploying.",
        );
    }
}
