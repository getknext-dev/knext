/**
 * asset-upload.ts — stageStandaloneAssets (the .next/static + public → staging
 * copy, with the #264 .knext-build marker) and reclaimBuildPrefix (the v6-P2
 * failure-path scoped single-prefix delete). stageStandaloneAssets is pure fs
 * (real temp cwd); reclaimBuildPrefix routes through the tolerant delete helper
 * (a missing provider CLI is swallowed by runQuietAllowFail — no throw).
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    BUILD_MARKER_FILENAME,
    reclaimBuildPrefix,
    type StorageBackedConfig,
    stageStandaloneAssets,
} from "../utils/asset-upload";

let cwd: string;

function seedBuild(opts: { buildId?: string; withPublic?: boolean }): void {
    const staticDir = join(cwd, ".next", "static", opts.buildId ?? "bid1");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "chunk.js"), "console.log(1)");
    if (opts.buildId) {
        writeFileSync(join(cwd, ".next", "BUILD_ID"), `${opts.buildId}\n`);
    }
    if (opts.withPublic) {
        mkdirSync(join(cwd, "public"), { recursive: true });
        writeFileSync(join(cwd, "public", "favicon.ico"), "icon");
    }
}

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "knext-stage-"));
});
afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
});

describe("stageStandaloneAssets", () => {
    it("stages .next/static under _next/static, copies public/, and writes the build marker", () => {
        seedBuild({ buildId: "bid1", withPublic: true });

        const staging = stageStandaloneAssets(cwd);

        expect(
            existsSync(join(staging, "_next", "static", "bid1", "chunk.js")),
        ).toBe(true);
        // public/ files land at the staging root (bucket key-space root).
        expect(existsSync(join(staging, "favicon.ico"))).toBe(true);
        // #264 marker in this build's prefix.
        const marker = join(
            staging,
            "_next",
            "static",
            "bid1",
            BUILD_MARKER_FILENAME,
        );
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf8").trim()).toBe("bid1");
    });

    it("throws when .next/static is missing (build not run)", () => {
        expect(() => stageStandaloneAssets(cwd)).toThrow(/No \.next\/static/);
    });

    it("stages without a marker (and warns) when .next/BUILD_ID is absent", () => {
        // static present, but NO BUILD_ID file → marker not staged.
        seedBuild({ withPublic: false });
        const staging = stageStandaloneAssets(cwd);
        expect(
            existsSync(join(staging, "_next", "static", "bid1", "chunk.js")),
        ).toBe(true);
        expect(
            existsSync(
                join(staging, "_next", "static", "bid1", BUILD_MARKER_FILENAME),
            ),
        ).toBe(false);
    });

    it("rebuilds the staging area from scratch on each run (no stale carryover)", () => {
        seedBuild({ buildId: "bid1", withPublic: false });
        const staging = stageStandaloneAssets(cwd);
        writeFileSync(join(staging, "STALE.txt"), "old");
        // Second run must clear the stale file.
        stageStandaloneAssets(cwd);
        expect(existsSync(join(staging, "STALE.txt"))).toBe(false);
    });
});

describe("reclaimBuildPrefix", () => {
    const config: StorageBackedConfig = {
        name: "my-app",
        registry: "r",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://x",
        },
    };

    it("is a no-op for an empty build id (never scopes to the static root)", () => {
        // Returns BEFORE building a delete URI or spawning any provider CLI.
        expect(() => reclaimBuildPrefix(config, "")).not.toThrow();
    });
});
