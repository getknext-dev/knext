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
    resolveVinextStaticId,
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
    function seedNitroBuild(id = "1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b"): void {
        const uuid = join(cwd, ".output", "public", "_next", "static", id);
        mkdirSync(uuid, { recursive: true });
        writeFileSync(join(uuid, "chunk.js"), "console.log(1)");
        writeFileSync(join(cwd, ".output", "public", "favicon.ico"), "icon");
    }

    it("stages .output/public into a temp dir OUTSIDE the repo, key-space preserved", () => {
        // Outside the repo means outside deploy's docker build context and
        // outside git — an in-repo staging dir raced buildx's context walk
        // and wedged `git status` (re-gate residual on the fix round).
        seedNitroBuild();
        const staged = stageNitroPublicAssets(cwd);

        expect(staged.startsWith(cwd)).toBe(false);
        expect(staged).toContain("knext-upload-");
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

    it("a re-stage cannot see a previous run's stale files — fresh dir per run", () => {
        seedNitroBuild();
        const first = stageNitroPublicAssets(cwd);
        writeFileSync(join(first, "stale.js"), "old");

        const second = stageNitroPublicAssets(cwd);
        expect(second).not.toBe(first);
        expect(existsSync(join(second, "stale.js"))).toBe(false);
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

    /** Every `.knext-build` object under `dir`, relative to it. */
    function markersUnder(dir: string): string[] {
        const found: string[] = [];
        const walk = (d: string): void => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                if (e.isDirectory()) walk(join(d, e.name));
                else if (e.name === BUILD_MARKER_FILENAME)
                    found.push(join(d, e.name).slice(dir.length + 1));
            }
        };
        walk(dir);
        return found;
    }

    /**
     * T2b (#892) — the marker. Safe ONLY because T2a made the vinext static id
     * the deploy tag: marker key ≡ protection key ≡ image tag ≡ spec.buildId,
     * so the over-delete this staging path used to avoid by staying silent
     * cannot be expressed any more.
     */
    it("stages the .knext-build marker into _next/static/<id>/ (#892)", () => {
        seedNitroBuild("deploytag-7");
        const staged = stageNitroPublicAssets(cwd);

        const marker = join(
            staged,
            "_next",
            "static",
            "deploytag-7",
            BUILD_MARKER_FILENAME,
        );
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf8").trim()).toBe("deploytag-7");
        // ...and NOWHERE else. A marker on a shared dir is the max-blast-radius
        // failure the RESERVED deny-list exists to make impossible.
        expect(markersUnder(staged)).toEqual([
            join("_next", "static", "deploytag-7", BUILD_MARKER_FILENAME),
        ]);
    });

    it("writes the marker into the STAGING copy only — the artifact is untouched", () => {
        // The staging dir is a copy; the artifact is read-only (it is being
        // COPYd by the concurrent docker build).
        seedNitroBuild("deploytag-7");
        stageNitroPublicAssets(cwd);
        expect(
            existsSync(
                join(
                    cwd,
                    ".output",
                    "public",
                    "_next",
                    "static",
                    "deploytag-7",
                    BUILD_MARKER_FILENAME,
                ),
            ),
        ).toBe(false);
    });

    it("stages NO marker when the static id is ambiguous — fail-safe over-keep (#892)", () => {
        // Two candidate prefixes: the id cannot be resolved, so the build is
        // over-kept forever rather than marked under a guess. Never throws —
        // an unmarked upload is the safe outcome, not a failed deploy.
        seedNitroBuild("id-a");
        seedNitroBuild("id-b");
        const staged = stageNitroPublicAssets(cwd);
        expect(markersUnder(staged)).toEqual([]);
    });

    it("stages NO marker when there is no non-reserved prefix at all", () => {
        mkdirSync(join(cwd, ".output", "public", "_next", "static", "chunks"), {
            recursive: true,
        });
        writeFileSync(
            join(cwd, ".output", "public", "_next", "static", "chunks", "a.js"),
            "x",
        );
        const staged = stageNitroPublicAssets(cwd);
        expect(markersUnder(staged)).toEqual([]);
    });
});

/**
 * T2a/T2b — the ONE resolver both the deploy lock-step guard and the marker
 * staging use. Sharing it is what makes "marker key ≡ protection key" true by
 * construction rather than by two call sites agreeing today.
 */
describe("resolveVinextStaticId", () => {
    function seedStatic(ids: string[]): void {
        for (const id of ids) {
            const dir = join(cwd, ".output", "public", "_next", "static", id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "f.js"), "x");
        }
    }

    it("resolves the single non-reserved first-level prefix", () => {
        seedStatic(["deploytag-7"]);
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: true,
            id: "deploytag-7",
        });
    });

    it("ignores the reserved shared dirs when picking the id", () => {
        // Next's shared dirs sit beside the build prefix; treating one as the
        // id would mark `chunks/` — the max-blast-radius over-delete.
        seedStatic(["chunks", "css", "media", "deploytag-7"]);
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: true,
            id: "deploytag-7",
        });
    });

    it("reports `ambiguous` (never a guess) when two prefixes are present", () => {
        seedStatic(["id-a", "id-b"]);
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: false,
            reason: "ambiguous",
            ids: ["id-a", "id-b"],
        });
    });

    it("reports `none` when only reserved dirs are present", () => {
        seedStatic(["chunks"]);
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: false,
            reason: "none",
            ids: [],
        });
    });

    it("reports `missing` when _next/static does not exist", () => {
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: false,
            reason: "missing",
            ids: [],
        });
    });

    it("ignores FILES at the first level — only directories are candidates", () => {
        seedStatic(["deploytag-7"]);
        writeFileSync(
            join(cwd, ".output", "public", "_next", "static", "stray.txt"),
            "x",
        );
        expect(resolveVinextStaticId(cwd)).toEqual({
            ok: true,
            id: "deploytag-7",
        });
    });
});
