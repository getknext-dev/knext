/**
 * #1872 on vinext × node: `.output/server` runs directly under Node, so the
 * compile-time embed does not apply. Under plain Node ESM the externalized
 * `@vercel/og` 1.0.3 glue dies on esbuild's `__require("fs")` before it even
 * reaches the missing `__dirname/hb.wasm`, and vinext's app-router chunk reads
 * `../../hb.wasm` relative to a dir nitro never ships.
 *
 * `stageOgHarfbuzzForVinextNode` stages the version-pinned `harfbuzzjs`
 * binary (and its licence) into `.output/server` for both shapes. Each case
 * stages, ships ONLY `.output` to a fresh dir, deletes the app dir, and runs
 * the entry with `node` — asserted by exit code.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stageOgHarfbuzzForVinextNode } from "../cli/vinext-build";
import { buildOgApp, cleanupTemps, temp } from "./og-harfbuzz-fixture";

afterAll(cleanupTemps);

function shipAndRunNode(appDir: string) {
    const shipDir = temp("knext-og-hb-node-ship-");
    cpSync(join(appDir, ".output"), join(shipDir, ".output"), {
        recursive: true,
    });
    rmSync(appDir, { recursive: true, force: true });
    return spawnSync(
        "node",
        [join(shipDir, ".output", "server", "index.mjs")],
        {
            cwd: shipDir,
            encoding: "utf-8",
            timeout: 30_000,
        },
    );
}

describe("#1872 — next/og's hb.wasm on vinext × node (staged into .output/server)", () => {
    for (const shape of ["sidecar", "rsc-entry"] as const) {
        it(`${shape}: fails under node WITHOUT staging (the bug, measured)`, () => {
            const { appDir } = buildOgApp({ installedSatori: "0.33.5", shape });
            const run = shipAndRunNode(appDir);
            expect(run.status).not.toBe(0);
        }, 60_000);

        it(`${shape}: staged, the shipped .output runs under node and reads the pinned bytes`, () => {
            const { appDir } = buildOgApp({ installedSatori: "0.33.5", shape });
            const result = stageOgHarfbuzzForVinextNode(appDir);
            expect(result.warnings).toEqual([]);
            // sidecar: the externalized copy only; rsc-entry: that AND vinext's loader
            expect(result.staged.length).toBe(shape === "sidecar" ? 1 : 2);
            for (const file of result.staged) {
                expect(existsSync(file)).toBe(true);
                // the harfbuzzjs licence travels with the binary
                expect(existsSync(`${file}.LICENSE`)).toBe(true);
            }
            const run = shipAndRunNode(appDir);
            expect(run.status, run.stdout + run.stderr).toBe(0);
        }, 60_000);

        it(`${shape}: staging is idempotent (a second run changes nothing and still works)`, () => {
            const { appDir } = buildOgApp({ installedSatori: "0.33.5", shape });
            stageOgHarfbuzzForVinextNode(appDir);
            const again = stageOgHarfbuzzForVinextNode(appDir);
            expect(again.warnings).toEqual([]);
            const run = shipAndRunNode(appDir);
            expect(run.status, run.stdout + run.stderr).toBe(0);
        }, 60_000);

        it(`${shape}: a satori off the exact pin stages nothing and returns a warning`, () => {
            const { appDir } = buildOgApp({ installedSatori: "0.30.0", shape });
            const result = stageOgHarfbuzzForVinextNode(appDir);
            expect(result.staged).toEqual([]);
            expect(result.warnings.length).toBe(1);
            expect(result.warnings[0]).toContain(
                "next/og will fail at runtime",
            );
            const run = shipAndRunNode(appDir);
            expect(run.status).not.toBe(0);
        }, 60_000);
    }

    // Strict mode is honoured on node exactly as in the compiled build: the
    // build (which calls this with no options, so the env decides) FAILS.
    describe("strict requires (KNEXT_COMPILE_STRICT_REQUIRES=1)", () => {
        const saved = process.env.KNEXT_COMPILE_STRICT_REQUIRES;
        afterEach(() => {
            if (saved === undefined)
                delete process.env.KNEXT_COMPILE_STRICT_REQUIRES;
            else process.env.KNEXT_COMPILE_STRICT_REQUIRES = saved;
        });

        it("a pin mismatch THROWS the same actionable message under strict", () => {
            process.env.KNEXT_COMPILE_STRICT_REQUIRES = "1";
            const { appDir } = buildOgApp({
                installedSatori: "0.30.0",
                shape: "sidecar",
            });
            expect(() => stageOgHarfbuzzForVinextNode(appDir)).toThrow(
                "next/og will fail at runtime",
            );
        });

        it("strict off: the same mismatch only warns", () => {
            delete process.env.KNEXT_COMPILE_STRICT_REQUIRES;
            const { appDir } = buildOgApp({
                installedSatori: "0.30.0",
                shape: "sidecar",
            });
            expect(stageOgHarfbuzzForVinextNode(appDir).warnings.length).toBe(
                1,
            );
        });

        it("strict on with matching pins: stages normally, no throw", () => {
            process.env.KNEXT_COMPILE_STRICT_REQUIRES = "1";
            const { appDir } = buildOgApp({
                installedSatori: "0.33.5",
                shape: "sidecar",
            });
            expect(stageOgHarfbuzzForVinextNode(appDir).warnings).toEqual([]);
        });
    });

    it("is a no-op for an app with no next/og in its output", () => {
        const appDir = temp("knext-og-hb-none-");
        const result = stageOgHarfbuzzForVinextNode(appDir);
        expect(result).toEqual({ staged: [], warnings: [] });
    });
});
