/**
 * The compiled standalone-on-Bun cell: the entry knext compiles is Next's own
 * generated `server.js`, re-anchored so it runs from a single executable.
 *
 * Next emits `server.js` in two shapes — CommonJS, and an ESM variant (for a
 * `"type": "module"` app) that reaches `next` through `module.createRequire`.
 * The ESM variant is the dangerous one: a bundler does not follow a
 * createRequire'd `require('next')`, so compiling it verbatim yields a binary
 * that bundles NOTHING and loads all of Next from disk — bytecode for a
 * forty-line file. Both shapes must therefore normalise to the same CommonJS
 * entry whose `require('next')` is static.
 *
 * Every anchor is asserted to occur exactly once, so a future Next that changes
 * the shape fails the build rather than booting a server rooted in the
 * binary's virtual filesystem.
 */

import { describe, expect, it } from "bun:test";
import {
    DEV_ONLY_STUB_SOURCE,
    STANDALONE_DIR_BINDING,
    splitBareSpecifier,
    standaloneExecEntrySource,
} from "../adapters/standalone-exec-entry.mjs";

/** Verbatim head of `server.js` from `next build` 16.3.3, CommonJS app. */
const CJS_SERVER = `const path = require('path')

const dir = path.join(__dirname)

process.env.NODE_ENV = 'production'
process.chdir(__dirname)

const currentPort = parseInt(process.env.PORT, 10) || 3000
const nextConfig = {"distDir":"./.next"}

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)

require('next')
const { startServer } = require('next/dist/server/lib/start-server')

startServer({ dir, isDev: false, config: nextConfig, port: currentPort })
`;

/** Verbatim head of `server.js` from `next build` 16.3.3, `"type": "module"` app. */
const ESM_SERVER = `performance.mark('next-start');
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import module from 'node:module'
const require = module.createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))


const dir = path.join(__dirname)

process.env.NODE_ENV = 'production'
process.chdir(__dirname)

const nextConfig = {"distDir":"./.next"}
require('next')
const { startServer } = require('next/dist/server/lib/start-server')

startServer({ dir, isDev: false, config: nextConfig })
`;

const PRELOADS = ["/pkg/dist/adapters/a.cjs", "/pkg/dist/adapters/b.cjs"];

describe("standaloneExecEntrySource — CommonJS server.js", () => {
    const out = standaloneExecEntrySource(CJS_SERVER, PRELOADS);

    it("anchors the server on the executable's directory, never __dirname", () => {
        expect(out).not.toMatch(/\b__dirname\b/);
        expect(out).toContain(`const dir = ${STANDALONE_DIR_BINDING}`);
        expect(out).toContain(`process.chdir(${STANDALONE_DIR_BINDING})`);
        expect(out).toContain("process.env.KNEXT_STANDALONE_DIR");
        expect(out).toContain("dirname(process.execPath)");
    });

    it("keeps require('next') static, so the bundler compiles Next into the binary", () => {
        expect(out).toContain("require('next')");
        expect(out).toContain("require('next/dist/server/lib/start-server')");
    });

    it("bakes the preloads in as the first requires, in order, before server.js runs", () => {
        const a = out.indexOf(`require(${JSON.stringify(PRELOADS[0])})`);
        const b = out.indexOf(`require(${JSON.stringify(PRELOADS[1])})`);
        const next = out.indexOf("require('next')");
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThan(a);
        expect(next).toBeGreaterThan(b);
    });
});

describe("standaloneExecEntrySource — ESM server.js", () => {
    const out = standaloneExecEntrySource(ESM_SERVER, PRELOADS);

    it("drops createRequire so require('next') is a STATIC require the bundler follows", () => {
        expect(out).not.toContain("createRequire");
        expect(out).not.toContain("import.meta");
        expect(out).not.toMatch(/^\s*import\s/m);
        expect(out).toContain("require('next')");
    });

    it("rebinds `path` as a CommonJS require (the ESM import is gone)", () => {
        expect(out).toContain('const path = require("node:path")');
    });

    it("anchors the server on the executable's directory, never __dirname", () => {
        expect(out).not.toMatch(/\b__dirname\b/);
        expect(out).toContain(`const dir = ${STANDALONE_DIR_BINDING}`);
    });

    it("keeps the performance mark", () => {
        expect(out).toContain("performance.mark('next-start')");
    });
});

