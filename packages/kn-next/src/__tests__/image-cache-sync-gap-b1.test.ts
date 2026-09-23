/**
 * Coverage batch B1 (#1232) — genuine gaps in `image-cache-sync.ts` left
 * uncovered by the existing restore/watch/reconcile/defaultstore suites:
 *
 *  1. `watchAndPushImageCache` when the watch implementation itself throws
 *     synchronously on attach — must degrade to "restore-only mode" (a noop
 *     stop handle), not crash the caller.
 *  2. The reconcile phase's OWN store-list failure (distinct from restore's,
 *     already covered elsewhere): when `store.list` rejects during the
 *     post-attach reconcile, it must fall back to treating every local
 *     variant as unknown and push all of them (uploads are idempotent) rather
 *     than silently reconciling nothing.
 *  3. `defaultCacheDir()` — the `.next/cache/images` default used when no
 *     `cacheDir` is supplied. Every other test in the suite passes an
 *     explicit `cacheDir`, so this path (env-default resolution) was never
 *     exercised.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs, type watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ImageVariantStore,
    restoreImageCache,
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

describe("watchAndPushImageCache — watch attach failure", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgwatchfail-"));
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it("degrades to a noop stop handle when the watch implementation throws synchronously", async () => {
        const store = fakeStore();
        const throwingWatch = (() => {
            throw new Error("EMFILE: too many open files, watch");
        }) as unknown as typeof fsWatch;
        const warn = jest.fn();

        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: { info: () => {}, warn },
            watchImpl: throwingWatch,
        });

        // Must return a callable, side-effect-free stop — never throw, and
        // never leave a real watcher registered.
        expect(() => handle.stop()).not.toThrow();
        expect(
            warn.mock.calls.some((c) =>
                String(c[0]).includes("watch unavailable"),
            ),
        ).toBe(true);
    });
});

describe("watchAndPushImageCache — reconcile's own store-list failure", () => {
    let cacheDir: string;
    let watchBehavior: (
        listener: (event: string, filename: string | null) => void,
    ) => void;

    const scriptedWatch = ((
        _path: unknown,
        _opts: unknown,
        listener: (event: string, filename: string | null) => void,
    ) => {
        const watcher = new EventEmitter() as EventEmitter & {
            close: () => void;
        };
        watcher.close = () => {};
        watchBehavior(listener);
        return watcher;
    }) as unknown as typeof fsWatch;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgreconfail-"));
        watchBehavior = () => {};
    });

    afterEach(async () => {
        await fs.rm(cacheDir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it("falls back to pushing every local variant when store.list rejects during reconcile (no preListedKeys given)", async () => {
        // A variant already on disk before the watcher attaches — only the
        // reconcile pass (not the watcher) can discover and push it.
        const variantDir = join(cacheDir, "reconkey");
        await fs.mkdir(variantDir, { recursive: true });
        await fs.writeFile(join(variantDir, "1.2.e.u.webp"), "RECON");

        const store = fakeStore();
        spyOn(store, "list").mockRejectedValue(new Error("store unreachable"));
        const warn = jest.fn();

        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            store,
            log: { info: () => {}, warn },
            watchImpl: scriptedWatch,
            watchReadyTimeoutMs: 100,
            // Deliberately NOT setting preListedKeys — forces the reconcile
            // phase to call store.list() itself and hit the failure.
        });
        try {
            const pushed = await waitFor(() =>
                store.objects.has("image-cache/reconkey/1.2.e.u.webp"),
            );
            expect(pushed).toBe(true);
            expect(
                warn.mock.calls.some((c) =>
                    String(c[0]).includes("reconcile: store list failed"),
                ),
            ).toBe(true);
        } finally {
            handle.stop();
        }
    });
});

describe("defaultCacheDir() — the .next/cache/images default", () => {
    let tmpCwd: string;
    let originalCwd: string;

    beforeEach(async () => {
        originalCwd = process.cwd();
        tmpCwd = await fs.mkdtemp(join(tmpdir(), "knext-imgdefaultdir-"));
        process.chdir(tmpCwd);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(tmpCwd, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it("restoreImageCache resolves the cache dir to <cwd>/.next/cache/images when cacheDir is omitted", async () => {
        const store = fakeStore({
            "image-cache/k1/f.webp": Buffer.from("DEFAULTED"),
        });

        const restored = await restoreImageCache({
            bucket: "b",
            store,
            log: SILENT,
            // cacheDir intentionally omitted — exercises defaultCacheDir().
        });

        expect(restored).toBe(1);
        const expectedPath = join(
            tmpCwd,
            ".next",
            "cache",
            "images",
            "k1",
            "f.webp",
        );
        await expect(fs.readFile(expectedPath, "utf8")).resolves.toBe(
            "DEFAULTED",
        );
    });
});
