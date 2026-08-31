/**
 * #309 (one of four criteria) — NODE_COMPILE_CACHE on a COLD SHARED VOLUME and
 * on VOLUME FAILURE must degrade, never crash.
 *
 * knext points NODE_COMPILE_CACHE at a baked image layer by default, and the
 * operator may inject a path on a shared volume instead (ADR-0035, #440/#451).
 * A cold-start optimisation that turns a volume problem into a BOOT FAILURE is
 * strictly worse than not having the optimisation at all: the pod crashloops
 * instead of merely starting slower. So the contract this file pins is:
 *
 *   for EVERY broken-volume shape, the process still boots (exit 0, real work
 *   done) and V8 simply reports NO compile cache — degraded, not fatal.
 *
 * Both halves are asserted, deliberately (the one-sided-scan defect, #639):
 *  - the SANCTIONED outcome is present  — the process booted and produced its
 *    output, and on a HEALTHY dir the cache is genuinely ACTIVE and populated
 *    (otherwise "nothing crashed" would pass trivially with the feature dead);
 *  - nothing UNSANCTIONED happened      — no non-zero exit, no thrown/uncaught
 *    error text on stderr, for any broken shape.
 *
 * These spawn a real `node`, not a Next.js build, on purpose: the property
 * belongs to the runtime's env contract, so it must hold in every CI run rather
 * than only in the jobs that build the standalone server (which skip when no
 * build is present — green-by-skip). `module.getCompileCacheDir()` is the exact
 * runtime signal: a string when V8 accepted the directory, `undefined` when the
 * cache was refused and silently disabled.
 *
 * Failure shapes covered: missing (nested, uncreated) · unwritable parent
 * (EACCES on create) · path is a regular FILE (ENOTDIR) · existing but
 * read-only dir · a character device (`/dev/null`) · a CORRUPT entry left by a
 * pod SIGKILLed mid-flush on a shared volume.
 *
 * NOT simulatable portably, and honestly out of scope here: a true ENOSPC
 * (full volume) and a real read-only MOUNT both need root/privileged setup. In
 * V8/Node both surface through the same "cache write/open failed ⇒ disable the
 * cache" path exercised by the EACCES and read-only-dir cases below.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdtempSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_BIN } from "../../../../tests/helpers/runtime-binaries";

/**
 * A tiny "app": requires a second module (so there IS something for V8 to
 * cache) and reports whether the compile cache ended up active.
 */
const APP_SOURCE = `
const helper = require("./helper.js");
const { getCompileCacheDir } = require("node:module");
const dir = typeof getCompileCacheDir === "function" ? getCompileCacheDir() : undefined;
process.stdout.write(JSON.stringify({ booted: true, work: helper.work(), compileCacheDir: dir ?? null }));
`;
const HELPER_SOURCE = `
// Enough module body that V8 has real bytecode to cache.
exports.work = () => Array.from({ length: 64 }, (_, i) => i * i).reduce((a, b) => a + b, 0);
`;
const EXPECTED_WORK = Array.from({ length: 64 }, (_, i) => i * i).reduce(
    (a, b) => a + b,
    0,
);

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `knext-309-${prefix}-`));
    scratchDirs.push(dir);
    return dir;
}

/**
 * Writes the fixture app into a fresh dir and returns the entry path.
 * `stderrNoise` exists only for the harness-honesty test below: it proves the
 * stderr channel is really captured and really asserted on.
 */
function makeApp(stderrNoise?: string): string {
    const dir = scratch("app");
    writeFileSync(join(dir, "helper.js"), HELPER_SOURCE);
    const entry = join(dir, "app.js");
    const noise = stderrNoise
        ? `process.stderr.write(${JSON.stringify(stderrNoise)});\n`
        : "";
    writeFileSync(entry, noise + APP_SOURCE);
    return entry;
}

interface BootResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly compileCacheDir: string | null;
}

