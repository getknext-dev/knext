/**
 * The HarfBuzz / harfbuzzjs MIT notice ships with the vinext compiled
 * executable whenever hb.wasm is embedded in it: a notice file is written next
 * to the binary and every runtime image recipe COPYs it. Nothing is written
 * when hb.wasm is not embedded.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildOgApp, cleanupTemps } from "./og-harfbuzz-fixture";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const TEMPLATES = resolve(import.meta.dir, "../../templates/app");
const NOTICE = "knext-third-party-notices.txt";

afterAll(cleanupTemps);

function compile(appDir: string, serverDir: string) {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target =
        process.platform === "darwin"
            ? `bun-darwin-${arch}`
            : `bun-linux-${arch}`;
    const outFile = join(appDir, "og-hb-exec");
    const env = { ...process.env };
    delete env.KNEXT_COMPILE_STRICT_REQUIRES;
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
            target,
        ],
        { encoding: "utf-8", timeout: 90_000, env },
    );
    return { build, outFile };
}

describe("HarfBuzz notice ships with the compiled executable", () => {
    for (const shape of ["sidecar", "rsc-entry"] as const) {
        it(`${shape}: embedded hb.wasm -> the notice sits beside the binary with the licence text`, () => {
            const { appDir, serverDir } = buildOgApp({
                installedSatori: "0.33.5",
                shape,
            });
            const { build, outFile } = compile(appDir, serverDir);
            expect(build.status, build.stdout + build.stderr).toBe(0);
            const notice = join(dirname(outFile), NOTICE);
            expect(existsSync(notice)).toBe(true);
            const text = readFileSync(notice, "utf8");
            expect(text).toContain("MIT for the rest of the project");
            expect(text).toContain("harfbuzzjs");
            expect(text).toContain("HarfBuzz");
        }, 120_000);

        it(`${shape}: hb.wasm not embedded -> no notice is written`, () => {
            const { appDir, serverDir } = buildOgApp({
                installedSatori: "0.30.0",
                shape,
            });
            const { build, outFile } = compile(appDir, serverDir);
            expect(build.status, build.stdout + build.stderr).toBe(0);
            expect(existsSync(join(dirname(outFile), NOTICE))).toBe(false);
        }, 120_000);
    }

    for (const name of ["Dockerfile.hbs", "Dockerfile.self-contained.hbs"]) {
        it(`${name} COPYs the notice into the image (tolerating its absence)`, () => {
            const text = readFileSync(join(TEMPLATES, name), "utf8");
            // glob form: a bracket char class so a no-match is not a build error
            expect(text).toMatch(
                /^COPY knext-third-party-notices\.tx\[t\] \/app\/$/m,
            );
        });
    }
});
