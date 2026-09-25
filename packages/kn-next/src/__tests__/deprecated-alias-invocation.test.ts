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
    // `writeSync(2, ...)` writes to the REAL process stderr fd by default —
    // spawning a child under Bash is how cli-node-runtime.test.ts captures
    // that end-to-end (real symlinks, real subprocess). In-process, the
    // function now also takes an injectable `write` (the same idiom as
    // `handleUsageError` above in this file), so the env-gated suppression
    // below (#1380 rev-1380 round 2) can be asserted directly rather than
    // only "does not throw".
    it("the notice condition matches isDeprecatedAliasInvocation exactly (same argv1), with no npm_command set", () => {
        for (const argv1 of [
            "/x/.bin/kn-next",
            "/x/.bin/knext",
            "kn-next",
            "knext",
            undefined,
        ]) {
            expect(() =>
                printDeprecatedKnNextNoticeIfNeeded(argv1, {}),
            ).not.toThrow();
        }
    });

    it('writes the notice for a direct "kn-next" invocation with no npm_command set', () => {
        const writes: string[] = [];
        printDeprecatedKnNextNoticeIfNeeded("/x/.bin/kn-next", {}, (t) =>
            writes.push(t),
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain("deprecated");
    });

    it('writes NOTHING for "knext" (the canonical bin), npm_command notwithstanding', () => {
        const writes: string[] = [];
        printDeprecatedKnNextNoticeIfNeeded(
            "/x/.bin/knext",
            { npm_command: "exec" },
            (t) => writes.push(t),
        );
        expect(writes).toHaveLength(0);
    });

    it('#1380: suppresses the notice for "kn-next" argv1 when npm_command === "exec" — the npx/npm-exec bin-pick case, proven against real npm 11.9.0 to resolve argv1 through .bin/kn-next for `npx @getknext/core` regardless of user intent', () => {
        const writes: string[] = [];
        printDeprecatedKnNextNoticeIfNeeded(
            "/x/.bin/kn-next",
            { npm_command: "exec" },
            (t) => writes.push(t),
        );
        expect(writes).toHaveLength(0);
    });

    it('does NOT suppress for "kn-next" argv1 under npm_command === "run" — a project script that names kn-next directly still gets the notice', () => {
        const writes: string[] = [];
        printDeprecatedKnNextNoticeIfNeeded(
            "/x/.bin/kn-next",
            { npm_command: "run" },
            (t) => writes.push(t),
        );
        expect(writes).toHaveLength(1);
    });
});
