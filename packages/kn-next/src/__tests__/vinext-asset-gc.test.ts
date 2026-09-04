/**
 * T2b + T2c (#892) — the vinext build's assets, from staging to reclaim,
 * against a MUTABLE fake object store.
 *
 * Every other suite here asserts which argv was passed to a provider CLI. That
 * is the right shape for "did we ask for the correct thing", and the wrong
 * shape for the question #892 actually asks: *does anything ever get
 * reclaimed?* The pre-T2 answer was no — vinext builds were staged with no
 * marker, so `pruneOldBuilds` returned at `keptUnmarked` before it could ever
 * classify, and `reclaimBuildPrefix` logged that it had reclaimed a prefix
 * vinext never wrote. Both were green in a mock-argv world.
 *
 * So the store here is a real key set: the lister renders from it, the delete
 * removes from it, and the assertions are about the keys that are GONE and the
 * keys that SURVIVED. A reclaim that deletes nothing fails.
 */

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
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

mock.module("../cli/exec", () => ({
    runCapture: mock(),
    runQuiet: mock(),
    runQuietAllowFail: mock(),
}));

import { runCapture, runQuietAllowFail } from "../cli/exec";
import {
    BUILD_MARKER_FILENAME,
    pruneOldBuilds,
    reclaimBuildPrefix,
    type StorageBackedConfig,
    stageNitroPublicAssets,
} from "../utils/asset-upload";

const runCaptureMock = runCapture as unknown as Mock<typeof runCapture>;
const runDeleteMock = runQuietAllowFail as unknown as Mock<
    typeof runQuietAllowFail
>;

const BUCKET = "b";
const APP = "shop";

function makeConfig(assetRetention?: number): StorageBackedConfig {
    return {
        name: APP,
        storage: {
            provider: "gcs",
            bucket: BUCKET,
            publicUrl: `https://example.test/${BUCKET}`,
            assetRetention,
        },
    } as unknown as StorageBackedConfig;
}

/**
 * A fake GCS bucket: a set of object keys (relative to the bucket root) that
 * the mocked `gsutil ls -r` renders and the mocked `gsutil rm -r` mutates.
 */
class FakeStore {
    readonly keys = new Set<string>();

    /** Object keys under `<app>/_next/static/`, sorted. */
    staticKeys(): string[] {
        return [...this.keys]
            .filter((k) => k.startsWith(`${APP}/_next/static/`))
            .sort();
    }

    /** Renders `gsutil ls -r gs://b/shop/_next/static/` over the live key set. */
    render(): string {
        const byPrefix = new Map<string, string[]>();
        for (const key of this.staticKeys()) {
            const rest = key.slice(`${APP}/_next/static/`.length);
            const id = rest.split("/")[0] as string;
            if (!rest.includes("/")) continue; // a bare object, no prefix
            const list = byPrefix.get(id) ?? [];
            list.push(`gs://${BUCKET}/${key}`);
            byPrefix.set(id, list);
        }
        return [
            `gs://${BUCKET}/${APP}/_next/static/:`,
            "",
            ...[...byPrefix].map(([id, files]) =>
                [
                    `gs://${BUCKET}/${APP}/_next/static/${id}/:`,
                    ...files,
                    "",
                ].join("\n"),
            ),
        ].join("\n");
    }

    /** Applies a `gsutil rm -r gs://b/<prefix>` — the real recursive delete. */
    deleteUri(uri: string): void {
        const prefix = uri.replace(`gs://${BUCKET}/`, "");
        for (const key of [...this.keys]) {
            if (key.startsWith(prefix)) this.keys.delete(key);
        }
    }
}

let store: FakeStore;
let cwd: string;

beforeEach(() => {
    store = new FakeStore();
    cwd = mkdtempSync(join(tmpdir(), "knext-vinext-gc-"));
    runCaptureMock.mockReset();
    runDeleteMock.mockReset();
    runCaptureMock.mockImplementation(() => store.render());
    runDeleteMock.mockImplementation((...a: unknown[]) => {
        const argv = a[0] as string[];
        const uri = argv.find((t) => t.startsWith(`gs://${BUCKET}/`));
        if (uri) store.deleteUri(uri);
    });
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    jest.clearAllMocks();
});

