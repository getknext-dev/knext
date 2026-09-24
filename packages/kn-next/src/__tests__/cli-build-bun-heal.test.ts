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

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Mock the config loader and asset upload so `build()` runs the real build
// pipeline shape without a kn-next.config.ts or storage credentials.
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    loadConfig: mock(async () => ({
        name: "heal-test-app",
        storage: { provider: "gcs", bucket: "test-bucket" },
        cache: undefined,
        runtime: "node", // node config on purpose — the heal must run anyway
        // Explicit since ADR-0048: the heal walks a `.next/standalone` tree, so
        // it applies to that artifact SHAPE only. The default build is vinext,
        // which emits a nitro output and correctly skips the heal — relying on
        // the default here would assert the heal "does not run" while claiming
        // to test that it does.
        build: "turbopack",
    })),
}));
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets: mock(async () => {}),
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

const tempDirs: string[] = [];

/** A project dir shaped like an app AFTER `next build` (Node-traced tree). */
function seedProject() {
    const projectDir = mkdtempSync(join(tmpdir(), "knext-cli-build-heal-"));
    tempDirs.push(projectDir);
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
    jest.restoreAllMocks();
    for (const d of tempDirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});

describe("kn-next build — bun-exports heal ships on the user build path (#188)", () => {
    it("heals the standalone tree during build(), even with a node runtime config", async () => {
        const { projectDir, standalonePkgDir } = seedProject();
        spyOn(process, "cwd").mockReturnValue(projectDir);

        await build({ skipNextBuild: true });

        expect(existsSync(join(standalonePkgDir, "server.bun.js"))).toBe(true);
        expect(
            readFileSync(join(standalonePkgDir, "server.bun.js"), "utf8"),
        ).toBe("module.exports = 'bun';\n");
    });

    it("survives a project without a standalone tree (no throw, build continues)", async () => {
        const projectDir = mkdtempSync(join(tmpdir(), "knext-cli-build-none-"));
        tempDirs.push(projectDir);
        spyOn(process, "cwd").mockReturnValue(projectDir);
        await expect(build({ skipNextBuild: true })).resolves.toBeUndefined();
    });

    it("build.ts invokes the heal on the post-build path, via the shared compile step (source contract)", () => {
        // #1339 review finding #1: the heal (and the standalone-bun/vinext
        // compile) moved into ONE shared step (`build-artifact.ts`'s
        // `compileArtifactForDeploy`) so `kn-next deploy`/`preview` reuse it
        // instead of duplicating it. build.ts no longer calls
        // `healBunExportTargets` directly — it calls the shared step, which
        // does. Both halves are asserted so this stays a real source
        // contract, not a rename that quietly stopped checking anything.
        const buildSrc = readFileSync(
            resolve(import.meta.dirname, "../cli/build.ts"),
            "utf8",
        );
        const artifactSrc = readFileSync(
            resolve(import.meta.dirname, "../cli/build-artifact.ts"),
            "utf8",
        );

        // build.ts calls the shared step, post-build and before completion.
        expect(buildSrc).toContain("compileArtifactForDeploy(");
        expect(
            buildSrc.lastIndexOf("compileArtifactForDeploy("),
        ).toBeGreaterThan(buildSrc.indexOf("skipNextBuild"));
        expect(buildSrc.lastIndexOf("compileArtifactForDeploy(")).toBeLessThan(
            buildSrc.indexOf("Build complete!"),
        );
        // build.ts must NOT ALSO call the heal directly — that would be the
        // exact duplication finding #1 asked to remove.
        expect(buildSrc).not.toContain("healBunExportTargets(");

        // The shared step itself is what actually performs the heal.
        expect(artifactSrc).toContain("healBunExportTargets(");
    });
});
