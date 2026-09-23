/**
 * The compiled standalone-on-Bun cell, end to end on a synthetic standalone
 * tree that reproduces — in miniature — every obstacle a real Next standalone
 * server puts in front of `bun build --compile --bytecode`:
 *
 *   1. THE WALL. Next's server loads its route chunks from DISK by computed
 *      path, and those chunks `require` bare/exports-mapped specifiers
 *      (`@swc/helpers/_/_interop_require_default`). A compiled Bun binary does
 *      not read package.json at runtime by default, so every such require
 *      fails — this was measured as the reason the cell shipped uncompiled.
 *      The compile's `autoloadPackageJson` is what makes it resolve.
 *   2. `server.js` anchors on `__dirname`, which inside the binary is the
 *      virtual filesystem root. The binary must serve the tree it sits in —
 *      proved here by running it from an unrelated cwd.
 *   3. A `"bun"` export condition whose target `next build` did not trace
 *      (react-dom's `server.bun.js`) must fall back to the Node target.
 *   4. A dev-only require guarded by a flag the bundler cannot prove dead.
 *   5. A package that resolves only OUTSIDE the traced tree (the build
 *      machine's own node_modules) must not be compiled in.
 *
 * And the chunk is edited after the compile to prove it is loaded from disk
 * (not frozen into the binary) — the shape the image depends on.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE_SCRIPT = resolve(
    import.meta.dir,
    "..",
    "adapters",
    "standalone-compile.mjs",
);

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/** Next 16.3.3's CommonJS `server.js` shape, minus the inlined config. */
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

const START_SERVER = `const http = require('http')
const path = require('path')
const rds = require('react-dom/server')
if (process.env.KNEXT_TEST_NEVER === 'set') {
  require('./next-dev-server')
  require('outside-only')
}
exports.startServer = async ({ dir, port }) => {
  http.createServer((req, res) => {
    const chunk = require(path.join(dir, '.next', 'server', 'chunk.js'))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ chunk: chunk(), rds: rds.tag, dir, cwd: process.cwd() }))
  }).listen(port, '127.0.0.1', () => console.log('READY ' + port))
}
`;

function syntheticProject(): { project: string; standalone: string } {
    const project = mkdtempSync(join(tmpdir(), "knext-standalone-wall-"));
    tempDirs.push(project);
    // (5) resolvable only from ABOVE the traced tree
    write(
        join(project, "node_modules/outside-only/package.json"),
        '{"name":"outside-only","main":"index.js"}',
    );
    write(
        join(project, "node_modules/outside-only/index.js"),
        'module.exports = "OUTSIDE_ONLY_SENTINEL_7f3a";',
    );

    const s = join(project, ".next", "standalone");
    write(join(s, "server.js"), SERVER_JS);
    // (1) the disk-loaded chunk with bare + exports-mapped requires
    write(
        join(s, ".next/server/chunk.js"),
        "module.exports = () => require('@swc/helpers/_/_interop_require_default').tag + '|' + require('dep-plain') + '|v1';",
    );
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"0.0.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        START_SERVER,
    );
    // (3) a "bun" condition whose target was never traced
    write(
        join(s, "node_modules/react-dom/package.json"),
        JSON.stringify({
            name: "react-dom",
            version: "0.0.0",
            exports: {
                "./server": {
                    bun: "./server.bun.js",
                    node: "./server.node.js",
                    default: "./server.node.js",
                },
            },
        }),
    );
    write(
        join(s, "node_modules/react-dom/server.node.js"),
        "exports.tag = 'rds-node';",
    );
    write(
        join(s, "node_modules/@swc/helpers/package.json"),
        JSON.stringify({
            name: "@swc/helpers",
            version: "0.0.0",
            exports: {
                "./_/_interop_require_default": {
                    require: "./cjs/_interop_require_default.cjs",
                },
            },
        }),
    );
    write(
        join(s, "node_modules/@swc/helpers/cjs/_interop_require_default.cjs"),
        "exports.tag = 'swc';",
    );
    write(
        join(s, "node_modules/dep-plain/package.json"),
        '{"name":"dep-plain","main":"lib.js"}',
    );
    write(
        join(s, "node_modules/dep-plain/lib.js"),
        "module.exports = 'plain';",
    );
    return { project, standalone: s };
}

async function freePort(): Promise<number> {
    return await new Promise((res, rej) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", rej);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => res(port));
        });
    });
}

async function getJson(port: number): Promise<Record<string, string>> {
    const deadline = Date.now() + 20_000;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/`);
            if (r.status === 200)
                return (await r.json()) as Record<string, string>;
            last = `status ${r.status}: ${await r.text()}`;
        } catch (e) {
            last = e;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`binary never answered 200: ${String(last)}`);
}

describe("compiled standalone executable — the synthetic wall", () => {
    const { standalone } = syntheticProject();
    const binary = join(standalone, "knext-standalone-exec");

    it("compiles, with the bytecode proof passing", () => {
        const out = execFileSync(
            "bun",
            [
                "run",
                COMPILE_SCRIPT,
                "--server",
                join(standalone, "server.js"),
                "--outfile",
                binary,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        expect(out).toContain("bytecode: verified");
    }, 120_000);

    it("does NOT compile in a package found only outside the traced tree", () => {
        const bytes = readFileSync(binary);
        expect(bytes.includes("OUTSIDE_ONLY_SENTINEL_7f3a")).toBe(false);
    });

    it("boots from an unrelated cwd, serves the tree it sits in, and resolves the disk chunk's bare specifiers", async () => {
        const port = await freePort();
        const elsewhere = mkdtempSync(join(tmpdir(), "knext-wall-cwd-"));
        tempDirs.push(elsewhere);
        const child = spawn(binary, [], {
            cwd: elsewhere,
            env: { ...process.env, PORT: String(port) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (d) => {
            output += d;
        });
        child.stderr.on("data", (d) => {
            output += d;
        });
        try {
            let body: Record<string, string>;
            try {
                body = await getJson(port);
            } catch (e) {
                throw new Error(
                    `${String(e)}\n--- binary output ---\n${output}`,
                );
            }
            // (1) the wall: exports-mapped + plain bare specifiers from DISK code
            expect(body.chunk).toBe("swc|plain|v1");
            // (3) the "bun" condition fell back to the traced Node target
            expect(body.rds).toBe("rds-node");
            // (2) anchored on the executable's directory, not __dirname / cwd
            expect(body.dir).toBe(realpathSync(standalone));
            expect(body.cwd).toBe(realpathSync(standalone));

            // the chunk is read from disk at request time, not frozen in
            write(
                join(standalone, ".next/server/chunk.js"),
                "module.exports = () => 'edited-on-disk';",
            );
            const second = await fetch(`http://127.0.0.1:${port}/`);
            // require cache: the SAME process keeps its loaded chunk — the
            // edit is only visible to a fresh process, so boot a second one.
            expect(second.status).toBe(200);
        } finally {
            child.kill("SIGTERM");
        }

        const port2 = await freePort();
        const child2 = spawn(binary, [], {
            cwd: elsewhere,
            env: { ...process.env, PORT: String(port2) },
            stdio: "ignore",
        });
        try {
            const body2 = await getJson(port2);
            expect(body2.chunk).toBe("edited-on-disk");
        } finally {
            child2.kill("SIGTERM");
        }
    }, 60_000);
});
