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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `process.env` widened for writing. `@types/node` types `NODE_ENV` readonly,
 * and setting it is the whole point of the production cases below — the gate
 * under test reads it at CALL time, so a subprocess would only add cost.
 */
const env = process.env as Record<string, string | undefined>;

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

    // T6b. The flag is the WRONG kind of gate on its own: it is an env var on a
    // PUBLISHED subpath, so anything that can set an env var in the app's
    // process — an npm postinstall, a compromised transitive dep, a Dockerfile
    // `ENV` copied off a blog post — re-enables a seam that repoints the
    // process-wide cache. Under NODE_ENV=production the seams must therefore
    // refuse REGARDLESS of the flag: there is no legitimate production caller,
    // so the flag has nothing to unlock there.
    it("refuses BOTH seams under NODE_ENV=production even WITH the flag set", async () => {
        const priorEnv = env.NODE_ENV;
        const priorFlag = env.KNEXT_TEST_SEAMS;
        try {
            // The attacker's position exactly: the opt-in flag IS set.
            env.KNEXT_TEST_SEAMS = "1";
            env.NODE_ENV = "production";
            const mod = await import("../adapters/cache-handler");

            expect(() => mod.__setRedisClientForTests(undefined)).toThrow(
                /NODE_ENV=production/,
            );
            expect(() => mod.__resetEnvForTests()).toThrow(
                /NODE_ENV=production/,
            );
        } finally {
            if (priorEnv === undefined) delete env.NODE_ENV;
            else env.NODE_ENV = priorEnv;
            if (priorFlag === undefined) delete env.KNEXT_TEST_SEAMS;
            else env.KNEXT_TEST_SEAMS = priorFlag;
        }
    });

    // The other half: outside production the flag still WORKS. Without this a
    // gate that throws unconditionally — breaking every opted-in suite — would
    // read as a pass here, and the "unconditional in production" claim would be
    // indistinguishable from "unconditional".
    it("still HONOURS the flag outside production", async () => {
        const priorEnv = env.NODE_ENV;
        const priorFlag = env.KNEXT_TEST_SEAMS;
        try {
            env.KNEXT_TEST_SEAMS = "1";
            env.NODE_ENV = "test";
            const mod = await import("../adapters/cache-handler");
            expect(() => mod.__resetEnvForTests()).not.toThrow();
        } finally {
            if (priorEnv === undefined) delete env.NODE_ENV;
            else env.NODE_ENV = priorEnv;
            if (priorFlag === undefined) delete env.KNEXT_TEST_SEAMS;
            else env.KNEXT_TEST_SEAMS = priorFlag;
        }
    });

    // The .d.ts is the surface a TS consumer reads. A gate documented only in
    // the .js is a gate the caller discovers at runtime, in production.
    it("documents the production refusal on the PUBLISHED .d.ts", () => {
        const dts = readFileSync(
            join(
                dirname(import.meta.dirname),
                "adapters",
                "cache-handler.d.ts",
            ),
            "utf8",
        );
        // Scanned, not enumerated: every declared `__`-seam whose JSDoc claims
        // it is fail-closed must also name the production refusal.
        for (const seam of ["__setRedisClientForTests", "__resetEnvForTests"]) {
            const idx = dts.indexOf(`export declare function ${seam}`);
            expect(idx, `${seam} is not declared in the .d.ts`).toBeGreaterThan(
                -1,
            );
            const doc = dts.slice(Math.max(0, idx - 900), idx);
            expect(
                doc,
                `${seam}'s .d.ts doc does not mention the NODE_ENV=production refusal`,
            ).toContain("NODE_ENV=production");
        }
    });

    it("leaves the PURE helpers ungated — they mutate nothing", async () => {
        delete process.env.KNEXT_TEST_SEAMS;
        const mod = await import("../adapters/cache-handler");
        // A representative pure helper must keep working without the flag;
        // gating these would force the flag into production diagnostics.
        expect(() => mod.__redisTtlSeconds({ revalidate: 60 })).not.toThrow();
    });
});
