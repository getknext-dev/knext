/**
 * #1452 — the `KNEXT_BUN_BASE_EXE` seam (CI-only patched Bun base executable).
 *
 * Three layers, each red on its own mutation:
 *   1. SCAN, not enumerate: every adapter script that hands `compile:` to
 *      `Bun.build` must resolve the seam through `bunBaseExeCompileOptions()`
 *      and spread it into that compile object — a new compile script without
 *      the seam fails here without anyone adding it to a list. The seam must
 *      never be readable from config or CLI flags (CI-only by decision).
 *   2. The fail-closed table of `bunBaseExeCompileOptions()`.
 *   3. Both real scripts, run as processes with `Bun.build` stubbed by a
 *      preload, so the assertion is on what the scripts actually hand to
 *      Bun.build: absent → no `executablePath` key at all; a verified base →
 *      `executablePath`; every bad state → exit 1 before Bun.build runs.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    BUN_BASE_EXE_ENV,
    bunBaseExeCompileOptions,
} from "../adapters/bun-base-exe.mjs";

const ADAPTERS = resolve(import.meta.dir, "..", "adapters");
const SRC = resolve(import.meta.dir, "..");

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(d);
    return d;
}
function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** A fake base executable with a valid sibling `.sha256`. */
function verifiedBase(): string {
    const dir = tmp("knext-bun-base-");
    const exe = join(dir, "bun");
    copyFileSync(process.execPath, exe);
    chmodSync(exe, 0o755);
    writeFileSync(`${exe}.sha256`, `${sha256(readFileSync(exe))}  bun\n`);
    return exe;
}

// ── 1. scan ──────────────────────────────────────────────────────────────────

/** The body of the `compile: { … }` object inside a `Bun.build({ … })` call. */
function compileBlocks(source: string): string[] {
    const blocks: string[] = [];
    for (const build of source.matchAll(/Bun\.build\(\s*\{/g)) {
        const at = source.indexOf("compile:", build.index);
        if (at < 0) continue;
        const open = source.indexOf("{", at);
        let depth = 0;
        for (let i = open; i < source.length; i++) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}" && --depth === 0) {
                blocks.push(source.slice(open, i + 1));
                break;
            }
        }
    }
    return blocks;
}

describe("KNEXT_BUN_BASE_EXE seam — scan", () => {
    const scripts = readdirSync(ADAPTERS)
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => ({
            file: f,
            source: readFileSync(join(ADAPTERS, f), "utf8"),
        }))
        .filter(({ source }) => compileBlocks(source).length > 0);

    it("finds the compile scripts (a scan that finds nothing proves nothing)", () => {
        const names = scripts.map((s) => s.file);
        expect(names).toContain("vinext-compile.mjs");
        expect(names).toContain("standalone-compile.mjs");
    });

    for (const { file, source } of scripts) {
        it(`${file} resolves the seam and spreads it into every compile object`, () => {
            expect(source).toContain(
                'import { bunBaseExeCompileOptions } from "./bun-base-exe.mjs";',
            );
            expect(source).toMatch(
                /BUN_BASE_EXE = bunBaseExeCompileOptions\(\);/,
            );
            for (const block of compileBlocks(source)) {
                expect(block).toContain("...BUN_BASE_EXE");
                // The seam is the ONLY source of executablePath.
                expect(block).not.toContain("executablePath");
            }
        });
    }

    it("is never read from config or the CLI (CI-only by decision)", () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name !== "__tests__") walk(p);
                } else if (/\.(ts|mts|js|mjs|cjs)$/.test(e.name)) {
                    if (p === join(ADAPTERS, "bun-base-exe.mjs")) continue;
                    if (readFileSync(p, "utf8").includes(BUN_BASE_EXE_ENV))
                        offenders.push(p);
                }
            }
        };
        walk(SRC);
        expect(offenders).toEqual([]);
    });
});

// ── 2. fail-closed table ─────────────────────────────────────────────────────

