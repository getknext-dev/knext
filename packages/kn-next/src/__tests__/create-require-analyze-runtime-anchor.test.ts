/**
 * #2758 - @getknext/lib no longer anchors its ioredis `createRequire` at
 * `import.meta.url` (a webpack build turned that into a build-machine path); it
 * anchors at a call-time `runtimeAnchor()`. The compile report must still NAME the
 * deliberate ioredis load for that shape, on both bundler outputs:
 *
 *   - rolldown / vinext: `createRequire(runtimeAnchor())(SPEC)` with SPEC the
 *     literal-join idiom;
 *   - webpack: `(0, <ns>.createRequire)(runtimeAnchor())("ioredis")` with the
 *     specifier already constant-folded.
 *
 * The shapes already named for `import.meta.url` / `file:` anchors are covered by
 * entry-require-staticize-folded-spec.test.ts and
 * standalone-webpack-ioredis-report.test.ts and are untouched. The exemption stays
 * exactly as narrow: the NAME ioredis, a zero-argument call as the anchor, one
 * argument each. Both halves are asserted.
 */
import { describe, expect, it } from "bun:test";
import { analyzeServerModule } from "../adapters/entry-require-staticize.mjs";

const IMPORT = 'import { createRequire } from "node:module";\n';
const MARKER = "\0knext-direct-require-call";

describe("the runtime-anchored ioredis load is named (rolldown / ESM shape)", () => {
    const named: [string, string][] = [
        [
            "a module-level join const",
            "const SPEC = ['io', 'redis'].join('');\n" +
                "export const f = () => createRequire(runtimeAnchor())(SPEC);\n",
        ],
        [
            "an inline join",
            "export const f = () => createRequire(runtimeAnchor())(['io', 'redis'].join(''));\n",
        ],
        [
            "a namespaced anchor function",
            "const SPEC = ['io', 'redis'].join('');\n" +
                "export const f = () => createRequire(anchor.runtimeAnchor())(SPEC);\n",
        ],
    ];
    for (const [name, body] of named) {
        it(`names ioredis for ${name} and does not fail the strict gate`, () => {
            const a = analyzeServerModule(IMPORT + body);
            expect(a.foldedRuntimeRequires).toEqual(["ioredis"]);
            expect(a.nonLiteralCallees.has(MARKER)).toBe(false);
            expect(a.unrecognizedBinding).toBe(false);
        });
    }

    const quiet: [string, string][] = [
        [
            "another package assembled the same way",
            "const SPEC = ['sh', 'arp'].join('');\n" +
                "export const f = () => createRequire(runtimeAnchor())(SPEC);\n",
        ],
        [
            "ioredis with a path suffix",
            "const SPEC = ['io', 'redis/foo'].join('');\n" +
                "export const f = () => createRequire(runtimeAnchor())(SPEC);\n",
        ],
        [
            "an anchor call that takes arguments (not the zero-arg runtime anchor)",
            "const SPEC = ['io', 'redis'].join('');\n" +
                "export const f = () => createRequire(somethingElse(1))(SPEC);\n",
        ],
        [
            "a string-literal anchor",
            "const SPEC = ['io', 'redis'].join('');\n" +
                "export const f = () => createRequire('/')(SPEC);\n",
        ],
        [
            "a specifier that cannot be folded",
            "export const f = (SPEC) => createRequire(runtimeAnchor())(SPEC);\n",
        ],
    ];
    for (const [name, body] of quiet) {
        it(`does not name ioredis for ${name}`, () => {
            const a = analyzeServerModule(IMPORT + body);
            expect(a.foldedRuntimeRequires).toEqual([]);
        });
    }
});

describe("the runtime-anchored ioredis load is named (webpack shape)", () => {
    const chunk = (call: string) =>
        `"use strict";exports.id=311;exports.modules={5:(e,t,n)=>{var a=n(9),` +
        `i=n.n(a);function loadRedisCtor(){return((${call}).default??1)(1,2)}}};\n`;

    const named: [string, string][] = [
        [
            "a sequence-wrapped namespace member",
            `(0,node_module__WEBPACK_IMPORTED_MODULE_0__.createRequire)((0,n_1.runtimeAnchor)())("ioredis")`,
        ],
        [
            "a plain namespace member with a bare anchor call",
            `m.createRequire(c())("ioredis")`,
        ],
        ["a bare createRequire", `createRequire(c())("ioredis")`],
    ];
    for (const [name, call] of named) {
        it(`names ioredis for ${name}`, () => {
            const a = analyzeServerModule(chunk(call));
            expect(a.foldedRuntimeRequires).toEqual(["ioredis"]);
        });
    }

    const quiet: [string, string][] = [
        ["another package", `(0,m.createRequire)(c())("sharp")`],
        [
            "an anchor call with arguments",
            `(0,m.createRequire)(c(1))("ioredis")`,
        ],
        [
            "a non-call identifier anchor",
            `(0,m.createRequire)(base)("ioredis")`,
        ],
        [
            "a string-literal non-file anchor",
            `(0,m.createRequire)("/")("ioredis")`,
        ],
        ["a callee that is not createRequire", `(0,m.other)(c())("ioredis")`],
        [
            "a second specifier argument",
            `(0,m.createRequire)(c())("ioredis", 1)`,
        ],
    ];
    for (const [name, call] of quiet) {
        it(`does not name ${name}`, () => {
            expect(
                analyzeServerModule(chunk(call)).foldedRuntimeRequires,
            ).toEqual([]);
        });
    }
});
