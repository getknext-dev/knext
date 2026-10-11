/**
 * The published entry of a module with test seams carries every public export
 * and no seam (#936).
 *
 * `cache-handler.js` and `logger.ts` define `__`-prefixed test seams in the
 * module whose state they reset, so each is split in two: the implementation
 * (internal, and the test-only entry the suites import by path) and a thin
 * `*.public.*` file that tsup builds as the published entry. The thin file lists
 * its exports by name, because `export *` would carry the seams back out.
 *
 * A hand-maintained list can drift in either direction, so this compares the two
 * modules as they actually evaluate:
 *
 *   - a public export DROPPED from the thin file would silently shrink the
 *     published API (the dist scan cannot see that — a missing name is not a
 *     `__` name);
 *   - a seam ADDED to the thin file is the bug itself.
 *
 * `scripts/scan-published-seams.mjs` (tests/published-seam-export-scan.test.ts)
 * is the authority on what the BUILT package exports. This is the early signal
 * that needs no build.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = dirname(import.meta.dirname);

const isSeam = (name: string) => name.startsWith("__");

const exportsOf = (mod: object) => Object.keys(mod).sort();

describe("the published entries are the implementations minus their seams", () => {
    it("cache-handler: public === implementation without `__` names", async () => {
        const impl = await import("../adapters/cache-handler.js");
        const pub = await import("../adapters/cache-handler.public.js");
        const implNames = exportsOf(impl);

        // Anti-vacuity: with no seams on the implementation there is nothing to
        // have kept out, and the equality below would hold for any pub module.
        expect(implNames.filter(isSeam).length).toBeGreaterThanOrEqual(7);
        expect(exportsOf(pub).filter(isSeam)).toEqual([]);
        expect(exportsOf(pub)).toEqual(implNames.filter((n) => !isSeam(n)));
    });

    it("cache-handler: the published default IS the implementation's default", async () => {
        const impl = await import("../adapters/cache-handler.js");
        const pub = await import("../adapters/cache-handler.public.js");
        expect(pub.default).toBe(impl.default as unknown);
    });

    it("logger: public === implementation without `__` names", async () => {
        const impl = await import("../utils/logger");
        const pub = await import("../utils/logger.public");
        const implNames = exportsOf(impl);
        expect(implNames.filter(isSeam)).toContain("__resetLoggerForTests");
        expect(exportsOf(pub).filter(isSeam)).toEqual([]);
        expect(exportsOf(pub)).toEqual(implNames.filter((n) => !isSeam(n)));
    });
});

describe("no tsup entry points at a module that defines a seam", () => {
    // The entries are read out of the config, not listed: a new entry that points
    // at a seam-bearing implementation reds before any build exists.
    const config = readFileSync(join(SRC, "..", "tsup.config.ts"), "utf8");
    const entries = [...config.matchAll(/'([^']+)':\s*'(src\/[^']+)'/g)].map(
        (m) => ({ key: m[1] as string, file: m[2] as string }),
    );

    it("discovers the entries instead of trusting a list", () => {
        expect(entries.length).toBeGreaterThan(40);
        expect(entries.map((e) => e.key)).toContain("adapters/cache-handler");
        expect(entries.map((e) => e.key)).toContain("utils/logger");
    });

    it("the entry for each split module is its `.public` file", () => {
        const byKey = new Map(entries.map((e) => [e.key, e.file]));
        expect(byKey.get("adapters/cache-handler")).toBe(
            "src/adapters/cache-handler.public.js",
        );
        expect(byKey.get("utils/logger")).toBe("src/utils/logger.public.ts");
    });

    it("no entry file exports a `__` name directly", () => {
        const offenders: string[] = [];
        for (const { file } of entries) {
            const text = readFileSync(join(SRC, "..", file), "utf8");
            const direct =
                /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+__/;
            // `export { … __x … }` (a block may span lines; `as __x` counts too)
            const block = /\bexport\s*\{[^}]*\b__\w+/;
            if (direct.test(text) || block.test(text)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });
});
