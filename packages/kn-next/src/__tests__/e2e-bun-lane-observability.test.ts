/**
 * #188 (Bun-lane fix round 1, triage of run 28607626868) — observability + bun
 * lane wiring for the official-suite harness scripts.
 *
 * Triage's #1 finding: every Bucket-1 "socket hang up" failure's real cause was
 * sitting in `.adapter-server.log` inside the fixture temp dir — and CI threw
 * it away. e2e-logs.sh only runs at SETUP (next-deploy.ts fetchBuildLogs); on a
 * mere per-test failure nothing surfaced the server stderr.
 *
 * The mechanism that DOES reach the per-file `❌ <file> output` group:
 * next-deploy.ts@v16.2.0 `cleanupUsingCustomScript` pipes the cleanup script's
 * stdout/stderr into the jest process (lines 140-148), whose combined output
 * run-tests.js prints inside the failing file's group (and hides for passing
 * files). So: e2e-cleanup.sh dumps a BOUNDED tail of the server log at
 * teardown — failures carry the server-side exception, green files stay quiet.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = resolve(import.meta.dirname, "../../../../scripts");
const CLEANUP = join(SCRIPTS_DIR, "e2e-cleanup.sh");
const DEPLOY = join(SCRIPTS_DIR, "e2e-deploy.sh");
const LOGS = join(SCRIPTS_DIR, "e2e-logs.sh");

function runCleanup(cwd: string) {
    return spawnSync("bash", [CLEANUP], { cwd, encoding: "utf8" });
}

function seedAppDir(overrides: { serverLog?: string | null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "knext-e2e-cleanup-"));
    const serverLogPath = join(dir, ".adapter-server.log");
    // No PID line on purpose: nothing to kill, deterministic teardown.
    writeFileSync(
        join(dir, ".adapter-build.log"),
        [
            "BUILD_ID=test-build",
            "DEPLOYMENT_ID=knext-test",
            "PORT=0",
            "RUNTIME=bun",
            `SERVER_LOG=${serverLogPath}`,
            "",
        ].join("\n"),
    );
    if (overrides.serverLog !== null) {
        writeFileSync(
            serverLogPath,
            overrides.serverLog ??
                "▲ Next.js 16.2.0\nError: Internal: NoFallbackError\n    at processTicksAndRejections (null)\n",
        );
    }
    return { dir, serverLogPath };
}

describe("e2e-cleanup.sh — surfaces the server log tail at teardown (#188 bucket 1 observability)", () => {
    it("dumps the .adapter-server.log tail to stderr so the harness ❌ group carries the server-side exception", () => {
        const { dir } = seedAppDir();
        const res = runCleanup(dir);
        expect(res.status).toBe(0);
        expect(res.stderr).toContain("knext standalone server log tail");
        expect(res.stderr).toContain("Error: Internal: NoFallbackError");
        expect(res.stderr).toContain("end of server log tail");
    });

    it("bounds the dump to the log TAIL (last bytes), never the whole file", () => {
        const head = `HEAD-SENTINEL-${"x".repeat(64)}\n`;
        const filler = `${"f".repeat(127)}\n`.repeat(512); // 64 KiB of filler
        const tail = "TAIL-SENTINEL: the exception is here\n";
        const { dir } = seedAppDir({ serverLog: head + filler + tail });
        const res = runCleanup(dir);
        expect(res.status).toBe(0);
        expect(res.stderr).toContain("TAIL-SENTINEL");
        expect(res.stderr).not.toContain("HEAD-SENTINEL");
    });

    it("stays exit-0 and says so when there is no server log", () => {
        const { dir } = seedAppDir({ serverLog: null });
        const res = runCleanup(dir);
        expect(res.status).toBe(0);
        expect(res.stderr).toContain("no server log");
    });
});

describe("e2e-deploy.sh — bun-lane keep-alive guard wiring (#188 bucket 1 fix)", () => {
    const src = readFileSync(DEPLOY, "utf8");

    it("resolves the bun keep-alive guard preload from the installed package (with source fallback)", () => {
        expect(src).toContain("internal/bun-keepalive-guard");
        expect(src).toContain("bun-keepalive-guard.cjs");
    });

    it("appends the guard preload ONLY for RUNTIME=bun — the Node boot line stays byte-identical", () => {
        // the guard -r flag must be inside a bun-only branch
        expect(src).toMatch(
            /if \[ "\$\{RUNTIME\}" = "bun" \];[\s\S]{0,200}KNEXT_BUN_GUARD_PRELOAD/,
        );
        // and the shared (Node-reaching) preload args must NOT carry the guard
        expect(src).toMatch(
            /SERVER_PRELOAD_ARGS=\(-r "\$\{KNEXT_CC_PRELOAD\}"\)/,
        );
    });
});

describe("harness scripts stay bash-valid (bash -n)", () => {
    for (const script of [DEPLOY, CLEANUP, LOGS]) {
        it(`bash -n ${script.split("/").pop()}`, () => {
            const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
            expect(res.status, res.stderr).toBe(0);
        });
    }
});
