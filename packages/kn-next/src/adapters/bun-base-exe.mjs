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
 * This module IS bundled into the published `@getknext/core` (both compile
 * scripts import it), so the variable exists in what users install. It is
 * refused unless `GITHUB_ACTIONS === "true"`: outside a GitHub Actions job a
 * set `KNEXT_BUN_BASE_EXE` throws with a "CI-only" message instead of
 * compiling against an arbitrary base. That is a guard against accidental use,
 * not a security boundary — anyone can export GITHUB_ACTIONS=true, and anyone
 * who can set environment variables for a build already controls that build.
 *
 * Fail closed. If the variable is present at all (even empty), the file it
 * names must exist, be a regular executable file, and hash to the sha256
 * recorded in the sibling `<path>.sha256` file: exactly one line, either a
 * bare hex digest or `sha256sum` format whose filename is this file's
 * basename. Anything else throws — a compile that silently fell back to the
 * stock base would report a stock-Bun result as a patched-Bun verification.
 *
 * When the variable is absent, the result is `{}`, so spreading it into
 * `compile: { ... }` leaves the Bun.build options exactly as they were.
 *
 * Symlinks are NOT confined: the path is followed wherever it points, and the
 * sha256 check is what binds the bytes. Point it only at a downloaded,
 * signature-verified artifact directory.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

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
    if (env.GITHUB_ACTIONS !== "true") {
        throw new BunBaseExeError(
            "is CI-only (a patched Bun base for verifying upstream fixes) and is refused outside GitHub Actions — unset it",
        );
    }
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
    const lines = readFileSync(sumFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "");
    if (lines.length !== 1) {
        throw new BunBaseExeError(`${sumFile} must hold exactly one line, found ${lines.length}`);
    }
    const m = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(lines[0].trim());
    if (!m) {
        throw new BunBaseExeError(`${sumFile} does not start with a sha256 hex digest`);
    }
    const expected = m[1].toLowerCase();
    if (m[2] !== undefined && basename(m[2]) !== basename(exe)) {
        throw new BunBaseExeError(`${sumFile} names ${m[2]}, not ${basename(exe)}`);
    }
    const actual = createHash("sha256").update(readFileSync(exe)).digest("hex");
    if (actual !== expected) {
        throw new BunBaseExeError(`sha256 mismatch for ${exe}: expected ${expected}, got ${actual}`);
    }
    return { executablePath: exe };
}