/**
 * Boot the fixture with the given NODE_COMPILE_CACHE and assert the SANCTIONED
 * half: it exited 0, ran its real work, and printed nothing alarming.
 *
 * `spawnSync`, deliberately, NOT `execFileSync`: the latter returns only stdout
 * and surfaces the child's stderr solely on the thrown error, so a
 * `let stderr = ""` next to it is never assigned and every stderr assertion
 * compares the empty string to itself. That tautology shipped in round 1 and
 * was mutation-disproved by writing an error line from the fixture and watching
 * all ten tests stay green. Here stderr is the REAL captured stream, and the
 * failing-exit path reports it instead of hiding it.
 */
function boot(entry: string, nodeCompileCache: string): BootResult {
    const result = spawnSync(NODE_BIN, [entry], {
        encoding: "utf8",
        env: {
            ...process.env,
            NODE_COMPILE_CACHE: nodeCompileCache,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";

    // Crash-free boot is the whole point, so report WHY when it is not.
    expect(
        result.status,
        `child exited ${result.status} for NODE_COMPILE_CACHE=${nodeCompileCache}\nstderr: ${stderr}`,
    ).toBe(0);

    const parsed = JSON.parse(stdout) as {
        booted: boolean;
        work: number;
        compileCacheDir: string | null;
    };
    expect(parsed.booted).toBe(true);
    // The process did REAL work, not just "started and printed something".
    expect(parsed.work).toBe(EXPECTED_WORK);
    // Nothing unsanctioned: no thrown/uncaught error surfaced to stderr. This
    // now reads a stream that is actually populated.
    expect(
        stderr,
        `unexpected stderr for NODE_COMPILE_CACHE=${nodeCompileCache}`,
    ).not.toMatch(/Error|throw|ENOENT|EACCES|ENOTDIR|ENOSPC|EROFS/);
    return { stdout, stderr, compileCacheDir: parsed.compileCacheDir };
}

/**
 * Make `dir` unwritable and PROVE it. Running as root defeats mode bits, which
 * would make every assertion below pass for the wrong reason — a guard that is
 * green because the failure it simulates never happened is decoration. So this
 * FAILS LOUDLY rather than skipping.
 */
function makeUnwritable(dir: string): string {
    chmodSync(dir, 0o555);
    let wrote = false;
    try {
        writeFileSync(join(dir, ".knext-write-probe"), "x");
        wrote = true;
    } catch {
        // expected
    }
    if (wrote) {
        throw new Error(
            `precondition failed: ${dir} is still writable after chmod 0555 (uid=${process.getuid?.()}). ` +
                "These cases simulate an unwritable cache volume; as root the simulation is a no-op, " +
                "so the run is reported as a FAILURE rather than a false pass. Run the suite as a non-root user.",
        );
    }
    return dir;
}

function fileCountRecursive(dir: string): number {
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory())
            count += fileCountRecursive(join(dir, entry.name));
        else if (entry.isFile()) count++;
    }
    return count;
}

afterAll(() => {
    // Restore modes so the runner can clean the temp dirs.
    for (const dir of scratchDirs) {
        try {
            chmodSync(dir, 0o755);
        } catch {
            // best effort
        }
    }
});

describe("#309 NODE_COMPILE_CACHE degrades, never crashes", () => {
    it("HEALTHY volume: the cache is genuinely ACTIVE and populated", () => {
        // The control case. Without it, every "it still booted" assertion below
        // would also pass with the compile cache permanently dead.
        const entry = makeApp();
        const cache = scratch("healthy");

        const first = boot(entry, cache);
        expect(first.compileCacheDir).not.toBeNull();
        expect(first.compileCacheDir).toContain(cache);
        expect(fileCountRecursive(cache)).toBeGreaterThan(0);

        // Second boot on the now-WARM volume: still active, still fine.
        const second = boot(entry, cache);
        expect(second.compileCacheDir).not.toBeNull();
    });

    it("COLD volume (nested path nothing created yet): boots, cache active", () => {
        // A freshly-attached empty shared volume is the ordinary cold case:
        // Node creates the directory itself, so this must stay ACTIVE.
        const entry = makeApp();
        const cache = join(scratch("cold"), "never", "created");

        const result = boot(entry, cache);
        expect(result.compileCacheDir).not.toBeNull();
        expect(result.compileCacheDir).toContain(cache);
    });

    it("UNWRITABLE parent (EACCES on create): boots with the cache DISABLED", () => {
        const entry = makeApp();
        const parent = makeUnwritable(scratch("eacces"));

        const result = boot(entry, join(parent, "cache"));
        expect(result.compileCacheDir).toBeNull();
    });

    it("READ-ONLY existing dir: boots with the cache DISABLED", () => {
        const entry = makeApp();
        const cache = makeUnwritable(scratch("readonly"));

        const result = boot(entry, cache);
        expect(result.compileCacheDir).toBeNull();
    });

    it("path is a regular FILE (ENOTDIR): boots with the cache DISABLED", () => {
        const entry = makeApp();
        const notADir = join(scratch("notadir"), "cache");
        writeFileSync(notADir, "i am not a directory");
        expect(statSync(notADir).isFile()).toBe(true);

        const result = boot(entry, notADir);
        expect(result.compileCacheDir).toBeNull();
    });

    it("path is a character device (/dev/null): boots with the cache DISABLED", () => {
        const entry = makeApp();

        const result = boot(entry, "/dev/null");
        expect(result.compileCacheDir).toBeNull();
    });

    it("CORRUPT entry from a pod killed mid-flush: boots, cache still active", () => {
        // The shared-volume hazard #309 names: another pod was SIGKILLed while
        // V8 was flushing, leaving a truncated entry. Reading garbage must not
        // be fatal — the entry is rejected and recompiled.
        const entry = makeApp();
        const cache = scratch("corrupt");

        boot(entry, cache); // populate
        const written: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile()) written.push(p);
            }
        };
        walk(cache);
        expect(written.length).toBeGreaterThan(0);
        for (const file of written) {
            writeFileSync(file, "GARBAGE-NOT-A-V8-CACHE-ENTRY");
        }

        const result = boot(entry, cache);
        // Still functional: the cache dir is accepted, the garbage is discarded.
        expect(result.compileCacheDir).not.toBeNull();
    });

    it("a MISSING mount point under an unwritable root: boots, cache DISABLED", () => {
        // The operator injected a path whose volume never mounted, and the
        // container filesystem cannot create it either.
        const entry = makeApp();
        const root = makeUnwritable(scratch("unmounted"));

        const result = boot(entry, join(root, "pvc", "bytecode", "latest"));
        expect(result.compileCacheDir).toBeNull();
    });

    it("never leaves the process without its cache dir reported one way or the other", () => {
        // Scan, don't enumerate: whatever the shape, the reported value is
        // either a real string path or explicitly null — never an exception.
        const entry = makeApp();
        const unwritable = makeUnwritable(scratch("scan"));
        const shapes = [
            scratch("scan-ok"),
            join(unwritable, "nope"),
            "/dev/null",
        ];
        for (const shape of shapes) {
            const { compileCacheDir } = boot(entry, shape);
            expect(
                compileCacheDir === null || typeof compileCacheDir === "string",
            ).toBe(true);
        }
    });
});

