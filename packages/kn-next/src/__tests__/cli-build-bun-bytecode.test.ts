/**
 * Per-file Bun bytecode precompilation on the build path (runtime=bun).
 *
 * Mechanism (all verified empirically on Bun 1.3.5 against a real
 * next@16.2.4 standalone tree — see PR #193):
 *   - Bundling the standalone entry (`bun build server.js --bytecode`)
 *     HARD-FAILS (standalone-pruned dev requires; runtime-computed chunk
 *     requires) — that path stays rejected.
 *   - But `bun build <file> --bytecode --target=bun --format=cjs
 *     --external '*'` transforms ONE file with its require graph untouched
 *     (all requires preserved verbatim) and emits a companion `<file>.jsc`.
 *   - Bun's RUNTIME consumes the companion .jsc for require()'d files, not
 *     just the entry (measured: 60ms vs 85ms requiring a 2.4MB module), with
 *     hash validation — stale/corrupt/other-version .jsc falls back to
 *     source silently. Full-tree result: 287ms → 152ms median startup
 *     (-47%), N=12.
 *   - The transformed files are pragma'd CJS wrappers (`// @bun @bytecode
 *     @bun-cjs`) that DO NOT LOAD UNDER NODE (module.exports never assigned)
 *     — verified: a transformed tree never boots under Node. Hence the pass
 *     is GATED on config.runtime === "bun", unlike the additive exports heal.
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { precompileBunBytecode } from "../adapters/standalone-bun-bytecode";

// Mutable runtime so one mock serves both gate directions.
let mockRuntime: string | undefined = "node";
vi.mock("../cli/shared", () => ({
    loadConfig: vi.fn(async () => ({
        name: "bytecode-test-app",
        storage: { provider: "gcs", bucket: "test-bucket" },
        cache: undefined,
        runtime: mockRuntime,
    })),
}));
vi.mock("../utils/asset-upload", () => ({
    uploadAssets: vi.fn(async () => {}),
}));

import { spawnSync } from "node:child_process";
import { build } from "../cli/build";

const bunAvailable = (() => {
    try {
        return spawnSync("bun", ["--version"], { stdio: "pipe" }).status === 0;
    } catch {
        return false;
    }
})();

const CJS_SRC = 'module.exports = { marker: "ORIGINAL" };\n';
const STATIC_SRC = "window.__client = 1;\n";

/** Project dir shaped like an app AFTER `next build`. */
function seedProject() {
    const projectDir = mkdtempSync(join(tmpdir(), "knext-bytecode-"));
    const standaloneDir = join(projectDir, ".next/standalone");
    mkdirSync(join(standaloneDir, ".next/server/chunks"), { recursive: true });
    mkdirSync(join(standaloneDir, ".next/static/chunks"), { recursive: true });
    writeFileSync(join(standaloneDir, "server.js"), CJS_SRC);
    writeFileSync(join(standaloneDir, ".next/server/chunks/page.js"), CJS_SRC);
    writeFileSync(
        join(standaloneDir, ".next/static/chunks/client.js"),
        STATIC_SRC,
    );
    return { projectDir, standaloneDir };
}

afterEach(() => {
    vi.restoreAllMocks();
    mockRuntime = "node";
    delete process.env.KNEXT_BUN_BYTECODE;
});

