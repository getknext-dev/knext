/**
 * The compiled exec loads the app's server externals from the traced sidecar
 * (`.output/server/node_modules`) when it is present beside the binary, and
 * falls back to the bundled copy only when the sidecar does not hold the package.
 *
 * Root cause (#1320, compat group G8), measured on Bun 1.4.2: `vinext-compile`
 * BUNDLED every package nitro left external (`serverExternalPackages`, Next's
 * default external list), so they ran from the binary's virtual filesystem
 * (`/$bunfs`). Packages that need their REAL files then broke:
 *   - `twoslash` → `@typescript/vfs` calls `require.resolve("typescript")` and reads
 *     `lib.*.d.ts` beside it: `Cannot find module 'typescript'` from `/$bunfs/root/…`;
 *   - `sqlite3` → `bindings` walks up from its caller to find `package.json`:
 *     `Could not find module root given file: "/$bunfs/root/…"`.
 * A compiled Bun binary never reads a package.json at runtime, so a sidecar
 * alone cannot help. The fix resolves sidecar packages with its own resolver
 * (sidecar-runtime.mjs), confined to `<dir of the binary>/.output/server/
 * node_modules`, and loads the resulting absolute files. The binary is NOT
 * compiled with `autoloadPackageJson`, which widens runtime resolution beyond
 * the sidecar.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    hasNativeAddon,
    isCommonJsEntry,
    isSidecarCandidate,
    NEVER_SIDECAR,
    packageNameOf,
    sidecarShimSource,
} from "../adapters/entry-external-sidecar.mjs";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(prefix: string): string {
    // realpath: macOS tmpdir is a /var -> /private/var symlink, and
    // vinext-compile matches its entry by resolved path.
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
function write(path: string, body: string): void {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, body);
}

describe("entry-external-sidecar (unit)", () => {
    it("derives the package name from a specifier", () => {
        expect(packageNameOf("typescript")).toBe("typescript");
        expect(packageNameOf("twoslash/core")).toBe("twoslash");
        expect(packageNameOf("@typescript/vfs")).toBe("@typescript/vfs");
        expect(packageNameOf("@a/b/c/d")).toBe("@a/b");
    });

    it("only bare, non-builtin, non-sharp specifiers are sidecar candidates", () => {
        for (const s of [
            "typescript",
            "sqlite3",
            "@scope/pkg",
            "twoslash/core",
        ]) {
            expect(isSidecarCandidate(s), s).toBe(true);
        }
        for (const s of [
            "./local.js",
            "../up.js",
            "/abs/x.js",
            "node:fs",
            "fs",
            "path/posix",
            "bun",
            "bun:sqlite",
            "sharp",
            "@img/sharp-linux-x64",
            "file:///x.js",
        ]) {
            expect(isSidecarCandidate(s), s).toBe(false);
        }
        expect(NEVER_SIDECAR).toContain("sharp");
    });

    it("the shim loads the sidecar's resolved entry file, else the bundled copy, and never resolves on its own", () => {
        const src = sidecarShimSource("twoslash/core");
        expect(src).toContain('globalThis[Symbol.for("knext.sidecar")]');
        // present-check is on the PACKAGE, not the subpath
        expect(src).toContain('__k.has("twoslash")');
        expect(src).toContain('require(__k.entryFile("twoslash/core"))');
        expect(src).toContain('require("knext-bundled:twoslash/core")');
        // no resolution of its own: no cwd, no Bun resolver
        expect(src).not.toContain("process.cwd");
        expect(src).not.toContain("Bun.resolveSync");
    });

    it("classifies a sidecar package's entry as CommonJS or ESM the way the runtime resolves it", () => {
        const nm = temp("knext-1320-format-");
        write(
            join(nm, "c", "package.json"),
            JSON.stringify({ name: "c", main: "lib/c.js" }),
        );
        write(join(nm, "c", "lib", "c.js"), "module.exports = 1;");
        write(
            join(nm, "m", "package.json"),
            JSON.stringify({ name: "m", type: "module", main: "lib/m.js" }),
        );
        write(join(nm, "m", "lib", "m.js"), "export default 1;");
        // exports whose `require` target was not traced (nitro traces `import`)
        write(
            join(nm, "x", "package.json"),
            JSON.stringify({
                name: "x",
                type: "module",
                exports: { ".": { require: "./a.cjs", import: "./a.mjs" } },
            }),
        );
        write(join(nm, "x", "a.mjs"), "export default 1;");
        write(
            join(nm, "k", "package.json"),
            JSON.stringify({ name: "k", exports: { ".": "./k.cjs" } }),
        );
        write(join(nm, "k", "k.cjs"), "module.exports = 1;");
        expect(isCommonJsEntry(nm, "c")).toBe(true);
        expect(isCommonJsEntry(nm, "m")).toBe(false);
        // only an untraced `require` target: unresolvable under require
        // conditions, so it is not redirected and stays bundled
        expect(isCommonJsEntry(nm, "x")).toBeNull();
        expect(isCommonJsEntry(nm, "k")).toBe(true);
        expect(isCommonJsEntry(nm, "missing")).toBeNull();
    });

    it("detects native addons (a .node file or binding.gyp) in a package tree", () => {
        const root = temp("knext-1320-native-");
        write(
            join(root, "sqlite3", "build", "Release", "node_sqlite3.node"),
            "x",
        );
        write(join(root, "gyp-only", "binding.gyp"), "{}");
        write(join(root, "pure", "index.js"), "module.exports = 1;");
        expect(hasNativeAddon(join(root, "sqlite3"))).toBe(true);
        expect(hasNativeAddon(join(root, "gyp-only"))).toBe(true);
        expect(hasNativeAddon(join(root, "pure"))).toBe(false);
        expect(hasNativeAddon(join(root, "missing"))).toBe(false);
    });
});

/**
 * The G8 shape, reduced, plus the security property the design must keep.
 *
 *  - `fake-esm` (ESM; only its `import` target traced, like nitro's subset) stays
 *    BUNDLED. Its CJS helper `fake-lib-reader` does what `@typescript/vfs` does:
 *    `require.resolve` a sibling package at RUNTIME, then reads a data file
 *    beside it. That runtime resolve must reach the SIDECAR.
 *  - `fake-cjs` (CommonJS) is loaded from the sidecar. Its own
 *    `require("fake-dep")` must resolve inside the sidecar too (`fake-dep` has a
 *    non-index `main`, like real packages: the compiled resolver never reads
 *    package.json on its own).
 *  - `fake-pure` (CommonJS) must keep working with the sidecar gone.
 *  - PLANTED copies of every package sit in `<cwd>/node_modules` and
 *    `<cwd>/../node_modules`. Nothing may ever load them: resolution is anchored
 *    at the binary's own `.output/server/node_modules` only.
 *
 * Markers rewritten in the sidecar AFTER the compile prove which copy ran:
 * `*_LIVE` can only come from the real file on disk, the original only from
 * the bundle, `PLANTED` only from outside the sidecar.
 */
