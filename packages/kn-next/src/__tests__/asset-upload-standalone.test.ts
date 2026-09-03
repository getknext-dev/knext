import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    type Mock,
    mock,
} from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * uploadAssets must work against what `next build` (output:'standalone')
 * ACTUALLY produces — `.next/static/**` plus the app's `public/` dir — not the
 * Nitro-era `.output/public` directory, which nothing in the standalone build
 * flow creates. Before the fix, `uploadAssets` did a bare `readdirSync` on
 * `.output/public` and crashed with ENOENT on every real deploy that did not
 * pass `--skip-upload`.
 *
 * Contract under test:
 *   - `.next/static/**` is uploaded under the `_next/static/...` key space
 *     (matching the served assetPrefix `<publicUrl>/<name>/_next/static/...`)
 *   - `public/**` is uploaded at the key-space root (e.g. `favicon.ico`)
 *   - a missing `.next/static` fails loudly telling the user to run
 *     `next build` first (NOT a bare ENOENT)
 *   - `public/` is optional
 *   - stale files from a previous build's staging dir are NOT re-uploaded
 */

mock.module("../cli/exec", () => ({
    runQuiet: mock(),
    runCapture: mock(),
}));

import { runCapture, runQuiet } from "../cli/exec";
import { type StorageBackedConfig, uploadAssets } from "../utils/asset-upload";

const runQuietMock = runQuiet as unknown as Mock<typeof runQuiet>;
const runCaptureMock = runCapture as unknown as Mock<typeof runCapture>;

const APP_NAME = "shop";
const BUCKET = "my-bucket";

function makeConfig(): StorageBackedConfig {
    return {
        name: APP_NAME,
        // These suites exercise the STANDALONE upload path (staging from
        // .next/static). Since ADR-0048 the default build is vinext, whose
        // staging reads .output/public instead — so the shape is pinned
        // explicitly here rather than inherited from a default that moved.
        build: "turbopack",
        storage: {
            provider: "gcs",
            bucket: BUCKET,
            publicUrl: `https://example.test/${BUCKET}`,
        },
    } as unknown as StorageBackedConfig;
}

/** Renders the fake `gsutil ls -r` remote listing for the given keys. */
function gcsListing(keys: string[]): string {
    return keys.map((k) => `gs://${BUCKET}/${APP_NAME}/${k}`).join("\n");
}

