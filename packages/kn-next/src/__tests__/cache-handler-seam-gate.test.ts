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
import {
    activeSeamRelocationExemptions,
    SEAM_RELOCATION_EXEMPTIONS,
} from "../../../../scripts/lib/published-seam-policy.mjs";

/**
 * `process.env` widened for writing. `@types/node` types `NODE_ENV` readonly,
 * and setting it is the whole point of the production cases below — the gate
 * under test reads it at CALL time, so a subprocess would only add cost.
 */
const env = process.env as Record<string, string | undefined>;

const HANDLER_SRC = join(
    dirname(import.meta.dirname),
    "adapters",
    "cache-handler.js",
);

/**
 * The GATED seams, read out of the module rather than listed here.
 *
 * An enumerated pair is how the third one ships ungated: someone adds a seam,
 * calls `assertTestSeamEnabled` in it, and this file — asserting on the two it
 * was written for — stays green while the new seam is covered by nothing. The
 * authoritative declaration is the gate CALL itself, so that is what is scanned.
 * A name here that is not exported, or that fails to throw, reds below.
 */
function gatedSeamNames(): string[] {
    const src = readFileSync(HANDLER_SRC, "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(
        /assertTestSeamEnabled\(\s*['"](__[A-Za-z0-9_]+)['"]\s*\)/g,
    )) {
        found.add(m[1] as string);
    }
    return [...found].sort();
}

describe("cache-handler published seams fail closed", () => {
    it("discovers the gated seams instead of trusting a list", () => {
        const seams = gatedSeamNames();
        // Anti-vacuity: an empty scan would make every loop below iterate zero
        // times and report a pass.
        expect(
            seams.length,
            "no gated seams found — the scan is broken, or the gate was removed wholesale",
        ).toBeGreaterThanOrEqual(2);
        for (const known of [
            "__resetEnvForTests",
            "__setRedisClientForTests",
        ]) {
            expect(seams, `the scan missed ${known}`).toContain(known);
        }
    });

    it("refuses EVERY gated seam without KNEXT_TEST_SEAMS=1", async () => {
        delete process.env.KNEXT_TEST_SEAMS;
        const mod = (await import(
            "../adapters/cache-handler"
        )) as unknown as Record<string, (arg?: unknown) => unknown>;

        for (const seam of gatedSeamNames()) {
            expect(
                typeof mod[seam],
                `${seam} is gated but not exported — the gate protects nothing a consumer can reach`,
            ).toBe("function");
            expect(
                () => mod[seam]?.(undefined),
                `${seam} did not refuse`,
            ).toThrow(/TEST-ONLY seam on a published module/);
        }
    });

    // T6b. The flag is the WRONG kind of gate on its own: it is an env var on a
    // PUBLISHED subpath, so anything that can set an env var in the app's
    // process — an npm postinstall, a compromised transitive dep, a Dockerfile
    // `ENV` copied off a blog post — re-enables a seam that repoints the
    // process-wide cache. Under NODE_ENV=production the seams must therefore
    // refuse REGARDLESS of the flag: there is no legitimate production caller,
    // so the flag has nothing to unlock there.
    it("refuses EVERY gated seam under NODE_ENV=production even WITH the flag set", async () => {
        const priorEnv = env.NODE_ENV;
        const priorFlag = env.KNEXT_TEST_SEAMS;
        try {
            // The attacker's position exactly: the opt-in flag IS set.
            env.KNEXT_TEST_SEAMS = "1";
            env.NODE_ENV = "production";
            const mod = (await import(
                "../adapters/cache-handler"
            )) as unknown as Record<string, (arg?: unknown) => unknown>;

            for (const seam of gatedSeamNames()) {
                expect(
                    () => mod[seam]?.(undefined),
                    `${seam} did not refuse under NODE_ENV=production`,
                ).toThrow(/NODE_ENV=production/);
            }
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
        // Discovered from the gate calls, not enumerated: a third gated seam
        // must document the refusal too, or a TS consumer meets it at runtime
        // in production — the one place it must not be a surprise.
        for (const seam of gatedSeamNames()) {
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

    /**
     * The DEFERRAL has a clock (#936).
     *
     * T6b is the cheap half: the seams refuse in production, but they are still
     * exported from a published subpath. Relocating them is a public-API change
     * and therefore a workflow.md escalation trigger, so it is tracked rather
     * than smuggled into a hardening PR — and tracked here, mechanically, not
     * only in a PR body that nobody re-reads.
     */
    it("every seam still on the published subpath is a DATED exception", () => {
        const excused = activeSeamRelocationExemptions();
        for (const seam of gatedSeamNames()) {
            expect(
                excused,
                `${seam} is still exported from the published cache-handler subpath and its ` +
                    "relocation exception has EXPIRED. Do the relocation (#936), or re-date the " +
                    "entry in scripts/lib/published-seam-policy.mjs with a reason. Do not weaken " +
                    "this test.",
            ).toContain(`@getknext/core/adapters/cache-handler#${seam}`);
        }
    });

    it("the relocation clock is real, not decorative", () => {
        // The other half. Without it an exemption reader that never expires
        // anything would satisfy the case above forever, which is the quietest
        // way to neuter a deferral: it still reads as dated.
        const [entry] = SEAM_RELOCATION_EXEMPTIONS;
        const after = new Date(`${entry?.expires}T00:00:01Z`);
        expect(activeSeamRelocationExemptions(after).size).toBe(0);
    });

    it("leaves the PURE helpers ungated — they mutate nothing", async () => {
        delete process.env.KNEXT_TEST_SEAMS;
        const mod = await import("../adapters/cache-handler");
        // A representative pure helper must keep working without the flag;
        // gating these would force the flag into production diagnostics.
        expect(() => mod.__redisTtlSeconds({ revalidate: 60 })).not.toThrow();
    });
});
