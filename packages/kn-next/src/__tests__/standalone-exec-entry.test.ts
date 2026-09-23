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
