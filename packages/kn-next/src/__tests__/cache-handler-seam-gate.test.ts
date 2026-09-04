/**
 * The published mutating seams FAIL CLOSED (sprint-close design-gate block).
 *
 * `@getknext/core/adapters/cache-handler` is a published subpath, and
 * `__setRedisClientForTests(undefined)` repoints — or disables — the
 * process-wide cache. Without this gate, any consumer (or any dependency of a
 * consumer) could call it in production and every request would silently fall
 * to the in-memory cache. The seam now throws unless a test harness opts in
 * with KNEXT_TEST_SEAMS=1.
 *
 * This file deliberately does NOT set the flag (the runner isolates one
 * process per file, so the opted-in cache-handler suites cannot leak it here)
 * — it is the half of the guard that proves the CLOSED state, without which
 * deleting `assertTestSeamEnabled` stays green everywhere.
 */

import { describe, expect, it } from "bun:test";

describe("cache-handler published seams fail closed", () => {
    it("refuses both mutating seams without KNEXT_TEST_SEAMS=1", async () => {
        delete process.env.KNEXT_TEST_SEAMS;
        const mod = await import("../adapters/cache-handler");

        expect(() => mod.__setRedisClientForTests(undefined)).toThrow(
            /TEST-ONLY seam on a published module/,
        );
        expect(() => mod.__resetEnvForTests()).toThrow(
            /TEST-ONLY seam on a published module/,
        );
    });

    it("leaves the PURE helpers ungated — they mutate nothing", async () => {
        delete process.env.KNEXT_TEST_SEAMS;
        const mod = await import("../adapters/cache-handler");
        // A representative pure helper must keep working without the flag;
        // gating these would force the flag into production diagnostics.
        expect(() => mod.__redisTtlSeconds({ revalidate: 60 })).not.toThrow();
    });
});
