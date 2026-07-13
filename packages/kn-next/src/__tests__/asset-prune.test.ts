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
 * Deploy-time build-prune tests (#93, ADR-0011; marker inversion #264).
 *
 * `pruneOldBuilds` is the deploy-time half of the retention GC: it lists the
 * remote `_next/static/<buildId>/` prefixes under `<app>/`, asks the pure
 * `selectBuildsToDelete` which build-ids are reapable (retain window OR live ⇒
 * keep), and deletes ONLY those prefixes. It must NEVER:
 *   - delete the bare `<app>/` prefix (that is teardown-only, ADR-0008),
 *   - delete a build-id that is in the live set (a #92 pinned/canary/rollback),
 *   - delete the newest / only build,
 *   - delete a prefix that does NOT carry the `.knext-build` marker object
 *     (#264 marker inversion: only prefixes knext itself uploaded are ever
 *     candidates — unknown/future dirs and pre-marker uploads default KEEP),
 *   - delete a reserved shared dir (chunks/css/media/...) EVEN IF a marker
 *     object somehow appears inside it (the deny-list stays permanently as
 *     defense-in-depth under the marker inversion — deleting shared chunks/
 *     is the max-blast-radius failure).
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

/** The marker object name is a LOCKED contract (ADR-0011) — hardcoded here. */
const MARKER = ".knext-build";

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

/** One first-level "directory" under `<app>/_next/static/` in the fake store. */
interface SeededPrefix {
    id: string;
    /** true ⇒ the prefix carries `<id>/.knext-build` (a knext-uploaded build). */
    marker: boolean;
}

/** Shorthand: every id marker-carrying (the post-#264 steady state). */
function marked(ids: string[]): SeededPrefix[] {
    return ids.map((id) => ({ id, marker: true }));
}

/** Files each seeded prefix contains (besides the optional marker). */
const PREFIX_FILES = ["_buildManifest.js", "_ssgManifest.js"];

/**
 * Renders each provider's RECURSIVE listing of `<app>/_next/static/` the way
 * the pruner's marker-aware listing parses it (#264): full object keys, so the
 * marker object is visible.
 */
const STATIC_LISTERS: Record<
    StorageProvider,
    (bucket: string, app: string, prefixes: SeededPrefix[]) => string
> = {
    // `gsutil ls -r` prints a TOP-LEVEL header for the listed dir itself
    // (`gs://<bucket>/<app>/_next/static/:`), then per-directory header lines
    // (`.../<id>/:`) followed by full object URIs, with blank separator lines.
    // The top-level header is real-gsutil fidelity (#264 review finding): a
    // naive parser folds it into a phantom ":" prefix that pollutes the loud
    // over-keep output on every clean GCS run.
    gcs: (bucket, app, prefixes) =>
        [
            `gs://${bucket}/${app}/_next/static/:`,
            "",
            ...prefixes.map(({ id, marker }) => {
                const base = `gs://${bucket}/${app}/_next/static/${id}`;
                const files = [
                    ...PREFIX_FILES.map((f) => `${base}/${f}`),
                    ...(marker ? [`${base}/${MARKER}`] : []),
                ];
                return [`${base}/:`, ...files, ""].join("\n");
            }),
        ].join("\n"),
    // `aws s3api list-objects-v2 --output text` → whitespace-separated keys.
    s3: (_bucket, app, prefixes) =>
        prefixes
            .flatMap(({ id, marker }) => [
                ...PREFIX_FILES.map((f) => `${app}/_next/static/${id}/${f}`),
                ...(marker ? [`${app}/_next/static/${id}/${MARKER}`] : []),
            ])
            .join("\n"),
    // `mc ls --recursive` → metadata columns then the key, RELATIVE to the
    // listed prefix.
    minio: (_bucket, _app, prefixes) =>
        prefixes
            .flatMap(({ id, marker }) => [
                ...PREFIX_FILES.map(
                    (f) =>
                        `[2026-07-01 10:00:00 UTC]    11B STANDARD ${id}/${f}`,
                ),
                ...(marker
                    ? [
                          `[2026-07-01 10:00:00 UTC]     8B STANDARD ${id}/${MARKER}`,
                      ]
                    : []),
            ])
            .join("\n"),
    // `az storage blob list --query [].name -o json` → JSON array of names.
    azure: (_bucket, app, prefixes) =>
        JSON.stringify(
            prefixes.flatMap(({ id, marker }) => [
                ...PREFIX_FILES.map((f) => `${app}/_next/static/${id}/${f}`),
                ...(marker ? [`${app}/_next/static/${id}/${MARKER}`] : []),
            ]),
        ),
};

describe("pruneOldBuilds", () => {
    beforeEach(() => {
        runCaptureMock.mockReset();
        runDeleteMock.mockReset();
    });
    afterEach(() => vi.clearAllMocks());

    /** Every token passed to the delete exec, joined for substring checks. */
    function deletedTokens(): string {
        return runDeleteMock.mock.calls
            .flatMap((c) => c[0] as string[])
            .join("\n");
    }

    it("deletes only the build-ids outside the retain window, scoped to <app>/_next/static/<id>/", () => {
        const bucket = "b";
        const app = "shop";
        // 4 builds present; retain 2 keeps the two newest, deletes the two oldest.
        const ids = ["b1", "b2", "b3", "b4"]; // listing order = oldest→newest
        runCaptureMock.mockReturnValue(
            STATIC_LISTERS.gcs(bucket, app, marked(ids)),
        );

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
        runCaptureMock.mockReturnValue(
            STATIC_LISTERS.gcs(bucket, app, marked(ids)),
        );

        // b1 is the OLDEST but it is the RESOLVED build-id of a live revision
        // (deploy.ts resolved revisionName -> `apps.kn-next.dev/build-id` label
        // == "b1"). Defect-B fix: the live set is exact resolved build-ids, so
        // "b1" itself is passed (NOT a revision name like "shop-b1-00009").
        pruneOldBuilds(makeConfig("gcs", bucket, app, 2), ["b1"], "b4");

        const deleted = deletedTokens();
        expect(deleted).not.toContain("/b1/");
        // b2 (oldest non-live, outside window) is the only reap.
        expect(deleted).toContain("/b2/");
    });

    it("NEVER issues a delete of the bare <app>/ prefix", () => {
        const bucket = "b";
        const app = "shop";
        runCaptureMock.mockReturnValue(
            STATIC_LISTERS.gcs(bucket, app, marked(["b1", "b2", "b3", "b4"])),
        );
        pruneOldBuilds(makeConfig("gcs", bucket, app, 1), [], "b4");

        expect(runDeleteMock.mock.calls.length).toBeGreaterThan(0);
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
            STATIC_LISTERS.gcs(bucket, app, marked(["b1", "b2"])),
        );
        pruneOldBuilds(makeConfig("gcs", bucket, app, 3), [], "b2");
        expect(runDeleteMock).not.toHaveBeenCalled();
    });

    it("NEVER treats Next's reserved static dirs (chunks/css/media) as prunable — EVEN with a marker inside (deny-list stays as defense-in-depth)", () => {
        // Real `next build` output puts MORE than build-id dirs under
        // `.next/static/` (staged to `<app>/_next/static/`): content-hashed
        // `chunks/`, `css/`, `media/` shared by the pages of EVERY build.
        // Deleting them 404s the CURRENT build's own JS/CSS — the
        // max-blast-radius failure. Under the #264 marker inversion they are
        // naturally unmarked, but the RESERVED_STATIC_DIRS deny-list stays
        // PERMANENTLY: even a hostile/accidental `.knext-build` object inside
        // a reserved dir must not make it a candidate.
        const bucket = "b";
        const app = "shop";
        const prefixes: SeededPrefix[] = [
            { id: "1001", marker: true },
            { id: "1002", marker: true },
            { id: "1003", marker: true },
            // Reserved dirs WITH a (hostile) marker each — still never reaped.
            { id: "chunks", marker: true },
            { id: "css", marker: true },
            { id: "media", marker: true },
        ];
        runCaptureMock.mockReturnValue(
            STATIC_LISTERS.gcs(bucket, app, prefixes),
        );

        pruneOldBuilds(makeConfig("gcs", bucket, app, 1), [], "1003");

        const deleted = deletedTokens();
        // Reserved dirs are NEVER deleted…
        expect(deleted).not.toContain("/chunks/");
        expect(deleted).not.toContain("/css/");
        expect(deleted).not.toContain("/media/");
        // …and the retain window applies to REAL build-ids only: retain=1
        // keeps the just-deployed 1003; 1001 + 1002 are reaped.
        expect(deleted).toContain("/_next/static/1001/");
        expect(deleted).toContain("/_next/static/1002/");
        expect(deleted).not.toContain("/1003/");
    });

    it("azure: reaps via `az ... blob delete-batch` scoped to the build prefix, never bare <app>/", () => {
        const bucket = "c";
        const app = "shop";
        runCaptureMock.mockReturnValue(
            STATIC_LISTERS.azure(bucket, app, marked(["b1", "b2", "b3", "b4"])),
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

    /**
     * #264 marker inversion — the failure direction is KEEP. A FUTURE Next
     * version emitting a NEW shared dir under `.next/static/` (not in the
     * deny-list, no marker) must survive the GC; only prefixes knext itself
     * uploaded (proven by the `.knext-build` marker object) are candidates.
     */
    describe("marker inversion (#264): unknown dirs default KEEP", () => {
        it("an unknown-dir prefix (not reserved, NO marker) survives and is named in keptUnmarked", () => {
            const bucket = "b";
            const app = "shop";
            const prefixes: SeededPrefix[] = [
                ...marked(["b1", "b2", "b3", "b4"]),
                // A hypothetical future Next shared dir — unknown to the
                // deny-list, carries no marker. Aged out of every window.
                { id: "turbo", marker: false },
            ];
            runCaptureMock.mockReturnValue(
                STATIC_LISTERS.gcs(bucket, app, prefixes),
            );

            const summary = pruneOldBuilds(
                makeConfig("gcs", bucket, app, 1),
                [],
                "b4",
            );

            const deleted = deletedTokens();
            // The unknown dir is NEVER deleted…
            expect(deleted).not.toContain("/turbo/");
            // …and the skip is LOUD: named in the returned summary.
            expect(summary.keptUnmarked).toContain("turbo");
            // Marker-carrying aged prefixes ARE still reaped (the GC still GCs).
            expect(deleted).toContain("/_next/static/b1/");
            expect(deleted).toContain("/_next/static/b2/");
            expect(deleted).toContain("/_next/static/b3/");
            expect(summary.reaped).toEqual(["b1", "b2", "b3"]);
        });

        it("a pre-marker bucket (NO markers anywhere) ⇒ nothing deleted, every prefix named (transition story)", () => {
            // Mixed-bucket transition (ADR-0011): builds uploaded before the
            // marker existed are over-kept until a re-upload writes markers.
            const bucket = "b";
            const app = "shop";
            const ids = ["b1", "b2", "b3", "b4"];
            runCaptureMock.mockReturnValue(
                STATIC_LISTERS.gcs(
                    bucket,
                    app,
                    ids.map((id) => ({ id, marker: false })),
                ),
            );

            const summary = pruneOldBuilds(
                makeConfig("gcs", bucket, app, 1),
                [],
                "b4",
            );

            expect(runDeleteMock).not.toHaveBeenCalled();
            expect(summary.reaped).toEqual([]);
            expect([...summary.keptUnmarked].sort()).toEqual(ids);
        });

        const providers: StorageProvider[] = ["gcs", "s3", "minio", "azure"];
        it.each(
            providers,
        )("provider=%s: reaps ONLY marker-carrying aged prefixes; the unmarked prefix survives", (provider) => {
            const bucket = "b";
            const app = "shop";
            const prefixes: SeededPrefix[] = [
                { id: "old-marked", marker: true },
                { id: "old-unmarked", marker: false },
                { id: "new-marked", marker: true },
            ];
            runCaptureMock.mockReturnValue(
                STATIC_LISTERS[provider](bucket, app, prefixes),
            );

            const summary = pruneOldBuilds(
                makeConfig(provider, bucket, app, 1),
                [],
                "new-marked",
            );

            const deleted = deletedTokens();
            expect(deleted).toContain("/_next/static/old-marked/");
            expect(deleted).not.toContain("/old-unmarked/");
            expect(deleted).not.toContain("/new-marked/");
            expect(summary.reaped).toEqual(["old-marked"]);
            expect(summary.keptUnmarked).toEqual(["old-unmarked"]);
        });
    });
});
