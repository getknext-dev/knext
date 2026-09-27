/**
 * standalone-embed (#1456) — the pure pieces of the self-contained standalone
 * executable: how each file under `.next` is embedded, the relative rewrite
 * between embedded modules, the `__dirname` rebind, the turbopack external
 * alias rewrite and the runtime `fs` alias the entry installs.
 *
 * The end-to-end proof (file-manager on webpack and turbopack, from an empty
 * directory) is apps/file-manager/self-contained-e2e.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    classifyDistFiles,
    EMBED_ROOT_GLOBAL,
    installDistDirAlias,
    installEmbeddedJsonRequire,
    middlewareManifestFiles,
    rebindDirnameSource,
    relativeSpecifier,
    rewriteExternalAliases,
} from "../adapters/standalone-embed.mjs";

/** A `.next` listing shaped like file-manager's (webpack AND turbopack names). */
const DIST = [
    "BUILD_ID",
    "app-path-routes-manifest.json",
    "build-manifest.json",
    "package.json",
    "prerender-manifest.json",
    "required-server-files.json",
    "routes-manifest.json",
    "cache/images/abc/x.webp",
    "static/chunks/webpack-1.js",
    "static/css/app.css",
    "server/app/page.js",
    "server/app/page.js.map",
    "server/app/page_client-reference-manifest.js",
    "server/app/index.html",
    "server/app/index.rsc",
    "server/app/index.meta",
    "server/app/api/health/route.js",
    "server/app/api/health/route.body",
    "server/app/[id]/page.js",
    "server/app/_global-error.segments/_full.segment.rsc",
    "server/chunks/123.js",
    "server/chunks/[turbopack]_runtime.js",
    "server/chunks/ssr/[root-of-the-server]__abc._.js",
    "server/edge-runtime-webpack.js",
    "server/src/middleware.js",
    "server/instrumentation.js",
    "server/middleware-build-manifest.js",
    "server/middleware-manifest.json",
    "server/next-font-manifest.js",
    "server/server-reference-manifest.js",
    "server/pages/_document.js",
    "server/webpack-runtime.js",
    "server/app/font.woff2",
];
const EDGE = ["server/edge-runtime-webpack.js", "server/src/middleware.js"];

describe("classifyDistFiles", () => {
    const c = classifyDistFiles(DIST, { edgeFiles: EDGE });

    it("partitions EVERY input file — nothing is dropped", () => {
        expect([...c.modules, ...c.assets, ...c.disk].sort()).toEqual(
            [...DIST].sort(),
        );
        expect(new Set([...c.modules, ...c.assets, ...c.disk]).size).toBe(
            DIST.length,
        );
    });

    it("embeds the JavaScript Next requires as modules — route chunks, runtimes, instrumentation, bracketed names", () => {
        expect(c.modules).toEqual([
            "server/app/[id]/page.js",
            "server/app/api/health/route.js",
            "server/app/page.js",
            "server/chunks/123.js",
            "server/chunks/[turbopack]_runtime.js",
            "server/chunks/ssr/[root-of-the-server]__abc._.js",
            "server/instrumentation.js",
            "server/pages/_document.js",
            "server/webpack-runtime.js",
        ]);
    });

    it("embeds what Next reads with fs byte for byte: manifests (JSON and the *manifest.js it evaluates), edge files, prerendered output, BUILD_ID", () => {
        for (const f of [
            "BUILD_ID",
            "server/app/page_client-reference-manifest.js",
            "server/middleware-build-manifest.js",
            "server/next-font-manifest.js",
            "server/server-reference-manifest.js",
            "server/middleware-manifest.json",
            "server/edge-runtime-webpack.js",
            "server/src/middleware.js",
            "server/app/index.html",
            "server/app/index.rsc",
            "server/app/index.meta",
            "server/app/api/health/route.body",
            "server/app/page.js.map",
            "server/app/_global-error.segments/_full.segment.rsc",
        ]) {
            expect(c.assets).toContain(f);
        }
    });

    it("leaves static/ and cache/ on disk", () => {
        expect(c.disk).toEqual([
            "cache/images/abc/x.webp",
            "static/chunks/webpack-1.js",
            "static/css/app.css",
        ]);
    });

    it("reports (and still embeds) a file kind it does not know, instead of guessing", () => {
        expect(c.unknownKinds).toEqual(["server/app/font.woff2"]);
        expect(c.assets).toContain("server/app/font.woff2");
    });

    it("without the middleware manifest's list, an edge file would be compiled as a module — the list is load-bearing", () => {
        expect(classifyDistFiles(EDGE).modules).toEqual(EDGE);
    });
});

describe("middlewareManifestFiles", () => {
    it("collects middleware and edge-function files, deduplicated and sorted", () => {
        expect(
            middlewareManifestFiles({
                middleware: { "/": { files: ["server/b.js", "server/a.js"] } },
                functions: {
                    "/api/e": { files: ["server/a.js", "server/c.js"] },
                },
            }),
        ).toEqual(["server/a.js", "server/b.js", "server/c.js"]);
        expect(
            middlewareManifestFiles({ middleware: {}, functions: {} }),
        ).toEqual([]);
        expect(middlewareManifestFiles(undefined)).toEqual([]);
    });
});

