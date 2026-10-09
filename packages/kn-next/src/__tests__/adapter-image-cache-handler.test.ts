/**
 * next-adapter.ts — routes Next's optimized-image cache through the knext
 * cache handler (write-free runtime).
 *
 * Next writes optimized `next/image` variants to `.next/cache/images` unless
 * `images.customCacheHandler: true` sends them through the app's
 * `cacheHandler` instead. That disk write is the last reason a
 * storage-configured standalone app needed a writable volume, so the adapter
 * turns the option on — but ONLY when the configured handler is knext's own
 * (which knows how to store an IMAGE entry's raw Buffer). A user-written
 * handler that JSON-serializes values would corrupt the bytes, so it is left
 * alone.
 *
 * `modifyConfig` receives the RESOLVED config (Next applies its defaults
 * first), so a Next that supports the option always carries
 * `images.customCacheHandler` as a boolean; its absence means this Next has
 * no such option and the adapter must not invent one. The fixtures below pass
 * `customCacheHandler: false` to stand in for that resolved default.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

const dir = mkdtempSync(join(tmpdir(), "knext-adapter-img-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const savedOptOut = process.env.KNEXT_IMAGE_CACHE_HANDLER;
afterEach(() => {
    if (savedOptOut === undefined) delete process.env.KNEXT_IMAGE_CACHE_HANDLER;
    else process.env.KNEXT_IMAGE_CACHE_HANDLER = savedOptOut;
});

function handlerFile(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
}

// The one-line re-export every knext scaffold generates (cache-handler.js.hbs).
const KNEXT_REEXPORT = handlerFile(
    "cache-handler.js",
    'export { default } from "@getknext/core/adapters/cache-handler";\n',
);
const USER_HANDLER = handlerFile(
    "my-cache-handler.js",
    "export default class MyHandler { async get() { return null; } async set() {} }\n",
);

// Next's resolved image defaults on a version that supports the option.
const RESOLVED_IMAGES = { customCacheHandler: false };

function run(config: Record<string, unknown>) {
    spyOn(console, "log").mockImplementation(() => {});
    return modifyConfig(
        config as Parameters<ModifyConfig>[0],
        {
            phase: "phase-production-build",
        } as Parameters<ModifyConfig>[1],
    ) as {
        images?: Record<string, unknown>;
    };
}

describe("adapter.modifyConfig — images.customCacheHandler", () => {
    it("turns it on for the knext cache handler and keeps the app's image settings", () => {
        const out = run({
            cacheHandler: KNEXT_REEXPORT,
            images: {
                ...RESOLVED_IMAGES,
                formats: ["image/avif", "image/webp"],
                remotePatterns: [],
            },
        });
        expect(out.images?.customCacheHandler).toBe(true);
        expect(out.images?.formats).toEqual(["image/avif", "image/webp"]);
        expect(out.images?.remotePatterns).toEqual([]);
    });

    it("recognises the handler module itself (a path inside @getknext/core)", () => {
        const pkgDir = join(
            dir,
            "node_modules",
            "@getknext",
            "core",
            "dist",
            "adapters",
        );
        mkdirSync(pkgDir, { recursive: true });
        const direct = join(pkgDir, "cache-handler.js");
        writeFileSync(direct, "export default class CacheHandler {}\n");
        expect(
            run({ cacheHandler: direct, images: { ...RESOLVED_IMAGES } }).images
                ?.customCacheHandler,
        ).toBe(true);
    });

    it("leaves a user-written cache handler alone", () => {
        const out = run({
            cacheHandler: USER_HANDLER,
            images: { ...RESOLVED_IMAGES },
        });
        expect(out.images?.customCacheHandler).toBe(false);
    });

    it("does nothing without a cache handler", () => {
        expect(
            run({ images: { ...RESOLVED_IMAGES } }).images?.customCacheHandler,
        ).toBe(false);
    });

    it("does not invent the option on a Next that has none", () => {
        const out = run({ cacheHandler: KNEXT_REEXPORT, images: {} });
        expect(out.images).not.toHaveProperty("customCacheHandler");
    });

    it("KNEXT_IMAGE_CACHE_HANDLER=0 keeps Next's disk cache", () => {
        process.env.KNEXT_IMAGE_CACHE_HANDLER = "0";
        const out = run({
            cacheHandler: KNEXT_REEXPORT,
            images: { ...RESOLVED_IMAGES },
        });
        expect(out.images?.customCacheHandler).toBe(false);
    });

    it("does not fail the build when the handler path cannot be read", () => {
        const out = run({
            cacheHandler: join(dir, "missing.js"),
            images: { ...RESOLVED_IMAGES },
        });
        expect(out.images?.customCacheHandler).toBe(false);
    });
});
