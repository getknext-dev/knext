/**
 * `KNEXT_BUN_BASE_EXE` — the CI-only seam that points a compile at a patched
 * Bun base executable (the `infra/bun-base/` pipeline) instead of the Bun
 * running the compile script.
 *
 * CI-verification only. The patched base exists to TEST upstream Bun fixes
 * against knext's compile before they are released; it is never shipped to
 * users. That is why the seam is an environment variable and nothing else:
 * it is deliberately not a `kn-next.config.ts` key and not a CLI flag.
 *
 * Fail closed. If the variable is present at all (even empty), the file it
 * names must exist, be a regular executable file, and hash to the sha256
 * recorded in the sibling `<path>.sha256` file (`sha256sum` format or a bare
 * hex digest). Anything else throws — a compile that silently fell back to the
 * stock base would report a stock-Bun result as a patched-Bun verification.
 *
 * When the variable is absent, the result is `{}`, so spreading it into
 * `compile: { ... }` leaves the Bun.build options exactly as they were.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const BUN_BASE_EXE_ENV = "KNEXT_BUN_BASE_EXE";

export class BunBaseExeError extends Error {
    constructor(message) {
        super(`${BUN_BASE_EXE_ENV}: ${message}`);
        this.name = "BunBaseExeError";
    }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ executablePath?: string }} spread into Bun.build's `compile`
 */
export function bunBaseExeCompileOptions(env = process.env) {
    if (!Object.hasOwn(env, BUN_BASE_EXE_ENV)) return {};
    const raw = env[BUN_BASE_EXE_ENV];
    if (typeof raw !== "string" || raw.trim() === "") {
        throw new BunBaseExeError("is set but empty — unset it to compile with the stock Bun base");
    }
    const exe = resolve(raw.trim());
    if (!existsSync(exe)) throw new BunBaseExeError(`${exe} does not exist`);
    if (!statSync(exe).isFile()) throw new BunBaseExeError(`${exe} is not a regular file`);
    try {
        accessSync(exe, constants.X_OK);
    } catch {
        throw new BunBaseExeError(`${exe} is not executable`);
    }
    const sumFile = `${exe}.sha256`;
    if (!existsSync(sumFile)) {
        throw new BunBaseExeError(`${sumFile} is missing — the base executable must ship with its sha256`);
    }
    const expected = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/.test(expected)) {
        throw new BunBaseExeError(`${sumFile} does not start with a sha256 hex digest`);
    }
    const actual = createHash("sha256").update(readFileSync(exe)).digest("hex");
    if (actual !== expected) {
        throw new BunBaseExeError(`sha256 mismatch for ${exe}: expected ${expected}, got ${actual}`);
    }
    return { executablePath: exe };
}
