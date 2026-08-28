/**
 * The vinext → single-executable build path (ADR-0048).
 *
 * `kn-next build` previously ran only the app's `npm run build` and looked for
 * `.next/standalone`. ADR-0048 makes `build: vinext` + `runtime: bun` the only
 * supported target, so the CLI has to be able to PRODUCE that artifact rather
 * than merely describe where it lands.
 *
 * Two steps, mirroring `examples/bun-exec/build.sh`, which is the recipe this
 * was measured against:
 *
 *   1. `vite build`  — vinext emits a nitro **bun-preset** `.output`, entry
 *                      `.output/server/index.mjs`.
 *   2. `bun build --compile --minify --bytecode --target=<t>` — bakes that
 *      entry, every route it reaches, and V8 bytecode into one executable.
 *
 * The bytecode flag is not optional here and is the reason for the measured
 * cold start: 61 ms median against node-standalone's 884 ms on an identical
 * app (`docs/benchmarks/vinext-bun14-single-exec-2026-08-27.md`).
 *
 * ## The Bun floor is 1.4.0, and it is a floor rather than a preference
 *
 * Measured, both directions:
 *   - Bun 1.3.5 compiles a working binary but is **2× slower to cold start**
 *     (121 ms vs 61 ms) on the same source.
 *   - Bun 1.3.5 cannot serve a Next standalone tree at all (HTTP 500,
 *     `Expected CommonJS module to have a function`), which is why the retired
 *     `runtime: bun` + turbopack combination was never viable on it.
 *
 * So the build refuses to run under < 1.4.0 rather than silently producing a
 * slower artifact whose provenance nobody records.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runQuiet } from "./exec";
import { UsageError } from "./shared";

/** The first Bun that ADR-0048 accepts. See the docstring for the measurements. */
export const MIN_BUN_MAJOR = 1;
export const MIN_BUN_MINOR = 4;

/** `bun build --compile` target triples, keyed by knext's arch names. */
const COMPILE_TARGETS: Record<string, string> = {
    "linux-x64": "bun-linux-x64-musl",
    "linux-arm64": "bun-linux-arm64-musl",
    "darwin-arm64": "bun-darwin-arm64",
    "darwin-x64": "bun-darwin-x64",
};

/**
 * `major.minor` of a Bun version string, or undefined if unreadable.
 *
 * Leading digits only, so a prerelease (`1.4.0-canary.x`) reads as 1.4 — a
 * canary of a release that carries the fix does carry it. NUMERIC compare:
 * `"1.10.0" < "1.4.0"` lexically, and a string comparison would reject a newer
 * Bun forever.
 */
export function parseBunVersion(
    version: string,
): { major: number; minor: number } | undefined {
    const m = /^(\d+)\.(\d+)/.exec(version.trim());
    if (!m) return undefined;
    return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Does this Bun meet ADR-0048's floor? Unparseable is NOT accepted. */
export function bunMeetsFloor(version: string): boolean {
    const v = parseBunVersion(version);
    if (!v) return false;
    if (v.major !== MIN_BUN_MAJOR) return v.major > MIN_BUN_MAJOR;
    return v.minor >= MIN_BUN_MINOR;
}

/**
 * The `bun build --compile` argv for this target and entry.
 *
 * Exported so a test can assert the flags rather than trusting prose: dropping
 * `--bytecode` would still produce a working binary, just a slow one, and that
 * is exactly the regression nobody would notice without an assertion.
 */
export function compileArgv(
    arch: string,
    entry: string,
    outFile: string,
): string[] {
    const target = COMPILE_TARGETS[arch];
    if (!target) {
        throw new UsageError(
            `Unknown build arch '${arch}'. Known: ${Object.keys(COMPILE_TARGETS).join(", ")}.`,
        );
    }
    return [
        "bun",
        "build",
        "--compile",
        "--minify",
        "--bytecode",
        `--target=${target}`,
        entry,
        "--outfile",
        outFile,
    ];
}

export interface VinextBuildOptions {
    /** App root. */
    readonly cwd: string;
    /** Target arch; defaults to the ship target. */
    readonly arch?: string;
    /** Output binary path, relative to cwd. */
    readonly outFile?: string;
    /** Injectable for tests; the real runner inherits stderr. */
    readonly run?: (argv: readonly string[]) => void;
    /** Injectable for tests. */
    readonly bunVersion?: string;
}

/**
 * Run the two-step vinext build. Returns the produced binary's path.
 *
 * Never names the output after a runtime (`bun`, `node`, …): the asset-root
 * resolver classifies a compiled binary by basename, so those names make it
 * read the BUILD TREE's assets silently.
 */
export function buildVinextExecutable(opts: VinextBuildOptions): string {
    const run = opts.run ?? runQuiet;
    const arch = opts.arch ?? "linux-x64";
    const outFile = opts.outFile ?? `knext-exec-${arch}`;

    const version = opts.bunVersion ?? detectBunVersion(run);
    if (!bunMeetsFloor(version)) {
        throw new UsageError(
            `The vinext single-executable target requires Bun ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0 or newer; found '${version}'.\n\n` +
                "Bun 1.3.x compiles a binary that boots roughly twice as slowly (121ms vs 61ms measured),\n" +
                "so knext refuses it rather than shipping a slower artifact silently. Upgrade with `bun upgrade`.",
        );
    }

    // 1. vinext → nitro bun-preset .output
    run(["npx", "vite", "build"]);

    const entry = join(".output", "server", "index.mjs");
    if (!existsSync(join(opts.cwd, entry))) {
        throw new UsageError(
            `The vinext build finished but '${entry}' is not there.\n\n` +
                "That entry is what gets compiled into the executable, so the image would have nothing to run.\n" +
                "Check that this app's vite config uses the nitro bun preset.",
        );
    }

    // 2. compile + bytecode
    run(compileArgv(arch, entry, outFile));
    return outFile;
}

/** Reads `bun --version`. Separate so the floor check is testable without a Bun. */
function detectBunVersion(run: (argv: readonly string[]) => void): string {
    // `runQuiet` does not capture stdout, so shell the version into a file-free
    // read via execFileSync in the caller when a real detection is needed. The
    // default path here keeps the seam explicit rather than pretending.
    void run;
    try {
        // Lazily required so tests that inject `bunVersion` never spawn.
        const { execFileSync } =
            require("node:child_process") as typeof import("node:child_process");
        return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
        throw new UsageError(
            "The vinext single-executable target needs `bun` on PATH (https://bun.sh), and it was not found.",
        );
    }
}