describe("#309 the fixture itself is honest", () => {
    it("reports a cache dir only when one is really created", () => {
        // Mutation shield: if the fixture always reported null, every
        // "DISABLED" assertion above would pass vacuously. The healthy case
        // above already fails in that world; this pins it directly.
        const entry = makeApp();
        const cache = scratch("fixture");
        const { compileCacheDir } = boot(entry, cache);
        expect(compileCacheDir).not.toBeNull();
        expect(statSync(cache).isDirectory()).toBe(true);
        expect(fileCountRecursive(cache)).toBeGreaterThan(0);
    });

    it("really captures child stderr, and really fails on it", () => {
        // Round 1's stderr assertion was a tautology: `execFileSync` returns
        // only stdout, so the `stderr` variable it compared was the empty
        // string forever. Writing an error line from the fixture left all ten
        // tests green. This pins the plumbing directly — the channel is
        // captured, non-empty, and the assertion inside `boot` rejects it.
        const noisy = makeApp("Error: uncaught EACCES\n");
        const cache = scratch("stderr-honesty");

        expect(() => boot(noisy, cache)).toThrow(/unexpected stderr/);

        // ...and the same fixture without the noise passes, so the assertion
        // rejects the NOISE rather than everything.
        const quiet = makeApp();
        expect(() => boot(quiet, scratch("stderr-quiet"))).not.toThrow();
    });
});
