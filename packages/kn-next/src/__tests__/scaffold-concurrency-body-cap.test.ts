/**
 * #1834 — a scaffold template that sets `scaling.containerConcurrency` above
 * the value ADR-0044's request-body cap was sized for lets concurrent large
 * uploads buffer enough bytes to OOM-kill a 1Gi pod. `knext create`'s two app
 * templates and the in-repo zone scaffolder all set `containerConcurrency: 100`
 * — four to five times the operator's default of 20 (ADR-0028), which is the
 * concurrency the 8 MiB cap's own arithmetic assumes (`DEFAULT_MAX_REQUEST_BYTES`'s
 * doc comment in `runtime-contract.mjs.hbs`: "1Gi memory limit, containerConcurrency
 * 20, so 20 worst-case buffered bodies must stay far under the limit").
 *
 * This guard derives the safe ceiling from that doc comment rather than hardcoding
 * `20` a second time — so if the cap's sizing assumption ever changes, this test's
 * notion of "safe" moves with it instead of silently going stale.
 *
 * Scope: every Handlebars scaffold template under `packages/kn-next/templates/`
 * and `turbo/generators/templates/` that emits a `scaling:` block. A template
 * added tomorrow in a directory nobody has thought of must be caught too, so
 * this scans the whole tree for `*.hbs` files rather than enumerating paths.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Walk the whole repo tree and return every `.hbs` file's absolute path. */
function findHbsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            findHbsFiles(p, out);
        } else if (entry.endsWith(".hbs")) {
            out.push(p);
        }
    }
    return out;
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

describe("scaffold templates never exceed the body cap's sized concurrency (#1834)", () => {
    it("derives a safe ceiling from runtime-contract.mjs.hbs's own sizing arithmetic", () => {
        const safe = deriveSafeContainerConcurrency();
        expect(safe).toBe(20);
    });

    it("no *.hbs scaffold template sets scaling.containerConcurrency above that ceiling", () => {
        const safe = deriveSafeContainerConcurrency();
        const hbsFiles = findHbsFiles(REPO_ROOT);
        expect(hbsFiles.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of hbsFiles) {
            const src = readFileSync(file, "utf8");
            const matches = src.matchAll(/containerConcurrency\s*:\s*(\d+)/g);
            for (const m of matches) {
                const value = Number(m[1]);
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
