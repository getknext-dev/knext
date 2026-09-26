export const BUN_BASE_EXE_ENV: "KNEXT_BUN_BASE_EXE";
export class BunBaseExeError extends Error {
    constructor(message: string);
}
/** Spread into Bun.build's `compile`; `{}` when the variable is absent. Throws outside GitHub Actions. */
export function bunBaseExeCompileOptions(env?: Record<string, string | undefined>): {
    executablePath?: string;
};
