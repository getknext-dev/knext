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
 * Deploy-time build-prune tests (#93, ADR-0011).
 *
 * `pruneOldBuilds` is the deploy-time half of the retention GC: it lists the
 * remote `_next/static/<buildId>/` prefixes under `<app>/`, asks the pure
 * `selectBuildsToDelete` which build-ids are reapable (retain window OR live ⇒
 * keep), and deletes ONLY those prefixes. It must NEVER:
 *   - delete the bare `<app>/` prefix (that is teardown-only, ADR-0008),
 *   - delete a build-id that is in the live set (a #92 pinned/canary/rollback),
 *   - delete the newest / only build.
 *
 * The provider CLIs are mocked at the `exec` layer, so these assert the argv
 * contract of the recursive delete (scoped to `<app>/_next/static/<id>/`).
 */
vi.mock("../cli/exec", () => ({
    runQuiet: vi.fn(),
    runCapture: vi.fn(),
    runQuietAllowFail: vi.fn(),
}));

import { runCapture, runQuietAllowFail } from "../cli/exec";
import type { KnativeNextConfig, StorageProvider } from "../config";
import { pruneOldBuilds } from "../utils/asset-upload";

const runCaptureMock = runCapture as unknown as Mock;
const runDeleteMock = runQuietAllowFail as unknown as Mock;

function makeConfig(
    provider: StorageProvider,
    bucket: string,
    name = "shop",
    assetRetention?: number,
): KnativeNextConfig {
    return {
        name,
        storage: {
            provider,
            bucket,
            publicUrl: `https://example.test/${bucket}`,
            assetRetention,
        },
    } as unknown as KnativeNextConfig;
}

/** GCS `gsutil ls` of the static dir: one line per build-id "directory". */
function gcsStaticListing(bucket: string, app: string, ids: string[]): string {
    return ids
        .map((id) => `gs://${bucket}/${app}/_next/static/${id}/`)
        .join("\n");
}

/**
 * Azure `az storage blob list --query [].name -o json` of the static dir: a JSON
 * array of blob names under `<app>/_next/static/<id>/...`. The impl extracts the
 * build-id segment that follows `_next/static/`.
 */
function azureStaticListing(app: string, ids: string[]): string {
    return JSON.stringify(
        ids.map((id) => `${app}/_next/static/${id}/chunk.js`),
    );
}

describe("pruneOldBuilds", () => {
    beforeEach(() => {
        runCaptureMock.mockReset();
        runDeleteMock.mockReset();
    });
    afterEach(() => vi.clearAllMocks());

    it("deletes only the build-ids outside the retain window, scoped to <app>/_next/static/<id>/", () => {
        const bucket = "b";
        const app = "shop";
        // 4 builds present; retain 2 keeps the two newest, deletes the two oldest.
        const ids = ["b1", "b2", "b3", "b4"]; // listing order = oldest→newest
        runCaptureMock.mockReturnValue(gcsStaticListing(bucket, app, ids));

        pruneOldBuilds(makeConfig("gcs", bucket, app, 2), [], "b4");

        const deletedPrefixes = runDeleteMock.mock.calls
            .map((c) => (c[0] as string[]).find((t) => t.includes("_next")))
            .filter(Boolean) as string[];

        // Exactly the two oldest were deleted, each scoped to its build prefix.
        expect(deletedPrefixes).toContain(
            `gs://${bucket}/${app}/_next/static/b1/`,
        );
        expect(deletedPrefixes).toContain(
            `gs://${bucket}/${app}/_next/static/b2/`,
        );
        // Newest two retained.
        expect(deletedPrefixes.join("\n")).not.toContain("/b3/");
        expect(deletedPrefixes.join("\n")).not.toContain("/b4/");
    });

    it("never deletes a live build-id (rollback/canary protection, #92)", () => {
        const bucket = "b";
        const app = "shop";
        const ids = ["b1", "b2", "b3", "b4"];
        runCaptureMock.mockReturnValue(gcsStaticListing(bucket, app, ids));

        // b1 is the OLDEST but it is the RESOLVED build-id of a live revision
        // (deploy.ts resolved revisionName -> `apps.kn-next.dev/build-id` label
        // == "b1"). Defect-B fix: the live set is exact resolved build-ids, so
        // "b1" itself is passed (NOT a revision name like "shop-b1-00009").
        pruneOldBuilds(makeConfig("gcs", bucket, app, 2), ["b1"], "b4");

        const deleted = runDeleteMock.mock.calls
            .flatMap((c) => c[0] as string[])
            .join("\n");
        expect(deleted).not.toContain("/b1/");
        // b2 (oldest non-live, outside window) is the only reap.
        expect(deleted).toContain("/b2/");
    });

    it("NEVER issues a delete of the bare <app>/ prefix", () => {
        const bucket = "b";
        const app = "shop";
        runCaptureMock.mockReturnValue(
            gcsStaticListing(bucket, app, ["b1", "b2", "b3", "b4"]),
        );
        pruneOldBuilds(makeConfig("gcs", bucket, app, 1), [], "b4");

        for (const call of runDeleteMock.mock.calls) {
            const argv = call[0] as string[];
            for (const tok of argv) {
                // No delete target may be the bare app prefix or bucket root.
                expect(tok).not.toBe(`gs://${bucket}/${app}/`);
                expect(tok).not.toBe(`gs://${bucket}/`);
                expect(tok).not.toBe(`gs://${bucket}`);
            }
        }
    });

    it("is a no-op when nothing is outside the window (no deletes issued)", () => {
        const bucket = "b";
        const app = "shop";
        runCaptureMock.mockReturnValue(
            gcsStaticListing(bucket, app, ["b1", "b2"]),
        );
        pruneOldBuilds(makeConfig("gcs", bucket, app, 3), [], "b2");
        expect(runDeleteMock).not.toHaveBeenCalled();
    });

    it("azure: reaps via `az ... blob delete-batch` scoped to the build prefix, never bare <app>/", () => {
        const bucket = "c";
        const app = "shop";
        runCaptureMock.mockReturnValue(
            azureStaticListing(app, ["b1", "b2", "b3", "b4"]),
        );
        pruneOldBuilds(makeConfig("azure", bucket, app, 2), [], "b4");

        const calls = runDeleteMock.mock.calls.map((c) => c[0] as string[]);
        // Every delete is the azure CLI delete-batch verb.
        expect(calls.length).toBeGreaterThan(0);
        for (const argv of calls) {
            expect(argv[0]).toBe("az");
            expect(argv).toContain("delete-batch");
            // The --pattern is scoped to `<app>/_next/static/<id>/...`, never bare <app>/.
            const pattern = argv[argv.indexOf("--pattern") + 1];
            expect(pattern).toContain(`${app}/_next/static/`);
            expect(pattern).not.toBe(`${app}/`);
        }
        const patterns = calls
            .map((argv) => argv[argv.indexOf("--pattern") + 1])
            .join("\n");
        // The two oldest reaped; the two newest retained.
        expect(patterns).toContain("/_next/static/b1/");
        expect(patterns).toContain("/_next/static/b2/");
        expect(patterns).not.toContain("/b3/");
        expect(patterns).not.toContain("/b4/");
    });
});
