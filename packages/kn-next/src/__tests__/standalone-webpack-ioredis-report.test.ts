/**
 * #2688 — a webpack `next build` (standalone) rewrites `import.meta.url` to a
 * string literal URL and constant-folds the `['io','redis'].join('')` specifier,
 * so the ioredis load in `@getknext/lib` reaches the server chunks as
 *
 *   (0, <external module ns>.createRequire)("file:///<build path>/chunk.js")("ioredis")
 *
 * The creator there is NOT an ES import (webpack turns `node:module` into an
 * external), so the createRequire alias tracking never sees it. The build must
 * still name the load, exactly as it does for the vinext shape. Both halves are
 * asserted: the shape is named, and nothing else is swept in with it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    foldedRuntimeSummary,
    unembeddedDynamicReport,
} from "../adapters/compile-embed.mjs";

const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function report(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "knext-2688-"));
    dirs.push(dir);
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
    }
    return unembeddedDynamicReport(dir);
}

const URL_ = "file:///build/machine/packages/lib/dist/chunk-T6O5ID7N.js";
const webpackChunk = (call: string) =>
    `"use strict";exports.id=311;exports.ids=[311];exports.modules={5:(e,t,n)=>{var a=n(9),` +
    `i=n.n(a);function loadRedisCtor(){let f=1;return((${call}).default??f)(1,2)}}};\n`;

describe("the webpack-shape ioredis load is named", () => {
    const shapes: [string, string][] = [
        [
            "a sequence-wrapped namespace member (webpack's import call form)",
            `(0,node_module__WEBPACK_IMPORTED_MODULE_0__.createRequire)("${URL_}")("ioredis")`,
        ],
        [
            "a plain namespace member call",
            `node_module__WEBPACK_IMPORTED_MODULE_0__.createRequire("${URL_}")("ioredis")`,
        ],
        [
            "a bare createRequire identifier",
            `createRequire("${URL_}")("ioredis")`,
        ],
        [
            "a template-literal URL and specifier",
            `createRequire(\`${URL_}\`)(\`ioredis\`)`,
        ],
    ];
    for (const [name, call] of shapes) {
        it(`names ioredis for ${name}`, () => {
            const rows = report({ "chunks/311.js": webpackChunk(call) });
            expect(rows).toEqual([
                {
                    file: "chunks/311.js",
                    computedSites: 0,
                    dynamicRequireBindings: [],
                    foldedRuntimeRequires: ["ioredis"],
                },
            ]);
            expect(foldedRuntimeSummary(rows)).toMatch(
                /ioredis \(chunks\/311\.js\)/,
            );
        });
    }
});

describe("only the ioredis load on a file URL is named (the gate stays narrow)", () => {
    const quiet: [string, string][] = [
        [
            "another package on the same shape",
            `(0,m.createRequire)("${URL_}")("sharp")`,
        ],
        [
            "ioredis anchored at a non-file string",
            `(0,m.createRequire)("/")("ioredis")`,
        ],
        [
            "ioredis loaded with more than one argument",
            `(0,m.createRequire)("${URL_}")("ioredis", 1)`,
        ],
        [
            "createRequire called with more than the one URL argument",
            `(0,m.createRequire)("${URL_}", 1)("ioredis")`,
        ],
        [
            "a callee that is not a createRequire",
            `(0,m.somethingElse)("${URL_}")("ioredis")`,
        ],
        [
            "createRequire(url) bound but never called with ioredis",
            `(0,m.createRequire)("${URL_}")`,
        ],
    ];
    for (const [name, call] of quiet) {
        it(`does not name ${name}`, () => {
            const rows = report({
                "chunks/311.js": webpackChunk(call),
            });
            expect(rows.flatMap((r) => r.foldedRuntimeRequires)).toEqual([]);
        });
    }

    it("a chunk with no createRequire at all is not reported", () => {
        expect(
            report({ "chunks/1.js": 'exports.x=()=>require("ioredis");\n' }),
        ).toEqual([]);
    });
});