describe("uploadAssets reads the standalone build output (not .output/public)", () => {
    let root: string;
    let prevCwd: string;

    /** The upload key space the staged assets must land in. */
    const expectedKeys = [
        "_next/static/build123/_buildManifest.js",
        "_next/static/chunks/main.js",
        "favicon.ico",
    ];

    /** Seeds a simulated `next build` (output:'standalone') result. */
    async function seedStandaloneBuild(dir: string): Promise<void> {
        const files: Record<string, string> = {
            // .next/static/** — what next build actually emits
            [join(dir, ".next", "static", "build123", "_buildManifest.js")]:
                "manifest",
            [join(dir, ".next", "static", "chunks", "main.js")]: "chunk",
            // the app's public/ dir
            [join(dir, "public", "favicon.ico")]: "icon",
        };
        for (const [path, bytes] of Object.entries(files)) {
            await fs.mkdir(join(path, ".."), { recursive: true });
            await fs.writeFile(path, bytes);
        }
    }

    beforeEach(async () => {
        prevCwd = process.cwd();
        root = await fs.mkdtemp(join(tmpdir(), "knext-standalone-"));
        process.chdir(root);
        runQuietMock.mockReset();
        runCaptureMock.mockReset();
    });

    afterEach(async () => {
        process.chdir(prevCwd);
        jest.clearAllMocks();
    });

    it("uploads a simulated standalone build without a pre-existing .output/public (the ENOENT bug)", async () => {
        await seedStandaloneBuild(root);
        // NOTHING creates .output/public in the standalone flow.
        expect(existsSync(join(root, ".output", "public"))).toBe(false);

        runCaptureMock.mockReturnValue(gcsListing(expectedKeys));

        // Before the fix: throws ENOENT (readdirSync .output/public).
        await expect(uploadAssets(makeConfig())).resolves.toBeUndefined();
    });

    it("stages .next/static under _next/static/... and public/ at the root of the upload set", async () => {
        await seedStandaloneBuild(root);
        runCaptureMock.mockReturnValue(gcsListing(expectedKeys));

        await uploadAssets(makeConfig());

        // The verify pass diffs the LOCAL staged file set against the remote
        // listing. A complete remote listing of exactly `expectedKeys` passing
        // with no retry proves the staged local set == expectedKeys layout:
        // any extra/missing/mis-prefixed local key would trigger a retry or throw.
        const singleFileRetries = runQuietMock.mock.calls
            .map((c) => c[0] as string[])
            .filter((argv) => argv.includes("cp") && !argv.includes("-r"));
        expect(singleFileRetries).toHaveLength(0);
    });

    it("routes a DEFAULT (vinext) config to the nitro staging — .knext-upload, sourced from .output/public", async () => {
        // The other half of this suite's shape pin, and the dispatch guard:
        // deleting the shape dispatch in uploadAssets would leave every
        // turbopack-pinned test green while the default path silently staged
        // from a tree vinext never produces. Config carries NO build field.
        const nitroKeys = ["_next/static/uuid-1/chunk.js", "favicon.ico"];
        await fs.mkdir(
            join(root, ".output", "public", "_next", "static", "uuid-1"),
            {
                recursive: true,
            },
        );
        await fs.writeFile(
            join(
                root,
                ".output",
                "public",
                "_next",
                "static",
                "uuid-1",
                "chunk.js",
            ),
            "chunk",
        );
        await fs.writeFile(
            join(root, ".output", "public", "favicon.ico"),
            "icon",
        );
        // NO .next/static anywhere — the standalone staging would throw here.
        runCaptureMock.mockReturnValue(gcsListing(nitroKeys));

        const config = { ...makeConfig() };
        // biome-ignore lint/performance/noDelete: absence (not undefined) is the case under test
        delete (config as Record<string, unknown>).build;
        await expect(uploadAssets(config)).resolves.toBeUndefined();

        // The bulk upload must read the staging dir, never the artifact root.
        const bulk = runQuietMock.mock.calls
            .map((c) => c[0] as string[])
            .find((argv) => argv.includes("-r"));
        expect(bulk?.join(" ")).toContain(".knext-upload");
        expect(bulk?.join(" ")).not.toContain(".output/public");
    });

    it("fails loudly with a next-build hint (not a bare ENOENT) when .next/static is missing", async () => {
        // No build at all: neither .next/static nor public exists.
        await expect(uploadAssets(makeConfig())).rejects.toThrow(/next build/i);
        // And no provider CLI was ever invoked.
        expect(runQuietMock).not.toHaveBeenCalled();
        expect(runCaptureMock).not.toHaveBeenCalled();
    });

    it("works without a public/ dir (public files are optional)", async () => {
        const staticOnly = expectedKeys.filter((k) =>
            k.startsWith("_next/static/"),
        );
        await fs.mkdir(join(root, ".next", "static", "chunks"), {
            recursive: true,
        });
        await fs.mkdir(join(root, ".next", "static", "build123"), {
            recursive: true,
        });
        await fs.writeFile(
            join(root, ".next", "static", "build123", "_buildManifest.js"),
            "manifest",
        );
        await fs.writeFile(
            join(root, ".next", "static", "chunks", "main.js"),
            "chunk",
        );

        runCaptureMock.mockReturnValue(gcsListing(staticOnly));

        await expect(uploadAssets(makeConfig())).resolves.toBeUndefined();
    });

    it("does not re-upload stale files left in the staging dir by a previous build", async () => {
        await seedStandaloneBuild(root);
        // Simulate a leftover staged file from an earlier deploy. If staging is
        // not cleared, this stale key enters the local file set, the (complete)
        // remote listing won't contain it, and the verify pass would retry then
        // throw naming it.
        const stale = join(root, ".output", "public", "stale-old-build.js");
        await fs.mkdir(join(stale, ".."), { recursive: true });
        await fs.writeFile(stale, "stale");

        runCaptureMock.mockReturnValue(gcsListing(expectedKeys));

        await expect(uploadAssets(makeConfig())).resolves.toBeUndefined();
    });
});
