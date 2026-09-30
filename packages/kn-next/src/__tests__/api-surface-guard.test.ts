/**
 * #1669 — public API type-surface guard for the publishable @getknext/*
 * packages (core, lib, db).
 *
 * `public-api-surface.test.ts` (PK5/#286) proves WHICH subpaths are public.
 * It does not look inside a subpath, so renaming an export or narrowing a
 * type within an already-public subpath passed CI untouched. This test
 * closes that gap: it regenerates each package's type-surface report (via
 * the TypeScript compiler API's single-file `.d.ts` emit — no new
 * dependency, `typescript` is already a root devDependency, no network) and
 * asserts it matches the checked-in baseline in `api-surface/*.d.ts.report`.
 *
 * A rename, a removal, or a narrowed parameter/property type changes what
 * `generatePackageReport` emits, so it changes this diff and reds this test
 * — an addition also changes the diff, and the fix is the same either way:
 * review it, then `node scripts/api-surface/generate.mjs` and commit the
 * updated report (the same "generated artifact is part of the reviewed PR
 * diff" discipline `public-api-surface.test.ts` already uses for the subpath
 * contract).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
    generatePackageReport,
    PACKAGES,
    reportPath,
} from "../../../../scripts/api-surface/lib.mjs";

describe("#1669: public API type-surface reports match source", () => {
    for (const pkg of PACKAGES) {
        it(`${pkg.name}: checked-in report is not stale`, () => {
            const baselinePath = reportPath(pkg);
            expect(
                existsSync(baselinePath),
                `missing baseline report for ${pkg.name} at ${baselinePath} — run node scripts/api-surface/generate.mjs`,
            ).toBe(true);
            const baseline = readFileSync(baselinePath, "utf8");
            const current = generatePackageReport(pkg);
            expect(
                current,
                `${pkg.name} public API type surface changed — if intentional, ` +
                    "run node scripts/api-surface/generate.mjs and commit the updated report",
            ).toBe(baseline);
        });
    }

    it("covers exactly the three publishable packages", () => {
        expect(PACKAGES.map((p) => p.name).sort()).toEqual([
            "@getknext/core",
            "@getknext/db",
            "@getknext/lib",
        ]);
    });
});