describe("standaloneExecEntrySource — an unknown shape fails closed", () => {
    it("throws when the __dirname anchor is missing", () => {
        expect(() =>
            standaloneExecEntrySource(
                CJS_SERVER.replace("path.join(__dirname)", "path.resolve('.')"),
                [],
            ),
        ).toThrow(/const dir = path.join\(__dirname\)/);
    });

    it("throws when an anchor occurs twice", () => {
        expect(() =>
            standaloneExecEntrySource(
                `${CJS_SERVER}\nprocess.chdir(__dirname)\n`,
                [],
            ),
        ).toThrow(/2 occurrence/);
    });

    it("throws when an ESM server.js carries only part of the known header", () => {
        const partial = ESM_SERVER.replace(
            "const require = module.createRequire(import.meta.url)\n",
            "",
        );
        expect(() => standaloneExecEntrySource(partial, [])).toThrow();
    });

    it("throws when __dirname survives anywhere else in the file", () => {
        expect(() =>
            standaloneExecEntrySource(
                `${CJS_SERVER}\nconsole.log(__dirname)\n`,
                [],
            ),
        ).toThrow(/__dirname/);
    });
});

describe("DEV_ONLY_STUB_SOURCE — dev-only modules fail loudly if production ever reaches them", () => {
    const load = () => {
        const module = { exports: {} as Record<string, unknown> };
        new Function("module", DEV_ONLY_STUB_SOURCE)(module);
        return module.exports;
    };

    it("loads without throwing (a require in a dead branch costs nothing)", () => {
        expect(load).not.toThrow();
    });

    it("stays benign for bundler interop and promise probing", () => {
        const stub = load();
        expect(stub.__esModule).toBeUndefined();
        expect(stub.then).toBeUndefined();
        expect(
            (stub as Record<symbol, unknown>)[Symbol.toStringTag],
        ).toBeUndefined();
    });

    it("THROWS on any real use, naming the property — never returns undefined", () => {
        const stub = load();
        expect(() => stub.default).toThrow(/dev-only Next module.*default/);
        expect(() => stub.createHotReloader).toThrow(/createHotReloader/);
    });
});

describe("splitBareSpecifier", () => {
    it("splits plain, deep, scoped and scoped-deep specifiers", () => {
        expect(splitBareSpecifier("next")).toEqual({
            name: "next",
            subpath: ".",
        });
        expect(splitBareSpecifier("react-dom/server")).toEqual({
            name: "react-dom",
            subpath: "./server",
        });
        expect(splitBareSpecifier("@swc/helpers")).toEqual({
            name: "@swc/helpers",
            subpath: ".",
        });
        expect(
            splitBareSpecifier("@swc/helpers/_/_interop_require_default"),
        ).toEqual({
            name: "@swc/helpers",
            subpath: "./_/_interop_require_default",
        });
    });
});

