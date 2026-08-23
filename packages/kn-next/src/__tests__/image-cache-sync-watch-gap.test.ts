/**
 * image-cache-sync — DETERMINISTIC coverage for the #805 attach gap.
 *
 * `fs.watch` gives no readiness guarantee (macOS FSEvents attaches its stream
 * asynchronously after watch() returns), and in production the sync starts via
 * deferred init AFTER the Next child is already serving — so variants can land
 * on disk with no watch event ever firing for them. The real-fs tests cannot
 * force that gap deterministically (FSEvents sometimes REPLAYS pre-attach
 * writes), so these tests inject a scripted watcher via the internal
 * `watchImpl` option: by default it never delivers an event, so everything
 * asserted below is pushed by the post-attach reconcile alone — or not at all.
 *
 * Injection, not vi.mock("node:fs"): a factory mock of node:fs is
 * config-dependent — under the ROOT vitest config (which CI's
 * `vitest run --coverage` and `vitest list` use) `importOriginal` returns an
 * empty module, so a partial mock cannot be built there at all. This broke CI
 * on PR #837 while passing under the package-level config locally.
 */

import { EventEmitter } from "node:events";
import { promises as fs, type watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ImageVariantStore,
    watchAndPushImageCache,
} from "../adapters/image-cache-sync";

type WatchListener = (event: string, filename: string | null) => void;

/**
 * Per-test watch behavior, given the impl's listener. Default: inert — the
 * watcher registers fine but never delivers an event, a deterministic stand-in
 * for the FSEvents attach dead window. Tests may replace it to script delivery
 * timing (reset in beforeEach).
 */
let watchBehavior: (listener: WatchListener) => void = () => {};

const scriptedWatch = ((
    _path: unknown,
    _opts: unknown,
    listener: WatchListener,
) => {
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => {};
    watchBehavior(listener);
    return watcher;
}) as unknown as typeof fsWatch;

const SILENT = { info: () => {}, warn: () => {} };
/** Scripted watcher + short probe deadline (inert default can never confirm). */
const GAP_WATCH = { watchImpl: scriptedWatch, watchReadyTimeoutMs: 100 };

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
        watchBehavior = () => {};
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
            ...GAP_WATCH,
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
            ...GAP_WATCH,
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
            ...GAP_WATCH,
        });
        handle.stop();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("readiness probe unconfirmed"),
        );
    });

    it("does not resolve until the watcher has demonstrably delivered an event (readiness ordering)", async () => {
        // The probe is the half of the #805 fix aimed at the attach race:
        // watchAndPushImageCache must keep waiting until its own watch
        // callback has observed an event. Script the watcher to deliver the
        // first event only after a delay; if the impl did not genuinely wait
        // (e.g. an inert probe loop), it would resolve immediately — before
        // the scripted delivery — leaving deliveredAt at 0. Ordering
        // assertion, not a log-line or elapsed-window assertion.
        const EVENT_DELAY_MS = 250;
        let deliveredAt = 0;
        watchBehavior = (listener) => {
            setTimeout(() => {
                deliveredAt = Date.now();
                listener("rename", ".knext-watch-probe/t");
            }, EVENT_DELAY_MS);
        };
        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store: fakeStore(),
            log: SILENT,
            watchImpl: scriptedWatch,
            watchReadyTimeoutMs: 4000,
        });
        const resolvedAt = Date.now();
        handle.stop();
        expect(deliveredAt).toBeGreaterThan(0);
        expect(resolvedAt).toBeGreaterThanOrEqual(deliveredAt);
    });

    it("leaves no probe residue in the cache dir or the store", async () => {
        const store = fakeStore();
        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: SILENT,
            ...GAP_WATCH,
        });
        handle.stop();
        expect(await fs.readdir(cacheDir)).toEqual([]);
        expect(
            [...store.objects.keys()].filter((k) => k.includes("probe")),
        ).toEqual([]);
    });
});
