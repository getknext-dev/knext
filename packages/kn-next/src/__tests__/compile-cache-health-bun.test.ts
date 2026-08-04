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
    probeType: typeof getCompileCacheDir,
    probeValue: (typeof getCompileCacheDir === "function" ? getCompileCacheDir() : undefined) ?? null,
    status,
    warns,
}));
`;

interface HarnessResult {
    runtime: string;
    probeType: string;
    probeValue: string | null;
    status: string;
    warns: string[];
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
        "observes the Bun shape the fix is built on: probe present, returns undefined for a HEALTHY dir",
        () => {
            if (!bun) throw new Error("unreachable: guarded by skipIf");
            const result = runHarness(bun, healthyCacheDir());

            expect(result.runtime).toBe("bun");
            // The premise, measured rather than assumed. If a future bun implements
            // NODE_COMPILE_CACHE, `probeValue` becomes a string and this fails —
            // which is the signal to narrow the runtime check by version.
            expect(result.probeType).toBe("function");
            expect(result.probeValue).toBeNull();
        },
    );

    it.skipIf(!bun)(
        "stays SILENT and reports 'unknown' under bun, with a healthy volume",
        () => {
            if (!bun) throw new Error("unreachable: guarded by skipIf");
            const result = runHarness(bun, healthyCacheDir());

            expect(result.status).toBe("unknown");
            expect(result.warns).toEqual([]);
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
