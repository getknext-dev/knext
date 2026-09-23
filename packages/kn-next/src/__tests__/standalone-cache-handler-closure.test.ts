/**
 * The compiled standalone-on-Bun cell keeps every module that disk-loaded code
 * can reach OUT of the bytecode bundle, so disk code and the bundled server
 * core share ONE instance of it (standalone-compile.mjs, "the disk closure").
 *
 * A custom `cacheHandler` is disk-loaded code too: Next loads it at runtime by
 * computed path (`formatDynamicImportPath(distDir, cacheHandler)`), from outside
 * `.next/server`. A handler that imports a Next internal the route chunks never
 * reference would otherwise get a SECOND instance of it — the compile bundles
 * the core's copy. So the compile scans each configured handler as an extra
 * root, and these are the paths it scans: every handler Next can load, resolved
 * exactly as Next resolves them.
 *
 * The docker e2e (standalone-pages.docker-e2e.test.ts) proves the behaviour on
 * a real app; this pins the resolution rules.
 */

import { describe, expect, it } from "bun:test";
import { standaloneCacheHandlerFiles } from "../adapters/standalone-exec-entry.mjs";

const SERVER_DIR = "/srv/app/.next/standalone";

/** A `server.js` shaped like `next build` 16.3.3 emits it, with `config` inlined. */
function serverWith(config: Record<string, unknown>): string {
    return [
        "const path = require('path')",
        "",
        "const dir = path.join(__dirname)",
        "",
        "process.env.NODE_ENV = 'production'",
        "process.chdir(__dirname)",
        "",
        "const currentPort = parseInt(process.env.PORT, 10) || 3000",
        `const nextConfig = ${JSON.stringify(config)}`,
        "",
        "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)",
        "",
        "require('next')",
    ].join("\n");
}

describe("standaloneCacheHandlerFiles — the handlers Next loads by computed path", () => {
    it("returns nothing when no handler is configured", () => {
        expect(
            standaloneCacheHandlerFiles(
                serverWith({ distDir: "./.next", cacheHandlers: {} }),
                SERVER_DIR,
            ),
        ).toEqual([]);
    });

    it("resolves a relative `cacheHandler` against distDir, as Next does (the traced `../cache-handler.js`)", () => {
        expect(
            standaloneCacheHandlerFiles(
                serverWith({
                    distDir: "./.next",
                    cacheHandler: "../cache-handler.js",
                }),
                SERVER_DIR,
            ),
        ).toEqual(["/srv/app/.next/standalone/cache-handler.js"]);
    });

    it("honours a non-default distDir", () => {
        expect(
            standaloneCacheHandlerFiles(
                serverWith({ distDir: "build", cacheHandler: "../h.js" }),
                SERVER_DIR,
            ),
        ).toEqual(["/srv/app/.next/standalone/h.js"]);
    });

    it("keeps an absolute path, and converts a file:// URL to one", () => {
        expect(
            standaloneCacheHandlerFiles(
                serverWith({
                    distDir: "./.next",
                    cacheHandler: "/opt/handler.js",
                    cacheHandlers: { remote: "file:///opt/remote.mjs" },
                }),
                SERVER_DIR,
            ),
        ).toEqual(["/opt/handler.js", "/opt/remote.mjs"]);
    });

    it("includes every `cacheHandlers` entry ('use cache' handlers) and the legacy experimental.incrementalCacheHandlerPath, deduplicated", () => {
        expect(
            standaloneCacheHandlerFiles(
                serverWith({
                    distDir: "./.next",
                    cacheHandler: "../isr.js",
                    cacheHandlers: {
                        default: "../use-cache.js",
                        remote: "../isr.js",
                    },
                    experimental: {
                        incrementalCacheHandlerPath: "../legacy.js",
                    },
                }),
                SERVER_DIR,
            ),
        ).toEqual([
            "/srv/app/.next/standalone/isr.js",
            "/srv/app/.next/standalone/use-cache.js",
            "/srv/app/.next/standalone/legacy.js",
        ]);
    });

    it("fails closed on a server.js with no inlined nextConfig — never guesses that no handler exists", () => {
        expect(() =>
            standaloneCacheHandlerFiles("require('next')\n", SERVER_DIR),
        ).toThrow(/nextConfig/);
    });
});
