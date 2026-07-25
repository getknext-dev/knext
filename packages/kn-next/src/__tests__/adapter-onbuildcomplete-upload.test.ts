/**
 * next-adapter — onBuildComplete + uploadBuildArtifacts (#89, ADR-0006).
 *
 * onBuildComplete logs output/routing counts and best-effort uploads
 * staticFiles + prerenders to the object store (guarded by STORAGE_BUCKET). These
 * tests drive the real hook with a fake AdapterOutputs ctx and a mocked
 * @getknext/lib/clients so the upload path runs WITHOUT MinIO/network:
 *  - STORAGE_BUCKET unset → upload skipped cleanly,
 *  - STORAGE_BUCKET set → staticFiles/prerenders uploaded under <buildId>/<path>,
 *    a missing filePath is skipped, a putObject failure is counted (not thrown),
 *  - a storage-client import failure degrades to "skipped",
 *  - both routing ctx shapes (legacy ctx.routes / typed ctx.routing) are counted.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock handle for the MinIO client's putObject. It DRAINS the passed
// ReadStream to completion so the source file is fully read before afterEach
// removes the temp dir (an unconsumed lazy stream would open-ENOENT afterwards).
const putObject = vi.hoisted(() =>
    vi.fn(
        (_bucket: string, _key: string, stream: NodeJS.ReadableStream) =>
            new Promise((resolvePromise) => {
                stream.on("error", () => resolvePromise({}));
                stream.on("end", () => resolvePromise({}));
                stream.resume();
            }),
    ),
);
const getMinioClient = vi.hoisted(() => vi.fn(() => ({ putObject })));

vi.mock("@getknext/lib/clients", () => ({ getMinioClient }));

import adapter from "../adapters/next-adapter";

type Ctx = Parameters<NonNullable<typeof adapter.onBuildComplete>>[0];

let dir: string;
const savedBucket = process.env.STORAGE_BUCKET;

/** Minimal AdapterOutputs with the array shapes the hook reads. */
function makeOutputs(
    over: Partial<Record<string, unknown[]>> = {},
): Ctx["outputs"] {
    return {
        pages: [],
        appPages: [],
        appRoutes: [],
        pagesApi: [],
        prerenders: [],
        staticFiles: [],
        middleware: undefined,
        ...over,
    } as unknown as Ctx["outputs"];
}

function makeCtx(over: Partial<Ctx> = {}): Ctx {
    return {
        buildId: "bid123",
        distDir: join(dir, ".next"),
        nextVersion: "16.2.0",
        config: { output: "standalone" },
        outputs: makeOutputs(),
        routing: undefined,
        ...over,
    } as unknown as Ctx;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-adapter-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    putObject.mockClear();
    getMinioClient.mockClear();
    getMinioClient.mockReturnValue({ putObject });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedBucket === undefined) delete process.env.STORAGE_BUCKET;
    else process.env.STORAGE_BUCKET = savedBucket;
    vi.restoreAllMocks();
});

describe("onBuildComplete — artifact upload", () => {
    it("skips upload cleanly when STORAGE_BUCKET is unset", async () => {
        delete process.env.STORAGE_BUCKET;
        await adapter.onBuildComplete?.(makeCtx());
        expect(getMinioClient).not.toHaveBeenCalled();
    });

    it("uploads staticFiles + prerender fallbacks keyed by buildId, skipping missing files", async () => {
        process.env.STORAGE_BUCKET = "my-bucket";
        // A real static file on disk, and one whose path does not exist (skipped).
        const staticPath = join(dir, "index.html");
        writeFileSync(staticPath, "<html></html>");
        const prerenderPath = join(dir, "fallback.html");
        writeFileSync(prerenderPath, "<fallback/>");

        await adapter.onBuildComplete?.(
            makeCtx({
                buildId: "b1",
                outputs: makeOutputs({
                    staticFiles: [
                        { filePath: staticPath, pathname: "/index.html" },
                        { filePath: join(dir, "missing.html"), pathname: "/m" },
                    ],
                    prerenders: [
                        { id: "home", fallback: { filePath: prerenderPath } },
                        { id: "no-fallback" }, // filtered out (no fallback.filePath)
                    ],
                }),
            }),
        );

        expect(getMinioClient).toHaveBeenCalledTimes(1);
        const keys = putObject.mock.calls.map((c) => c[1]);
        expect(keys).toContain("b1/index.html");
        expect(keys).toContain("b1/home");
        // The missing static file and the fallback-less prerender were skipped.
        expect(putObject).toHaveBeenCalledTimes(2);
    });

    it("runs the bun-exports heal when the standalone dir already exists", async () => {
        delete process.env.STORAGE_BUCKET;
        // distDir/standalone present → the heal branch (else-branch otherwise).
        // An empty standalone tree (no node_modules) heals nothing but the
        // real healBunExportTargets orchestration runs (0 copied / 0 skipped).
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
        await expect(
            adapter.onBuildComplete?.(makeCtx()),
        ).resolves.toBeUndefined();
    });

    it("counts a putObject failure as skipped without throwing", async () => {
        process.env.STORAGE_BUCKET = "my-bucket";
        const staticPath = join(dir, "a.html");
        writeFileSync(staticPath, "x");
        // Drain the stream (so the file is read before teardown), THEN reject —
        // exercising the hook's per-file catch/skip branch.
        putObject.mockImplementationOnce(
            (_b: string, _k: string, stream: NodeJS.ReadableStream) =>
                new Promise((_res, reject) => {
                    stream.on("error", () => reject(new Error("s3 500")));
                    stream.on("end", () => reject(new Error("s3 500")));
                    stream.resume();
                }),
        );

        await expect(
            adapter.onBuildComplete?.(
                makeCtx({
                    outputs: makeOutputs({
                        staticFiles: [
                            { filePath: staticPath, pathname: "/a.html" },
                        ],
                    }),
                }),
            ),
        ).resolves.toBeUndefined();
    });

    it("degrades to skipped when the storage client cannot be loaded", async () => {
        process.env.STORAGE_BUCKET = "my-bucket";
        getMinioClient.mockImplementationOnce(() => {
            throw new Error("no minio env");
        });
        const staticPath = join(dir, "a.html");
        writeFileSync(staticPath, "x");

        await adapter.onBuildComplete?.(
            makeCtx({
                outputs: makeOutputs({
                    staticFiles: [
                        { filePath: staticPath, pathname: "/a.html" },
                    ],
                }),
            }),
        );
        // Client threw → putObject never reached.
        expect(putObject).not.toHaveBeenCalled();
    });
});

describe("onBuildComplete — routing-count ctx shapes", () => {
    it("counts the legacy ctx.routes shape without throwing", async () => {
        delete process.env.STORAGE_BUCKET;
        const ctx = makeCtx({ routing: undefined }) as Ctx & {
            routes?: unknown;
        };
        (ctx as { routes?: unknown }).routes = {
            headers: [{}, {}],
            redirects: [{}],
            rewrites: { beforeFiles: [{}], afterFiles: [], fallback: [] },
            dynamicRoutes: [{}, {}, {}],
        };
        await expect(adapter.onBuildComplete?.(ctx)).resolves.toBeUndefined();
    });

    it("counts the typed ctx.routing shape without throwing", async () => {
        delete process.env.STORAGE_BUCKET;
        await adapter.onBuildComplete?.(
            makeCtx({
                routing: {
                    beforeMiddleware: [],
                    beforeFiles: [{}],
                    afterFiles: [],
                    dynamicRoutes: [{}],
                    onMatch: [],
                    fallback: [],
                } as unknown as Ctx["routing"],
            }),
        );
    });
});
