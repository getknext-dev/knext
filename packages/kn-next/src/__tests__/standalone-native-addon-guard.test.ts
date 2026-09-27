/**
 * self-contained compile (#1456): a `.node` native addon under `.next/server`
 * must fail the build, never be silently embedded as data. A native addon is
 * `dlopen`'d from a real filesystem path — `$bunfs` (the compiled binary's
 * virtual filesystem) cannot provide one, so embedding it byte-for-byte (the
 * path every other unknown-kind file takes) would ship a file Next's
 * `require` can only crash on at runtime, with no build-time signal.
 *
 * Round-1 review finding (`standalone-embed.mjs:43-54,109`): a `.node` (or
 * `.wasm`/`.gz`) fell into `unknownKinds`, embedded as data and only logged —
 * never failed. This proves the fix at the actual compile-script boundary,
 * not just the pure classifier (see `standalone-embed.test.ts` for that).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE_SCRIPT = resolve(
    import.meta.dir,
    "..",
    "adapters",
    "standalone-compile.mjs",
);

/**
 * The shape standalone-exec-entry.mjs's rewrite requires ("server.js has N
 * occurrence(s) of ... expected exactly 1") — the same fixture the wall test
 * (standalone-compile-wall.test.ts) uses, trimmed to what that check needs.
 */
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

function write(path: string, content: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/** Just enough of a standalone tree to reach self-contained planning. */
function syntheticStandalone(): { standalone: string; nodeFile: string } {
    const project = mkdtempSync(join(tmpdir(), "knext-native-addon-guard-"));
    tempDirs.push(project);
    const standalone = join(project, ".next", "standalone");
    write(join(standalone, "server.js"), SERVER_JS);
    // Any bytes stand in for a real native addon binary — the guard triggers
    // on the extension, not the content.
    const nodeFile = join(standalone, ".next", "server", "vendor", "sharp-linux-x64.node");
    write(nodeFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    return { standalone, nodeFile };
}

function runCompile(standalone: string, binary: string): { status: number | null; stderr: string } {
    try {
        execFileSync(
            "bun",
            [
                "run",
                COMPILE_SCRIPT,
                "--server",
                join(standalone, "server.js"),
                "--outfile",
                binary,
                "--self-contained",
                "1",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        return { status: 0, stderr: "" };
    } catch (err) {
        const e = err as { status: number | null; stderr: string };
        return { status: e.status, stderr: String(e.stderr) };
    }
}

describe("self-contained compile fails closed on a .node native addon", () => {
    it("exits non-zero and names the offending file, before attempting to compile", () => {
        const { standalone, nodeFile } = syntheticStandalone();
        const binary = join(standalone, "knext-standalone-exec");
        const result = runCompile(standalone, binary);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("native addon");
        expect(result.stderr).toContain("server/vendor/sharp-linux-x64.node");
        expect(result.stderr).toContain("dlopen");
        expect(result.stderr).not.toBe("");
        // sanity: the file we asserted on is the one we actually wrote
        expect(() => statSync(nodeFile)).not.toThrow();
    }, 30_000);

    it("does not write an outfile — the guard fires before any compile is attempted", () => {
        const { standalone } = syntheticStandalone();
        const binary = join(standalone, "knext-standalone-exec-2");
        const result = runCompile(standalone, binary);
        expect(result.status).not.toBe(0);
        expect(() => statSync(binary)).toThrow();
    }, 30_000);
});
