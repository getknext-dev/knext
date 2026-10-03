/**
 * #1834 — a scaffold template that sets `scaling.containerConcurrency` above
 * the value ADR-0044's request-body cap was sized for lets concurrent large
 * uploads buffer enough bytes to OOM-kill a 1Gi pod. `knext create`'s two app
 * templates and the in-repo zone scaffolder all set `containerConcurrency: 100`
 * — five times the operator's default of 20 (ADR-0028), which is the
 * concurrency the 8 MiB cap's own arithmetic assumes (`DEFAULT_MAX_REQUEST_BYTES`'s
 * doc comment in `runtime-contract.mjs.hbs`: "1Gi memory limit, containerConcurrency
 * 20, so 20 worst-case buffered bodies must stay far under the limit").
 *
 * This guard derives the safe ceiling from that doc comment rather than hardcoding
 * `20` a second time — so if the cap's sizing assumption ever changes, this test's
 * notion of "safe" moves with it instead of silently going stale.
 *
 * Scope: every template/generator file (`.hbs`, `.ts`, `.js`, `.mjs`, `.json`,
 * `.yaml`, `.yml`) under the scaffold template and generator directories — not
 * only `*.hbs`, since a generator can also emit the key as quoted JSON
 * (`"containerConcurrency": 100`) rather than a bare TS/JS object literal key.
 * A file added tomorrow in one of these directories must be caught too, so this
 * walks the whole subtree rather than enumerating paths.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/kn-next/src/__tests__ -> repo root
const REPO_ROOT = resolve(here, "../../../..");

const SKIP_DIRS = new Set([
    ".git",
    ".next",
    ".output",
    ".turbo",
    ".vercel",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "coverage-bun",
    ".claude",
    "graphify-out",
]);

/** The scaffold template and generator directories this guard is scoped to. */
const SCAN_DIRS = [
    join(REPO_ROOT, "packages", "kn-next", "templates"),
    join(REPO_ROOT, "packages", "kn-next", "src", "generators"),
    join(REPO_ROOT, "turbo", "generators"),
];

/** File extensions a scaffold template or generator can plausibly use. */
const SCAN_EXTENSIONS = new Set([
    ".hbs",
    ".ts",
    ".js",
    ".mjs",
    ".json",
    ".yaml",
    ".yml",
]);

/** Walk a directory tree and return every file matching `SCAN_EXTENSIONS`. */
function findScannableFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            findScannableFiles(p, out);
        } else if (SCAN_EXTENSIONS.has(extname(entry))) {
            out.push(p);
        }
    }
    return out;
}

/**
 * Extract every `containerConcurrency` value from a source string — the key
 * optionally single- or double-quoted (the TS/JS object-literal form and the
 * quoted-JSON form both appear across these directories), value unquoted
 * (valid in both TS/JS and JSON).
 */
function extractContainerConcurrencyValues(src: string): number[] {
    const matches = src.matchAll(/["']?containerConcurrency["']?\s*:\s*(\d+)/g);
    return [...matches].map((m) => Number(m[1]));
}

/**
 * Derive the safe `containerConcurrency` ceiling from the canonical
 * `runtime-contract.mjs.hbs`'s own documented arithmetic, rather than
 * hardcoding `20` here as a second, independently-driftable source of truth.
 */
function deriveSafeContainerConcurrency(): number {
    const runtimeContractPath = join(
        REPO_ROOT,
        "packages",
        "kn-next",
        "templates",
        "app",
        "runtime-contract.mjs.hbs",
    );
    const src = readFileSync(runtimeContractPath, "utf8");
    // Anchored on the DEFAULT_MAX_REQUEST_BYTES doc comment's own sentence:
    // "...containerConcurrency` 20, so 20 worst-case buffered bodies...".
    const match = src.match(
        /containerConcurrency`?\s+(\d+),\s*so\s+\1\s*(?:\n\s*\*\s*)?worst-case buffered bodies/,
    );
    if (!match) {
        throw new Error(
            "could not find the documented containerConcurrency sizing arithmetic " +
                `in ${runtimeContractPath} — update this guard's anchor regex alongside ` +
                "whatever changed the comment's wording.",
        );
    }
    return Number(match[1]);
}

describe("extractContainerConcurrencyValues", () => {
    it("matches the bare TS/JS object-literal key form", () => {
        expect(
            extractContainerConcurrencyValues("containerConcurrency: 100,"),
        ).toEqual([100]);
    });

    it("matches the double-quoted JSON key form", () => {
        expect(
            extractContainerConcurrencyValues('"containerConcurrency": 100,'),
        ).toEqual([100]);
    });

    it("matches the single-quoted key form", () => {
        expect(
            extractContainerConcurrencyValues("'containerConcurrency': 50,"),
        ).toEqual([50]);
    });

    it("matches multiple occurrences across a file", () => {
        expect(
            extractContainerConcurrencyValues(
                'containerConcurrency: 20,\n"containerConcurrency": 100,',
            ),
        ).toEqual([20, 100]);
    });

    it("finds nothing when the key is absent", () => {
        expect(extractContainerConcurrencyValues("maxScale: 10,")).toEqual([]);
    });
});

describe("scaffold templates never exceed the body cap's sized concurrency (#1834)", () => {
    it("derives a safe ceiling from runtime-contract.mjs.hbs's own sizing arithmetic", () => {
        const safe = deriveSafeContainerConcurrency();
        expect(safe).toBe(20);
    });

    it("no template/generator file sets containerConcurrency above that ceiling, in either key form", () => {
        const safe = deriveSafeContainerConcurrency();
        const files = SCAN_DIRS.flatMap((dir) => findScannableFiles(dir));
        expect(files.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, "utf8");
            for (const value of extractContainerConcurrencyValues(src)) {
                if (value > safe) {
                    offenders.push(
                        `${file} sets containerConcurrency: ${value} (max safe: ${safe})`,
                    );
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});
