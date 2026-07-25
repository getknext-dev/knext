/**
 * image-cache-sync — the DEFAULT MinIO-backed store (defaultStore()). When no
 * store is injected, the module lazily builds an ImageVariantStore over
 * @getknext/lib/clients' getMinioClient() (listObjectsV2 stream → keys; fGetObject
 * → download; fPutObject → upload). These tests mock that client so the real
 * closures run without a live MinIO, covering restore/push through the default
 * store, plus the "client unavailable" degrade path.
 */

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable client double the mock resolves to; swapped per test.
const clientRef = vi.hoisted(() => ({ current: null as unknown }));
const getMinioClient = vi.hoisted(() => vi.fn(() => clientRef.current));
vi.mock("@getknext/lib/clients", () => ({ getMinioClient }));

import {
    restoreImageCache,
    watchAndPushImageCache,
} from "../adapters/image-cache-sync";

const SILENT = { info: () => {}, warn: () => {} };

let cacheDir: string;

beforeEach(async () => {
    cacheDir = await fs.mkdtemp(join(tmpdir(), "knext-imgds-"));
    getMinioClient.mockClear();
});

afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("image-cache-sync defaultStore (MinIO-backed)", () => {
    it("restores via listObjectsV2 stream + fGetObject when no store is injected", async () => {
        const stored: Record<string, string> = {
            "image-cache/k1/1.2.e.u.webp": "BYTES1",
        };
        clientRef.current = {
            listObjectsV2(_bucket: string, prefix: string) {
                const em = new EventEmitter();
                setImmediate(() => {
                    for (const name of Object.keys(stored)) {
                        if (name.startsWith(prefix)) em.emit("data", { name });
                    }
                    em.emit("end");
                });
                return em;
            },
            async fGetObject(_b: string, key: string, destPath: string) {
                await fs.mkdir(join(destPath, ".."), { recursive: true });
                await fs.writeFile(destPath, stored[key]);
            },
        };

        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            log: SILENT,
        });

        expect(restored).toBe(1);
        expect(getMinioClient).toHaveBeenCalled();
        expect(
            await fs.readFile(join(cacheDir, "k1", "1.2.e.u.webp"), "utf8"),
        ).toBe("BYTES1");
    });

    it("propagates a listObjectsV2 stream error to the best-effort restore (returns 0)", async () => {
        clientRef.current = {
            listObjectsV2() {
                const em = new EventEmitter();
                setImmediate(() => em.emit("error", new Error("stream boom")));
                return em;
            },
            fGetObject: vi.fn(),
        };
        await expect(
            restoreImageCache({ bucket: "b", cacheDir, log: SILENT }),
        ).resolves.toBe(0);
    });

    it("pushes via fPutObject through the default store on watch flush", async () => {
        const uploads: string[] = [];
        clientRef.current = {
            listObjectsV2() {
                const em = new EventEmitter();
                setImmediate(() => em.emit("end"));
                return em;
            },
            async fPutObject(_b: string, key: string, _src: string) {
                uploads.push(key);
            },
        };

        const handle = await watchAndPushImageCache({
            bucket: "b",
            cacheDir,
            log: SILENT,
        });
        try {
            const variantDir = join(cacheDir, "vk");
            await fs.mkdir(variantDir, { recursive: true });
            await fs.writeFile(join(variantDir, "a.avif"), "X");
            const start = Date.now();
            while (Date.now() - start < 4000 && uploads.length === 0) {
                await new Promise((r) => setTimeout(r, 25));
            }
            expect(uploads).toContain("image-cache/vk/a.avif");
        } finally {
            handle.stop();
        }
    });

    it("degrades to a no-op when the store client cannot be constructed", async () => {
        getMinioClient.mockImplementationOnce(() => {
            throw new Error("no minio credentials");
        });
        const warn = vi.fn();
        const restored = await restoreImageCache({
            bucket: "b",
            cacheDir,
            log: { info: () => {}, warn },
        });
        expect(restored).toBe(0);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("object store client unavailable"),
        );
    });
});