describe("relativeSpecifier", () => {
    it("is always relative, across directories and the .bun store", () => {
        expect(
            relativeSpecifier(
                "a/.next/server/app/page.js",
                "a/.next/server/chunks/1.js",
            ),
        ).toBe("../chunks/1.js");
        expect(relativeSpecifier("a/b.js", "a/c.js")).toBe("./c.js");
        expect(
            relativeSpecifier(
                "apps/fm/.next/server/chunks/x.js",
                "node_modules/.bun/next@16/node_modules/next/dist/server/a.external.js",
            ),
        ).toBe(
            "../../../../../node_modules/.bun/next@16/node_modules/next/dist/server/a.external.js",
        );
    });
});

describe("rebindDirnameSource", () => {
    const run = (src: string, root: string) => {
        const g = globalThis as Record<string, unknown>;
        const prev = g[EMBED_ROOT_GLOBAL];
        g[EMBED_ROOT_GLOBAL] = root;
        try {
            const module = { exports: {} as Record<string, unknown> };
            new Function(
                "module",
                "exports",
                "__dirname",
                "__filename",
                src,
            ).call(
                module.exports,
                module,
                module.exports,
                "/BUILD/DIR",
                "/BUILD/DIR/f.js",
            );
            return module.exports;
        } finally {
            g[EMBED_ROOT_GLOBAL] = prev;
        }
    };

    it("rebinds __dirname and __filename to the embedded path, read from the root global at load time", () => {
        const src =
            "module.exports.d = __dirname; module.exports.f = __filename; module.exports.self = this === module.exports;";
        const out = rebindDirnameSource(
            src,
            "apps/fm/.next/server/chunks/[turbopack]_runtime.js",
        );
        expect(run(out, "/$bunfs/root")).toEqual({
            d: "/$bunfs/root/apps/fm/.next/server/chunks",
            f: "/$bunfs/root/apps/fm/.next/server/chunks/[turbopack]_runtime.js",
            self: true,
        });
    });

    it("a module at the embed root gets the root itself", () => {
        expect(
            run(
                rebindDirnameSource("module.exports.d = __dirname;", "x.js"),
                "/$bunfs/root",
            ),
        ).toEqual({
            d: "/$bunfs/root",
        });
    });

    it("leaves a module that uses neither binding, and ESM, untouched", () => {
        expect(rebindDirnameSource("module.exports = 1;", "a.js")).toBe(
            "module.exports = 1;",
        );
        const esm = 'import x from "y";\nexport const d = __dirname;';
        expect(rebindDirnameSource(esm, "a.js")).toBe(esm);
    });
});

describe("rewriteExternalAliases", () => {
    const aliases = new Map([
        [
            "pg-61b435ba5261e5d7",
            "node_modules/.bun/pg@8/node_modules/pg/esm/index.js",
        ],
    ]);

    it("replaces every quoted alias with the absolute embedded path, built from the root global", () => {
        const src =
            'e.y("pg-61b435ba5261e5d7"); e.x(\'pg-61b435ba5261e5d7\', () => require("pg-61b435ba5261e5d7"));';
        const { source, rewritten, unresolvedSubpaths } =
            rewriteExternalAliases(src, aliases);
        expect(rewritten).toBe(3);
        expect(unresolvedSubpaths).toEqual([]);
        expect(source).not.toContain('"pg-61b435ba5261e5d7"');
        const g = globalThis as Record<string, unknown>;
        g[EMBED_ROOT_GLOBAL] = "/$bunfs/root";
        const seen: string[] = [];
        new Function("e", "require", source)(
            {
                y: (id: string) => seen.push(id),
                x: (id: string) => seen.push(id),
            },
            () => 0,
        );
        expect(seen).toEqual([
            "/$bunfs/root/node_modules/.bun/pg@8/node_modules/pg/esm/index.js",
            "/$bunfs/root/node_modules/.bun/pg@8/node_modules/pg/esm/index.js",
        ]);
    });

    it("does not touch a longer identifier that merely contains the alias", () => {
        const src = 'x("pg-61b435ba5261e5d7x"); y("my-pg-61b435ba5261e5d7");';
        expect(rewriteExternalAliases(src, aliases)).toEqual({
            source: src,
            rewritten: 0,
            unresolvedSubpaths: [],
        });
    });

    it("reports a subpath of an alias rather than guessing its target", () => {
        expect(
            rewriteExternalAliases(
                'e.y("pg-61b435ba5261e5d7/lib/x.js")',
                aliases,
            ).unresolvedSubpaths,
        ).toEqual(['"pg-61b435ba5261e5d7/lib/x.js"']);
    });
});

