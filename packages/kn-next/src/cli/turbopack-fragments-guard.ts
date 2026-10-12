/**
 * Refuse `experimental.turbopackModuleFragments` on the Bun runtime.
 *
 * With that flag on, Next 16.4 Turbopack emits chunks that assign to a `const`
 * in code that never runs. Bun's parser rejects that at LOAD time (Node does
 * not), so a Bun-runtime app (the compiled single-exec and standalone-on-Bun
 * alike) fails on those chunks. `build` refuses up front and `knext doctor`
 * reports the same condition (`doctor/checks/turbopack-fragments.ts`).
 *
 * RETIREMENT: delete this guard (and the doctor row) once a Bun release that
 * contains the upstream parser fix (oven-sh/bun#45010, tracking issue
 * oven-sh/bun#45007) is the minimum Bun knext supports. Until then it stays.
 *
 * Detection reuses the doctor's next.config text scan (no second parser): a
 * flag set through a computed value is not visible to it. FAIL CLOSED where it
 * can be: a next.config that exists but cannot be read is refused on Bun,
 * rather than assumed clean.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NEXT_CONFIG_FILES, stripComments } from "./doctor/checks/use-cache";
import { UsageError } from "./shared";

/** True iff the config text switches the flag on (comments ignored). */
export function enablesTurbopackModuleFragments(configText: string): boolean {
    return /\bturbopackModuleFragments\s*:\s*true\b/.test(
        stripComments(configText),
    );
}

/**
 * The next.config source in `cwd`, or `undefined` when there is none. THROWS
 * when a config file exists but cannot be read (callers fail closed).
 */
export function readNextConfigStrict(cwd = process.cwd()): string | undefined {
    for (const name of NEXT_CONFIG_FILES) {
        const path = join(cwd, name);
        if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return undefined;
}

export const TURBOPACK_FRAGMENTS_BUN_DETAIL =
    "experimental.turbopackModuleFragments is on, the build is Turbopack and the runtime is Bun. Bun's parser rejects the chunks that flag makes Turbopack emit (they assign to a const in code that never runs), so the app fails when those chunks load. Node and non-Turbopack (webpack, vinext) builds are not affected.";
export const TURBOPACK_FRAGMENTS_BUN_HINT =
    'turn experimental.turbopackModuleFragments off in your next.config, or set runtime: "node" in your knext config';

export function assertNoBunTurbopackFragments(opts: {
    runtime: string;
    /** Only the Turbopack builder emits fragment chunks; webpack/vinext never do. */
    builder: string;
    readNextConfig?: () => string | undefined;
}): void {
    if (opts.runtime !== "bun" || opts.builder !== "turbopack") return;
    let text: string | undefined;
    try {
        text = (opts.readNextConfig ?? readNextConfigStrict)();
    } catch (err) {
        throw new UsageError(
            `Could not read your next.config to check experimental.turbopackModuleFragments, which Bun cannot run (${err instanceof Error ? err.message : String(err)}). Fix the file's permissions, or set runtime: "node".`,
        );
    }
    if (text !== undefined && enablesTurbopackModuleFragments(text)) {
        throw new UsageError(
            `${TURBOPACK_FRAGMENTS_BUN_DETAIL} Fix: ${TURBOPACK_FRAGMENTS_BUN_HINT}.`,
        );
    }
}
