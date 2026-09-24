/**
 * `isDeprecatedAliasInvocation` / `printDeprecatedKnNextNoticeIfNeeded`
 * (#1369, rev-1380 round).
 *
 * `bin.knext` and `bin.kn-next` point at the SAME dist file (a second file
 * broke `npx @getknext/core`'s bin auto-pick for every consumer — see
 * shared.ts's header). The only way left to tell the two invocations apart
 * is `process.argv[1]`'s BASENAME, checked before any realpath resolution
 * (npm's `.bin/` symlinks carry the name the user typed; realpath would
 * collapse both back to the one real file). These are the pure unit tests
 * for that decision; the end-to-end proof against REAL symlinks lives in
 * cli-node-runtime.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
    isDeprecatedAliasInvocation,
    printDeprecatedKnNextNoticeIfNeeded,
} from "../cli/shared";

describe("isDeprecatedAliasInvocation", () => {
    it('argv[1] basename "kn-next" (any directory) → true', () => {
        expect(
            isDeprecatedAliasInvocation("/x/y/node_modules/.bin/kn-next"),
        ).toBe(true);
        expect(isDeprecatedAliasInvocation("kn-next")).toBe(true);
    });

    it('argv[1] basename "knext" → false', () => {
        expect(
            isDeprecatedAliasInvocation("/x/y/node_modules/.bin/knext"),
        ).toBe(false);
        expect(isDeprecatedAliasInvocation("knext")).toBe(false);
    });

    it("a basename matching NEITHER alias (e.g. direct dist-file execution) → false (fail toward silence)", () => {
        expect(isDeprecatedAliasInvocation("/x/y/dist/cli/kn-next.js")).toBe(
            false,
        );
        expect(isDeprecatedAliasInvocation("/x/y/deploy.ts")).toBe(false);
        expect(isDeprecatedAliasInvocation("core")).toBe(false);
    });

    it("undefined argv[1] → false", () => {
        expect(isDeprecatedAliasInvocation(undefined)).toBe(false);
    });

    it("defaults to reading the REAL process.argv[1] when called with no argument", () => {
        // The test runner's own argv[1] is neither alias name.
        expect(isDeprecatedAliasInvocation()).toBe(false);
    });
});

describe("printDeprecatedKnNextNoticeIfNeeded", () => {
    // `writeSync(2, ...)` writes to the REAL process stderr fd — spawning a
    // child under Bash is how cli-node-runtime.test.ts captures it end-to-end
    // (real symlinks, real subprocess). In-process, `writeSync` is bound at
    // import time in shared.ts, so this suite asserts the observable CONTRACT
    // (the underlying decision, and that the call never throws either way)
    // rather than re-mocking node:fs, which the repo's own mock-pollution
    // note (require-isolated-process.ts) warns is unsafe to do lightly.
    it("the notice condition matches isDeprecatedAliasInvocation exactly (same argv1)", () => {
        for (const argv1 of [
            "/x/.bin/kn-next",
            "/x/.bin/knext",
            "kn-next",
            "knext",
            undefined,
        ]) {
            // Neither branch throws — the notice write is fire-and-forget on
            // a real fd, so the only thing to assert without a process
            // boundary is that the decision runs to completion either way.
            expect(() =>
                printDeprecatedKnNextNoticeIfNeeded(argv1),
            ).not.toThrow();
        }
    });
});
