/**
 * vinext × node image recipe (#1260) — the fast, static half of the proof.
 *
 * The real proof is `vinext-node-image.docker-e2e.test.ts`, which builds the
 * image and watches V8 ACCEPT the baked code cache on boot. That suite needs
 * docker and minutes; this one pins, in milliseconds, the two ordering facts a
 * Dockerfile edit can silently break:
 *
 *   1. The compile cache is baked AS THE RUNTIME USER. Node keys the cache
 *      subdirectory by uid (`v<ver>-<arch>-<hash>-<uid>`, measured), so a bake
 *      that runs as root writes a directory the non-root runtime never reads —
 *      a populated-looking cache with a 0% hit rate, the ADR-0035 placebo again.
 *   2. The bake is followed by an assertion that FAILS THE BUILD on an empty or
 *      undersized cache, rather than shipping one.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(__dirname, "..", "..");
const RECIPE = readFileSync(
    join(PKG_ROOT, "templates", "app", "Dockerfile.vinext-node.hbs"),
    "utf8",
);
/** Instruction lines only — comments cannot satisfy an ordering assertion. */
const LINES = RECIPE.split("\n").filter(
    (l) => l.trim() !== "" && !l.trim().startsWith("#"),
);

function lineIndex(pred: (l: string) => boolean, what: string): number {
    const hits = LINES.map((l, i) => (pred(l) ? i : -1)).filter((i) => i >= 0);
    expect(hits.length, `expected exactly one ${what} line`).toBe(1);
    return hits[0];
}

describe("Dockerfile.vinext-node — the baked V8 compile cache (#1260, ADR-0035)", () => {
    it("is literal — staged verbatim, so a placeholder would ship raw", () => {
        expect(RECIPE).not.toContain("{{");
    });

    it("pins the node base by digest (security.md)", () => {
        expect(RECIPE).toMatch(/^FROM node:22-alpine@sha256:[0-9a-f]{64}/m);
    });

    it("points NODE_COMPILE_CACHE at the baked directory", () => {
        expect(RECIPE).toMatch(/NODE_COMPILE_CACHE=\/app\/\.compile-cache/);
    });

    it("bakes AFTER switching to the runtime uid — a root bake is a guaranteed miss", () => {
        const user = lineIndex(
            (l) => /^USER 65532(:65532)?\s*$/.test(l.trim()),
            "USER 65532",
        );
        const bake = lineIndex(
            (l) => l.includes("KNEXT_COMPILE_CACHE_BAKE=1"),
            "bake RUN",
        );
        expect(bake).toBeGreaterThan(user);
    });

    it("fails the build on an undersized cache, AFTER the bake", () => {
        const bake = lineIndex(
            (l) => l.includes("KNEXT_COMPILE_CACHE_BAKE=1"),
            "bake RUN",
        );
        const floor = lineIndex(
            (l) => l.includes("below the floor"),
            "cache-floor failure",
        );
        expect(floor).toBeGreaterThan(bake);
        // The floor is a real byte count, not "non-empty": a truncated flush
        // passes a `>= 1 file` check (ADR-0035).
        expect(RECIPE).toMatch(/ARG KNEXT_COMPILE_CACHE_MIN_BYTES=\d{5,}/);
    });

    it("runs the node-preset entry directly — no supervisor, no shell", () => {
        expect(LINES.at(-1)).toBe(
            'CMD ["node", "/app/.output/server/index.mjs"]',
        );
    });
});
