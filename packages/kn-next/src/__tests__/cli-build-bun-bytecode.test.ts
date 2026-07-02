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
 *     @bun-cjs`) that DO NOT LOAD UNDER NODE — and they fail SILENTLY there
 *     (empty exports, no diagnostic). Hence the safety design under test:
 *     the ENTRY server.js is left UNTRANSFORMED (its own bytecode win is
 *     negligible) and gets a loud fail-fast guard so `node server.js` on a
 *     bytecode-built image exits 1 with a FATAL message instead of
 *     CrashLooping mutely.
 */

import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** knext-bc-* temp dirs currently present (leak detection). */
function tempDirCount(): number {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("knext-bc-"))
        .length;
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
        // fail-open: tree untouched (no guard either — nothing was compiled)
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
        "transforms dependency .js in place with a companion .jsc, but leaves the entry untransformed",
        () => {
            const { standaloneDir } = seedProject();
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            // page.js only — the entry server.js is deliberately skipped.
            expect(result.compiled).toBe(1);
            expect(result.skipped).toEqual([]);
            expect(
                existsSync(
                    join(standaloneDir, ".next/server/chunks/page.js.jsc"),
                ),
            ).toBe(true);
            const page = readFileSync(
                join(standaloneDir, ".next/server/chunks/page.js"),
                "utf8",
            );
            expect(page).toContain("@bytecode");
            expect(page).toContain('"ORIGINAL"');
            // entry: no pragma, no .jsc — original source plus the guard.
            const entry = readFileSync(
                join(standaloneDir, "server.js"),
                "utf8",
            );
            expect(entry).not.toContain("@bytecode");
            expect(entry).toContain(CJS_SRC.trim());
            expect(existsSync(join(standaloneDir, "server.js.jsc"))).toBe(
                false,
            );
        },
    );

    it.skipIf(!bunAvailable)(
        "guards the entry: `node server.js` on a bytecode-built tree exits 1 with a loud FATAL",
        () => {
            const { standaloneDir } = seedProject();
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            expect(result.guarded).toContain(join(standaloneDir, "server.js"));
            const node = spawnSync(
                process.execPath, // vitest runs under Node
                [join(standaloneDir, "server.js")],
                { stdio: "pipe" },
            );
            expect(node.status).toBe(1);
            expect(node.stderr.toString()).toContain("FATAL");
            expect(node.stderr.toString()).toContain("bun");
            // ...while Bun sails through the guard and loads the module.
            const bun = spawnSync("bun", [join(standaloneDir, "server.js")], {
                stdio: "pipe",
            });
            expect(bun.status).toBe(0);
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
        "never writes through symlinks (pnpm-store hazard): symlinked .js is skipped",
        () => {
            const { projectDir, standaloneDir } = seedProject();
            // a "store" file outside the tree, symlinked into it — the pass
            // must neither transform the link nor mutate the target.
            const store = join(projectDir, "store");
            mkdirSync(store, { recursive: true });
            const target = join(store, "real.js");
            writeFileSync(target, CJS_SRC);
            const link = join(standaloneDir, ".next/server/linked.js");
            symlinkSync(target, link);
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            expect(result.compiled).toBe(1); // page.js only, as before
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(readFileSync(target, "utf8")).toBe(CJS_SRC);
            expect(existsSync(`${link}.jsc`)).toBe(false);
        },
    );

    it.skipIf(!bunAvailable)(
        "fail-open per file: a broken file is left intact (reason reported), the rest still compile",
        () => {
            const { standaloneDir } = seedProject();
            const broken = join(standaloneDir, ".next/server/broken.js");
            writeFileSync(broken, "this is ((( not javascript\n");
            const result = precompileBunBytecode({
                standaloneDir,
                bunBin: "bun",
            });
            expect(result.compiled).toBe(1);
            expect(result.skipped.length).toBe(1);
            expect(result.skipped[0]).toContain("broken.js");
            expect(readFileSync(broken, "utf8")).toBe(
                "this is ((( not javascript\n",
            );
            expect(existsSync(`${broken}.jsc`)).toBe(false);
        },
    );

    it.skipIf(!bunAvailable)(
        "cleans up its temp dirs (969-file trees must not litter tmpdir)",
        () => {
            const { standaloneDir } = seedProject();
            const before = tempDirCount();
            precompileBunBytecode({ standaloneDir, bunBin: "bun" });
            expect(tempDirCount()).toBe(before);
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
        expect(
            existsSync(join(standaloneDir, ".next/server/chunks/page.js.jsc")),
        ).toBe(false);
    });

    it.skipIf(!bunAvailable)("runs the pass for runtime=bun", async () => {
        const { projectDir, standaloneDir } = seedProject();
        mockRuntime = "bun";
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);
        await build({ skipNextBuild: true });
        expect(
            existsSync(join(standaloneDir, ".next/server/chunks/page.js.jsc")),
        ).toBe(true);
        // the entry guard ships on the real build path too
        expect(
            readFileSync(join(standaloneDir, "server.js"), "utf8"),
        ).toContain("FATAL");
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
        expect(
            existsSync(join(standaloneDir, ".next/server/chunks/page.js.jsc")),
        ).toBe(false);
    });

    it.skipIf(!bunAvailable)(
        "composes with the bun-exports heal on one build (behavioral ordering contract)",
        async () => {
            // Seed BOTH fixtures: a heal-able package (bun-condition export
            // target missing from the standalone tree) and a bytecode-able
            // chunk. One build() must do both — proving the pass runs on the
            // same post-build path as the heal, not instead of it.
            const { projectDir, standaloneDir } = seedProject();
            const pkg = {
                name: "fake-react-dom",
                version: "19.9.9",
                exports: {
                    "./server": {
                        bun: "./server.bun.js",
                        node: "./server.node.js",
                        default: "./server.node.js",
                    },
                },
            };
            for (const base of [
                join(projectDir, "node_modules/fake-react-dom"),
                join(standaloneDir, "node_modules/fake-react-dom"),
            ]) {
                mkdirSync(base, { recursive: true });
                writeFileSync(
                    join(base, "package.json"),
                    JSON.stringify(pkg, null, 2),
                );
                writeFileSync(
                    join(base, "server.node.js"),
                    "module.exports = 'node';\n",
                );
            }
            // the bun-condition target exists only in the real node_modules
            writeFileSync(
                join(projectDir, "node_modules/fake-react-dom/server.bun.js"),
                "module.exports = 'bun';\n",
            );
            mockRuntime = "bun";
            vi.spyOn(process, "cwd").mockReturnValue(projectDir);
            await build({ skipNextBuild: true });
            // heal ran: the missing bun-condition target was copied in
            expect(
                existsSync(
                    join(
                        standaloneDir,
                        "node_modules/fake-react-dom/server.bun.js",
                    ),
                ),
            ).toBe(true);
            // bytecode pass ran: chunk transformed
            expect(
                existsSync(
                    join(standaloneDir, ".next/server/chunks/page.js.jsc"),
                ),
            ).toBe(true);
        },
    );
});
