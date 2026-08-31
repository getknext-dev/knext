/**
 * Regression tests for the vinext → official Next.js Adapter migration.
 *
 * These tests assert that Nitro/Vinext build APIs are fully removed from the
 * kn-next framework packages, and that the official `output:'standalone'` path
 * is wired instead. Written RED-first per superteam TDD discipline.
 *
 * Tested invariants:
 *  - shared.ts no longer exports getNitroPreset or copyAdapters (Nitro-specific)
 *  - build.ts source does not reference NITRO_PRESET or getNitroPreset
 *  - deploy.ts source does not reference NITRO_PRESET or getNitroPreset
 *  - node-server.ts does not import Nitro's index.mjs; starts standalone server.js
 *  - config.ts runtime field comment does not mention "Nitro preset"
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Locate the kn-next src directory relative to this __tests__ file.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(TESTS_DIR, "..");

function readSrc(relPath: string): string {
    return readFileSync(resolve(SRC, relPath), "utf-8");
}

// ─── shared.ts: Nitro exports removed ────────────────────────────────────────

describe("shared.ts: Nitro APIs removed", () => {
    it("does NOT export getNitroPreset", async () => {
        const mod = await import("../cli/shared");
        expect("getNitroPreset" in mod).toBe(false);
    });

    it("does NOT export copyAdapters (Nitro .output copy removed)", async () => {
        const mod = await import("../cli/shared");
        expect("copyAdapters" in mod).toBe(false);
    });

    it("still exports loadConfig", async () => {
        const mod = await import("../cli/shared");
        expect(typeof (mod as Record<string, unknown>).loadConfig).toBe(
            "function",
        );
    });
});

// ─── build.ts: no Nitro build orchestration ───────────────────────────────────

describe("build.ts: no Nitro build orchestration", () => {
    it("does NOT contain NITRO_PRESET env var", () => {
        expect(readSrc("cli/build.ts")).not.toMatch(/NITRO_PRESET/);
    });

    it("does NOT call getNitroPreset", () => {
        expect(readSrc("cli/build.ts")).not.toContain("getNitroPreset");
    });

    it("does NOT call copyAdapters", () => {
        expect(readSrc("cli/build.ts")).not.toContain("copyAdapters");
    });
});

// ─── deploy.ts: no Nitro build orchestration ──────────────────────────────────

describe("deploy.ts: no Nitro build orchestration", () => {
    it("does NOT contain NITRO_PRESET env var", () => {
        expect(readSrc("cli/deploy.ts")).not.toMatch(/NITRO_PRESET/);
    });

    it("does NOT call getNitroPreset", () => {
        expect(readSrc("cli/deploy.ts")).not.toContain("getNitroPreset");
    });

    it("does NOT call copyAdapters", () => {
        expect(readSrc("cli/deploy.ts")).not.toContain("copyAdapters");
    });
});

// ─── node-server.ts: standalone runtime, not Nitro ───────────────────────────

describe("node-server.ts: starts Next.js standalone server, not Nitro", () => {
    it("does NOT import Nitro server (index.mjs / .output/server)", () => {
        const src = readSrc("adapters/node-server.ts");
        expect(src).not.toContain("index.mjs");
        expect(src).not.toContain(".output/server");
    });

    it("references the Next.js standalone server.js entry point", () => {
        expect(readSrc("adapters/node-server.ts")).toMatch(/server\.js/);
    });
});

// ─── config.ts: runtime field is standalone-oriented, not Nitro ──────────────

describe("config.ts: runtime field describes standalone, not Nitro preset", () => {
    it('does NOT describe runtime as a "Nitro preset"', () => {
        expect(readSrc("config.ts")).not.toMatch(/Nitro preset/i);
    });
});

// ─── apps/file-manager: no regression on the official adapter ─────────────────
// The app already uses the official NextAdapter via experimental.adapterPath.
// Verify the next-adapter.ts and next.config.ts remain on that path.

// ─── node-server: NODE_COMPILE_CACHE forwarded to spawned process ─────────────
// `buildChildEnv` is extracted from node-server.ts so it can be tested without
// starting the HTTP server or spawning a real child process.
// The operator injects NODE_COMPILE_CACHE pointing at a PVC for cross-pod caching;
// the standalone server MUST inherit it — never hardcode or override it.

describe("node-server: NODE_COMPILE_CACHE forwarded to spawned server", () => {
    it("buildChildEnv inherits NODE_COMPILE_CACHE from process.env when set", async () => {
        const { buildChildEnv } = await import("../adapters/env");
        const saved = process.env.NODE_COMPILE_CACHE;
        try {
            process.env.NODE_COMPILE_CACHE = "/test/compile-cache";
            expect(buildChildEnv().NODE_COMPILE_CACHE).toBe(
                "/test/compile-cache",
            );
        } finally {
            if (saved === undefined) delete process.env.NODE_COMPILE_CACHE;
            else process.env.NODE_COMPILE_CACHE = saved;
        }
    });

    it("externally-set NODE_COMPILE_CACHE is not clobbered (operator PVC path wins)", async () => {
        const { buildChildEnv } = await import("../adapters/env");
        const saved = process.env.NODE_COMPILE_CACHE;
        try {
            process.env.NODE_COMPILE_CACHE = "/operator-pvc/bytecode-cache";
            const env = buildChildEnv();
            expect(env.NODE_COMPILE_CACHE).toBe("/operator-pvc/bytecode-cache");
        } finally {
            if (saved === undefined) delete process.env.NODE_COMPILE_CACHE;
            else process.env.NODE_COMPILE_CACHE = saved;
        }
    });

    it("NODE_COMPILE_CACHE absent from env when not set (no hardcoded fallback in buildChildEnv)", async () => {
        const { buildChildEnv } = await import("../adapters/env");
        const saved = process.env.NODE_COMPILE_CACHE;
        try {
            delete process.env.NODE_COMPILE_CACHE;
            // Must be undefined — the Dockerfile CMD supplies the fallback, not the code
            expect(buildChildEnv().NODE_COMPILE_CACHE).toBeUndefined();
        } finally {
            if (saved !== undefined) process.env.NODE_COMPILE_CACHE = saved;
        }
    });
});

// ─── apps/file-manager: no regression on the official adapter ─────────────────
// The app already uses the official NextAdapter via experimental.adapterPath.
// Verify the next-adapter.ts and next.config.ts remain on that path.

describe("apps/file-manager: official adapter, not Nitro", () => {
    const APP_SRC = resolve(TESTS_DIR, "../../../../apps/file-manager");

    function readApp(relPath: string): string {
        return readFileSync(resolve(APP_SRC, relPath), "utf-8");
    }

    it("next-adapter.ts uses official NextAdapter interface (not Nitro)", () => {
        const src = readApp("next-adapter.ts");
        // Must import NextAdapter from 'next'
        expect(src).toMatch(/from\s+['"]next['"]/);
        // Must not use Nitro-style imports
        expect(src).not.toContain("index.mjs");
    });

    it("next.config.ts sets output:standalone and adapterPath (official adapter)", () => {
        const src = readApp("next.config.ts");
        expect(src).toContain("output: 'standalone'");
        expect(src).toContain("adapterPath");
    });
});
