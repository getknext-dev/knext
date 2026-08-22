/**
 * image-cache-sync — DETERMINISTIC coverage for the #805 attach gap.
 *
 * `fs.watch` gives no readiness guarantee (macOS FSEvents attaches its stream
 * asynchronously after watch() returns), and in production the sync starts via
 * deferred init AFTER the Next child is already serving — so variants can land
 * on disk with no watch event ever firing for them. The real-fs test in
 * image-cache-sync-watch.test.ts cannot force that gap deterministically
 * (FSEvents sometimes REPLAYS pre-attach writes), so here `watch` is mocked to
 * an inert watcher that never delivers an event: everything asserted below is
 * pushed by the post-attach reconcile alone, or it is not pushed at all.
 */

import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ImageVariantStore,
    watchAndPushImageCache,
} from "../adapters/image-cache-sync";

vi.mock("node:fs", async (importOriginal) => {
    const real = await importOriginal<typeof import("node:fs")>();
    return {
        ...real,
        // Inert watcher: registers fine, never delivers an event — a
        // deterministic stand-in for the FSEvents attach dead window.
        watch: () => {
            const watcher = new EventEmitter() as EventEmitter & {
                close: () => void;
            };
            watcher.close = () => {};
            return watcher;
        },
    };
});

// Imported AFTER the mock so `promises` is the real implementation (the mock
// spreads the real module and only replaces `watch`).
import { promises as fs } from "node:fs";

const SILENT = { info: () => {}, warn: () => {} };
/** Short probe deadline: the inert watcher can never confirm readiness. */
const FAST_PROBE = { watchReadyTimeoutMs: 100 };

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

/** Poll until predicate is true or the timeout elapses. */
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

describe("image-cache-sync — the attach gap, forced (watch never fires)", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imggap-"));
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("pushes a pre-attach variant via the reconcile even with zero watch events", async () => {
        const store = fakeStore();
        const variantDir = join(cacheDir, "gapkey");
        await fs.mkdir(variantDir, { recursive: true });
        await fs.writeFile(join(variantDir, "1.2.e.u.webp"), "GAP");

        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
            ...FAST_PROBE,
        });
        try {
            const pushed = await waitFor(() =>
                store.objects.has("image-cache/gapkey/1.2.e.u.webp"),
            );
            expect(pushed).toBe(true);
            expect(
                store.objects
                    .get("image-cache/gapkey/1.2.e.u.webp")
                    ?.toString(),
            ).toBe("GAP");
        } finally {
            handle.stop();
        }
    });

    it("reconcile pushes only variants missing from the store (no blanket re-upload)", async () => {
        // "fresh" is on disk but not in the store → pushed; "known" is already
        // stored byte-for-byte → NOT re-uploaded (a cold pod would otherwise
        // re-upload its whole restored cache on every start). Waiting for
        // "fresh" proves the reconcile flush ran, so the negative assertion on
        // "known" is ordering-deterministic, not a fixed window.
        const store = fakeStore({
            "image-cache/known/1.2.e.u.webp": Buffer.from("KNOWN"),
        });
        await fs.mkdir(join(cacheDir, "known"), { recursive: true });
        await fs.writeFile(join(cacheDir, "known", "1.2.e.u.webp"), "KNOWN");
        await fs.mkdir(join(cacheDir, "fresh"), { recursive: true });
        await fs.writeFile(join(cacheDir, "fresh", "1.2.e.u.webp"), "NEW");
        const upload = vi.spyOn(store, "upload");

        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
            ...FAST_PROBE,
        });
        try {
            const pushed = await waitFor(() =>
                store.objects.has("image-cache/fresh/1.2.e.u.webp"),
            );
            expect(pushed).toBe(true);
            const uploadedKeys = upload.mock.calls.map((call) => call[1]);
            expect(uploadedKeys).not.toContain(
                "image-cache/known/1.2.e.u.webp",
            );
        } finally {
            handle.stop();
        }
    });

    it("warns when the readiness probe cannot confirm event delivery", async () => {
        const warn = vi.fn();
        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store: fakeStore(),
            log: { info: () => {}, warn },
            ...FAST_PROBE,
        });
        handle.stop();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("readiness probe unconfirmed"),
        );
    });

    it("leaves no probe residue in the cache dir or the store", async () => {
        const store = fakeStore();
        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
            ...FAST_PROBE,
        });
        handle.stop();
        expect(await fs.readdir(cacheDir)).toEqual([]);
        expect(
            [...store.objects.keys()].filter((k) => k.includes("probe")),
        ).toEqual([]);
    });
});
