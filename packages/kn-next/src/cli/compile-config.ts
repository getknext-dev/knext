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
 */

export interface CompileConfigShape {
    readonly compile?: unknown;
    readonly build?: unknown;
    readonly runtime?: unknown;
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
    const known = new Set(["include"]);
    for (const key of Object.keys(compile)) {
        if (!known.has(key)) {
            errors.push(
                `'compile.${key}' is not a known option (supported: include)`,
            );
        }
    }
    const { include } = compile as { include?: unknown };
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
    const runtime = config.runtime ?? "bun";
    if (config.build !== "vinext" || runtime !== "bun") {
        errors.push(
            "'compile.include' is supported only on the compiled vinext executable " +
                "(build: 'vinext' with the default runtime: 'bun'); remove it for this target",
        );
    }
    return errors;
}
