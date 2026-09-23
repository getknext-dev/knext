/**
 * How the supervisor (`node-server.ts`) starts the Next child.
 *
 * Two shapes, chosen by STANDALONE_SERVER_EXEC:
 *
 *   - unset  -> `<runtime> [--require preloads…] server.js` (the uncompiled
 *               node cell — byte-identical to before);
 *   - set    -> the compiled standalone executable, with NO arguments: it
 *               takes no `--require` (its argv is the app's), and its preloads
 *               are compiled in.
 *
 * A relative STANDALONE_SERVER_EXEC resolves against the supervisor's cwd, like
 * STANDALONE_SERVER_PATH. An empty value is treated as unset rather than as
 * "spawn the cwd".
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { childSpawnPlan } from "../adapters/standalone-exec";

const base = {
    cwd: "/app",
    execPath: "/usr/local/bin/bun",
    serverJs: "/app/.next/standalone/server.js",
    preloadArgs: ["--require", "/p/a.cjs", "--require", "/p/b.cjs"],
};

describe("childSpawnPlan", () => {
    it("spawns the runtime with preloads + server.js when no executable is configured", () => {
        expect(childSpawnPlan({ ...base, env: {} })).toEqual({
            mode: "script",
            command: "/usr/local/bin/bun",
            args: [...base.preloadArgs, base.serverJs],
        });
    });

    it("spawns the compiled executable with NO arguments when configured", () => {
        expect(
            childSpawnPlan({
                ...base,
                env: {
                    STANDALONE_SERVER_EXEC:
                        "/app/.next/standalone/knext-standalone-exec",
                },
            }),
        ).toEqual({
            mode: "exec",
            command: "/app/.next/standalone/knext-standalone-exec",
            args: [],
        });
    });

    it("resolves a relative executable path against the cwd", () => {
        expect(
            childSpawnPlan({
                ...base,
                env: { STANDALONE_SERVER_EXEC: ".next/standalone/x" },
            }).command,
        ).toBe("/app/.next/standalone/x");
    });

    it("treats an empty value as unset", () => {
        expect(
            childSpawnPlan({ ...base, env: { STANDALONE_SERVER_EXEC: "" } })
                .mode,
        ).toBe("script");
    });
});

describe("node-server.ts wiring", () => {
    const src = readFileSync(
        resolve(import.meta.dir, "..", "adapters", "node-server.ts"),
        "utf8",
    );

    it("spawns through the plan (both shapes), not a hard-coded runtime + script", () => {
        expect(src).toContain("childSpawnPlan(");
        expect(src).toMatch(/spawn\(\s*spawnPlan\.command,\s*spawnPlan\.args/);
    });
});