const LIB = "KNEXT_1320_REAL_LIB_TXT_4c1e";
const PURE = "KNEXT_1320_PURE_MARKER_9b2d";
const PURE_LIVE = "KNEXT_1320_PURE_LIVE_SIDECAR_e81a";
const DEP = "KNEXT_1320_DEP_MARKER_51aa";
const DEP_LIVE = "KNEXT_1320_DEP_LIVE_SIDECAR_77c3";
const PLANTED = "KNEXT_1320_PLANTED_BY_CWD_0bad";

/** A package with a non-index CommonJS `main`. */
function cjsPackage(nm: string, name: string, body: string): void {
    write(
        join(nm, name, "package.json"),
        JSON.stringify({ name, version: "1.0.0", main: "lib/main.js" }),
    );
    write(join(nm, name, "lib", "main.js"), body);
}

/** Every fixture package, planted with the PLANTED marker. */
function plant(nm: string): void {
    for (const name of [
        "fake-pure",
        "fake-cjs",
        "fake-dep",
        "fake-lib-reader",
    ]) {
        cjsPackage(
            nm,
            name,
            `module.exports = { marker: ${JSON.stringify(PLANTED)}, lib: () => ${JSON.stringify(PLANTED)} };\n`,
        );
    }
    write(
        join(nm, "fake-data", "package.json"),
        JSON.stringify({ name: "fake-data", version: "1.0.0" }),
    );
    write(join(nm, "fake-data", "lib.txt"), `${PLANTED}\n`);
}

