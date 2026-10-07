/**
 * `computeDiskClosure()` (`standalone-compile.mjs`) scans disk-loaded route
 * chunks for literal `require(...)` / `import(...)` / `from "..."`
 * specifiers and resolves each one (`resolveRequireLike`) to decide whether
 * it must stay on disk, bundled, or unresolvable altogether. A specifier that
 * resolves under NEITHER the `require` nor the ESM/`default` condition used
 * to be dropped with a bare `catch { continue }` — silently. That silence hid
 * a real bug (minio's export map, #1790): it surfaced ~550 KB later as an
 * unrelated "bytecode marker not under `// @bun` pragma" failure instead of
 * at the point the module actually went missing.
 *
 * This test proves the drop is now LOGGED: a specifier the fixture chunk
 * requires, but that resolves nowhere on disk, makes the compile script print
 * a `[knext standalone-compile]` warning naming the specifier, the resolving
 * directory, and both resolution attempts' failures — without the compile
 * script itself failing on account of it (the module is still just dropped,
 * same as before; only the silence changed).
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

const UNRESOLVABLE_SPECIFIER = "knext-test-unresolvable-pkg-1790";

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

function syntheticProject(): { standalone: string; cleanup: () => void } {
    const project = mkdtempSync(join(tmpdir(), "knext-dropped-specifier-"));
    const s = join(project, ".next", "standalone");
    write(join(s, "server.js"), SERVER_JS);
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"0.0.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        "exports.startServer = async () => {};",
    );
    // The disk-loaded chunk: one resolvable require, one that resolves
    // nowhere (neither the `require` nor the ESM/`default` condition).
    write(
        join(s, ".next/server/chunk.js"),
        `module.exports = () => require('${UNRESOLVABLE_SPECIFIER}');`,
    );
    return {
        standalone: s,
        cleanup: () => rmSync(project, { recursive: true, force: true }),
    };
}

describe("computeDiskClosure — a specifier that resolves nowhere is logged, not silently dropped", () => {
    it("with --verbose, prints a [knext standalone-compile] warning naming the specifier, the resolving directory, and both resolution attempts", () => {
        const { standalone, cleanup } = syntheticProject();
        try {
            const outfile = join(standalone, "knext-standalone-exec");
            const result = spawnSync(
                "bun",
                [
                    "run",
                    COMPILE_SCRIPT,
                    "--server",
                    join(standalone, "server.js"),
                    "--outfile",
                    outfile,
                ],
                {
                    encoding: "utf8",
                    env: { ...process.env, KNEXT_VERBOSE: "1" },
                },
            );
            const stderr = result.stderr ?? "";
            expect(stderr).toContain("[knext standalone-compile]");
            expect(stderr).toContain(UNRESOLVABLE_SPECIFIER);
            expect(stderr).toContain(join(standalone, ".next", "server"));
            expect(stderr).toContain("require condition failed");
            expect(stderr).toContain("ESM/default condition failed");
        } finally {
            cleanup();
        }
    }, 60_000);

    it("does not print the warning for a specifier that DOES resolve", () => {
        const { standalone, cleanup } = syntheticProject();
        try {
            // Replace the chunk with one that only requires something real.
            write(
                join(standalone, ".next/server/chunk.js"),
                "module.exports = () => require('path');",
            );
            const outfile = join(standalone, "knext-standalone-exec");
            const result = spawnSync(
                "bun",
                [
                    "run",
                    COMPILE_SCRIPT,
                    "--server",
                    join(standalone, "server.js"),
                    "--outfile",
                    outfile,
                ],
                { encoding: "utf8" },
            );
            expect(result.stderr ?? "").not.toContain("disk closure: dropping");
        } finally {
            cleanup();
        }
    }, 60_000);
});

describe("computeDiskClosure — the default build stays quiet", () => {
    it("without --verbose, folds the dropped specifiers into ONE summary line that points at --verbose", () => {
        const { standalone, cleanup } = syntheticProject();
        try {
            const env = { ...process.env };
            delete env.KNEXT_VERBOSE;
            delete env.KNEXT_STANDALONE_COMPILE_VERBOSE;
            const result = spawnSync(
                "bun",
                [
                    "run",
                    COMPILE_SCRIPT,
                    "--server",
                    join(standalone, "server.js"),
                    "--outfile",
                    join(standalone, "knext-standalone-exec"),
                ],
                { encoding: "utf8", env },
            );
            expect(result.status).toBe(0);
            const stderr = result.stderr ?? "";
            expect(stderr).not.toContain(UNRESOLVABLE_SPECIFIER);
            expect(stderr).not.toContain("Require stack");
            const lines = stderr.split("\n").filter((l) => l.trim() !== "");
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(
                /^\[knext standalone-compile\] 1 note; rerun with --verbose for details$/,
            );
        } finally {
            cleanup();
        }
    }, 60_000);

    it("prints nothing at all when there is nothing to note", () => {
        const { standalone, cleanup } = syntheticProject();
        try {
            write(
                join(standalone, ".next/server/chunk.js"),
                "module.exports = () => require('path');",
            );
            const env = { ...process.env };
            delete env.KNEXT_VERBOSE;
            const result = spawnSync(
                "bun",
                [
                    "run",
                    COMPILE_SCRIPT,
                    "--server",
                    join(standalone, "server.js"),
                    "--outfile",
                    join(standalone, "knext-standalone-exec"),
                ],
                { encoding: "utf8", env },
            );
            expect(result.status).toBe(0);
            expect(result.stderr ?? "").toBe("");
        } finally {
            cleanup();
        }
    }, 60_000);

    it("a FAILED compile still prints the held notes in full, before the failure", () => {
        const { standalone, cleanup } = syntheticProject();
        try {
            const env = { ...process.env };
            delete env.KNEXT_VERBOSE;
            const result = spawnSync(
                "bun",
                [
                    "run",
                    COMPILE_SCRIPT,
                    "--server",
                    join(standalone, "server.js"),
                    "--outfile",
                    join(standalone, "knext-standalone-exec"),
                    // an unknown target makes Bun.build fail AFTER the closure scan
                    "--target",
                    "bun-no-such-target",
                ],
                { encoding: "utf8", env },
            );
            expect(result.status).not.toBe(0);
            const stderr = result.stderr ?? "";
            expect(stderr).toContain(UNRESOLVABLE_SPECIFIER);
            expect(stderr).not.toContain("rerun with --verbose");
        } finally {
            cleanup();
        }
    }, 60_000);
});
