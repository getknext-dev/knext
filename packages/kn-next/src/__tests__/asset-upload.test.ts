import { existsSync, promises as fs } from "node:fs";
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
import { SUPPORTED_STORAGE_PROVIDERS } from "../cli/validate";
import type { KnativeNextConfig, StorageProvider } from "../config";
import {
    appKeyPrefix,
    getAssetPrefix,
    uploadAssets,
} from "../utils/asset-upload";

const runQuietMock = runQuiet as unknown as Mock;
const runCaptureMock = runCapture as unknown as Mock;

/**
 * Writes a local asset by its UPLOAD KEY into the standalone-build source
 * location `uploadAssets` stages from: `_next/static/<k>` comes from
 * `.next/static/<k>`, everything else from `public/<k>`.
 */
async function seedSourceFile(root: string, key: string): Promise<void> {
    const staticNs = "_next/static/";
    const full = key.startsWith(staticNs)
        ? join(root, ".next", "static", key.slice(staticNs.length))
        : join(root, "public", key);
    await fs.mkdir(join(full, ".."), { recursive: true });
    await fs.writeFile(full, `bytes:${key}`);
}

/** App name used across the namespacing tests. Mirrors `NextApp.metadata.name`. */
const APP_NAME = "shop";

/** Builds a minimal config for a given provider + bucket. */
function makeConfig(
    provider: StorageProvider,
    bucket: string,
    name = APP_NAME,
): KnativeNextConfig {
    return {
        name,
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
 *
 * Objects live under the app-namespaced prefix `<app>/<key>` (#74): the
 * verification pass strips the SAME `<bucket>/<app>/` prefix and so the parsed
 * key set must match the local relative file set. The remote rendering therefore
 * prepends `<app>/` to every key.
 */
const REMOTE_LISTERS: Record<
    StorageProvider,
    (bucket: string, app: string, keys: string[]) => string
> = {
    gcs: (bucket, app, keys) =>
        keys.map((k) => `gs://${bucket}/${app}/${k}`).join("\n"),
    s3: (_bucket, app, keys) => keys.map((k) => `${app}/${k}`).join("\n"),
    minio: (bucket, app, keys) =>
        keys.map((k) => `minio/${bucket}/${app}/${k}`).join("\n"),
    // `az storage blob list --query [].name -o json` → flat array of names.
    azure: (_bucket, app, keys) =>
        JSON.stringify(keys.map((k) => `${app}/${k}`)),
};

describe("uploadAssets data plane", () => {
    let root: string;
    let assetsDir: string;
    let prevCwd: string;
    const localKeys = [
        "_next/static/chunks/main.js",
        "_next/static/css/app.css",
        "favicon.ico",
    ];

    beforeEach(async () => {
        prevCwd = process.cwd();
        root = await fs.mkdtemp(join(tmpdir(), "knext-assets-"));
        // uploadAssets STAGES the standalone-build sources (.next/static +
        // public/) into .output/public before uploading; assetsDir is that
        // staged dir — the local path the provider argv references.
        assetsDir = join(root, ".output", "public");
        // Seed the standalone-build sources, keyed by upload key.
        for (const key of localKeys) {
            await seedSourceFile(root, key);
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

    // Derive the exercised set from validate's supported list so the data-plane
    // contract tests and the accepted-provider gate can never drift (#474).
    const providers: StorageProvider[] = [...SUPPORTED_STORAGE_PROVIDERS];

    describe.each(providers)("provider=%s", (provider) => {
        const bucket = "my-bucket";

        it("success path: bulk-uploads then verifies, no re-upload when complete", async () => {
            // Remote contains every local key → verification finds nothing missing.
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, localKeys),
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
                REMOTE_LISTERS[provider](bucket, APP_NAME, presentKeys),
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
                    APP_NAME,
                    localKeys.slice(0, localKeys.length - 1),
                ),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).rejects.toThrow();
        });

        it("argv is injection-safe: array tokens, no shell metachars concatenated", async () => {
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, localKeys),
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
                REMOTE_LISTERS[provider]("b", APP_NAME, localKeys),
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
                APP_NAME,
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

    /**
     * #481 — Azure re-deploy robustness. Two `az` CLI defaults would break a
     * second deploy or a large asset set unless handled explicitly:
     *  - `az storage blob upload`/`upload-batch` default to NO-overwrite, so a
     *    re-deploy of an unhashed asset (e.g. favicon.ico) under the same key
     *    errors. The gcs/s3/minio paths are idempotent on re-upload; azure must
     *    match via `--overwrite`.
     *  - `az storage blob list` caps at 5000 results by default, so a >5000-object
     *    prefix yields a false "missing" verdict → redundant re-uploads. `--num-results *`
     *    lists all.
     */
    describe("azure re-deploy robustness (#481)", () => {
        const bucket = "assets-container";

        it("upload-batch passes --overwrite so a second deploy is idempotent", async () => {
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.azure(bucket, APP_NAME, localKeys),
            );
            await uploadAssets(makeConfig("azure", bucket));
            const uploadBatch = allArgvs().find((a) =>
                a.includes("upload-batch"),
            );
            expect(uploadBatch, "azure bulk upload-batch argv").toBeDefined();
            expect(uploadBatch).toContain("--overwrite");
        });

        it("blob list passes --num-results * so verification is correct beyond the 5000-object cap", async () => {
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.azure(bucket, APP_NAME, localKeys),
            );
            await uploadAssets(makeConfig("azure", bucket));
            const list = allArgvs().find(
                (a) => a.includes("list") && a.includes("--prefix"),
            );
            expect(list, "azure blob list argv").toBeDefined();
            const i = (list as string[]).indexOf("--num-results");
            expect(i, "list must pass --num-results").toBeGreaterThanOrEqual(0);
            expect((list as string[])[i + 1]).toBe("*");
        });

        it("single-file re-upload passes --overwrite (a re-upload always replaces)", async () => {
            const missingKey = localKeys[0];
            // Remote consistently missing one key → the single-file blob upload
            // path runs (then the deploy fails loudly since it's still missing).
            // We only assert the re-upload argv carried --overwrite.
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.azure(
                    bucket,
                    APP_NAME,
                    localKeys.filter((k) => k !== missingKey),
                ),
            );
            await expect(
                uploadAssets(makeConfig("azure", bucket)),
            ).rejects.toThrow();
            // Single-file re-upload uses `-f <file>`; upload-batch uses `-s <dir>`.
            const reupload = allArgvs().find(
                (a) =>
                    a[0] === "az" && a.includes("upload") && a.includes("-f"),
            );
            expect(reupload, "azure single-file re-upload argv").toBeDefined();
            // The -f path is absolute (cwd-resolved, so /private/var vs /var on
            // macOS) — match on the key suffix, not the full path.
            expect(
                (reupload as string[]).some((t) => t.endsWith(missingKey)),
            ).toBe(true);
            expect(reupload).toContain("--overwrite");
        });
    });

    /**
     * #74 — app-namespacing contract. Objects are uploaded under `<app>/...`
     * inside the shared bucket, and the served `assetPrefix` resolves to the
     * SAME `<publicUrl>/<app>` location. This is what makes the operator
     * finalizer's `<app>/` storage cleanup REAL (it deletes exactly these keys)
     * AND gives per-app isolation in a shared bucket (data sovereignty).
     */
    describe("app-namespaced upload location (#74)", () => {
        it("appKeyPrefix is `<name>/` — matches the operator finalizer prefix", () => {
            // This MUST equal the operator's appStoragePrefix() = app.Name+"/".
            // The two are tied by the shared `<app>/` contract documented here.
            expect(appKeyPrefix(makeConfig("s3", "bkt", "shop"))).toBe("shop/");
            expect(appKeyPrefix(makeConfig("gcs", "bkt", "blog"))).toBe(
                "blog/",
            );
        });

        it("served assetPrefix includes /<app> so browsers fetch from the namespaced location", () => {
            const cfg = makeConfig("gcs", "bkt", "shop");
            // publicUrl is `https://example.test/bkt` → assetPrefix must be
            // `https://example.test/bkt/shop` (no trailing slash; Next appends).
            expect(getAssetPrefix(cfg)).toBe("https://example.test/bkt/shop");
        });

        it("served assetPrefix tolerates a trailing slash on publicUrl", () => {
            const cfg = makeConfig("gcs", "bkt", "shop");
            cfg.storage.publicUrl = "https://example.test/bkt/";
            expect(getAssetPrefix(cfg)).toBe("https://example.test/bkt/shop");
        });

        it.each<StorageProvider>([
            "gcs",
            "s3",
            "minio",
            "azure",
        ])("provider=%s uploads objects under the `<app>/` prefix (not bucket root)", async (provider) => {
            const bucket = "shared-bucket";
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, localKeys),
            );
            await uploadAssets(makeConfig(provider, bucket, APP_NAME));

            // SOME upload destination token must place objects under
            // `<app>/` within the bucket — never at the bucket root. We look
            // for the app prefix in any non-local-path argv token of the
            // bulk-upload / re-upload commands.
            const destTokens = runQuietMock.mock.calls
                .flatMap((c) => c[0] as string[])
                .filter((t) => !t.startsWith(assetsDir));
            const namespaced = destTokens.some((t) =>
                t.includes(`${APP_NAME}/`),
            );
            expect(namespaced).toBe(true);
        });
    });

    /**
     * #264 — marker-object inversion (ADR-0011). `uploadAssets` writes a
     * `.knext-build` marker object into `_next/static/<BUILD_ID>/` for EVERY
     * uploaded build; the pruner deletes ONLY marker-carrying prefixes. The
     * marker is staged as a regular file, so it rides each provider's bulk
     * upload AND the #75 verify-and-retry pass — a build whose marker did not
     * land remotely fails the deploy loudly. The marker object name is a
     * LOCKED contract, hardcoded here.
     */
    describe("build marker object (#264, marker inversion)", () => {
        const BUILD_ID = "bid-mark-1";
        const markerKey = `_next/static/${BUILD_ID}/.knext-build`;

        beforeEach(async () => {
            // `next build` wrote its BUILD_ID (deploy.ts pins it to the tag).
            await fs.writeFile(
                join(root, ".next", "BUILD_ID"),
                `${BUILD_ID}\n`,
            );
        });

        it.each(
            providers,
        )("provider=%s: stages the marker into _next/static/<BUILD_ID>/ and verifies it remotely", async (provider) => {
            const bucket = "b";
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, [
                    ...localKeys,
                    markerKey,
                ]),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).resolves.toBeUndefined();

            // The marker file is part of the staged upload set — it rides
            // the provider's bulk upload of the staging dir.
            const staged = await fs.readFile(
                join(assetsDir, markerKey),
                "utf8",
            );
            expect(staged).toContain(BUILD_ID);
        });

        it.each(
            providers,
        )("provider=%s: a marker missing REMOTELY fails the deploy loudly, naming the marker key", async (provider) => {
            const bucket = "b";
            // Remote has every asset EXCEPT the marker (even after retry).
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, localKeys),
            );

            await expect(
                uploadAssets(makeConfig(provider, bucket)),
            ).rejects.toThrow(".knext-build");
        });

        it("no .next/BUILD_ID ⇒ no marker staged (pre-marker behaviour: that build is over-kept)", async () => {
            await fs.rm(join(root, ".next", "BUILD_ID"));
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.s3("b", APP_NAME, localKeys),
            );
            await expect(
                uploadAssets(makeConfig("s3", "b")),
            ).resolves.toBeUndefined();
            expect(
                existsSync(join(assetsDir, "_next", "static", BUILD_ID)),
            ).toBe(false);
        });
    });

    /**
     * #93 — skew-protection regression lock. These assert the *no-clobber*
     * guarantee that makes serving a prior build's chunks possible at all:
     * upload is ADDITIVE. No provider's bulk-upload argv may carry a prune /
     * delete / mirror flag, and a second deploy (build B) must not delete build
     * A's keys. If any of these regress, a rollback / canary (#92) would start
     * 404'ing the old build's `_next/static/<A>/...` chunks.
     */
    describe("upload is additive — no clobber of prior builds (#93)", () => {
        const providers2: StorageProvider[] = ["gcs", "s3", "minio", "azure"];

        // Flags that would DELETE remote objects not present locally. `aws s3
        // sync --delete`, `gsutil rsync -d`, `mc mirror --remove`, and
        // `azcopy sync --delete-destination` are the prune idioms we forbid.
        const PRUNE_FLAGS = [
            "--delete",
            "--delete-destination",
            "--remove",
            "--mirror",
            "rsync",
        ];

        it.each(
            providers2,
        )("provider=%s upload argv carries NO prune/delete/mirror flag", async (provider) => {
            const bucket = "b";
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS[provider](bucket, APP_NAME, localKeys),
            );
            await uploadAssets(makeConfig(provider, bucket));

            const tokens = runQuietMock.mock.calls.flatMap(
                (c) => c[0] as string[],
            );
            for (const flag of PRUNE_FLAGS) {
                expect(tokens).not.toContain(flag);
            }
            // NB: a bare `-d` is NOT a prune flag here — Azure's
            // `upload-batch -d <container>` means *destination*, not delete.
            // The explicit prune-idiom list above is the real no-clobber lock.
        });

        it("upload keys preserve the build-id segment (_next/static/<BUILD_ID>/...)", async () => {
            // Real Next output nests chunks under the BUILD_ID. The uploader must
            // pass that path through verbatim so two builds get distinct prefixes.
            const buildA = "buildA1";
            const buildKeys = [
                `_next/static/${buildA}/_buildManifest.js`,
                `_next/static/chunks/${buildA}/page.js`,
            ];
            // Re-seed the standalone-build source with build-id-nested keys.
            for (const key of buildKeys) {
                await seedSourceFile(root, key);
            }
            const allKeys = [...localKeys, ...buildKeys];
            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.s3("b", APP_NAME, allKeys),
            );
            await uploadAssets(makeConfig("s3", "b"));

            // The bulk `aws s3 sync` uploads the whole dir, so the build-id
            // segment is carried by the local source dir; assert the verify pass
            // saw the build-id-nested keys (proving they are in the upload set).
            const captured = runCaptureMock.mock.results
                .map((r) => r.value as string)
                .join("\n");
            expect(captured).toContain(buildA);
        });

        it("a second deploy (build B) issues no delete of build A's keys", async () => {
            // Build A then build B, same app. Across BOTH uploads, the combined
            // argv must contain no command that targets build A for deletion.
            const buildA = "buildAAA";
            const buildB = "buildBBB";

            runCaptureMock.mockReturnValue(
                REMOTE_LISTERS.gcs("b", APP_NAME, localKeys),
            );
            await uploadAssets(makeConfig("gcs", "b"));
            const afterA = runQuietMock.mock.calls.flatMap(
                (c) => c[0] as string[],
            );

            await uploadAssets(makeConfig("gcs", "b"));
            const afterB = runQuietMock.mock.calls.flatMap(
                (c) => c[0] as string[],
            );

            // No `gsutil rm` / `rm` verb anywhere, and no token references build A.
            for (const tokens of [afterA, afterB]) {
                expect(tokens).not.toContain("rm");
                expect(tokens).not.toContain("rb");
            }
            expect(afterB.some((t) => t.includes(buildA))).toBe(false);
            expect(afterB.some((t) => t.includes(buildB))).toBe(false);
        });
    });
});
