/**
 * The runtime-agnostic deployed Cache-Control rule at the Response level, and
 * its srvx middleware for vinext on Node (`build: 'vinext'`, `runtime: 'node'`).
 *
 * WHY a middleware and not the `node:http` preload: nitro's node preset serves
 * through srvx/node, which writes response headers with
 * `res.writeHead(status, statusText, rawHeaders)` where `rawHeaders` is a FLAT
 * ARRAY (`[name, value, …]`). The preload (`cache-control-normalize.cjs`)
 * rewrites `setHeader` and object-form `writeHead` only, so on this path it
 * would leave the origin `s-maxage=…` untouched. The middleware applies the same
 * pure rule to the `Response` before srvx writes it, which is the same seam the
 * compiled executable uses at `Bun.serve`.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as bunServe from "../adapters/bun-serve-cache-control.mjs";
import {
    applyVinextDeployDefault,
    cacheControlMiddleware,
    normalizeResponse,
} from "../adapters/response-cache-control.mjs";

const DEPLOY = "public, max-age=0, must-revalidate";
const ISR = "s-maxage=2, stale-while-revalidate=31535998";

const req = (path = "/isr", method = "GET") =>
    new Request(`http://127.0.0.1:3000${path}`, { method });
const res = (headers: Record<string, string>) =>
    new Response("ok", { headers });

describe("cacheControlMiddleware: the srvx middleware for vinext on Node", () => {
    it("rewrites the origin ISR value on the response next() returns", async () => {
        const mw = cacheControlMiddleware({});
        const out = await mw(req(), async () => res({ "cache-control": ISR }));
        expect(out.headers.get("cache-control")).toBe(DEPLOY);
    });

    it("leaves the origin value when KNEXT_CACHE_CONTROL_NORMALIZE=0", async () => {
        const mw = cacheControlMiddleware({
            KNEXT_CACHE_CONTROL_NORMALIZE: "0",
        });
        const out = await mw(req(), async () => res({ "cache-control": ISR }));
        expect(out.headers.get("cache-control")).toBe(ISR);
    });

    it("applies the request-aware rule (never on /_next/data, never on non-GET/HEAD)", async () => {
        const mw = cacheControlMiddleware({});
        const shell = "private, no-cache, no-store, max-age=0, must-revalidate";
        const data = await mw(req("/_next/data/b/x.json"), async () =>
            res({ "cache-control": shell, "x-nextjs-cache": "MISS" }),
        );
        expect(data.headers.get("cache-control")).toBe(shell);
        const post = await mw(req("/isr", "POST"), async () =>
            res({ "cache-control": ISR }),
        );
        expect(post.headers.get("cache-control")).toBe(ISR);
    });

    it("passes a response without Cache-Control through untouched", async () => {
        const mw = cacheControlMiddleware({});
        const out = await mw(req(), async () =>
            res({ "content-type": "text/plain" }),
        );
        expect(out.headers.get("cache-control")).toBeNull();
    });

    it("never swallows a throw from next()", async () => {
        const mw = cacheControlMiddleware({});
        await expect(
            mw(req(), async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
    });
});

describe("the built dist resolves the rule from wherever tsup put the importer", () => {
    // Measured trap: when two ESM entries share this code, tsup hoists it into
    // a `dist/chunk-*.js` at the dist ROOT, where the relative
    // `./cache-control-normalize.cjs` import no longer resolves. Both the
    // srvx middleware and the compiled executable's installer then fail to
    // load under Node (ERR_MODULE_NOT_FOUND). SCANNED over every built file,
    // not an enumerated pair, so a future shared chunk is caught too.
    const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
    const SPEC =
        /from\s+["'](\.{1,2}\/[^"']*cache-control-normalize\.cjs)["']/g;

    it("every built import of cache-control-normalize.cjs points at a file that exists", () => {
        expect(existsSync(DIST), "build @getknext/core before this suite").toBe(
            true,
        );
        const importers: string[] = [];
        const broken: string[] = [];
        for (const rel of readdirSync(DIST, { recursive: true }).map(String)) {
            if (!rel.endsWith(".js")) continue;
            const file = join(DIST, rel);
            for (const [, spec] of readFileSync(file, "utf8").matchAll(SPEC)) {
                importers.push(rel);
                if (!existsSync(resolve(dirname(file), spec)))
                    broken.push(`${rel} → ${spec}`);
            }
        }
        expect(importers).toContain(
            join("adapters", "response-cache-control.js"),
        );
        expect(importers).toContain(
            join("adapters", "bun-serve-cache-control-install.js"),
        );
        expect(broken).toEqual([]);
    });

    it("both entries import under plain Node", () => {
        for (const rel of [
            "response-cache-control.js",
            "bun-serve-cache-control-install.js",
        ]) {
            const r = spawnSync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    `await import(${JSON.stringify(join(DIST, "adapters", rel))});`,
                ],
                {
                    encoding: "utf8",
                    env: { ...process.env, KNEXT_CACHE_CONTROL_NORMALIZE: "0" },
                },
            );
            expect(r.status, `${rel}: ${r.stderr}`).toBe(0);
        }
    });
});

describe("one rule, two seams", () => {
    it("the Bun.serve module re-exports the same functions, not copies", () => {
        expect(bunServe.normalizeResponse).toBe(normalizeResponse);
        expect(bunServe.applyVinextDeployDefault).toBe(
            applyVinextDeployDefault,
        );
    });
});
