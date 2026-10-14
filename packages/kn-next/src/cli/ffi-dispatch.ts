/**
 * Lazy dispatch of `knext ffi …` to the optional `@getknext/ffi` package
 * (ADR-0069 D12, D18) — the same protocol as `grpc-dispatch.ts`.
 *
 * In-process Rust (Beta, Bun only) lives in that package and the knext-ffi
 * crates, never in core. Core's whole involvement is this file: when `knext
 * ffi` is typed, find the package (from the app first, then from core's own
 * location), check it is a compatible pair, and hand it the argv. Core does not
 * depend on the package, does not import it statically, and the specifier is
 * resolved at run time so no bundler can inline it into the bin
 * (`ffi-dispatch.test.ts` holds all three, plus "no bun:ffi, no cargo").
 *
 * Compatibility: the package declares a peer range on `@getknext/core`; a core
 * outside it is refused with a message naming both versions. `--help` is
 * answered even then, and even when the package is not installed.
 *
 * Every failure here is a plain message and an exit code; nothing throws.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { coreVersion } from "./core-version";
import { satisfiesRange } from "./grpc-dispatch";

/** The package that provides `knext ffi`. */
export const FFI_PACKAGE = "@getknext/ffi";

/** Verbs owned by the package; core only routes them. */
export const FFI_VERBS: ReadonlySet<string> = new Set(["ffi"]);

/** The module shape this core knows how to call. */
const SUPPORTED_PROTOCOL = 1;

/** What core calls on `@getknext/ffi/cli`. */
export interface FfiCliModule {
    readonly DISPATCH_PROTOCOL: number;
    readonly FFI_VERSION: string;
    readonly CORE_PEER_RANGE: string;
    /** Help for a subcommand (`""`: the group help). */
    helpText(sub: string): string;
    run(verb: string, argv: readonly string[]): Promise<number>;
}

export interface DispatchDeps {
    /** Load the package; defaults to resolving it from the app, then from core. */
    readonly load?: () => Promise<FfiCliModule>;
    readonly stdout?: (text: string) => void;
    readonly stderr?: (text: string) => void;
}

class NotInstalled {}

function isNotFound(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

/** Resolve `@getknext/ffi/cli` from the app first, then from core itself. */
async function defaultLoad(): Promise<FfiCliModule> {
    const specifier = `${FFI_PACKAGE}/cli`;
    for (const base of [join(process.cwd(), "package.json"), import.meta.url]) {
        let resolved: string;
        try {
            resolved = createRequire(base).resolve(specifier);
        } catch (err) {
            if (isNotFound(err)) continue;
            throw err;
        }
        return (await import(pathToFileURL(resolved).href)) as FfiCliModule;
    }
    throw new NotInstalled();
}

const INSTALL_HELP = `knext ffi — in-process Rust for this zone (Beta, Bun only, optional package)

Usage: knext ffi <init|generate|check|build> [options]

Call Rust functions from a Server Action or route handler in the same process,
with a typed server-only wrapper. Runs only on the Bun runtime.

  knext ffi init       write knext.ffi.json and a starter rust/ crate
  knext ffi generate   build the crate for this machine and write the typed wrapper
  knext ffi check      the same, but fail if the committed wrapper is out of date
  knext ffi build      cross-build the library for the image (run by knext build)

These commands come from ${FFI_PACKAGE}, which is not installed in this app.
Install it next to @getknext/core:

  npm install --save-dev ${FFI_PACKAGE}

then run \`knext ffi --help\` again for each command's options.

Exit code: 0 for --help; 1 for anything else while the package is missing.
`;

/**
 * Route `knext ffi <argv…>` to the package. Returns the exit code.
 * `coreVersion` is this CLI's own version, checked against the package's
 * peer range.
 */
export async function dispatchFfiVerb(
    verb: string,
    argv: readonly string[],
    coreVersion: string,
    deps: DispatchDeps = {},
): Promise<number> {
    const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
    const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
    const help = argv.includes("--help") || argv.includes("-h");
    const typed = ["knext", verb, ...argv].join(" ");

    let mod: FfiCliModule;
    try {
        mod = await (deps.load ?? defaultLoad)();
    } catch (err) {
        if (err instanceof NotInstalled || isNotFound(err)) {
            if (help) {
                stdout(INSTALL_HELP);
                return 0;
            }
            stderr(
                `\`${typed}\`: this command comes from the optional ${FFI_PACKAGE} package ` +
                    "(Beta), which is not installed here.\n" +
                    `Install it next to @getknext/core: npm install --save-dev ${FFI_PACKAGE}\n`,
            );
            return 1;
        }
        stderr(
            `could not load ${FFI_PACKAGE}: ${(err as Error)?.message ?? String(err)}\n`,
        );
        return 1;
    }

    if (help) {
        const sub = argv.find((a) => !a.startsWith("-")) ?? "";
        stdout(`${mod.helpText(sub)}\n`);
        return 0;
    }
    const pair = `${FFI_PACKAGE} ${mod.FFI_VERSION} and @getknext/core ${coreVersion}`;
    if (mod.DISPATCH_PROTOCOL !== SUPPORTED_PROTOCOL) {
        stderr(
            `${pair} do not work together (dispatch protocol ${mod.DISPATCH_PROTOCOL}, ` +
                `expected ${SUPPORTED_PROTOCOL}). Install a matching pair.\n`,
        );
        return 1;
    }
    if (satisfiesRange(coreVersion, mod.CORE_PEER_RANGE) !== true) {
        stderr(
            `${FFI_PACKAGE} ${mod.FFI_VERSION} works with @getknext/core ` +
                `${mod.CORE_PEER_RANGE}, but this is @getknext/core ${coreVersion}. ` +
                "Install a matching pair.\n",
        );
        return 1;
    }
    try {
        return await mod.run(verb, argv);
    } catch (err) {
        stderr(`${typed} failed: ${(err as Error)?.message ?? String(err)}\n`);
        return 1;
    }
}

export { coreVersion };

/** `knext ffi` — bin entry. Answers `--help` itself when the package is missing. */
export function ffiMain(argv: readonly string[]): Promise<number> {
    return dispatchFfiVerb("ffi", argv, coreVersion());
}
