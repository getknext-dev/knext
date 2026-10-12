/**
 * The request-tag seam (ADR-0068 D5.1, ADR-0027): the interface the cache handler
 * records an entry's tags through, anchored on `globalThis` so Next's duplicated
 * modules (the #352 class) all see one store.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { edge, edgeModulePath, loadEdge, requireCjs } from "./cdn-edge-untyped";

const KEY = Symbol.for("knext.core.cdn.requestTags");

interface Store {
    own: string[];
    fetch: string[];
}
const store = (): Store => ({ own: [], fetch: [] });

describe("the request-tag seam", () => {
    it("is anchored on globalThis under the namespaced Symbol.for key", () => {
        const seam = edge.ensureSeam();
        expect((globalThis as Record<symbol, unknown>)[KEY]).toBe(seam);
    });

    it("survives a duplicated module instance (Next duplicates modules across webpack layers)", () => {
        const first = edge.ensureSeam();
        const path = edgeModulePath();
        const cached = requireCjs.cache[path];
        delete requireCjs.cache[path];
        try {
            const second = loadEdge();
            expect(second).not.toBe(edge);
            expect(second.ensureSeam()).toBe(first);
        } finally {
            if (cached) requireCjs.cache[path] = cached;
        }
    });

    it("records own-entry and fetch tags into the current request store only", () => {
        const seam = edge.ensureSeam();
        expect(seam.record({ kind: "page", tags: ["_N_T_/a"] })).toBe(false); // no request
        const s = store();
        seam.als.run(s, () => {
            expect(seam.record({ kind: "page", tags: ["_N_T_/a", "x"] })).toBe(
                true,
            );
            expect(seam.record({ kind: "route", tags: ["_N_T_/api/r"] })).toBe(
                true,
            );
            expect(seam.record({ kind: "fetch", tags: ["data"] })).toBe(true);
            expect(seam.record({ kind: "other", tags: ["z"] })).toBe(false);
            expect(seam.record({ kind: "page", tags: "nope" })).toBe(false);
            expect(seam.record(undefined)).toBe(false);
        });
        expect(s.own).toEqual(["_N_T_/a", "x", "_N_T_/api/r"]);
        expect(s.fetch).toEqual(["data"]);
    });

    it("keeps concurrent stores apart across an async hop", async () => {
        const seam = edge.ensureSeam();
        const a = store();
        const b = store();
        await Promise.all([
            seam.als.run(a, async () => {
                await new Promise((r) => setTimeout(r, 10));
                seam.record({ kind: "page", tags: ["_N_T_/a"] });
            }),
            seam.als.run(b, async () => {
                seam.record({ kind: "page", tags: ["_N_T_/b"] });
                await new Promise((r) => setTimeout(r, 20));
            }),
        ]);
        expect(a.own).toEqual(["_N_T_/a"]);
        expect(b.own).toEqual(["_N_T_/b"]);
    });

    it("bounds what one request can accumulate", () => {
        const seam = edge.ensureSeam();
        const s = store();
        seam.als.run(s, () => {
            seam.record({
                kind: "fetch",
                tags: Array.from({ length: 10000 }, (_, i) => `t${i}`),
            });
        });
        expect(s.fetch.length).toBe(4096);
    });

    it("module state is never a bare module-level let/var (the #352 class)", () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(
            join(here, "..", "adapters", "cdn-edge.cjs"),
            "utf8",
        );
        expect(src.split("\n").filter((l) => /^(let|var)\s/.test(l))).toEqual(
            [],
        );
    });
});

describe("the preload set (D11)", () => {
    it("the compiled executable bakes in the preload that carries the CDN tier", () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const compile = readFileSync(
            join(here, "..", "adapters", "standalone-compile.mjs"),
            "utf8",
        );
        const block =
            /const PRELOAD_NAMES = \[([\s\S]*?)\];/.exec(compile)?.[1] ?? "";
        expect(block).toContain('"cache-control-normalize.cjs"');
        const preload = readFileSync(
            join(here, "..", "adapters", "cache-control-normalize.cjs"),
            "utf8",
        );
        expect(preload).toContain("require('./cdn-edge.cjs')");
    });
});
