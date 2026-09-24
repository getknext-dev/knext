/**
 * The compiled standalone-on-Bun build step.
 *
 * With `build: 'turbopack'` and `runtime: 'bun'`, `next build`'s
 * `.next/standalone` server is compiled into a Bun single executable WITH
 * bytecode (`adapters/standalone-compile.mjs`), rather than shipped as
 * `bun server.js`. The executable replaces the script, not the tree: the
 * image still carries `.next/standalone` beside it, because Next loads its
 * route chunks from there by computed path at request time.
 *
 * Bytecode is not an optimisation this step may quietly lose. The CLI hands
 * the compile script a fresh marker and then scans the produced executable for
 * it (`bytecode-exec-verify.mjs`) — independent of whatever the script claims —
 * and the build FAILS unless the entry was compiled to bytecode. A binary
 * without it boots and serves, just slower, which is exactly the regression
 * nobody would otherwise notice.
 *
 * ADR-0001: this module writes a file into the local build context only.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyBytecodeExec } from "../adapters/bytecode-exec-verify.mjs";
import { packageRoot } from "./create";
import { runQuiet } from "./exec";
import { UsageError } from "./shared";
import {
    bunCompileTarget,
    bunMeetsFloor,
    detectBunVersion,
    MIN_BUN_MAJOR,
    MIN_BUN_MINOR,
} from "./vinext-build";

/**
 * The executable's basename. Never a runtime word (`bun`, `node`), for the
 * same reason as the vinext binary, and never `knext-exec*`: the standalone
 * build context's ignore file drops that prefix (the vinext binaries), and the
 * standalone image COPYs this file out of that context.
 */
export const STANDALONE_EXEC_BASENAME = "knext-standalone-exec";

export function standaloneExecFileName(arch: string): string {
    return `${STANDALONE_EXEC_BASENAME}-${arch}`;
}

/**
 * The shipped compile script, resolved from the PACKAGE ROOT (`packageRoot()`,
 * shared with `create.ts`'s template resolution and `compileScriptPath` in
 * `vinext-build.ts`) — NOT from `dirname(import.meta.url)/..` (#1339 round-3,
 * jev 0.92 BLOCKER, proven with tsup + npm pack). See `compileScriptPath`'s
 * doc comment for the full failure mechanism: this module is now shared by
 * `build-artifact.ts` across build.ts/deploy.ts/preview.ts, so tsup hoists it
 * into a ROOT-level `dist/chunk-<hash>.js` rather than a `dist/cli/`-nested
 * one, and a depth-relative walk resolves one level too shallow — a path
 * that is never in the published tarball at all.
 *
 * Prefers the BUILT `dist/adapters/standalone-compile.js`; falls back to the
 * SOURCE `src/adapters/standalone-compile.mjs` when dist has not been built
 * (running from a source checkout — the docker e2e drives this real path).
 */
export function standaloneCompileScriptPath(): string {
    const root = packageRoot();
    const built = join(root, "dist", "adapters", "standalone-compile.js");
    if (existsSync(built)) return built;
    const source = join(root, "src", "adapters", "standalone-compile.mjs");
    if (existsSync(source)) return source;
    return built;
}

export interface StandaloneCompileArgs {
    readonly arch: string;
    /** The standalone `server.js`. */
    readonly server: string;
    /** The `.next/standalone` root (the traced tree the graph is confined to). */
    readonly root: string;
    readonly outFile: string;
    /** The bytecode-proof marker this build will scan the artifact for. */
    readonly marker: string;
}

export function standaloneCompileArgv(args: StandaloneCompileArgs): string[] {
    return [
        "bun",
        "run",
        standaloneCompileScriptPath(),
        "--server",
        args.server,
        "--root",
        args.root,
        "--outfile",
        args.outFile,
        "--target",
        bunCompileTarget(args.arch),
        "--marker",
        args.marker,
    ];
}

export interface StandaloneExecBuildOptions {
    /** App root (the directory holding `.next/standalone`). */
    readonly cwd: string;
    /** Target arch; the image ships linux-x64. */
    readonly arch: string;
    /** Output path; defaults to `<cwd>/knext-standalone-exec-<arch>`. */
    readonly outFile?: string;
    /** Injectable for tests; the real runner inherits stderr. */
    readonly run?: (argv: readonly string[]) => void;
    /** Injectable for tests. */
    readonly bunVersion?: string;
    /** Injectable for tests: read the produced executable. */
    readonly readArtifact?: (path: string) => Uint8Array;
}

/**
 * Compile `.next/standalone/server.js` into the bytecode executable and prove
 * the result carries bytecode. Returns the executable's path.
 */
export function buildStandaloneExecutable(
    opts: StandaloneExecBuildOptions,
): string {
    const run = opts.run ?? runQuiet;
    const version = opts.bunVersion ?? detectBunVersion(run);
    if (!bunMeetsFloor(version)) {
        throw new UsageError(
            `The compiled standalone-on-Bun target requires Bun ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0 or newer; found '${version}'.\n\n` +
                "Bun 1.3.x cannot serve a Next standalone tree at all. Upgrade with `bun upgrade`.",
        );
    }

    const root = join(opts.cwd, ".next", "standalone");
    const server = join(root, "server.js");
    if (!existsSync(server)) {
        throw new UsageError(
            `The standalone build finished but '${server}' is not there.\n\n` +
                "That server is what gets compiled into the executable. Check that next.config sets output: 'standalone'.",
        );
    }

    const outFile =
        opts.outFile ?? join(opts.cwd, standaloneExecFileName(opts.arch));
    const marker = `knext-standalone-exec:${randomBytes(12).toString("hex")}`;
    run(
        standaloneCompileArgv({
            arch: opts.arch,
            server,
            root,
            outFile,
            marker,
        }),
    );

    const read = opts.readArtifact ?? ((p: string) => readFileSync(p));
    const verdict = verifyBytecodeExec(read(outFile), marker);
    if (!verdict.ok) {
        rmSync(outFile, { force: true });
        throw new UsageError(
            `The compiled standalone executable failed the bytecode check: ${verdict.reason}.\n\n` +
                "Refusing to ship it — a binary without bytecode boots, but pays a full compile on every cold start.",
        );
    }
    return outFile;
}
