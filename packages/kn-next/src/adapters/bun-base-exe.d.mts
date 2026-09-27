export const BUN_BASE_EXE_ENV: "KNEXT_BUN_BASE_EXE";
export class BunBaseExeError extends Error {
    constructor(message: string);
}
/** Spread into Bun.build's `compile`; `{}` when the variable is absent. Throws outside GitHub Actions. */
export function bunBaseExeCompileOptions(env?: Record<string, string | undefined>): {
    executablePath?: string;
};
/** Throws the seam's resolution error (resolved once, at import, from `process.env`), if any. */
export function assertBunBaseExe(): void;
/** The only way to build a `compile` value: merges `parts`, refuses a foreign executable path, appends the seam last. */
export function sealCompile(...parts: Array<Record<string, unknown> | undefined>): Readonly<Record<string, unknown>>;
