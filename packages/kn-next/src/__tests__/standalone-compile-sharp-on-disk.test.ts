/**
 * #2360 — next/image served the original PNG on the compiled standalone
 * executable (build: turbopack/webpack + runtime: bun).
 *
 * Measured on a GitHub runner (diag run 38515418989): the compile BUNDLED
 * sharp. Its loader's literal `require("@img/sharp-linux-x64/sharp.node")`
 * then embedded the addon in the executable, and at runtime Bun extracts an
 * embedded `.node` to a temp directory before `dlopen`. The addon finds
 * libvips by a RELATIVE rpath, so from `/tmp` it looked for
 * `/tmp/../../sharp-libvips-linux-x64/lib/libvips-cpp.so.*` (strace: ENOENT),
 * the load failed with ERR_DLOPEN_FAILED, and Next's optimizer quietly fell
 * back to the original bytes. The uncompiled `bun server.js` on the same tree
 * served image/webp.
 *
 * The fix keeps sharp out of the bundle: it joins the disk closure, so the
 * executable requires it from its real path in the standalone tree, where the
 * addon and libvips sit side by side as the installer laid them out. This
 * proves it at the compile script boundary, on a synthetic tree: AFTER the
 * compile, the on-disk sharp is rewritten to report a different value, so the
 * executable can only print that value if it really loads sharp from disk.
 * (`__filename` would not do — the bundler preserves a bundled module's
 * original path, measured.)
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE_SCRIPT = resolve(
    import.meta.dir,
    "..",
    "adapters",
    "standalone-compile.mjs",
);

/** The server.js shape standalone-exec-entry.mjs rewrites. */
const SERVER_JS = `const path = require('path')

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
`;

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/**
 * A standalone tree whose fake Next reaches sharp the way the real one does:
 * `next/dist/server/image-optimizer.js` requires the bare `sharp`, and the
 * server (bundled, reached statically from server.js) calls it. The fake
 * sharp ships both export conditions, like sharp 0.35, and reports the file
 * it was loaded from. `withSharp: false` is an app with no sharp traced.
 */
function syntheticStandalone(withSharp = true): string {
    const project = mkdtempSync(join(tmpdir(), "knext-2360-sharp-disk-"));
    tempDirs.push(project);
    const s = join(project, ".next", "standalone");
    write(join(s, "server.js"), SERVER_JS);
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"0.0.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/image-optimizer.js"),
        "exports.getSharp = () => require('sharp');",
    );
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        [
            "exports.startServer = async () => {",
            "  let where;",
            "  try { where = require('../image-optimizer').getSharp().where; }",
            "  catch (e) { where = 'LOAD-FAILED ' + e.message; }",
            "  console.log('SHARP_FROM=' + where);",
            "  process.exit(0);",
            "};",
        ].join("\n"),
    );
    if (withSharp) {
        write(
            join(s, "node_modules/sharp/package.json"),
            JSON.stringify({
                name: "sharp",
                version: "0.35.5",
                exports: {
                    ".": {
                        import: "./dist/index.mjs",
                        require: "./dist/index.cjs",
                    },
                },
            }),
        );
        write(
            join(s, "node_modules/sharp/dist/index.cjs"),
            "module.exports = require('./sharp.cjs');",
        );
        write(
            join(s, "node_modules/sharp/dist/sharp.cjs"),
            "module.exports = { where: __filename };",
        );
        write(
            join(s, "node_modules/sharp/dist/index.mjs"),
            "export const where = import.meta.url;",
        );
    }
    return s;
}

/** What the on-disk sharp reports once rewritten after the compile. */
const ON_DISK = "ON-DISK-AT-RUNTIME";

function compileAndRun(standalone: string): {
    compile: ReturnType<typeof spawnSync>;
    run: ReturnType<typeof spawnSync> | null;
} {
    const outfile = join(standalone, "knext-standalone-exec");
    const compile = spawnSync(
        "bun",
        [
            "run",
            COMPILE_SCRIPT,
            "--server",
            join(standalone, "server.js"),
            "--outfile",
            outfile,
        ],
        { encoding: "utf8", timeout: 120_000 },
    );
    if (compile.status !== 0) return { compile, run: null };
    const loader = join(standalone, "node_modules/sharp/dist/sharp.cjs");
    if (existsSync(loader)) {
        writeFileSync(
            loader,
            `module.exports = { where: ${JSON.stringify(ON_DISK)} };`,
        );
    }
    const run = spawnSync(outfile, [], {
        cwd: standalone,
        encoding: "utf8",
        timeout: 60_000,
    });
    return { compile, run };
}

describe("the compiled standalone executable loads sharp from the standalone tree, not from its bundle (#2360)", () => {
    it("requires sharp from its real path on disk, where the addon's relative rpath to libvips holds", () => {
        const standalone = syntheticStandalone();
        const { compile, run } = compileAndRun(standalone);
        expect(compile.stderr).not.toContain("compile failed");
        expect(compile.status).toBe(0);
        expect(run?.status).toBe(0);
        const line = String(run?.stdout)
            .split("\n")
            .find((l) => l.startsWith("SHARP_FROM="));
        // Bundled, the executable carries the compile-time sharp and prints
        // its original path; only a load from disk sees the rewrite.
        expect(line).toBe(`SHARP_FROM=${ON_DISK}`);
    }, 180_000);

    it("an app with no sharp in its traced tree still compiles, and the require fails exactly as uncompiled", () => {
        const standalone = syntheticStandalone(false);
        const { compile, run } = compileAndRun(standalone);
        expect(compile.status).toBe(0);
        expect(run?.status).toBe(0);
        expect(String(run?.stdout)).toContain("SHARP_FROM=LOAD-FAILED");
    }, 180_000);
});
