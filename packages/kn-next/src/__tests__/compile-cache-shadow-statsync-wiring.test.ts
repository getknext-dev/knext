/**
 * #451 — the `dev`+`ino` mechanism must be wired to the REAL `statSync` in
 * production, not merely to whatever a test injects.
 *
 * Why this file exists: the round-2 review mutation-disproved the claim that a
 * "default parameter test" covered this. Replacing the default with
 * `() => { throw new Error("MUTANT"); }` left every test in
 * `compile-cache-shadow.test.ts` GREEN, because
 *  - `isCompileCacheShadowed(a, b, true)` returns `true` either way (a throwing
 *    stat fails open to "not the same" ⇒ shadow ⇒ `true`), and
 *  - `isSameDirectory(a, a)` short-circuits on canonical equality before the
 *    stat function is ever reached.
 * So the bind-mount mechanism had ZERO coverage of its production wiring —
 * decoration by this repo's own definition.
 *
 * The proof here uses a **hard link**, which is the one aliasing case a test
 * can create without root and WITHOUT mocking anything:
 *  - two hard links are two distinct paths;
 *  - `realpathSync` does NOT collapse them (it resolves symlinks, not links),
 *    so the cheap canonical comparison FAILS and cannot decide the outcome;
 *  - they share one inode, so `(dev, ino)` is identical.
 * That is structurally the same signal a bind mount produces, and the only way
 * the assertion below can pass is if the default parameter really is the
 * imported `statSync` reading the real filesystem. (Mocking `node:fs` was tried
 * first and is not viable here: under this vitest/node setup `importOriginal`
 * and `vi.importActual` both hand back an EMPTY namespace for the builtin, and
 * `spyOn` fails with "Module namespace is not configurable in ESM".)
 *
 * Hard links are files; production compares directories, where the equivalent
 * alias is a bind mount. The mechanism exercised — inode identity through the
 * production default stat — is the same one.
 *
 * Mutation-proved: replacing the default with a throwing function, or with any
 * stub that does not read the real filesystem, turns the first two cases RED.
 */

import { describe, expect, it } from "bun:test";
import { linkSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    isCompileCacheShadowed,
    isSameDirectory,
} from "../adapters/compile-cache-shadow";

/** Two REAL paths sharing one inode, in two different parent directories. */
function hardLinkedPair(): { original: string; alias: string } {
    const dirA = mkdtempSync(join(tmpdir(), "knext-451-link-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "knext-451-link-b-"));
    const original = join(dirA, "cache-entry.bin");
    const alias = join(dirB, "cache-entry.bin");
    writeFileSync(original, "bytecode");
    linkSync(original, alias);
    return { original, alias };
}

describe("#451 the dev/ino check is wired to the real statSync", () => {
    it("treats two hard links as the SAME fs node, with no injected stat", () => {
        const { original, alias } = hardLinkedPair();

        // Precondition: the CHEAP comparison cannot decide this. If realpath
        // collapsed hard links, the assertion below would prove nothing.
        expect(realpathSync(alias)).not.toBe(realpathSync(original));

        // No statFn argument: this can only pass through the production
        // default reading the real filesystem.
        expect(isSameDirectory(original, alias)).toBe(true);
    });

    it("reaches the same production stat through isCompileCacheShadowed", () => {
        const { original, alias } = hardLinkedPair();
        // Same node ⇒ not a shadow, decided by dev/ino alone.
        expect(isCompileCacheShadowed(alias, original, true)).toBe(false);
    });

    it("still separates two genuinely distinct real paths", () => {
        // The counterpart: a stub default that always reported "same" would
        // pass the cases above and fail here.
        const a = mkdtempSync(join(tmpdir(), "knext-451-distinct-a-"));
        const b = mkdtempSync(join(tmpdir(), "knext-451-distinct-b-"));
        expect(isSameDirectory(a, b)).toBe(false);
        expect(isCompileCacheShadowed(a, b, true)).toBe(true);
    });
});
