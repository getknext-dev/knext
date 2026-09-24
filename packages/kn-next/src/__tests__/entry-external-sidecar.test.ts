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
 * A compiled Bun binary also refuses ALL runtime bare-specifier resolution by
 * default, even from a real on-disk anchor, so a sidecar alone cannot help.
 * `autoloadPackageJson` switches that resolution back on, and the loader
 * resolves with `Bun.resolveSync` (ESM conditions: nitro traces only a
 * package's `import` target) against the sidecar anchored at the binary's own
 * directory, never at `process.cwd()`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    hasNativeAddon,
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

    it("the shim prefers the sidecar anchored at the binary, never at cwd, and falls back to the bundled copy", () => {
        const src = sidecarShimSource("twoslash/core");
        expect(src).toContain("process.execPath");
        expect(src).not.toContain("process.cwd");
        expect(src).toContain('".output","server"');
        // present-check is on the PACKAGE, not the subpath
        expect(src).toContain('"node_modules","twoslash","package.json"');
        expect(src).toContain('Bun.resolveSync("twoslash/core"');
        expect(src).toContain('require("knext-bundled:twoslash/core")');
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
 * The G8 shape, reduced: an ESM external whose traced tree holds only its
 * `import` target (nitro's trace subset), reaching a CJS helper that does what
 * `@typescript/vfs` does — `require.resolve` a sibling package at RUNTIME and read
 * a data file beside it. Plus a pure package, which must keep working with the
 * sidecar gone (the production image ships no sidecar today).
 */
const LIB = "KNEXT_1320_REAL_LIB_TXT_4c1e";
const PURE = "KNEXT_1320_PURE_MARKER_9b2d";
const PURE_LIVE = "KNEXT_1320_PURE_LIVE_SIDECAR_e81a";

function buildApp(): { work: string; exe: string; sidecar: string } {
    const work = temp("knext-1320-");
    const server = join(work, ".output", "server");
    const nm = join(server, "node_modules");
    write(
        join(nm, "fake-esm", "package.json"),
        JSON.stringify({
            name: "fake-esm",
            version: "1.0.0",
            type: "module",
            // index.cjs is deliberately NOT written: nitro traces only the
            // `import` target, so a `require`-condition resolve must not be used.
            exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
        }),
    );
    write(
        join(nm, "fake-esm", "index.mjs"),
        'import reader from "fake-lib-reader";\nexport const kind = "esm";\nexport const lib = () => reader.lib();\n',
    );
    write(
        join(nm, "fake-lib-reader", "package.json"),
        JSON.stringify({
            name: "fake-lib-reader",
            version: "1.0.0",
            main: "index.js",
        }),
    );
    write(
        join(nm, "fake-lib-reader", "index.js"),
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
    write(
        join(nm, "fake-pure", "package.json"),
        JSON.stringify({
            name: "fake-pure",
            version: "1.0.0",
            main: "index.js",
        }),
    );
    write(
        join(nm, "fake-pure", "index.js"),
        `module.exports = { marker: ${JSON.stringify(PURE)} };\n`,
    );
    write(
        join(server, "index.mjs"),
        'import { marker } from "fake-pure";\n' +
            'import * as esm from "fake-esm";\n' +
            'console.log("PURE:" + marker);\n' +
            'try { console.log("RESULT:" + esm.kind + ":" + esm.lib()); }\n' +
            'catch (e) { console.log("RESULT-ERR:" + (e && e.message)); }\n',
    );
    const exe = join(work, "knext-1320-exec");
    const build = spawnSync(
        process.execPath,
        [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
        { cwd: work, encoding: "utf8" },
    );
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    // Bun keeps a bundled module's source __filename, so a path cannot tell
    // the two copies apart. Change the SIDECAR's copy after the compile
    // instead: the live marker can only come from the real file on disk,
    // the original marker only from the bundle.
    write(
        join(nm, "fake-pure", "index.js"),
        `module.exports = { marker: ${JSON.stringify(PURE_LIVE)} };\n`,
    );
    return { work, exe, sidecar: nm };
}

/** Run from a directory that is NOT the app dir: resolution must not ride on cwd. */
function run(exe: string): string {
    const elsewhere = temp("knext-1320-cwd-");
    const r = spawnSync(exe, [], {
        cwd: elsewhere,
        encoding: "utf8",
        timeout: 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    return r.stdout;
}

describe("vinext-compile loads server externals from the sidecar beside the binary (#1320)", () => {
    const app = buildApp();

    it("with the sidecar present, an external that needs its real files works (the G8 case)", () => {
        const out = run(app.exe);
        expect(out).toContain(`RESULT:esm:${LIB}`);
        // the pure package came from the real sidecar, not from $bunfs
        expect(out).toContain(`PURE:${PURE_LIVE}`);
        expect(out).not.toContain(`PURE:${PURE}\n`);
    });

    it("with the sidecar gone, the bundled copy still serves (no regression for today's images)", () => {
        const moved = `${app.sidecar}.away`;
        renameSync(app.sidecar, moved);
        try {
            const out = run(app.exe);
            // the bundled copy: the ORIGINAL marker, compiled in
            expect(out).toContain(`PURE:${PURE}\n`);
            expect(out).not.toContain(PURE_LIVE);
        } finally {
            renameSync(moved, app.sidecar);
        }
    });
});
