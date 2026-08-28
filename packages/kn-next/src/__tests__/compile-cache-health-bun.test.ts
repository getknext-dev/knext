/**
 * #309 round 2 — the Bun false-alarm, proved against REAL bun.
 *
 * Round 1 asserted "Bun has no `module.getCompileCacheDir`" and covered it by
 * injecting `getCompileCacheDir: undefined` — a stub for a runtime that does
 * not exist. Bun DOES export the function; it returns `undefined`
 * unconditionally, including for a healthy, writable, freshly-created
 * directory. So the shipped diagnostic reported `degraded` and warned that a
 * perfectly good volume "was refused", on every Bun pod. `node-server.ts`
 * branches on `process.versions.bun`, so this is a supported target, not a
 * hypothetical.
 *
 * A stub cannot prove that fix. This runs the REAL module under a REAL bun
 * process against a REAL writable directory and asserts BOTH halves:
 *  - the observed Bun shape is what the fix is built on (probe present,
 *    returns undefined for a healthy dir) — if a future Bun implements the
 *    cache, this assertion tells us, rather than the fix quietly resting on a
 *    stale premise;
 *  - the module stays SILENT and reports `unknown` there, while the same
 *    module under this Node process reports `degraded` for a directory the
 *    runtime really did refuse (so "silent" is not silence everywhere).
 *
 * Bun availability follows this repo's established shape (#448): with
 * `KNEXT_REQUIRE_BUN=1` a missing `bun` is a hard FAILURE, never a skip — and
 * because a flag CI never sets is the #408 defect verbatim, the job that sets
 * it is itself asserted, in `tests/compile-cache-health-bun-ci.test.ts`. When
 * bun IS on PATH (the ordinary local case) these run regardless of the flag.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HEALTH_MODULE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../adapters/compile-cache-health.ts",
);

/**
 * Runs the real module inside a real bun process. Reports what bun's probe
 * actually did, alongside the module's verdict, so the premise and the
 * conclusion are observed in the same run.
 */
const HARNESS = `
import { getCompileCacheDir } from "node:module";
import { warnOnDegradedCompileCache } from ${JSON.stringify(HEALTH_MODULE)};

const warns = [];
const status = warnOnDegradedCompileCache({
    env: process.env,
    log: { warn: (obj, msg) => warns.push(msg) },
});
console.log(JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node",
    bunVersion: process.versions.bun ?? null,
    probeType: typeof getCompileCacheDir,
    probeValue: (typeof getCompileCacheDir === "function" ? getCompileCacheDir() : undefined) ?? null,
    status,
    warns,
}));
`;

interface HarnessResult {
    runtime: string;
    bunVersion: string | null;
    probeType: string;
    probeValue: string | null;
    status: string;
    warns: string[];
}

/**
 * #807 — is this bun one that implements `NODE_COMPILE_CACHE`?
 *
 * Deliberately a SEPARATE implementation from the production
 * `runtimeHonoursCompileCache`, not an import of it. A test that asks the
 * subject to decide which assertion applies to itself proves nothing: any
 * version-gate bug would move the expectation in lockstep and stay green.
 *
 * Numeric compare, because `"1.10.0" < "1.4.0"` lexically. Unparseable resolves
 * to false, matching production's silent direction.
 */
function bunAtLeast14(version: string | null): boolean {
    if (!version) return false;
    const m = /^(\d+)\.(\d+)/.exec(version);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 1 || (major === 1 && minor >= 4);
}

/** The version of the bun binary on PATH, read from the binary itself. */
function bunVersionOf(bin: string): string | null {
    const out = spawnSync(bin, ["--version"], { encoding: "utf8" });
    return out.status === 0 ? out.stdout.trim() : null;
}

function bunOnPath(): string | null {
    const which = spawnSync("bash", ["-lc", "command -v bun"], {
        encoding: "utf8",
    });
    const path = which.stdout.trim();
    return which.status === 0 && path.length > 0 ? path : null;
}