describe("standaloneExecEntrySource — self-contained mode (#1456)", () => {
    const SC = {
        appRel: "apps/fm",
        distDir: ".next",
        extensionless: ["BUILD_ID"],
    };

    it("disk mode is byte-identical with the option absent or empty", () => {
        const base = standaloneExecEntrySource(CJS_SERVER, PRELOADS);
        expect(standaloneExecEntrySource(CJS_SERVER, PRELOADS, {})).toBe(base);
        expect(base).not.toContain("__knextEmbed");
        expect(base).not.toContain("nextConfig.distDir =");
    });

    it("rewrites distDir BEFORE Next serialises the config for its workers, and keeps dir + chdir on disk", () => {
        const out = standaloneExecEntrySource(CJS_SERVER, PRELOADS, {
            selfContained: SC,
        });
        const rewrite = out.indexOf("nextConfig.distDir = ");
        const serialise = out.indexOf(
            "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)",
        );
        expect(rewrite).toBeGreaterThan(out.indexOf("const nextConfig = "));
        expect(rewrite).toBeLessThan(serialise);
        expect(out).toContain(`const dir = ${STANDALONE_DIR_BINDING}`);
        expect(out).toContain(`process.chdir(${STANDALONE_DIR_BINDING})`);
    });

    it("refuses a server.js with no config-serialisation anchor rather than guess", () => {
        expect(() =>
            standaloneExecEntrySource(ESM_SERVER, PRELOADS, {
                selfContained: SC,
            }),
        ).toThrow(/__NEXT_PRIVATE_STANDALONE_CONFIG/);
    });

    /**
     * Run the generated prologue + distDir rewrite in a child, with
     * `process.argv[1]` set to what a compiled executable reports, a cwd that
     * is NOT the executable's directory, and a real disk `.next/static` beside
     * the "executable". Proves the anchor comes from argv[1]/execPath — never
     * the cwd — and that static/ and BUILD_ID are aliased.
     */
    function runPrologue(argv1: string) {
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
            require("node:fs") as typeof import("node:fs");
        const { join } = require("node:path") as typeof import("node:path");
        const { tmpdir } = require("node:os") as typeof import("node:os");
        const disk = mkdtempSync(join(tmpdir(), "knext-sc-prologue-"));
        const elsewhere = mkdtempSync(join(tmpdir(), "knext-sc-cwd-"));
        try {
            mkdirSync(join(disk, ".next", "static"), { recursive: true });
            writeFileSync(join(disk, ".next", "static", "a.js"), "static-ok");
            const out = standaloneExecEntrySource(CJS_SERVER, [], {
                selfContained: SC,
            });
            const head = out.slice(
                0,
                out.indexOf("process.env.__NEXT_PRIVATE_STANDALONE_CONFIG"),
            );
            const body = head
                .replace("process.chdir(", ";(() => {})(")
                .replace(
                    /^const path = require\('path'\)$/m,
                    "const path = require('node:path')",
                );
            const script =
                `process.argv[1] = ${JSON.stringify(argv1)};\n` +
                `${body}\n` +
                "const fs = require('node:fs');\n" +
                "const embedDist = require('node:path').join(dir, nextConfig.distDir);\n" +
                "console.log(JSON.stringify({ root: globalThis.__knextEmbedRoot, embedDist, dir, " +
                "static: fs.readFileSync(embedDist + '/static/a.js', 'utf8'), " +
                "buildIdTarget: fs.existsSync(embedDist + '/BUILD_ID') }));";
            const r = require("node:child_process").spawnSync(
                process.execPath,
                ["-e", script],
                {
                    cwd: elsewhere,
                    encoding: "utf8",
                    env: { ...process.env, KNEXT_STANDALONE_DIR: disk },
                },
            );
            return {
                status: r.status as number,
                stdout: String(r.stdout).trim(),
                stderr: String(r.stderr),
                disk,
            };
        } finally {
            rmSync(elsewhere, { recursive: true, force: true });
            setTimeout(() => rmSync(disk, { recursive: true, force: true }), 0);
        }
    }

    it("anchors distDir on the EMBEDDED root from argv[1] (not the cwd); static/ resolves on the disk beside the executable", () => {
        const r = runPrologue("/$bunfs/root/knext-standalone-exec-linux-x64");
        expect(r.stderr).toBe("");
        const got = JSON.parse(r.stdout);
        expect(got.root).toBe("/$bunfs/root");
        expect(got.embedDist).toBe("/$bunfs/root/apps/fm/.next");
        expect(got.dir).toBe(r.disk);
        expect(got.static).toBe("static-ok");
        // BUILD_ID is aliased to the dotted name Bun embeds; nothing is embedded here, so it does not exist
        expect(got.buildIdTarget).toBe(false);
    });

    it("fails closed when the process is not running from an embedded filesystem", () => {
        const r = runPrologue("/usr/local/bin/app");
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("not running from its embedded filesystem");
    });
});
