import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ImageVariantStore,
    pushVariant,
    restoreImageCache,
    startImageCacheSync,
} from "../adapters/image-cache-sync";

/**
 * Verifies ADR-0006 item 2: optimized image variants survive scale-to-zero by
 * persisting in the object store, keyed by Next's per-variant cacheKey dir name
 * (= (src,w,q,accept)). Uses an in-memory fake store + a real temp cache dir, so
 * no live MinIO/network is required (mirrors the cache-handler test discipline).
 */

const SILENT = { info: () => {}, warn: () => {} };

/** In-memory ImageVariantStore: bucket → key → file bytes. */
function fakeStore(seed: Record<string, Buffer> = {}): ImageVariantStore & {
    objects: Map<string, Buffer>;
} {
    const objects = new Map<string, Buffer>(Object.entries(seed));
    return {
        objects,
        async list(_bucket, prefix) {
            return [...objects.keys()].filter((k) => k.startsWith(prefix));
        },
        async download(_bucket, key, destPath) {
            const data = objects.get(key);
            if (!data) throw new Error(`no such object: ${key}`);
            await fs.mkdir(join(destPath, ".."), { recursive: true });
            await fs.writeFile(destPath, data);
        },
        async upload(_bucket, key, srcPath) {
            objects.set(key, await fs.readFile(srcPath));
        },
    };
}

describe("image-cache-sync", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgcache-"));
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("restores persisted variants into the local cache dir, keyed by cacheKey", async () => {
        // Store holds one variant `abc123` with one file (Next's filename layout).
        const variantFile = "31536000.1700000000.etag.upstream.webp";
        const store = fakeStore({
            [`image-cache/abc123/${variantFile}`]: Buffer.from("AVIF-BYTES"),
        });

        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });

        expect(restored).toBe(1);
        const local = join(cacheDir, "abc123", variantFile);
        expect(existsSync(local)).toBe(true);
        expect(await fs.readFile(local, "utf8")).toBe("AVIF-BYTES");
    });

    it("skips restoring files that already exist locally (no clobber)", async () => {
        const variantFile = "1.2.e.u.webp";
        const local = join(cacheDir, "key1", variantFile);
        await fs.mkdir(join(cacheDir, "key1"), { recursive: true });
        await fs.writeFile(local, "LOCAL-NEWER");

        const store = fakeStore({
            [`image-cache/key1/${variantFile}`]: Buffer.from("STORE-OLD"),
        });
        const download = vi.spyOn(store, "download");

        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });

        expect(restored).toBe(0);
        expect(download).not.toHaveBeenCalled();
        expect(await fs.readFile(local, "utf8")).toBe("LOCAL-NEWER");
    });

    it("pushes a newly-written variant directory to the store under <prefix>/<cacheKey>/<file>", async () => {
        const store = fakeStore();
        const variantDir = join(cacheDir, "deadbeef");
        await fs.mkdir(variantDir, { recursive: true });
        await fs.writeFile(join(variantDir, "1.2.e.u.avif"), "OPTIMIZED");

        const uploaded = await pushVariant("deadbeef", {
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });

        expect(uploaded).toBe(1);
        expect(
            store.objects.get("image-cache/deadbeef/1.2.e.u.avif")?.toString(),
        ).toBe("OPTIMIZED");
    });

    it("round-trips: a variant pushed by 'pod A' is restored by 'pod B' (scale-to-zero survival)", async () => {
        const store = fakeStore();

        // Pod A optimizes + writes a variant locally, then pushes it.
        const podA = join(cacheDir, "podA");
        const variantDir = join(podA, "v1key");
        await fs.mkdir(variantDir, { recursive: true });
        await fs.writeFile(join(variantDir, "x.webp"), "VARIANT");
        await pushVariant("v1key", {
            bucket: "b",
            cacheDir: podA,
            store,
            log: SILENT,
        });

        // Pod B starts cold (empty dir) and restores from the store.
        const podB = join(cacheDir, "podB");
        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir: podB,
            store,
            log: SILENT,
        });

        expect(restored).toBe(1);
        expect(await fs.readFile(join(podB, "v1key", "x.webp"), "utf8")).toBe(
            "VARIANT",
        );
    });

    it("is a no-op when STORAGE_BUCKET is unset", async () => {
        const store = fakeStore();
        const list = vi.spyOn(store, "list");

        const handle = await startImageCacheSync(
            // Type-level cast (#261): Next augments ProcessEnv with a REQUIRED
            // NODE_ENV; this env double deliberately carries no STORAGE_BUCKET
            // (and no NODE_ENV — the sync only reads STORAGE_BUCKET and the
            // IMAGE_CACHE_* keys).
            {
                IMAGE_CACHE_DIR: cacheDir,
            } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv,
            { store, log: SILENT },
        );

        expect(list).not.toHaveBeenCalled();
        expect(typeof handle.stop).toBe("function");
        handle.stop(); // safe no-op
    });

    it("degrades gracefully: a store list failure does not throw", async () => {
        const store = fakeStore();
        vi.spyOn(store, "list").mockRejectedValue(new Error("store down"));

        await expect(
            restoreImageCache({ bucket: "b", cacheDir, store, log: SILENT }),
        ).resolves.toBe(0);
    });
});
