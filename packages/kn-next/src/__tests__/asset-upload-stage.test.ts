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
    verifyVinextStaticPrefix,
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
     * T2b (#892) — the marker, keyed on the id the CALLER passes.
     *
     * Round 2 moved this from "discover the id from the tree" to "the caller
     * states the id and the write site verifies it". The discovery version was
     * wrong twice over, and both were real: vinext emits `_vinext_fonts/`
     * beside the build prefix for any app using `next/font`, which made the
     * single-candidate rule ambiguous; and `kn-next build` — which exports no
     * deploy id at all — would have had a UUID discovered for it and marked,
     * producing a marker no revision label can ever match. A marker that can be
     * classified as reapable but never protected is the over-delete ADR-0011
     * forbids, and it would have shipped on the path nobody tests.
     */
    it("stages the .knext-build marker into _next/static/<buildId>/ (#892)", () => {
        seedNitroBuild("deploytag-7");
        const staged = stageNitroPublicAssets(cwd, "deploytag-7");

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
        // failure the reserved deny-list exists to make impossible.
        expect(markersUnder(staged)).toEqual([
            join("_next", "static", "deploytag-7", BUILD_MARKER_FILENAME),
        ]);
    });

    it("writes the marker into the STAGING copy only — the artifact is untouched", () => {
        // The staging dir is a copy; the artifact is read-only (it is being
        // COPYd by the concurrent docker build).
        seedNitroBuild("deploytag-7");
        stageNitroPublicAssets(cwd, "deploytag-7");
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

    /**
     * The REAL tree a `next/font` app produces. Measured from vinext's
     * `createGoogleFontsPlugin` writeBundle hook, which copies font files into
     * `<outDir>/<assetsDir>/_vinext_fonts/` — `assetsDir` being `_next/static`.
     * So `_vinext_fonts` is a first-level sibling of the build prefix, exactly
     * like `chunks` and `css`.
     */
    function seedFontAppBuild(buildId: string): void {
        const staticRoot = join(cwd, ".output", "public", "_next", "static");
        rmSync(join(cwd, ".output"), { recursive: true, force: true });
        for (const dir of [buildId, "_vinext_fonts", "chunks", "css"]) {
            mkdirSync(join(staticRoot, dir), { recursive: true });
            writeFileSync(join(staticRoot, dir, "f.bin"), "x");
        }
        writeFileSync(join(cwd, ".output", "public", "favicon.ico"), "icon");
    }

    it("marks a next/font app correctly — _vinext_fonts is a sibling, not a rival", () => {
        // The blocking defect round 1 shipped: a build-id DISCOVERY rule saw
        // `_vinext_fonts` as a second candidate, called the id ambiguous, and
        // (a) staged no marker and (b) aborted the deploy — for every app that
        // uses next/font, including this repo's own dogfood app.
        seedFontAppBuild("deploytag-7");
        const staged = stageNitroPublicAssets(cwd, "deploytag-7");

        expect(markersUnder(staged)).toEqual([
            join("_next", "static", "deploytag-7", BUILD_MARKER_FILENAME),
        ]);
        // The fonts, chunks and css the app actually serves are still staged.
        for (const dir of ["_vinext_fonts", "chunks", "css"]) {
            expect(
                existsSync(join(staged, "_next", "static", dir, "f.bin")),
            ).toBe(true);
        }
    });

    it("stages NO marker when the caller states no build id — fail-safe over-keep", () => {
        // This is `kn-next build`: it uploads assets but creates no revision,
        // so nothing could ever protect the prefix. Unmarked means over-kept
        // forever, which is the safe direction; marking it would make it
        // reapable-but-never-protectable.
        seedNitroBuild("some-vinext-uuid");
        const staged = stageNitroPublicAssets(cwd);
        expect(markersUnder(staged)).toEqual([]);
        // ...and it still stages the assets. Refusing to mark is not refusing
        // to upload.
        expect(
            existsSync(
                join(staged, "_next", "static", "some-vinext-uuid", "chunk.js"),
            ),
        ).toBe(true);
    });

    it("REFUSES, deliberately, when the stated build id has no prefix", () => {
        // The write site enforces the equality rather than trusting the caller.
        // A marker written beside the real prefix would be a phantom build the
        // GC could reap while the chunks it names stay unprotected.
        //
        // The assertion is on the REFUSAL, not merely on throwing: with the
        // check removed, `writeFileSync` into the missing directory throws
        // ENOENT — whose message contains the path, and therefore the claimed
        // id. A `toThrow(/claimed-this/)` passed that mutation. (Found by
        // `mutation-prove-skew-id-chain.mjs`, which is what it is for.)
        seedNitroBuild("actually-built-under-this");
        expect(() => stageNitroPublicAssets(cwd, "claimed-this")).toThrow(
            /Refusing to stage a \.knext-build marker/,
        );
        // ...and it names what WAS built, so the message is a diagnosis.
        expect(() => stageNitroPublicAssets(cwd, "claimed-this")).toThrow(
            /actually-built-under-this/,
        );
    });

    it("REFUSES a build id that is a shared static directory", () => {
        // The standalone write site has always refused this. Without the same
        // refusal here, `--tag chunks` writes a marker INTO the cross-build
        // `chunks/` prefix and hands the pruner a licence to reap assets every
        // build shares — the max-blast-radius over-delete.
        mkdirSync(join(cwd, ".output", "public", "_next", "static", "chunks"), {
            recursive: true,
        });
        writeFileSync(
            join(cwd, ".output", "public", "_next", "static", "chunks", "a.js"),
            "x",
        );
        // The prefix EXISTS, so this is not the missing-prefix refusal — it is
        // a refusal on the name itself.
        expect(() => stageNitroPublicAssets(cwd, "chunks")).toThrow(
            /shared static directory/,
        );
    });

    /**
     * Every refusal must happen BEFORE the copy.
     *
     * `mkdtempSync` + `cpSync` duplicate the whole static tree, and the
     * `finally` cleanup keys off the staging dir this function RETURNS — which
     * a throw never returns. So a refusal after the copy leaks a full copy of
     * the tree per failed deploy: the exact leak class the fresh-per-run design
     * fixed for the success path.
     */
    it("leaks no temp dir when it refuses (validate before copying)", () => {
        const before = new Set(
            readdirSync(tmpdir()).filter((n) => n.startsWith("knext-upload-")),
        );

        seedNitroBuild("actually-built-under-this");
        expect(() => stageNitroPublicAssets(cwd, "claimed-this")).toThrow();
        expect(() => stageNitroPublicAssets(cwd, "chunks")).toThrow();

        const after = readdirSync(tmpdir()).filter(
            (n) => n.startsWith("knext-upload-") && !before.has(n),
        );
        expect(after).toEqual([]);

        // Non-vacuity: the SUCCESS path really does create one there, so an
        // empty diff above means "refused without creating", not "this check
        // is looking in the wrong place".
        const staged = stageNitroPublicAssets(cwd, "actually-built-under-this");
        expect(staged.startsWith(tmpdir())).toBe(true);
        expect(
            readdirSync(tmpdir()).filter(
                (n) => n.startsWith("knext-upload-") && !before.has(n),
            ),
        ).toHaveLength(1);
        rmSync(staged, { recursive: true, force: true });
    });
});

/**
 * T2a/T2b round 2 — the ONE check both the deploy lock-step guard and the
 * marker staging use. Sharing it is what makes "marker key ≡ protection key"
 * true by construction rather than by two call sites agreeing today.
 *
 * It asks "does the prefix this deploy claims to have built EXIST?" — never
 * "which of these directories is the build?". That is not a stylistic
 * preference: any classify-the-siblings rule has to enumerate what vinext may
 * emit beside the build prefix, and `_vinext_fonts` is the proof that such an
 * enumeration is a list someone will be short an entry on. An existence check
 * has nothing to enumerate, so a future sibling — a fifth namespace, a plugin
 * nobody here has seen — cannot break it.
 */
describe("verifyVinextStaticPrefix", () => {
    function seedStatic(ids: string[]): void {
        for (const id of ids) {
            const dir = join(cwd, ".output", "public", "_next", "static", id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "f.js"), "x");
        }
    }

    it("passes when the expected prefix is there", () => {
        seedStatic(["deploytag-7"]);
        expect(verifyVinextStaticPrefix(cwd, "deploytag-7")).toEqual({
            ok: true,
        });
    });

    it("passes REGARDLESS of how many siblings vinext emitted", () => {
        // Every sibling vinext is known to emit, plus one it does not — the
        // point being that the check does not care, so tomorrow's namespace
        // needs no code change here.
        seedStatic([
            "deploytag-7",
            "_vinext_fonts",
            "chunks",
            "css",
            "media",
            "_some_future_vinext_namespace",
        ]);
        expect(verifyVinextStaticPrefix(cwd, "deploytag-7")).toEqual({
            ok: true,
        });
    });

    it("fails, naming the siblings, when the expected prefix is absent", () => {
        seedStatic(["1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b", "chunks"]);
        const result = verifyVinextStaticPrefix(cwd, "deploytag-7");
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ reason: "prefix-missing" });
        // The siblings are reported so the error can say what WAS built —
        // "expected t1, found a UUID" is the diagnosis; "not found" is not.
        expect(result.ok === false && result.siblings).toContain(
            "1bf62579-a57c-4fec-b3a0-c6ce1c59ff1b",
        );
    });

    it("fails with `no-static-root` when _next/static does not exist", () => {
        expect(verifyVinextStaticPrefix(cwd, "deploytag-7")).toEqual({
            ok: false,
            reason: "no-static-root",
            siblings: [],
        });
    });

    it("a FILE of the right name is not a prefix", () => {
        mkdirSync(join(cwd, ".output", "public", "_next", "static"), {
            recursive: true,
        });
        writeFileSync(
            join(cwd, ".output", "public", "_next", "static", "deploytag-7"),
            "not a directory",
        );
        expect(verifyVinextStaticPrefix(cwd, "deploytag-7")).toMatchObject({
            ok: false,
            reason: "prefix-missing",
        });
    });

    it("refuses an empty build id rather than scoping to the static root", () => {
        seedStatic(["deploytag-7"]);
        expect(verifyVinextStaticPrefix(cwd, "")).toMatchObject({
            ok: false,
        });
    });
});
