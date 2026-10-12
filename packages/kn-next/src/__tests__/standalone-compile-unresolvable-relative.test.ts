/**
 * Next 16.4's `router-server.js` carries `require('../../lib/upgrade/nudge')`
 * inside a dev-only branch, and Next's own tracer deliberately keeps
 * `next/dist/lib/upgrade/**` out of the standalone tree. A bare specifier that
 * resolves nowhere is already left as a runtime require by the compile
 * resolver; a RELATIVE one used to fall through to `Bun.build`, which failed
 * the whole compile ("Could not resolve").
 *
 * The exception is bounded. Only a relative miss from a file inside
 * `node_modules/next/dist/` (the framework's own code, which the uncompiled
 * server would never reach either) is left as a runtime require, and the build
 * says so. A relative miss anywhere else — the user's own app code, any other
 * package — is a real defect and still fails the compile.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE_SCRIPT = resolve(
    import.meta.dir,
    "..",
    "adapters",
    "standalone-compile.mjs",
);

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

const NUDGE = "../../lib/upgrade/nudge";

const SERVER_JS = `const path = require('path')
const dir = path.join(__dirname)
process.env.NODE_ENV = 'production'
process.chdir(__dirname)
const nextConfig = {}
require('next')
const { startServer } = require('next/dist/server/lib/start-server')
startServer({ dir }).catch((err) => { console.error(err); process.exit(1) })
`;

const START_SERVER_WITH_NUDGE = `exports.startServer = async () => {
  if (process.env.KNEXT_TEST_REACH_NUDGE === '1') {
    require('${NUDGE}')
  }
  console.log('server-started')
}
`;

function project(
    opts: {
        startServer?: string;
        serverJs?: string;
        extra?: Record<string, string>;
    } = {},
) {
    const root = mkdtempSync(join(tmpdir(), "knext-unresolvable-relative-"));
    const s = join(root, ".next", "standalone");
    write(join(s, "server.js"), opts.serverJs ?? SERVER_JS);
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"16.4.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        opts.startServer ?? START_SERVER_WITH_NUDGE,
    );
    for (const [rel, body] of Object.entries(opts.extra ?? {})) {
        write(join(s, rel), body);
    }
    return {
        s,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

function compile(s: string, verbose = false) {
    const env = { ...process.env };
    delete env.KNEXT_VERBOSE;
    delete env.KNEXT_STANDALONE_COMPILE_VERBOSE;
    if (verbose) env.KNEXT_VERBOSE = "1";
    const outfile = join(s, "knext-standalone-exec");
    const result = spawnSync(
        "bun",
        [
            "run",
            COMPILE_SCRIPT,
            "--server",
            join(s, "server.js"),
            "--outfile",
            outfile,
        ],
        { encoding: "utf8", env },
    );
    return {
        result,
        outfile,
        out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
}

describe("standalone-compile — an unresolvable relative require", () => {
    it("inside next/dist is left as a runtime require: the compile succeeds and, with --verbose, names the specifier once", () => {
        const { s, cleanup } = project();
        try {
            const { result, out } = compile(s, true);
            expect(result.status).toBe(0);
            const notices = out.split("\n").filter((l) => l.includes(NUDGE));
            expect(notices).toHaveLength(1);
            expect(notices[0]).toContain("[knext standalone-compile]");
            expect(notices[0]).toContain(
                "next/dist/server/lib/start-server.js",
            );
        } finally {
            cleanup();
        }
    }, 120_000);

    it("by default folds into the one-line note summary instead of printing on a healthy build", () => {
        const { s, cleanup } = project();
        try {
            const { result, out } = compile(s);
            expect(result.status).toBe(0);
            expect(out).not.toContain(NUDGE);
            expect(out).toMatch(
                /\[knext standalone-compile\] 1 note; rerun with --verbose for details/,
            );
        } finally {
            cleanup();
        }
    }, 120_000);

    it("stays a throw if ever reached, exactly as the uncompiled server would, and is inert otherwise", () => {
        const { s, cleanup } = project();
        try {
            const { result, outfile } = compile(s);
            expect(result.status).toBe(0);
            const quiet = spawnSync(outfile, [], {
                encoding: "utf8",
                env: { ...process.env, KNEXT_TEST_REACH_NUDGE: "0" },
            });
            expect(`${quiet.stdout}${quiet.stderr}`).toContain(
                "server-started",
            );
            const reached = spawnSync(outfile, [], {
                encoding: "utf8",
                env: { ...process.env, KNEXT_TEST_REACH_NUDGE: "1" },
            });
            expect(reached.status).not.toBe(0);
            expect(`${reached.stdout}${reached.stderr}`).toContain("nudge");
        } finally {
            cleanup();
        }
    }, 120_000);

    it("in the user's own app code still fails the build", () => {
        const { s, cleanup } = project({
            serverJs: `${SERVER_JS}\nrequire('./user-module-that-does-not-exist')\n`,
        });
        try {
            const { result, out } = compile(s);
            expect(result.status).not.toBe(0);
            expect(out).toContain("user-module-that-does-not-exist");
        } finally {
            cleanup();
        }
    }, 120_000);

    it("in a package whose name merely starts with `next` still fails the build", () => {
        const { s, cleanup } = project({
            serverJs: `${SERVER_JS}\nrequire('next-sibling')\n`,
            extra: {
                "node_modules/next-sibling/package.json":
                    '{"name":"next-sibling","version":"1.0.0","main":"dist/index.js"}',
                "node_modules/next-sibling/dist/index.js":
                    "module.exports = require('./gone')",
            },
        });
        try {
            const { result } = compile(s);
            expect(result.status).not.toBe(0);
        } finally {
            cleanup();
        }
    }, 120_000);

    it("in next/ but outside dist/ still fails the build", () => {
        const { s, cleanup } = project({
            serverJs: `${SERVER_JS}\nrequire('next/other')\n`,
            extra: {
                "node_modules/next/other.js":
                    "module.exports = require('./gone')",
            },
        });
        try {
            const { result } = compile(s);
            expect(result.status).not.toBe(0);
        } finally {
            cleanup();
        }
    }, 120_000);
});