describe("installDistDirAlias", () => {
    function fakeFs() {
        const calls: unknown[][] = [];
        const mk = () =>
            function (this: unknown, ...args: unknown[]) {
                calls.push(args);
                return args[0];
            };
        const fs: Record<string, unknown> = { promises: {} };
        const fsp: Record<string, unknown> = {};
        for (const n of [
            "readFile",
            "stat",
            "createReadStream",
            "readdir",
            "mkdir",
            "writeFile",
            "rename",
        ]) {
            fs[n] = mk();
            fs[`${n}Sync`] = mk();
            fsp[n] = mk();
        }
        fs.existsSync = mk();
        fs.promises = fsp;
        return { fs, fsp, calls };
    }
    const E = "/$bunfs/root/apps/fm/.next";
    const D = "/srv/app/.next";

    it("maps a directory prefix and an exact file; leaves every other path alone", () => {
        const { fs, fsp } = fakeFs();
        installDistDirAlias(fs, fsp, {
            [`${E}/static`]: `${D}/static`,
            [`${E}/cache`]: `${D}/cache`,
            [`${E}/BUILD_ID`]: `${E}/BUILD_ID.`,
        });
        const call = (o: Record<string, unknown>, n: string, ...a: unknown[]) =>
            (o[n] as (...x: unknown[]) => unknown)(...a);
        expect(call(fs, "createReadStream", `${E}/static/chunks/a.js`)).toBe(
            `${D}/static/chunks/a.js`,
        );
        expect(call(fs, "statSync", `${E}/static`)).toBe(`${D}/static`);
        expect(call(fsp, "readdir", `${E}/static/css`)).toBe(`${D}/static/css`);
        expect(call(fsp, "mkdir", `${E}/cache/images`)).toBe(
            `${D}/cache/images`,
        );
        expect(call(fs, "readFileSync", `${E}/BUILD_ID`)).toBe(
            `${E}/BUILD_ID.`,
        );
        expect(call(fs, "existsSync", `${E}/BUILD_ID`)).toBe(`${E}/BUILD_ID.`);
        // not aliased: a sibling with the same prefix, the server tree, other paths, non-strings
        expect(call(fs, "readFileSync", `${E}/staticx/a`)).toBe(
            `${E}/staticx/a`,
        );
        expect(call(fs, "readFileSync", `${E}/server/app/page.js`)).toBe(
            `${E}/server/app/page.js`,
        );
        expect(call(fs, "readFileSync", "/etc/hosts")).toBe("/etc/hosts");
        expect(call(fs, "readFileSync", 3)).toBe(3);
    });

    it("maps BOTH paths of a two-path call, and wraps each function once", () => {
        const { fs, fsp, calls } = fakeFs();
        const aliases = { [`${E}/cache`]: `${D}/cache` };
        installDistDirAlias(fs, fsp, aliases);
        const once = fs.renameSync;
        installDistDirAlias(fs, fsp, aliases);
        expect(fs.renameSync).toBe(once);
        (fs.renameSync as (...a: unknown[]) => unknown)(
            `${E}/cache/a`,
            `${E}/cache/b`,
        );
        expect(calls.at(-1)).toEqual([`${D}/cache/a`, `${D}/cache/b`]);
    });

    it("installed into the entry by toString(): the serialised function is self-contained", () => {
        const { fs, fsp } = fakeFs();
        const rebuilt = new Function(
            `return (${installDistDirAlias.toString()})`,
        )();
        rebuilt(fs, fsp, { [`${E}/static`]: `${D}/static` });
        expect(
            (fs.readFileSync as (p: string) => string)(`${E}/static/x`),
        ).toBe(`${D}/static/x`);
    });
});

describe("installEmbeddedJsonRequire", () => {
    it("answers an absolute embedded .json require from the file's bytes, once; defers everything else", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-embed-json-"));
        try {
            mkdirSync(join(dir, "x"));
            writeFileSync(
                join(dir, "x", "m.json"),
                '{"middleware":{"/":{"files":[]}}}',
            );
            writeFileSync(
                join(dir, "x", "plain.cjs"),
                "module.exports = 'plain';",
            );
            // Run in a child: the hook patches Module.prototype.require process-wide.
            const script = `
const Module = require("node:module"), fs = require("node:fs");
let reads = 0; const realRead = fs.readFileSync;
const countingFs = { readFileSync: (...a) => { reads++; return realRead(...a); } };
(${installEmbeddedJsonRequire.toString()})(Module, countingFs, ${JSON.stringify(dir)});
const a = require(${JSON.stringify(join(dir, "x", "m.json"))});
const b = require(${JSON.stringify(join(dir, "x", "m.json"))});
const p = require(${JSON.stringify(join(dir, "x", "plain.cjs"))});
console.log(JSON.stringify({ a, same: a === b, reads, p }));`;
            const r = spawnSync(process.execPath, ["-e", script], {
                encoding: "utf8",
            });
            expect(r.status).toBe(0);
            expect(JSON.parse(r.stdout.trim())).toEqual({
                a: { middleware: { "/": { files: [] } } },
                same: true,
                reads: 1,
                p: "plain",
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
