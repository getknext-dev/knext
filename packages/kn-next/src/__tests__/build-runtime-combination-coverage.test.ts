/**
 * Track B4 — every build×runtime combination is either covered or honestly
 * declared uncovered.
 *
 * The plan's exit criterion is "no combination claimed green without a
 * red-on-fail check". This file enforces it the only way that survives someone
 * adding a builder later: it ENUMERATES the combinations from the contract
 * rather than from a hand-written list, and requires each one to carry a
 * disposition. A new builder or runtime therefore fails here on the commit that
 * introduces it, instead of silently inheriting a "covered" claim nobody made.
 *
 * `CLAUDE.md` is explicit about why this matters: capability rows that skipped
 * rather than failed were treated as verified for months. And `workflow.md`
 * says a bounded coverage decision must be logged rather than left implicit —
 * "silent truncation reads as 'covered everything' when it didn't".
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    BUILDERS,
    type BuilderId,
    isCompatible,
    RUNTIMES,
    type RuntimeId,
} from "../adapters/artifact-contract";

type Disposition =
    /** A red-on-fail check exercises this combination today. */
    | { state: "covered"; evidence: string }
    /**
     * Deliberately not covered, with the reason. Permitted ONLY for
     * combinations whose builder this release cannot run — an available
     * combination must be covered or the suite fails.
     */
    | { state: "not-buildable"; why: string };

const REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../..",
);

const key = (b: BuilderId, r: RuntimeId) => `${b}+${r}`;

/**
 * The dispositions. Adding a builder/runtime without adding its row here is a
 * FAILURE, which is the point — the registry cannot silently lag the contract.
 */
const DISPOSITIONS: Record<string, Disposition> = {
    "turbopack+node": {
        state: "not-buildable",
        why:
            "retired by ADR-0048. `kn-next build` no longer targets turbopack and the scaffolded image " +
            "ships a compiled binary, so this combination is not producible.",
    },
    "turbopack+bun": {
        state: "not-buildable",
        why:
            "retired by ADR-0048 along with turbopack itself. Bun 1.3.5 could not serve this tree at all " +
            "(HTTP 500), and 1.4 serving it is moot now the target is retired.",
    },
    "vinext+bun": {
        state: "covered",
        evidence:
            "the ONLY supported target (ADR-0048). vinext-build.test.ts asserts the compile flags and the " +
            "Bun 1.4.0 floor; artifact-contract-reality.test.ts binds the descriptor to the real built " +
            "artifact in examples/bun-exec",
    },
};

/** Every combination the contract admits, derived — never restated. */
function admissibleCombinations(): Array<{
    builderId: BuilderId;
    runtimeId: RuntimeId;
    available: boolean;
}> {
    const out = [];
    for (const builder of BUILDERS) {
        const artifact = builder.describeArtifact("/app");
        for (const runtime of RUNTIMES) {
            if (!isCompatible(runtime, artifact)) continue;
            out.push({
                builderId: builder.id,
                runtimeId: runtime.id,
                available: builder.available,
            });
        }
    }
    return out;
}

describe("#B4 build×runtime combination coverage", () => {
    const combos = admissibleCombinations();

    it("the enumeration is not vacuous", () => {
        // Without this, every assertion below would pass on an empty list —
        // the "guard that stays green when its subject is removed" failure.
        // THREE, not four. `vinext+node` is not admissible: node cannot execute
        // a bun-preset nitro output — measured, `node .output/server/index.mjs`
        // exits 1 with `ReferenceError: Bun is not defined`. A design gate found
        // that the contract claimed otherwise, on ADR-0036 prose rather than on
        // evidence. This number moves only when a shape/runtime pair really does.
        expect(combos.length).toBeGreaterThanOrEqual(3);
    });

    it.each(
        combos.map((c) => [key(c.builderId, c.runtimeId), c] as const),
    )("%s has a declared disposition", (k) => {
        expect(
            DISPOSITIONS[k],
            `${k} is admissible but has no disposition — add one rather than letting it inherit a coverage claim nobody made`,
        ).toBeDefined();
    });

    it("every AVAILABLE combination is covered, with named evidence", () => {
        for (const c of combos.filter((x) => x.available)) {
            const d = DISPOSITIONS[key(c.builderId, c.runtimeId)];
            expect(
                d?.state,
                `${key(c.builderId, c.runtimeId)} is buildable today, so 'not-buildable' is not an honest disposition for it`,
            ).toBe("covered");
        }
    });

    it("EVERY covered row cites a file that exists — available or not", () => {
        // Deliberately NOT inside the `.filter(x => x.available)` loop above.
        //
        // Round 1 of the design gate defeated a `length > 20` evidence check by
        // relabelling a row `not-buildable → covered` with its prose unchanged.
        // Round 2 defeated the FIX: the cited-file assertion was correct but
        // lived inside the availability loop, so it only ran on rows that were
        // already genuinely covered. The row where a fabricated claim actually
        // matters — an UNAVAILABLE builder — never reached it, and the same
        // relabel passed at exit 0 a second time.
        //
        // The lesson is the placement, not the assertion: a check that runs
        // only where the defect cannot occur is decoration. So this iterates
        // the dispositions themselves.
        for (const [k, d] of Object.entries(DISPOSITIONS)) {
            if (d.state !== "covered") continue;
            const cited = d.evidence.match(
                /[A-Za-z0-9_\-/.]+\.(?:test\.ts|mjs)/g,
            );
            expect(
                cited,
                `${k} claims coverage but cites no file — evidence must name the check, not describe it`,
            ).not.toBeNull();
            for (const cite of cited ?? []) {
                const candidates = [
                    join(REPO_ROOT, cite),
                    join(REPO_ROOT, "packages/kn-next/src/__tests__", cite),
                ];
                expect(
                    candidates.some((p) => existsSync(p)),
                    `${k} cites '${cite}', which does not exist`,
                ).toBe(true);
            }
        }
    });

    it("'not-buildable' is only claimed for builders this release cannot run", () => {
        // The inverse half. Without it, someone could silence a real coverage
        // gap by relabelling a working combination as not-buildable.
        for (const [k, d] of Object.entries(DISPOSITIONS)) {
            if (d.state !== "not-buildable") continue;
            const builderId = k.split("+")[0] as BuilderId;
            const builder = BUILDERS.find((b) => b.id === builderId);
            expect(
                builder?.available,
                `${k} is declared not-buildable, but builder '${builderId}' is available`,
            ).toBe(false);
        }
    });

    it("has no disposition for a combination the contract does not admit", () => {
        // Stale rows are as misleading as missing ones: a disposition for a
        // combination nobody can express reads as coverage of something real.
        const admissible = new Set(
            combos.map((c) => key(c.builderId, c.runtimeId)),
        );
        for (const k of Object.keys(DISPOSITIONS)) {
            expect(
                admissible.has(k),
                `${k} has a disposition but is not an admissible combination`,
            ).toBe(true);
        }
    });
});