/** Seeds `.output/public` the way a vinext build under `--tag=<id>` emits it. */
function seedVinextBuild(id: string): void {
    const dir = join(cwd, ".output", "public", "_next", "static", id);
    rmSync(join(cwd, ".output"), { recursive: true, force: true });
    mkdirSync(join(dir, "chunks"), { recursive: true });
    writeFileSync(join(dir, "_buildManifest.js"), "self.__BUILD=1");
    writeFileSync(join(dir, "chunks", "main.js"), "console.log(1)");
    writeFileSync(join(cwd, ".output", "public", "favicon.ico"), "icon");
}

/** Uploads a staged dir into the fake store under the app key prefix. */
function uploadStaged(stagedDir: string): void {
    const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            if (e.isDirectory()) walk(full);
            else
                store.keys.add(
                    `${APP}/${relative(stagedDir, full).split(sep).join("/")}`,
                );
        }
    };
    walk(stagedDir);
}

/**
 * Seeds a `next/font` app's `.output/public` — the real tree shape, with
 * `_vinext_fonts/` as a first-level sibling of the build prefix (vinext's
 * `createGoogleFontsPlugin` writeBundle hook copies fonts to
 * `<assetsDir>/_vinext_fonts/`, and `assetsDir` is `_next/static`).
 */
function seedFontAppBuild(id: string): void {
    seedVinextBuild(id);
    const staticRoot = join(cwd, ".output", "public", "_next", "static");
    mkdirSync(join(staticRoot, "_vinext_fonts"), { recursive: true });
    writeFileSync(
        join(staticRoot, "_vinext_fonts", "inter-latin.woff2"),
        "font",
    );
    mkdirSync(join(staticRoot, "css"), { recursive: true });
    writeFileSync(join(staticRoot, "css", "app.css"), "body{}");
}

/** Stages + uploads one vinext build under `id`, as a deploy would. */
function deployBuild(id: string): void {
    seedVinextBuild(id);
    uploadStaged(stageNitroPublicAssets(cwd, id));
}

describe("T2b (#892) — a vinext build is markered, protected, and reapable", () => {
    it("the staged upload carries the marker into the remote key set", () => {
        deployBuild("t1");
        expect(store.keys).toContain(
            `${APP}/_next/static/t1/${BUILD_MARKER_FILENAME}`,
        );
    });

    it("reaps a vinext build that left the retain window and is not live", () => {
        deployBuild("t1");
        deployBuild("t2");
        deployBuild("t3");

        // retain 1 + live = t3 ⇒ t1 and t2 leave the window.
        const summary = pruneOldBuilds(makeConfig(1), ["t3"], "t3");

        expect(summary.reaped.sort()).toEqual(["t1", "t2"]);
        // OBSERVED, not asserted from the summary: the objects are gone.
        expect(
            store.staticKeys().filter((k) => k.includes("/t1/")),
        ).toHaveLength(0);
        expect(
            store.staticKeys().filter((k) => k.includes("/t2/")),
        ).toHaveLength(0);
        // ...and the pre-T2 outcome (over-kept forever) is NOT what happened.
        expect(summary.keptUnmarked).toEqual([]);
    });

    it("a LIVE vinext build's prefix SURVIVES the same run (the over-delete case)", () => {
        deployBuild("t1");
        deployBuild("t2");
        deployBuild("t3");

        // t1 is the oldest AND live (a rollback pin). retain 1.
        const summary = pruneOldBuilds(makeConfig(1), ["t1"], "t3");

        expect(summary.keptLive).toContain("t1");
        expect(summary.reaped).not.toContain("t1");
        // The live build's own chunks are still served.
        expect(store.keys).toContain(`${APP}/_next/static/t1/chunks/main.js`);
        // The build being deployed is protected too.
        expect(store.keys).toContain(`${APP}/_next/static/t3/chunks/main.js`);
    });

    it("an upload with NO stated build id is over-kept, never reaped (the fail-safe)", () => {
        // `kn-next build`: assets uploaded, no deploy id, no revision. No
        // marker ⇒ the pruner cannot classify it ⇒ it survives even outside
        // the window. The alternative — marking whatever id vinext minted —
        // would make it reapable while no revision label could ever protect it.
        seedVinextBuild("some-vinext-uuid");
        uploadStaged(stageNitroPublicAssets(cwd));
        deployBuild("t2");
        deployBuild("t3");

        const summary = pruneOldBuilds(makeConfig(1), ["t3"], "t3");

        expect(summary.keptUnmarked).toEqual(["some-vinext-uuid"]);
        expect(summary.reaped).not.toContain("some-vinext-uuid");
        expect(store.keys).toContain(
            `${APP}/_next/static/some-vinext-uuid/chunks/main.js`,
        );
    });

    /**
     * The blocking defect from review round 1, at the GC layer.
     *
     * A build-id DISCOVERY rule saw `_vinext_fonts/` as a rival candidate, so
     * for every `next/font` app it staged no marker at all — the build was
     * over-kept forever and the font namespace polluted the prune listing as a
     * suspicious unmarked prefix on every single run.
     */
    it("a next/font app is markered, protected and reapable like any other", () => {
        seedFontAppBuild("t1");
        uploadStaged(stageNitroPublicAssets(cwd, "t1"));
        seedFontAppBuild("t2");
        uploadStaged(stageNitroPublicAssets(cwd, "t2"));
        seedFontAppBuild("t3");
        uploadStaged(stageNitroPublicAssets(cwd, "t3"));

        // The marker is there — the half that used to be silently skipped.
        expect(store.keys).toContain(
            `${APP}/_next/static/t1/${BUILD_MARKER_FILENAME}`,
        );

        const summary = pruneOldBuilds(makeConfig(1), ["t3"], "t3");

        // Reaped like any other build...
        expect(summary.reaped.sort()).toEqual(["t1", "t2"]);
        expect(
            store.staticKeys().filter((k) => k.includes("/t1/")),
        ).toHaveLength(0);
        // ...and the shared font/css namespaces are NEVER touched, nor
        // reported as mystery unmarked prefixes.
        expect(store.keys).toContain(
            `${APP}/_next/static/_vinext_fonts/inter-latin.woff2`,
        );
        expect(store.keys).toContain(`${APP}/_next/static/css/app.css`);
        expect(summary.keptUnmarked).toEqual([]);
        expect(summary.reservedExcluded).toContain("_vinext_fonts");
        expect(summary.reaped).not.toContain("_vinext_fonts");
    });
});

