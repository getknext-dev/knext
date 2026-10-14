/**
 * In-process Rust (Beta, Bun only) — core's whole build-side involvement
 * (ADR-0069 D14, D15, D18).
 *
 * Core reads only the EXISTENCE of `knext.ffi.json` (never its contents; the
 * optional ffi package owns the file). From that one fact:
 *
 *   - `assertFfiTargetSupported` refuses a target the feature cannot run on —
 *     the Node runtime (bun:ffi exists only in Bun) and the self-contained
 *     mode (it ships nothing beside the executable, and the library must sit
 *     on disk beside it). Called FIRST in `knext build`, `knext deploy` and
 *     `knext preview`, right after the config is loaded, so it stops before
 *     any build work and before every skip-build branch;
 *   - `runFfiBuildStep` dispatches `knext ffi build --target <triple>
 *     --native-dir <app>/native` to the package before the project build,
 *     mapping the image arch to its musl Rust triple.
 *
 * Without the file both are inert: an app that does not opt in builds exactly
 * as before (D17). Nothing here imports the package or names a Rust tool; the
 * dispatch is the lazy, runtime-resolved one in `ffi-dispatch.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_ID } from "../adapters/artifact-contract";
import { resolveSelfContained } from "./build-target";
import {
    coreVersion as defaultCoreVersion,
    dispatchFfiVerb,
} from "./ffi-dispatch";
import { UsageError } from "./shared";

/** The file whose existence opts an app in. Owned by the optional ffi package. */
export const FFI_CONFIG_FILE = "knext.ffi.json";

/** Does this app opt into in-process Rust? Existence only; never parsed. */
export function ffiOptedIn(cwd: string): boolean {
    return existsSync(join(cwd, FFI_CONFIG_FILE));
}

/** ADR-0069 D15, verbatim. */
export const FFI_NODE_REFUSAL = `knext: in-process Rust (bun:ffi) needs the Bun runtime, but this app builds for Node.

  knext.ffi.json opts this app into in-process Rust, and knext.config.ts resolves
  runtime: 'node'. bun:ffi exists only in Bun, so the build stops here instead of
  shipping an image whose Rust calls would fail on the first request.

  Fix one of:
    - use the Bun runtime: remove runtime: 'node' from knext.config.ts (Bun is the default);
    - or move this code to a zone function (knext add function <name> --lang rust),
      which runs on both runtimes.`;

/** ADR-0069 D14: self-contained mode is refused in v1. */
export const FFI_SELF_CONTAINED_REFUSAL = `knext: in-process Rust (bun:ffi) does not work in self-contained mode.

  knext.ffi.json opts this app into in-process Rust, and this build is
  self-contained (selfContained: true in knext.config.ts, or --self-contained).
  That mode ships nothing beside the executable, but the Rust library has to be
  loaded from disk beside it (native/ffi/), so the build stops here.

  Fix one of:
    - turn self-contained mode off: remove selfContained: true from knext.config.ts
      and drop --self-contained;
    - or move this code to a zone function (knext add function <name> --lang rust),
      which runs on both runtimes.`;

/**
 * Refuse a build target in-process Rust cannot run on. A no-op without
 * `knext.ffi.json`. `opts.selfContained` is the `--self-contained` flag; the
 * mode is resolved exactly as `compileArtifactForDeploy` resolves it.
 */
export function assertFfiTargetSupported(
    config: { runtime?: string; build?: string; selfContained?: boolean },
    cwd: string,
    opts: { selfContained?: boolean } = {},
): void {
    if (!ffiOptedIn(cwd)) return;
    if ((config.runtime ?? DEFAULT_RUNTIME_ID) === "node") {
        throw new UsageError(FFI_NODE_REFUSAL);
    }
    if (resolveSelfContained(config, opts.selfContained)) {
        throw new UsageError(FFI_SELF_CONTAINED_REFUSAL);
    }
}

/**
 * The Rust target triple for each image arch knext ships (D14). The images are
 * Alpine, so the triples are musl.
 */
export const FFI_TARGET_TRIPLES: Readonly<Record<string, string>> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
};

export function ffiTargetTriple(arch: string): string {
    const triple = FFI_TARGET_TRIPLES[arch];
    if (triple === undefined) {
        throw new UsageError(
            `In-process Rust has no build target for the image arch '${arch}' (supported: ${Object.keys(FFI_TARGET_TRIPLES).join(", ")}).`,
        );
    }
    return triple;
}

/** How to recover from an empty native/ffi/<triple>/, per entry point. */
export const FFI_STAGED_REMEDY = {
    /** `knext build --skip-next`, and the compile step `deploy`/`preview` share. */
    compile:
        "Run the build without --skip-next (it runs `knext ffi build` first), or run `knext ffi build` yourself.",
    /** `knext deploy --skip-build`, which never runs the build. */
    skipBuild:
        "Drop --skip-build (the build runs `knext ffi build` first), or run `knext build` before deploying.",
} as const;

/**
 * Refuse an opted-in app whose image would ship without its Rust library:
 * nothing is staged at `native/ffi/<triple>/` for the image arch. Every image
 * that runs the app's Bun executable needs it (the standalone and vinext
 * targets alike), and the legs that skip the build (`build --skip-next`,
 * `deploy --skip-build`) are exactly where nothing staged it this run. A
 * no-op without `knext.ffi.json`.
 */
export function assertFfiLibraryStaged(
    cwd: string,
    arch: string,
    remedy: string,
): void {
    if (!ffiOptedIn(cwd)) return;
    const triple = ffiTargetTriple(arch);
    if (!existsSync(join(cwd, "native", "ffi", triple))) {
        throw new UsageError(
            `${FFI_CONFIG_FILE} opts this app into in-process Rust, but nothing is staged at native/ffi/${triple}/ for the image arch ${arch}, so the image would ship without its Rust library.\n\n${remedy}`,
        );
    }
}

export interface FfiBuildStepDeps {
    readonly dispatch?: typeof dispatchFfiVerb;
    readonly coreVersion?: string;
}

/**
 * D14 steps 1–5, before the project build: when the app opts in, run
 * `knext ffi build` for the image arch. Returns whether it ran; throws a
 * usage error when it fails (its own message is already printed).
 */
export async function runFfiBuildStep(
    cwd: string,
    arch: string,
    deps: FfiBuildStepDeps = {},
): Promise<boolean> {
    if (!ffiOptedIn(cwd)) return false;
    const argv = [
        "build",
        "--target",
        ffiTargetTriple(arch),
        "--native-dir",
        join(cwd, "native"),
    ];
    const code = await (deps.dispatch ?? dispatchFfiVerb)(
        "ffi",
        argv,
        deps.coreVersion ?? defaultCoreVersion(),
    );
    if (code !== 0) {
        throw new UsageError(
            `knext ffi build failed (exit ${code}); see its message above. ${FFI_CONFIG_FILE} opts this app into in-process Rust, so the image is not built without its library.`,
        );
    }
    return true;
}
