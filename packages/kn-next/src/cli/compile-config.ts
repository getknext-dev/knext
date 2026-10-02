/**
 * The `compile` block of `knext.config.ts` (the opt-in patched Bun toolchain,
 * see `bun-toolchain.ts`): its values and its validation.
 *
 * Deliberately import-free: `validate.ts` (behind the public
 * `@getknext/core/validate` entry) and `build-artifact.ts` import this, and
 * must not pull in the toolchain's download / build-step graph (tests mock
 * `./vinext-build` around `build-artifact.ts`).
 *
 * RETIREMENT: goes with `bun-toolchain.ts` once a stock Bun release ships
 * `--compile --include` (retirement probe `bun-patched-toolchain`).
 */

export type BunToolchainId = "stock" | "knext-patched";

export const BUN_TOOLCHAINS: readonly BunToolchainId[] = [
    "stock",
    "knext-patched",
];

export interface CompileConfigShape {
    readonly compile?: unknown;
}

/** Did this config opt in to the patched toolchain? */
export function wantsPatchedBun(config: CompileConfigShape): boolean {
    return (
        (config.compile as { bun?: unknown } | undefined)?.bun ===
        "knext-patched"
    );
}

/** `validateConfig` half for the `compile` block. Returns error strings. */
export function validateCompileConfig(config: CompileConfigShape): string[] {
    const errors: string[] = [];
    const compile = config.compile;
    if (compile === undefined) return errors;
    if (
        typeof compile !== "object" ||
        compile === null ||
        Array.isArray(compile)
    ) {
        return ["'compile' must be an object, e.g. { bun: 'knext-patched' }"];
    }
    const { bun, include } = compile as { bun?: unknown; include?: unknown };
    if (
        bun !== undefined &&
        !(BUN_TOOLCHAINS as readonly unknown[]).includes(bun)
    ) {
        errors.push(
            `'compile.bun' must be one of: ${BUN_TOOLCHAINS.join(", ")} (got ${JSON.stringify(bun)})`,
        );
    }
    if (include !== undefined) {
        if (
            !Array.isArray(include) ||
            include.length === 0 ||
            !include.every((g) => typeof g === "string" && g.length > 0)
        ) {
            errors.push(
                "'compile.include' must be a non-empty array of glob strings",
            );
        } else if (bun !== "knext-patched") {
            errors.push(
                "'compile.include' needs compile.bun: 'knext-patched' — stock Bun has no " +
                    "`--compile --include` and would silently embed nothing",
            );
        }
    }
    return errors;
}
