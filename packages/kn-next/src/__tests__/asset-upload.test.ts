import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

/**
 * Data-plane tests for asset upload + post-upload verification (#75).
 *
 * The provider CLIs (`gsutil`/`aws`/`mc`/`az`) are never spawned: the `exec`
 * layer (`runQuiet`/`runCapture`) is mocked, so these tests assert the CONTRACT
 * — which binary is invoked with which argv, that verification lists the remote
 * prefix and diffs it against the local file set, that a missing object fails
 * the deploy loudly (non-zero / throw) naming the offending keys, and that argv
 * is injection-safe (discrete array elements, never a shell string).
 *
 * No live cloud credentials are required (CLAUDE.md §9: GCS + an S3-compatible
 * store are the two real data planes; the rest are thin shell-outs).
 */

vi.mock("../cli/exec", () => ({
    runQuiet: vi.fn(),
    runCapture: vi.fn(),
}));

import { runCapture, runQuiet } from "../cli/exec";
import type { KnativeNextConfig, StorageProvider } from "../config";
import { uploadAssets } from "../utils/asset-upload";

const runQuietMock = runQuiet as unknown as Mock;
const runCaptureMock = runCapture as unknown as Mock;

/** Builds a minimal config for a given provider + bucket. */
function makeConfig(
    provider: StorageProvider,
    bucket: string,
): KnativeNextConfig {
    return {
        storage: {
            provider,
            bucket,
            publicUrl: `https://example.test/${bucket}`,
        },
    } as unknown as KnativeNextConfig;
}

/**
 * How each provider renders a remote listing for the mocked `runCapture`,
 * given the set of keys the fake remote "contains". Mirrors the real CLI
 * `ls`-style output that the verification pass parses.
 */
const REMOTE_LISTERS: Record<
    StorageProvider,
    (bucket: string, keys: string[]) => string
> = {
    gcs: (bucket, keys) => keys.map((k) => `gs://${bucket}/${k}`).join("\n"),
    s3: (_bucket, keys) => keys.join("\n"),
    minio: (bucket, keys) => keys.map((k) => `minio/${bucket}/${k}`).join("\n"),
    // `az storage blob list --query [].name -o json` → flat array of names.
    azure: (_bucket, keys) => JSON.stringify(keys),
};

describe("uploadAssets data plane", () => {
    let assetsDir: string;
    let prevCwd: string;
    const localKeys = [
        "_next/static/chunks/main.js",
        "_next/static/css/app.css",
        "favicon.ico",
    ];

    beforeEach(async () => {
        prevCwd = process.cwd();
        const root = await fs.mkdtemp(join(tmpdir(), "knext-assets-"));
        assetsDir = join(root, ".output", "public");
        // Write the local file set under .output/public/<key>.
        for (const key of localKeys) {
            const full = join(assetsDir, key);
            await fs.mkdir(join(full, ".."), { recursive: true });
            await fs.writeFile(full, `bytes:${key}`);
        }
        process.chdir(root);
        runQuietMock.mockReset();
        runCaptureMock.mockReset();
    });

    afterEach(async () => {
        process.chdir(prevCwd);
        vi.clearAllMocks();
    });

    /** All argv arrays passed to either exec helper, for argv-shape assertions. */
    function allArgvs(): string[][] {
        return [
            ...runQuietMock.mock.calls.map((c) => c[0] as string[]),
            ...runCaptureMock.mock.calls.map((c) => c[0] as string[]),
        ];
    }

    const providers: StorageProvider[] = ["gcs", "s3", "minio", "azure"];

    describe.each(providers)("provider=%s", (provider) => {
        const bucket = "my-bucket";

        it("success path: bulk-uploads then verifies, no re-upload when complete", async () => {
            // Remote contains every local key → verification finds nothing missing.
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, localKeys),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).resolves.toBeUndefined();

            // Verification listed the remote (runCapture invoked at least once).
            expect(runCaptureMock).toHaveBeenCalled();

            // No per-file retry upload happened: the bulk upload is the only
            // upload, so no argv equals the single-file re-upload of a key.
            const argvs = allArgvs();
            const retried = argvs.some((argv) =>
                localKeys.some(
                    (k) =>
                        argv.includes(join(assetsDir, k)) &&
                        // a single-file retry references exactly one local path
                        argv.filter((a) => a.startsWith(assetsDir)).length ===
                            1,
                ),
            );
            expect(retried).toBe(false);
        });

        it("partial failure: re-uploads the missing key then fails loudly if still missing", async () => {
            const missingKey = localKeys[1];
            const presentKeys = localKeys.filter((k) => k !== missingKey);
            // Remote NEVER has the missing key, even after a retry upload →
            // verification must fail the deploy and name the offending key.
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, presentKeys),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).rejects.toThrow(missingKey);
        });

        it("verification catches a missing object even with a clean bulk upload", async () => {
            // Bulk upload command "succeeds" (runQuiet does not throw), but the
            // remote listing is missing one object → must throw.
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](
                    bucket,
                    localKeys.slice(0, localKeys.length - 1),
                ),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).rejects.toThrow();
        });

        it("argv is injection-safe: array tokens, no shell metachars concatenated", async () => {
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, localKeys),
            );
            await uploadAssets(makeConfig(provider, bucket));

            const argvs = allArgvs();
            expect(argvs.length).toBeGreaterThan(0);
            for (const argv of argvs) {
                // Every argv element is a string and the binary is a bare name
                // (no shell pipe / redirect / chaining smuggled into argv[0]).
                expect(Array.isArray(argv)).toBe(true);
                expect(typeof argv[0]).toBe("string");
                expect(argv[0]).not.toMatch(/[;&|`$()<>]/);
            }
        });
    });

    it("uses the correct provider CLI binary per provider", async () => {
        const expected: Record<StorageProvider, string> = {
            gcs: "gsutil",
            s3: "aws",
            minio: "mc",
            azure: "az",
        };
        for (const provider of providers) {
            runQuietMock.mockReset();
            runCaptureMock.mockReset();
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider]("b", localKeys),
            );
            await uploadAssets(makeConfig(provider, "b"));
            const bins = [
                ...runQuietMock.mock.calls.map((c) => (c[0] as string[])[0]),
                ...runCaptureMock.mock.calls.map((c) => (c[0] as string[])[0]),
            ];
            expect(bins).toContain(expected[provider]);
        }
    });

    it("re-upload failure surfaces the key + underlying error", async () => {
        const missingKey = localKeys[0];
        // Remote is missing the key; the per-file retry upload itself throws —
        // the error must name the key so the operator can see what broke.
        runCaptureMock.mockReturnValue(
            REMOTE_LISTERS.s3(
                "b",
                localKeys.filter((k) => k !== missingKey),
            ),
        );
        runQuietMock.mockImplementation((argv: string[]) => {
            // Bulk upload (the `sync`) is fine; only the single-file retry that
            // references the missing key throws.
            if (
                argv.includes(join(assetsDir, missingKey)) &&
                argv.filter((a) => a.startsWith(assetsDir)).length === 1
            ) {
                throw new Error("AccessDenied uploading object");
            }
        });
        await expect(uploadAssets(makeConfig("s3", "b"))).rejects.toThrow(
            missingKey,
        );
    });
});
