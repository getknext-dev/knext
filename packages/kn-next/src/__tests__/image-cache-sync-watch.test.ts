/**
 * image-cache-sync — coverage for the WATCH + top-level start paths and the
 * best-effort error branches (ADR-0006 item 2). Complements image-cache-sync.test.ts
 * (which pins restore/push round-trip) with:
 *  - watchAndPushImageCache: a newly-written variant dir is pushed to the store,
 *  - startImageCacheSync (bucket set): restores THEN returns a live stop() handle,
 *  - pushVariant/restore degrade (upload/download failures logged, never thrown).
 *
 * In-memory fake store + a real temp cache dir — no MinIO/network.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ImageVariantStore,
    pushVariant,
    restoreImageCache,
    startImageCacheSync,
    watchAndPushImageCache,
} from "../adapters/image-cache-sync";

const SILENT = { info: () => {}, warn: () => {} };

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

/** Poll until predicate is true or the timeout elapses (fs.watch is async). */
async function waitFor(
    predicate: () => boolean,
    timeoutMs = 4000,
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
}

describe("image-cache-sync — watch + start", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgwatch-"));
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("watches the cache dir and pushes a newly-written variant to the store", async () => {
        const store = fakeStore();
        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });
        try {
            // Simulate Next writing a new optimized variant directory + file.
            const variantDir = join(cacheDir, "newkey");
            await fs.mkdir(variantDir, { recursive: true });
            await fs.writeFile(join(variantDir, "1.2.e.u.webp"), "FRESH");

            const pushed = await waitFor(() =>
                store.objects.has("image-cache/newkey/1.2.e.u.webp"),
            );
            expect(pushed).toBe(true);
            expect(
                store.objects
                    .get("image-cache/newkey/1.2.e.u.webp")
                    ?.toString(),
            ).toBe("FRESH");
        } finally {
            handle.stop();
        }
        // stop() is idempotent-safe to call once; a second call must not throw.
        expect(() => handle.stop()).not.toThrow();
    });

    it("startImageCacheSync (bucket set): restores existing variants then returns a live stop handle", async () => {
        const store = fakeStore({
            "image-cache/warm/9.9.e.u.avif": Buffer.from("WARMED"),
        });
        const handle = await startImageCacheSync(
            {
                STORAGE_BUCKET: "b",
                IMAGE_CACHE_DIR: cacheDir,
            } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv,
            { store, log: SILENT },
        );
        try {
            // Restore ran: the seeded variant is now on local disk.
            const local = join(cacheDir, "warm", "9.9.e.u.avif");
            expect(await fs.readFile(local, "utf8")).toBe("WARMED");
            expect(typeof handle.stop).toBe("function");
        } finally {
            handle.stop();
        }
    });

    it("startImageCacheSync lists the store exactly once for restore + reconcile combined", async () => {
        const store = fakeStore({
            "image-cache/warm/9.9.e.u.avif": Buffer.from("WARMED"),
        });
        const list = vi.spyOn(store, "list");
        const handle = await startImageCacheSync(
            {
                STORAGE_BUCKET: "b",
                IMAGE_CACHE_DIR: cacheDir,
            } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv,
            { store, log: SILENT },
        );
        try {
            // Restore ran (the variant landed on disk), and the watch (with
            // its reconcile) resolved — yet the store was listed only once:
            // the listing is threaded through both phases.
            expect(
                await fs.readFile(
                    join(cacheDir, "warm", "9.9.e.u.avif"),
                    "utf8",
                ),
            ).toBe("WARMED");
            expect(list).toHaveBeenCalledTimes(1);
        } finally {
            handle.stop();
        }
    });

    it("honours IMAGE_CACHE_PREFIX when restoring under a custom prefix", async () => {
        const store = fakeStore({
            "custom/k/1.2.e.u.webp": Buffer.from("C"),
        });
        const handle = await startImageCacheSync(
            {
                STORAGE_BUCKET: "b",
                IMAGE_CACHE_DIR: cacheDir,
                IMAGE_CACHE_PREFIX: "custom",
            } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv,
            { store, log: SILENT },
        );
        try {
            expect(
                await fs.readFile(join(cacheDir, "k", "1.2.e.u.webp"), "utf8"),
            ).toBe("C");
        } finally {
            handle.stop();
        }
    });
});

describe("image-cache-sync — degrade-gracefully error branches", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgerr-"));
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("restore: a per-key download failure is logged and skipped, others still restored", async () => {
        const store = fakeStore({
            "image-cache/ok/1.2.e.u.webp": Buffer.from("OK"),
            "image-cache/bad/1.2.e.u.webp": Buffer.from("BAD"),
        });
        // Make ONLY the "bad" key fail to download.
        const realDownload = store.download.bind(store);
        vi.spyOn(store, "download").mockImplementation(
            async (bucket, key, dest) => {
                if (key.includes("/bad/")) throw new Error("blob read error");
                return realDownload(bucket, key, dest);
            },
        );
        const warn = vi.fn();

        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: { info: () => {}, warn },
        });

        expect(restored).toBe(1); // only the "ok" variant
        expect(warn).toHaveBeenCalled();
        expect(
            await fs.readFile(join(cacheDir, "ok", "1.2.e.u.webp"), "utf8"),
        ).toBe("OK");
    });

    it("restore: skips a bare prefix key (no relative path)", async () => {
        const store = fakeStore({ "image-cache/": Buffer.from("") });
        const download = vi.spyOn(store, "download");
        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });
        expect(restored).toBe(0);
        expect(download).not.toHaveBeenCalled();
    });

    it("pushVariant: a vanished variant directory pushes nothing (returns 0)", async () => {
        const store = fakeStore();
        const uploaded = await pushVariant("gone", {
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
        });
        expect(uploaded).toBe(0);
    });

    it("pushVariant: a per-file upload failure is logged and skipped", async () => {
        const store = fakeStore();
        vi.spyOn(store, "upload").mockRejectedValue(new Error("upload 500"));
        const variantDir = join(cacheDir, "k");
        await fs.mkdir(variantDir, { recursive: true });
        await fs.writeFile(join(variantDir, "x.webp"), "DATA");
        const warn = vi.fn();

        const uploaded = await pushVariant("k", {
            bucket: "b",
            cacheDir,
            store,
            log: { info: () => {}, warn },
        });

        expect(uploaded).toBe(0);
        expect(warn).toHaveBeenCalled();
    });
});
