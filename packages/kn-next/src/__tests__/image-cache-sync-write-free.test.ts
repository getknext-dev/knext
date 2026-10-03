/**
 * image-cache-sync under a write-free runtime.
 *
 * The sync mirrors `.next/cache/images` to the object store. Two shapes now
 * make that directory irrelevant or unusable, and the sync must stand down
 * cleanly in both instead of erroring on every cold wake:
 *
 *   1. The build routes optimized images through the knext cache handler
 *      (`images.customCacheHandler: true` in the built
 *      `required-server-files.json`): Next never writes the directory, so
 *      restoring or watching it is wasted store traffic.
 *   2. The directory is not writable (read-only root filesystem, no writable
 *      volume): restore/watch would `mkdir` into it and throw EROFS.
 *
 * Both must be no-ops that never touch the store.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ImageVariantStore,
    startImageCacheSync,
} from "../adapters/image-cache-sync";

const root = mkdtempSync(join(tmpdir(), "knext-ics-wf-"));
afterAll(() => {
    try {
        chmodSync(join(root, "ro", ".next"), 0o755);
    } catch {}
    rmSync(root, { recursive: true, force: true });
});

function countingStore() {
    const calls: string[] = [];
    const store: ImageVariantStore = {
        async list() {
            calls.push("list");
            return [];
        },
        async download() {
            calls.push("download");
        },
        async upload() {
            calls.push("upload");
        },
    };
    return { store, calls };
}

function syncEnv(app: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        STORAGE_BUCKET: "b",
        IMAGE_CACHE_DIR: join(app, ".next", "cache", "images"),
    };
}

function capturingLog() {
    const lines: string[] = [];
    return {
        lines,
        log: {
            info: (m: string) => lines.push(m),
            warn: (m: string) => lines.push(m),
        },
    };
}

describe("startImageCacheSync — write-free runtime", () => {
    it("stands down when the build routes images through the cache handler", async () => {
        const app = join(root, "routed");
        mkdirSync(join(app, ".next", "cache", "images"), { recursive: true });
        writeFileSync(
            join(app, ".next", "required-server-files.json"),
            JSON.stringify({
                config: { images: { customCacheHandler: true } },
            }),
        );
        const { store, calls } = countingStore();
        const { log, lines } = capturingLog();
        const handle = await startImageCacheSync(syncEnv(app), { store, log });
        handle.stop();
        expect(calls).toEqual([]);
        expect(lines.join("\n")).toContain("cache handler");
    });

    it("still syncs a build that writes images to disk", async () => {
        const app = join(root, "disk");
        mkdirSync(join(app, ".next", "cache", "images"), { recursive: true });
        writeFileSync(
            join(app, ".next", "required-server-files.json"),
            JSON.stringify({
                config: { images: { customCacheHandler: false } },
            }),
        );
        const { store, calls } = countingStore();
        const { log } = capturingLog();
        const handle = await startImageCacheSync(syncEnv(app), { store, log });
        handle.stop();
        expect(calls).toContain("list");
    });

    it.skipIf(process.getuid?.() === 0)(
        "stands down (no throw, no store traffic) when the cache dir cannot be created",
        async () => {
            const app = join(root, "ro");
            mkdirSync(join(app, ".next"), { recursive: true });
            chmodSync(join(app, ".next"), 0o555);
            const { store, calls } = countingStore();
            const { log, lines } = capturingLog();
            const handle = await startImageCacheSync(syncEnv(app), {
                store,
                log,
            });
            handle.stop();
            expect(calls).toEqual([]);
            expect(lines.join("\n")).toContain("not writable");
        },
    );
});