describe("T2c — the failure-path reclaim actually deletes", () => {
    it("the orphaned prefix EXISTS before the reclaim and is GONE after", () => {
        deployBuild("t1"); // a previous, still-live build
        deployBuild("t2"); // this run: uploaded, then the docker push rejects

        const before = store
            .staticKeys()
            .filter((k) => k.startsWith(`${APP}/_next/static/t2/`));
        // Non-vacuity: a reclaim of nothing must not read as a successful one.
        expect(before.length).toBeGreaterThan(0);

        reclaimBuildPrefix(makeConfig(), "t2");

        expect(
            store.staticKeys().filter((k) => k.includes("/t2/")),
        ).toHaveLength(0);
        // Scoped: the other build is untouched.
        expect(store.keys).toContain(`${APP}/_next/static/t1/chunks/main.js`);
        expect(store.keys).toContain(
            `${APP}/_next/static/t1/${BUILD_MARKER_FILENAME}`,
        );
    });

    it("reclaims the MARKER too — a marker outliving its chunks is a phantom build", () => {
        // The marker is what makes a prefix a prune candidate. Leaving it
        // behind would leave the GC reporting on a build with no assets.
        deployBuild("t2");
        expect(store.keys).toContain(
            `${APP}/_next/static/t2/${BUILD_MARKER_FILENAME}`,
        );

        reclaimBuildPrefix(makeConfig(), "t2");

        expect(store.keys).not.toContain(
            `${APP}/_next/static/t2/${BUILD_MARKER_FILENAME}`,
        );
    });

    it("the reclaimed prefix is the one the build was STAGED under (no UUID)", () => {
        // The pre-T2a defect in one assertion: deploy reclaims by the deploy
        // TAG, so if the staging prefix were a vinext UUID the reclaim would
        // delete nothing and log that it had succeeded. Post-T2a the staged
        // prefix IS the tag, so reclaiming by tag empties it.
        deployBuild("deploy-tag-9");
        const stagedPrefixes = new Set(
            store
                .staticKeys()
                .map(
                    (k) => k.slice(`${APP}/_next/static/`.length).split("/")[0],
                ),
        );
        expect([...stagedPrefixes]).toEqual(["deploy-tag-9"]);

        reclaimBuildPrefix(makeConfig(), "deploy-tag-9");
        expect(store.staticKeys()).toEqual([]);
    });
});