function buildApp(): { work: string; exe: string } {
    const work = temp("knext-1320-");
    // The binary sits in the app dir, beside the app's package.json, as in the
    // compat lane.
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    const server = join(work, ".output", "server");
    const nm = join(server, "node_modules");
    // nitro writes this manifest beside the traced node_modules.
    write(
        join(server, "package.json"),
        JSON.stringify({
            name: "traced-node-modules",
            version: "1.0.0",
            type: "module",
            private: true,
        }),
    );
    write(
        join(nm, "fake-esm", "package.json"),
        JSON.stringify({
            name: "fake-esm",
            version: "1.0.0",
            type: "module",
            // dist/entry.cjs is deliberately NOT written: nitro traces only the
            // `import` target.
            exports: {
                ".": {
                    import: "./dist/entry.mjs",
                    require: "./dist/entry.cjs",
                },
            },
        }),
    );
    write(
        join(nm, "fake-esm", "dist", "entry.mjs"),
        'import reader from "fake-lib-reader";\nexport const kind = "esm";\nexport const lib = () => reader.lib();\n',
    );
    cjsPackage(
        nm,
        "fake-lib-reader",
        "const path = require('path');\n" +
            "module.exports.lib = () => {\n" +
            "  const name = ['fake', 'data'].join('-');\n" + // non-literal: a RUNTIME resolve, like @typescript/vfs
            "  const dir = path.dirname(require.resolve(name + '/package.json'));\n" +
            "  return require('fs').readFileSync(path.join(dir, 'lib.txt'), 'utf8').trim();\n" +
            "};\n",
    );
    write(
        join(nm, "fake-data", "package.json"),
        JSON.stringify({ name: "fake-data", version: "1.0.0" }),
    );
    write(join(nm, "fake-data", "lib.txt"), `${LIB}\n`);
    cjsPackage(nm, "fake-dep", `module.exports = ${JSON.stringify(DEP)};\n`);
    cjsPackage(
        nm,
        "fake-cjs",
        'module.exports = { dep: () => require("fake-dep") };\n',
    );
    cjsPackage(
        nm,
        "fake-pure",
        `module.exports = { marker: ${JSON.stringify(PURE)} };\n`,
    );
    write(
        join(server, "index.mjs"),
        'import { marker } from "fake-pure";\n' +
            'import cjs from "fake-cjs";\n' +
            'import * as esm from "fake-esm";\n' +
            'console.log("PURE:" + marker);\n' +
            'try { console.log("DEP:" + cjs.dep()); }\n' +
            'catch (e) { console.log("DEP-ERR:" + (e && e.message)); }\n' +
            'try { console.log("RESULT:" + esm.kind + ":" + esm.lib()); }\n' +
            'catch (e) { console.log("RESULT-ERR:" + (e && e.message)); }\n' +
            // A runtime import() from bundled code must not resolve outside the
            // sidecar either; this case is sensitive to `autoloadPackageJson`
            // (the planted copy has a non-index `main`, which only a
            // package.json-reading resolver can find).
            'import(["fake", "pure"].join("-")).then(\n' +
            '  (m) => console.log("DYN:" + (m.marker ?? (m.default && m.default.marker))),\n' +
            '  (e) => console.log("DYN-ERR:" + (e && (e.code || e.message))),\n' +
            ");\n",
    );
    const exe = join(work, "knext-1320-exec");
    const build = spawnSync(
        process.execPath,
        [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
        { cwd: work, encoding: "utf8" },
    );
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    // Bun keeps a bundled module's source __filename, so a path cannot tell the
    // copies apart. Rewrite the SIDECAR's copies after the compile instead.
    write(
        join(nm, "fake-pure", "lib", "main.js"),
        `module.exports = { marker: ${JSON.stringify(PURE_LIVE)} };\n`,
    );
    write(
        join(nm, "fake-dep", "lib", "main.js"),
        `module.exports = ${JSON.stringify(DEP_LIVE)};\n`,
    );
    return { work, exe };
}

/**
 * Deploy the way an image does: copy the binary and `.output/` to a DIFFERENT
 * directory than the build (Docker builds in one tree and runs from `/app`), so
 * build-time paths cannot mask a runtime failure. Then run from a NESTED cwd
 * elsewhere whose own and parent `node_modules` hold planted copies.
 */
function deployAndRun(
    app: { work: string; exe: string },
    withSidecar: boolean,
): string {
    const deployed = temp("knext-1320-deploy-");
    const exe = join(deployed, "server");
    cpSync(app.exe, exe);
    cpSync(join(app.work, "package.json"), join(deployed, "package.json"));
    cpSync(join(app.work, ".output"), join(deployed, ".output"), {
        recursive: true,
    });
    if (!withSidecar) {
        rmSync(join(deployed, ".output", "server", "node_modules"), {
            recursive: true,
        });
    }
    const outside = temp("knext-1320-cwd-");
    const cwd = join(outside, "nested");
    plant(join(outside, "node_modules"));
    plant(join(cwd, "node_modules"));
    const r = spawnSync(exe, [], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    return r.stdout;
}

describe("vinext-compile loads server externals from the sidecar beside the binary (#1320)", () => {
    const app = buildApp();

    it("with the sidecar present, externals that need their real files work (the G8 case)", () => {
        const out = deployAndRun(app, true);
        // a bundled package's RUNTIME require.resolve reached the sidecar
        expect(out).toContain(`RESULT:esm:${LIB}`);
        // CJS externals came from the real sidecar, not from $bunfs ...
        expect(out).toContain(`PURE:${PURE_LIVE}`);
        // ... including a sidecar package's own nested require
        expect(out).toContain(`DEP:${DEP_LIVE}`);
        expect(out).not.toContain(PLANTED);
    });

    it("with the sidecar gone, the bundled copies still serve (no regression for today's images)", () => {
        const out = deployAndRun(app, false);
        expect(out).toContain(`PURE:${PURE}\n`);
        expect(out).toContain(`DEP:${DEP}\n`);
        expect(out).not.toContain("_LIVE_");
    });

    it("never loads a copy placed outside the sidecar (cwd, its parent), with or without the sidecar", () => {
        for (const withSidecar of [true, false]) {
            const out = deployAndRun(app, withSidecar);
            expect(out, `withSidecar=${withSidecar}\n${out}`).not.toContain(
                PLANTED,
            );
        }
    });
});
