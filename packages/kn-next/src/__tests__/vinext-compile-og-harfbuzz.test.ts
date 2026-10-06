/**
 * #1872 — `next/og` on the vinext × bun compiled executable 500s with
 * `ENOENT … hb.wasm`.
 *
 * `@vercel/og` 1.x inlines harfbuzzjs's Emscripten glue, and 1.0.3 (the
 * version vinext 1.0.1 pins) ships no `dist/hb.wasm`. Two shapes reach the
 * compile (see og-harfbuzz-fixture.ts): nitro's externalized copy (pages
 * router), and the app-router chunk vinext's own og plugins rewrote to a path
 * nitro never ships. The compile embeds the `hb.wasm` from the exact
 * dependency chain the glue was built from (`@vercel/og` → `satori` →
 * `harfbuzzjs`) for both.
 *
 * Each case compiles through the SHIPPED script, moves the binary to a fresh
 * dir, DELETES the app dir, and runs it — asserted by EXIT CODE (the entry
 * exits non-zero unless it read the fixture's own wasm bytes). The pin
 * mismatch cases also assert the build-time signal: a loud warning by
 * default, a failed build under strict requires.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildOgApp, cleanupTemps, temp } from "./og-harfbuzz-fixture";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

afterAll(cleanupTemps);

function hostTarget(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return process.platform === "darwin"
        ? `bun-darwin-${arch}`
        : `bun-linux-${arch}`;
}

function compile(appDir: string, serverDir: string, strict = false) {
    const outFile = join(appDir, "og-hb-exec");
    const env = { ...process.env };
    delete env.KNEXT_COMPILE_STRICT_REQUIRES;
    if (strict) env.KNEXT_COMPILE_STRICT_REQUIRES = "1";
    const build = spawnSync(
        "bun",
        [
            "run",
            COMPILE,
            "--entry",
            join(serverDir, "index.mjs"),
            "--outfile",
            outFile,
            "--target",
            hostTarget(),
        ],
        { encoding: "utf-8", timeout: 90_000, env },
    );
    return { build, outFile };
}

/** Ship the binary alone, delete the app dir, run it. */
function shipAndRun(appDir: string, outFile: string) {
    expect(existsSync(outFile)).toBe(true);
    const shipDir = temp("knext-og-hb-ship-");
    const shipped = join(shipDir, "og-hb-exec");
    // rename, not copy: same tmpfs, and it keeps this suite's disk I/O down
    // (each binary is tens of MB, and CI runs files in parallel)
    renameSync(outFile, shipped);
    rmSync(appDir, { recursive: true, force: true });
    return spawnSync(shipped, [], {
        cwd: shipDir,
        encoding: "utf-8",
        timeout: 30_000,
    });
}

describe("#1872 — @vercel/og's harfbuzz hb.wasm survives the compiled executable", () => {
    for (const shape of ["sidecar", "rsc-entry"] as const) {
        it(`${shape}: embeds harfbuzzjs/hb.wasm; the shipped binary reads it with the app dir gone`, () => {
            const { appDir, serverDir } = buildOgApp({
                installedSatori: "0.33.5",
                shape,
            });
            const { build, outFile } = compile(appDir, serverDir);
            expect(build.status, build.stdout + build.stderr).toBe(0);
            const run = shipAndRun(appDir, outFile);
            expect(run.status, run.stdout + run.stderr).toBe(0);
        }, 120_000);

        it(`${shape}: a satori off the exact pin embeds nothing, WARNS at build, and the read still fails`, () => {
            const { appDir, serverDir } = buildOgApp({
                installedSatori: "0.30.0",
                shape,
            });
            const { build, outFile } = compile(appDir, serverDir);
            expect(build.status, build.stdout + build.stderr).toBe(0);
            expect(build.stdout + build.stderr).toContain(
                "WARNING: next/og will fail at runtime",
            );
            const run = shipAndRun(appDir, outFile);
            expect(run.status).not.toBe(0);
        }, 120_000);

        it(`${shape}: the same pin mismatch FAILS the build under strict requires`, () => {
            const { appDir, serverDir } = buildOgApp({
                installedSatori: "0.30.0",
                shape,
            });
            const { build, outFile } = compile(appDir, serverDir, true);
            expect(build.status).not.toBe(0);
            expect(existsSync(outFile)).toBe(false);
        }, 120_000);
    }
});