describe("bunBaseExeCompileOptions — fail closed", () => {
    it("absent → {} with no own keys (compile options unchanged)", () => {
        const out = bunBaseExeCompileOptions({});
        expect(Object.keys(out)).toEqual([]);
        const base = { outfile: "x", target: "bun-linux-x64" };
        expect({ ...base, ...out }).toStrictEqual(base);
    });

    it("a verified base → its absolute executablePath", () => {
        const exe = verifiedBase();
        expect(bunBaseExeCompileOptions({ [BUN_BASE_EXE_ENV]: exe })).toEqual({
            executablePath: exe,
        });
    });

    it("accepts a bare-hex .sha256 as well as sha256sum format", () => {
        const exe = verifiedBase();
        writeFileSync(`${exe}.sha256`, sha256(readFileSync(exe)).toUpperCase());
        expect(
            bunBaseExeCompileOptions({ [BUN_BASE_EXE_ENV]: exe })
                .executablePath,
        ).toBe(exe);
    });

    const cases: Array<[string, () => string, RegExp]> = [
        ["set but empty", () => "", /set but empty/],
        ["whitespace only", () => "   ", /set but empty/],
        [
            "missing file",
            () => join(tmp("knext-bun-base-"), "nope"),
            /does not exist/,
        ],
        ["a directory", () => tmp("knext-bun-base-"), /not a regular file/],
        [
            "not executable",
            () => {
                const exe = verifiedBase();
                chmodSync(exe, 0o644);
                return exe;
            },
            /not executable/,
        ],
        [
            "missing .sha256",
            () => {
                const exe = verifiedBase();
                rmSync(`${exe}.sha256`);
                return exe;
            },
            /\.sha256 is missing/,
        ],
        [
            "malformed .sha256",
            () => {
                const exe = verifiedBase();
                writeFileSync(`${exe}.sha256`, "not-a-digest  bun\n");
                return exe;
            },
            /does not start with a sha256/,
        ],
        [
            "sha256 mismatch",
            () => {
                const exe = verifiedBase();
                writeFileSync(`${exe}.sha256`, `${"0".repeat(64)}  bun\n`);
                return exe;
            },
            /sha256 mismatch/,
        ],
    ];
    for (const [name, value, message] of cases) {
        it(`${name} → throws`, () => {
            expect(() =>
                bunBaseExeCompileOptions({ [BUN_BASE_EXE_ENV]: value() }),
            ).toThrow(message);
        });
    }
});

// ── 3. the real scripts, Bun.build stubbed ───────────────────────────────────

const STUB_MARK = "KNEXT_TEST_STUB_BUILD ";

function stubPreload(): string {
    const p = join(tmp("knext-bun-base-stub-"), "stub.mjs");
    writeFileSync(
        p,
        `Bun.build = async (o) => { console.log(${JSON.stringify(STUB_MARK)} + JSON.stringify(o.compile)); process.exit(0); };\n`,
    );
    return p;
}

function vinextFixture(): string[] {
    const d = tmp("knext-bun-base-vinext-");
    const entry = join(d, ".output/server/index.mjs");
    write(entry, 'export default "ok";\n');
    return [
        join(ADAPTERS, "vinext-compile.mjs"),
        "--entry",
        entry,
        "--outfile",
        join(d, "exe"),
    ];
}

function standaloneFixture(): string[] {
    const d = tmp("knext-bun-base-standalone-");
    const s = join(d, ".next/standalone");
    write(
        join(s, "server.js"),
        `const path = require('path')

const dir = path.join(__dirname)

process.env.NODE_ENV = 'production'
process.chdir(__dirname)

const currentPort = parseInt(process.env.PORT, 10) || 3000
const nextConfig = {}

require('next')
const { startServer } = require('next/dist/server/lib/start-server')

startServer({ dir, isDev: false, config: nextConfig, port: currentPort }).catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
    );
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"0.0.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        "exports.startServer = async () => {};",
    );
    return [
        join(ADAPTERS, "standalone-compile.mjs"),
        "--server",
        join(s, "server.js"),
        "--outfile",
        join(d, "exe"),
    ];
}

function run(argv: string[], base: string | undefined) {
    const env: Record<string, string> = { ...process.env } as Record<
        string,
        string
    >;
    delete env[BUN_BASE_EXE_ENV];
    if (base !== undefined) env[BUN_BASE_EXE_ENV] = base;
    const r = spawnSync(
        process.execPath,
        ["--preload", stubPreload(), ...argv],
        {
            env,
            encoding: "utf8",
        },
    );
    const line = r.stdout.split("\n").find((l) => l.startsWith(STUB_MARK));
    return {
        status: r.status,
        stderr: r.stderr,
        compile: line ? JSON.parse(line.slice(STUB_MARK.length)) : undefined,
    };
}

for (const [name, fixture] of [
    ["vinext-compile.mjs", vinextFixture],
    ["standalone-compile.mjs", standaloneFixture],
] as const) {
    describe(`${name} — seam end to end`, () => {
        it("absent → reaches Bun.build with no executablePath key", () => {
            const r = run(fixture(), undefined);
            expect(r.status).toBe(0);
            expect(r.compile).toBeDefined();
            expect(Object.hasOwn(r.compile, "executablePath")).toBe(false);
        });

        it("a verified base → Bun.build gets it as compile.executablePath", () => {
            const exe = verifiedBase();
            const r = run(fixture(), exe);
            expect(r.status).toBe(0);
            expect(r.compile?.executablePath).toBe(exe);
        });

        it("a bad base → exit 1 before Bun.build, naming the variable", () => {
            const exe = verifiedBase();
            writeFileSync(`${exe}.sha256`, `${"0".repeat(64)}  bun\n`);
            const r = run(fixture(), exe);
            expect(r.status).toBe(1);
            expect(r.compile).toBeUndefined();
            expect(r.stderr).toContain(`${BUN_BASE_EXE_ENV}: sha256 mismatch`);
        });

        it("set but empty → exit 1 (no silent fallback to stock Bun)", () => {
            const r = run(fixture(), "");
            expect(r.status).toBe(1);
            expect(r.compile).toBeUndefined();
        });
    });
}
