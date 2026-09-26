/**
 * #985 — a stranger who runs `knext create` then `npm install` (the exact
 * command the CLI's own output prescribes) must get a tree npm can actually
 * resolve against the PUBLIC registry.
 *
 * The scaffold-install nightly (run 34601538600) reproduced the break: phase 2
 * crashed with `npm error Cannot read properties of null (reading 'edgesOut')`.
 * That is not publish-lag — it is an @npmcli/arborist peer-set regression
 * present in npm <= 11.5.2 (as shipped on the CI runner), fixed in 11.6.1.
 *
 * MEASURED ROOT CAUSE (docker matrix, node:24, npm 11.5.2 vs 11.6.2): the
 * scaffold pinned `vitest@^4.0.18`, which resolves to 4.1.11. vitest 4.1.11's
 * OPTIONAL peers (`@vitest/ui`, `@vitest/browser`, `@vitest/coverage-*`) now
 * have a `@vitest/*@5.0.0` release that satisfies their peer ranges; the
 * newly-released 5.0.0 line peer-requires `vitest@5`, so arborist builds a
 * conflicting nested peer set and, on the buggy npm, dereferences a null node.
 * Aligning the scaffold to `vitest@^5` makes the @vitest ecosystem
 * self-consistent, so the peer set resolves and `npm install` completes on the
 * SAME npm that crashed on `^4`.
 *
 * This file is the PR-time FORM guard: the app scaffold must not pin vitest to
 * the major whose optional peers reproduce the crash. The run-time VALUE half
 * stays in `scripts/verify-scaffold-install.mjs` (phase 2, against the live
 * registry with the published CLI) — it can only go green after the next
 * publish ships this template, the same publish-lag division of labour the
 * script documents.
 *
 * Written RED-first: with the template still on `vitest@^4.0.18` the major
 * assertion below fails.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const APP_TEMPLATE = join(PKG_ROOT, "templates", "app", "package.json.hbs");

/** Lowest major that resolves cleanly on the affected npm (measured). */
const MIN_VITEST_MAJOR = 5;

/** Parse the leading major from a caret/tilde/plain semver range. */
function rangeMajor(range: string): number {
    const m = range.match(/(\d+)/);
    if (!m) throw new Error(`unparseable vitest range: ${range}`);
    return Number(m[1]);
}

describe("scaffold npm-install resolvability (#985)", () => {
    it("the app scaffold pins vitest at a major whose optional peers do not reproduce the arborist edgesOut crash", () => {
        const raw = readFileSync(APP_TEMPLATE, "utf8");
        const pkg = JSON.parse(raw) as {
            devDependencies?: Record<string, string>;
        };
        const vitest = pkg.devDependencies?.vitest;
        // Presence AND value: a template that dropped vitest would sail through
        // a pure range check but is still a regression of the check's premise.
        expect(
            vitest,
            "app scaffold must ship a vitest devDependency",
        ).toBeDefined();
        expect(
            rangeMajor(vitest as string),
            `vitest@${vitest} resolves to a 4.x whose @vitest/* optional peers pull in the 5.0.0 line and crash npm <=11.5.2 on 'edgesOut'; pin >=5`,
        ).toBeGreaterThanOrEqual(MIN_VITEST_MAJOR);
    });
});
