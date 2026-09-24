/**
 * `packageRoot()`'s last-resort throw (`src/cli/create.ts:79-83`) — reached
 * only when the walk UP from this module never finds a `package.json` named
 * `@getknext/core` AND never finds a `templates/app` directory to fall back
 * on. That never happens for a real install (this repo, or a published
 * tarball), so the only way to exercise it is to make `existsSync` lie: every
 * check reports false, so the walk climbs to the filesystem root with nothing
 * found and must throw rather than return `undefined`.
 *
 * `mock.module("node:fs", …)` replaces the whole module for every import in
 * this process — including the ones `create.ts` itself uses for `readdirSync`
 * / `readFileSync` elsewhere — so this file grabs the REAL `node:fs` via
 * `createRequire` first (the same hazard `deploy-entrypoint-dispatch.test.ts`
 * documents) and only overrides `existsSync`.
 */
import { describe, expect, it, mock } from "bun:test";

const { createRequire } = await import("node:module");
const realFs = createRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("node:fs", () => ({
    ...realFs,
    // Every existence check fails — the manifest is never found, the
    // `templates/app` fallback is never found either.
    existsSync: () => false,
}));

const { packageRoot } = await import("../cli/create");

describe("packageRoot() — the corrupt-install fallback (#407)", () => {
    it("throws a diagnosable error instead of walking off the filesystem root silently", () => {
        expect(() => packageRoot()).toThrow(
            /could not locate the @getknext\/core package root/,
        );
    });

    it("names the module URL it walked from, so the error is actionable", () => {
        try {
            packageRoot();
            throw new Error("expected packageRoot() to throw");
        } catch (err) {
            expect((err as Error).message).toMatch(/install looks corrupt/);
        }
    });
});