describe("precompileBunBytecode (module)", () => {
    it("never throws and reports disabled when the bun binary is missing", () => {
        const { standaloneDir } = seedProject();
        const result = precompileBunBytecode({
            standaloneDir,
            bunBin: "/nonexistent/definitely-not-bun",
        });
        expect(result.compiled).toBe(0);
        expect(result.disabled).toBeTruthy();
        // fail-open: tree untouched
        expect(readFileSync(join(standaloneDir, "server.js"), "utf8")).toBe(
            CJS_SRC,
        );
    });

    it("never throws on a missing standalone dir", () => {
        const result = precompileBunBytecode({
            standaloneDir: join(tmpdir(), "does-not-exist-knext"),
        });
        expect(result.compiled).toBe(0);
    });

    it.skipIf(!bunAvailable)(
        "transforms server-side .js in place with a companion .jsc, graph untouched",
        () => {
            const { standaloneDir } = seedProject();
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            expect(result.compiled).toBe(2); // server.js + chunks/page.js
            expect(result.skipped).toEqual([]);
            const transformed = readFileSync(
                join(standaloneDir, "server.js"),
                "utf8",
            );
            expect(transformed).toContain("@bytecode");
            expect(transformed).toContain('"ORIGINAL"');
            expect(existsSync(join(standaloneDir, "server.js.jsc"))).toBe(true);
            expect(
                existsSync(
                    join(standaloneDir, ".next/server/chunks/page.js.jsc"),
                ),
            ).toBe(true);
        },
    );

    it.skipIf(!bunAvailable)(
        "never touches .next/static (bytes are served verbatim to browsers)",
        () => {
            const { standaloneDir } = seedProject();
            precompileBunBytecode({ standaloneDir, bunBin: "bun" });
            expect(
                readFileSync(
                    join(standaloneDir, ".next/static/chunks/client.js"),
                    "utf8",
                ),
            ).toBe(STATIC_SRC);
            expect(
                existsSync(
                    join(standaloneDir, ".next/static/chunks/client.js.jsc"),
                ),
            ).toBe(false);
        },
    );

    it.skipIf(!bunAvailable)(
        "fail-open per file: a broken file is left intact, the rest still compile",
        () => {
            const { standaloneDir } = seedProject();
            const broken = join(standaloneDir, ".next/server/broken.js");
            writeFileSync(broken, "this is ((( not javascript\n");
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            expect(result.compiled).toBe(2);
            expect(result.skipped.length).toBe(1);
            expect(readFileSync(broken, "utf8")).toBe(
                "this is ((( not javascript\n",
            );
            expect(existsSync(`${broken}.jsc`)).toBe(false);
        },
    );
});

describe("kn-next build — bytecode pass gating (runtime knob)", () => {
    it("does NOT run the pass for runtime=node (transformed files cannot load under Node)", async () => {
        const { projectDir, standaloneDir } = seedProject();
        mockRuntime = "node";
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);
        await build({ skipNextBuild: true });
        expect(readFileSync(join(standaloneDir, "server.js"), "utf8")).toBe(
            CJS_SRC,
        );
        expect(existsSync(join(standaloneDir, "server.js.jsc"))).toBe(false);
    });

    it.skipIf(!bunAvailable)("runs the pass for runtime=bun", async () => {
        const { projectDir, standaloneDir } = seedProject();
        mockRuntime = "bun";
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);
        await build({ skipNextBuild: true });
        expect(existsSync(join(standaloneDir, "server.js.jsc"))).toBe(true);
    });

    it("KNEXT_BUN_BYTECODE=0 opts out even for runtime=bun", async () => {
        const { projectDir, standaloneDir } = seedProject();
        mockRuntime = "bun";
        process.env.KNEXT_BUN_BYTECODE = "0";
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);
        await build({ skipNextBuild: true });
        expect(readFileSync(join(standaloneDir, "server.js"), "utf8")).toBe(
            CJS_SRC,
        );
        expect(existsSync(join(standaloneDir, "server.js.jsc"))).toBe(false);
    });

    it("build.ts invokes the pass on the post-build path, gated (source contract)", () => {
        const src = readFileSync(
            resolve(import.meta.dirname, "../cli/build.ts"),
            "utf8",
        );
        expect(src).toContain("precompileBunBytecode");
        // gated on the bun runtime, after the heal, before completion.
        expect(src.lastIndexOf("precompileBunBytecode(")).toBeGreaterThan(
            src.lastIndexOf("healBunExportTargets("),
        );
        expect(src.lastIndexOf("precompileBunBytecode(")).toBeLessThan(
            src.indexOf("Build complete!"),
        );
        expect(src).toMatch(/runtime\s*===?\s*"bun"/);
    });
});
