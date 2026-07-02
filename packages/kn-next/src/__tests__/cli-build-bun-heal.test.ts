/**
 * #188 (architecture-gate finding on PR #189) — the standalone bun-exports
 * heal must ship on the REAL user build path, not only in the compat harness.
 *
 * The adapter's onBuildComplete call is a documented no-op (the hook fires
 * before `.next/standalone` exists at next 16.2), and e2e-deploy.sh only
 * covers the compat lane. `kn-next build` (cli/build.ts → `next build` →
 * asset upload; the Dockerfile COPYs the raw standalone tree) is what real
 * deployments run — without the heal there, a `runtime: bun` user still 500s
 * every pages-router SSR/API render (missing react-dom `server.bun.js`).
 *
 * DESIGN: the heal runs UNCONDITIONALLY (not gated on `config.runtime`):
 * it is additive-only, version-checked, and never throws — on Node-only
 * deployments it costs a few small file copies and changes nothing at
 * runtime — while the runtime choice is a deploy/serve-time knob (the same
 * image may later be booted under Bun), so gating at build time would leave
 * the latent 500 for exactly the users who flip runtimes after building.
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the config loader and asset upload so `build()` runs the real build
// pipeline shape without a kn-next.config.ts or storage credentials.
vi.mock("../cli/shared", () => ({
    loadConfig: vi.fn(async () => ({
        name: "heal-test-app",
        storage: { provider: "gcs", bucket: "test-bucket" },
        cache: undefined,
        runtime: "node", // node config on purpose — the heal must run anyway
    })),
}));
vi.mock("../utils/asset-upload", () => ({
    uploadAssets: vi.fn(async () => {}),
}));

import { build } from "../cli/build";

function writePkg(
    dir: string,
    pkg: Record<string, unknown>,
    files: Record<string, string>,
) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
    }
}

const FAKE_RD = {
    name: "fake-react-dom",
    version: "19.9.9",
    exports: {
        "./server": {
            bun: "./server.bun.js",
            node: "./server.node.js",
            default: "./server.node.js",
        },
    },
};

/** A project dir shaped like an app AFTER `next build` (Node-traced tree). */
function seedProject() {
    const projectDir = mkdtempSync(join(tmpdir(), "knext-cli-build-heal-"));
    writePkg(join(projectDir, "node_modules/fake-react-dom"), FAKE_RD, {
        "server.node.js": "module.exports = 'node';\n",
        "server.bun.js": "module.exports = 'bun';\n",
    });
    const standalonePkgDir = join(
        projectDir,
        ".next/standalone/node_modules/fake-react-dom",
    );
    writePkg(standalonePkgDir, FAKE_RD, {
        "server.node.js": "module.exports = 'node';\n",
    });
    return { projectDir, standalonePkgDir };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("kn-next build — bun-exports heal ships on the user build path (#188)", () => {
    it("heals the standalone tree during build(), even with a node runtime config", async () => {
        const { projectDir, standalonePkgDir } = seedProject();
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);

        await build({ skipNextBuild: true });

        expect(existsSync(join(standalonePkgDir, "server.bun.js"))).toBe(true);
        expect(
            readFileSync(join(standalonePkgDir, "server.bun.js"), "utf8"),
        ).toBe("module.exports = 'bun';\n");
    });

    it("survives a project without a standalone tree (no throw, build continues)", async () => {
        const projectDir = mkdtempSync(join(tmpdir(), "knext-cli-build-none-"));
        vi.spyOn(process, "cwd").mockReturnValue(projectDir);
        await expect(build({ skipNextBuild: true })).resolves.toBeUndefined();
    });

    it("build.ts invokes the heal on the post-build path (source contract)", () => {
        const src = readFileSync(
            resolve(import.meta.dirname, "../cli/build.ts"),
            "utf8",
        );
        expect(src).toContain("healBunExportTargets");
        // post-build: the heal must come after the next-build step and before
        // the completion log.
        // (the CALL — `lastIndexOf` skips the import at the top of the file)
        expect(src.lastIndexOf("healBunExportTargets(")).toBeGreaterThan(
            src.indexOf("skipNextBuild"),
        );
        expect(src.lastIndexOf("healBunExportTargets(")).toBeLessThan(
            src.indexOf("Build complete!"),
        );
    });
});