function runHarness(bin: string, cacheDir: string): HarnessResult {
    const dir = mkdtempSync(join(tmpdir(), "knext-309-bunharness-"));
    const entry = join(dir, "harness.ts");
    writeFileSync(entry, HARNESS);
    const stdout = execFileSync(bin, [entry], {
        encoding: "utf8",
        env: { ...process.env, NODE_COMPILE_CACHE: cacheDir },
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
}

/** A real, writable, empty cache directory — the HEALTHY case. */
function healthyCacheDir(): string {
    return mkdtempSync(join(tmpdir(), "knext-309-healthy-cache-"));
}

const bun = bunOnPath();
const bunRequired = process.env.KNEXT_REQUIRE_BUN === "1";

describe("#309 the compile-cache diagnostic under REAL bun", () => {
    it("has bun available whenever KNEXT_REQUIRE_BUN=1 (a missing bun FAILS)", () => {
        if (!bunRequired) {
            // Not the gate — the gate is the CI job that sets the flag.
            expect(bunRequired).toBe(false);
            return;
        }
        expect(
            bun,
            "KNEXT_REQUIRE_BUN=1 but `bun` is not on PATH. This suite proves the Bun false-alarm fix " +
                "against a REAL bun process; passing without it would leave the fix asserted only " +
                "against a stub of a runtime that does not exist.",
        ).not.toBeNull();
    });

    it.skipIf(!bun)(
        "observes the Bun shape the fix is built on, and it is VERSION-DEPENDENT since 1.4",
        () => {
            if (!bun) throw new Error("unreachable: guarded by skipIf");
            const result = runHarness(bun, healthyCacheDir());

            expect(result.runtime).toBe("bun");
            expect(result.probeType).toBe("function");

            // #807 — this assertion used to be an unconditional `toBeNull()`,
            // written as a tripwire: "if a future bun implements
            // NODE_COMPILE_CACHE, probeValue becomes a string and this fails,
            // which is the signal to narrow the runtime check by version."
            //
            // Bun 1.4.0 (2026-08-20) is that future. The tripwire did its job,
            // so it becomes a version-indexed premise rather than being deleted
            // — deleting it would retire the only thing that notices the NEXT
            // shape change.
            if (bunAtLeast14(result.bunVersion)) {
                expect(
                    result.probeValue,
                    "bun ≥1.4 implements NODE_COMPILE_CACHE; a healthy dir must yield a path",
                ).toEqual(expect.any(String));
            } else {
                expect(
                    result.probeValue,
                    "bun ≤1.3 stubs the probe; a healthy dir yields undefined",
                ).toBeNull();
            }
        },
    );

    it.skipIf(!bun)(
        "reports the verdict its bun version can actually earn, for a HEALTHY volume",
        () => {
            if (!bun) throw new Error("unreachable: guarded by skipIf");
            const result = runHarness(bun, healthyCacheDir());

            // Both halves of #807. Silence on ≤1.3 is the #309 fix; a real
            // `active` on ≥1.4 is the diagnostic finally working under bun.
            // Either way the healthy case must never WARN.
            expect(result.status).toBe(
                bunAtLeast14(result.bunVersion) ? "active" : "unknown",
            );
            expect(result.warns).toEqual([]);
        },
    );

    it.skipIf(!bun || !bunAtLeast14(bunVersionOf(bun)))(
        "WARNS under bun ≥1.4 for a dir the runtime really refused",
        () => {
            if (!bun) throw new Error("unreachable: guarded by skipIf");
            // The half that makes enabling the diagnostic safe. Verified against
            // a real bun 1.4.0: `/dev/null` yields undefined there exactly as it
            // does on node. Without this, `active` alone could not distinguish
            // "refused" from "not implemented", and a genuinely bad volume would
            // go silent on every 1.4 pod — the #309 defect inverted.
            const result = runHarness(bun, "/dev/null");

            expect(result.status).toBe("degraded");
            expect(result.warns).toHaveLength(1);
            expect(result.warns[0]).toContain("/dev/null");
        },
    );

    it("still WARNS under Node for a dir the runtime really refused", () => {
        // The other half: the fix must buy silence on Bun, not silence
        // everywhere. `/dev/null` is refused by V8 on Node (see
        // compile-cache-volume-fallback.test.ts), so the same module, same
        // harness, must speak here.
        const result = runHarness(process.execPath, "/dev/null");

        expect(result.runtime).toBe("node");
        expect(result.status).toBe("degraded");
        expect(result.warns).toHaveLength(1);
        expect(result.warns[0]).toContain("/dev/null");
    });
});
