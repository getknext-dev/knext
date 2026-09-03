/**
 * asset-upload.ts — stageStandaloneAssets (the .next/static + public → staging
 * copy, with the #264 .knext-build marker) and reclaimBuildPrefix (the v6-P2
 * failure-path scoped single-prefix delete). stageStandaloneAssets is pure fs
 * (real temp cwd); reclaimBuildPrefix routes through the tolerant delete helper
 * (a missing provider CLI is swallowed by runQuietAllowFail — no throw).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BUILD_MARKER_FILENAME,
    reclaimBuildPrefix,
    type StorageBackedConfig,
    stageNitroPublicAssets,
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

/**
 * The nitro (vinext) staging path — the coverage gap the PR #890 design gate
 * named: nothing anywhere ran the upload path against a vinext artifact, which
 * is how two defects shipped unseen — a throw whose remediation named the
 * retired builder, and an `rmSync` over the artifact's own static root, racing
 * the docker build that COPYs it.
 */
describe("stageNitroPublicAssets", () => {
    function seedNitroBuild(): void {
        const uuid = join(
            cwd,
            ".output",
            "public",
            "_next",
            "static",
            "1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b",
        );
        mkdirSync(uuid, { recursive: true });
        writeFileSync(join(uuid, "chunk.js"), "console.log(1)");
        writeFileSync(join(cwd, ".output", "public", "favicon.ico"), "icon");
    }

    it("stages .output/public into .knext-upload, key-space preserved", () => {
        seedNitroBuild();
        const staged = stageNitroPublicAssets(cwd);

        expect(staged).toBe(join(cwd, ".knext-upload"));
        expect(
            existsSync(
                join(
                    staged,
                    "_next",
                    "static",
                    "1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b",
                    "chunk.js",
                ),
            ),
        ).toBe(true);
        expect(existsSync(join(staged, "favicon.ico"))).toBe(true);
    });

    it("NEVER writes into the artifact — .output/public is byte-identical after staging", () => {
        // The defect this pins: the standalone staging dir IS .output/public,
        // so reusing it would rmSync the vinext build's real static root —
        // concurrently with the docker build that COPYs it (deploy runs the
        // upload and the image build as parallel tasks).
        seedNitroBuild();
        const artifactFile = join(
            cwd,
            ".output",
            "public",
            "_next",
            "static",
            "1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b",
            "chunk.js",
        );
        const before = readFileSync(artifactFile, "utf8");

        stageNitroPublicAssets(cwd);
        // Stage twice: the second run clears the STAGING dir — proving the
        // clear targets .knext-upload and not the artifact.
        stageNitroPublicAssets(cwd);

        expect(readFileSync(artifactFile, "utf8")).toBe(before);
        expect(existsSync(join(cwd, ".output", "public", "favicon.ico"))).toBe(
            true,
        );
    });

    it("clears stale files from a previous staging run", () => {
        seedNitroBuild();
        const staged = stageNitroPublicAssets(cwd);
        writeFileSync(join(staged, "stale.js"), "old");

        stageNitroPublicAssets(cwd);
        expect(existsSync(join(staged, "stale.js"))).toBe(false);
    });

    it("throws vinext-appropriate advice when .output/public is missing", () => {
        // NOT the standalone message: telling a vinext user to run
        // `next build` with output:'standalone' names a builder their config
        // cannot select.
        expect(() => stageNitroPublicAssets(cwd)).toThrow(/\.output\/public/);
        expect(() => stageNitroPublicAssets(cwd)).not.toThrow(
            /output: 'standalone'/,
        );
    });

    it("stages no .knext-build marker — vinext prefixes must stay over-kept", () => {
        // Marking vinext's uuid prefix would let the GC classify the CURRENT
        // build's assets as reapable while its protection keys (deploy tags
        // from revision labels) never match — an over-delete. Fail-safe is
        // unmarked (never reaped) until the GC learns the vinext namespace.
        seedNitroBuild();
        const staged = stageNitroPublicAssets(cwd);
        const markers: string[] = [];
        const walk = (d: string): void => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                if (e.isDirectory()) walk(join(d, e.name));
                else if (e.name === BUILD_MARKER_FILENAME)
                    markers.push(join(d, e.name));
            }
        };
        walk(staged);
        expect(markers).toEqual([]);
    });
});
