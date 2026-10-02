/**
 * The `compile` block of `knext.config.ts`: extra files to embed in the
 * compiled executable (`compile.include`), on stock Bun.
 *
 * Deliberately import-free: `validate.ts` (behind the public
 * `@getknext/core/validate` entry) and `build-artifact.ts` import this.
 *
 * How it works (vinext-compile.mjs + compile-embed.mjs): stock Bun has no
 * `--compile --include`, so the matched JS/TS modules are passed as extra
 * entrypoints rooted at the app root; Bun embeds each one unexecuted at
 * `$bunfs/root/<path relative to the app root>`, and it loads on its first
 * import. When a stock Bun release ships `--compile --include`
 * (oven-sh/bun#44059), the same plan can be passed that way instead.
 *
 * `compile.bun: 'knext-patched'` (opt-in, see `bun-toolchain.ts`) runs the
 * compile with a knext-published Bun 1.4.2 build that has that flag: the SAME
 * checked plan is then embedded through Bun's native `compile.include`. The
 * config, the safety checks and the `$bunfs` paths are identical in both modes.
 * RETIREMENT of the `bun` key: with `bun-toolchain.ts` (retirement probe
 * `bun-patched-toolchain`).
 */

export type BunToolchainId = "stock" | "knext-patched";

export const BUN_TOOLCHAINS: readonly BunToolchainId[] = [
    "stock",
    "knext-patched",
];

/**
 * The resolved compile toolchain (`resolveCompileToolchain` in
 * bun-toolchain.ts): `bin` is the verified patched Bun, absent for stock.
 */
export interface CompileToolchain {
    readonly bin?: string;
}

export interface CompileConfigShape {
    readonly compile?: unknown;
    readonly build?: unknown;
    readonly runtime?: unknown;
}

/** Did this config opt in to the patched toolchain? */
export function wantsPatchedBun(config: CompileConfigShape): boolean {
    return (
        (config.compile as { bun?: unknown } | undefined)?.bun ===
        "knext-patched"
    );
}

/** Is this the compiled vinext executable? `compile.*` applies to it and nothing else. */
function isCompiledVinext(config: CompileConfigShape): boolean {
    return config.build === "vinext" && (config.runtime ?? "bun") === "bun";
}

/** The user's `compile.include` globs, or `[]`. */
export function compileIncludeGlobs(config: CompileConfigShape): string[] {
    const include = (config.compile as { include?: unknown } | undefined)
        ?.include;
    return Array.isArray(include)
        ? include.filter((g): g is string => typeof g === "string")
        : [];
}

/** `validateConfig` half for the `compile` block. Returns error strings. */
export function validateCompileConfig(config: CompileConfigShape): string[] {
    const compile = config.compile;
    if (compile === undefined) return [];
    if (
        typeof compile !== "object" ||
        compile === null ||
        Array.isArray(compile)
    ) {
        return [
            "'compile' must be an object, e.g. { include: ['./plugins/*.js'] }",
        ];
    }
    const errors: string[] = [];
    const known = new Set(["include", "bun"]);
    for (const key of Object.keys(compile)) {
        if (!known.has(key)) {
            errors.push(
                `'compile.${key}' is not a known option (supported: include, bun)`,
            );
        }
    }
    const { include, bun } = compile as { include?: unknown; bun?: unknown };
    if (
        bun !== undefined &&
        !(BUN_TOOLCHAINS as readonly unknown[]).includes(bun)
    ) {
        errors.push(
            `'compile.bun' must be one of: ${BUN_TOOLCHAINS.join(", ")} (got ${JSON.stringify(bun)})`,
        );
    } else if (bun === "knext-patched" && !isCompiledVinext(config)) {
        errors.push(
            "'compile.bun' is supported only on the compiled vinext executable " +
                "(build: 'vinext' with the default runtime: 'bun'); remove it for this target",
        );
    }
    if (include === undefined) return errors;
    if (
        !Array.isArray(include) ||
        include.length === 0 ||
        !include.every((g) => typeof g === "string" && g.trim().length > 0)
    ) {
        errors.push(
            "'compile.include' must be a non-empty array of glob strings, relative to the app root",
        );
        return errors;
    }
    if (!isCompiledVinext(config)) {
        errors.push(
            "'compile.include' is supported only on the compiled vinext executable " +
                "(build: 'vinext' with the default runtime: 'bun'); remove it for this target",
        );
    }
    return errors;
}
