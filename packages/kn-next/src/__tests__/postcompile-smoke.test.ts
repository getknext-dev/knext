/**
 * #894 — the post-compile RuntimeContract smoke.
 *
 * `kn-next build` compiles `.output/server/index.mjs` whatever it contains. The
 * obligations the operator depends on — the health route it probes, the
 * `:9091` metrics exposition, the SIGTERM drain — live in the app's own entry,
 * so an app that swapped or broke that entry still COMPILES, still deploys, and
 * simply never goes Ready, never drains, or never exposes metrics.
 *
 * These cases drive the real function against a real child process
 * (`fixtures/smoke-server.mjs`), one obligation removed at a time. That is the
 * non-vacuity half: a smoke that asserted nothing would pass the "good" fixture
 * exactly as it does now, and only the mutant fixtures tell the two apart.
 *
 * NOTE ON THE PROBE SHAPE — this repo has measured it: a compiled binary
 * re-executed with a `--version`-style argv flag just BOOTS A SECOND SERVER,
 * because the baked entry never parses argv. So the smoke boots the binary and
 * speaks HTTP to it; it never asks the binary about itself.
 */

import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    describeDrainFailure,
    keepErrorsNonFatal,
    PostCompileSmokeError,
    runPostCompileSmoke,
    terminate,
} from "../cli/postcompile-smoke";
import { USAGE_ERROR_CODE } from "../cli/shared";

const FIXTURE = resolve(import.meta.dir, "fixtures/smoke-server.mjs");
chmodSync(FIXTURE, 0o755);

/** Short budgets: these cases exercise FAILURE, and a real failure is instant. */
const FAST = {
    bootMs: 15_000,
    healthMs: 10_000,
    metricsMs: 10_000,
    termMs: 3_000,
};

function smoke(mode: string, extra: Record<string, string> = {}) {
    return runPostCompileSmoke({
        binaryPath: FIXTURE,
        budgets: FAST,
        env: { KNEXT_SMOKE_FIXTURE_MODE: mode, ...extra },
    });
}

/** The obligation a rejection names, or a failure if it rejected wrongly. */
async function obligationOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (err) {
        if (err instanceof PostCompileSmokeError) return err.obligation;
        throw err;
    }
    throw new Error("the smoke PASSED — it was expected to fail");
}

describe("#894 post-compile smoke — a contract-honouring binary", () => {
    it("passes, and reports the ports it actually probed", async () => {
        const result = await smoke("good");
        // Non-vacuity: the smoke really spoke to a listener, so the ports it
        // reports are OS-assigned and cannot be the 3000/9091 defaults it would
        // have printed had it never read the child's startup line.
        expect(result.appPort).toBeGreaterThan(0);
        expect(result.metricsPort).toBeGreaterThan(0);
        expect(result.appPort).not.toBe(result.metricsPort);
        expect(result.healthStatus).toBe(200);
        expect(result.metricsStatus).toBe(200);
        expect(result.exitCode).toBe(0);
    }, 30_000);

    it("probes the CONFIGURED health path, not a hardcoded one", async () => {
        const result = await runPostCompileSmoke({
            binaryPath: FIXTURE,
            budgets: FAST,
            healthPath: "/healthz",
            env: {
                KNEXT_SMOKE_FIXTURE_MODE: "good",
                KNEXT_SMOKE_FIXTURE_HEALTH_PATH: "/healthz",
            },
        });
        expect(result.healthStatus).toBe(200);
        // And the other half: the default path is NOT served by that fixture,
        // so a smoke ignoring `healthPath` would have failed above.
        expect(
            await obligationOf(
                smoke("good", {
                    KNEXT_SMOKE_FIXTURE_HEALTH_PATH: "/healthz",
                }),
            ),
        ).toBe("health");
    }, 60_000);

    it("never binds a fixed port — PORT/METRICS_PORT are handed to the child as 0", async () => {
        // Two smokes CONCURRENTLY. With fixed ports the second child's bind
        // fails and this case is red; with 0 the OS assigns four distinct ports.
        const [a, b] = await Promise.all([smoke("good"), smoke("good")]);
        expect(
            new Set([a.appPort, a.metricsPort, b.appPort, b.metricsPort]).size,
        ).toBe(4);
    }, 60_000);
});

describe("#894 post-compile smoke — each obligation, removed", () => {
    it("names 'health' when the health route is gone", async () => {
        expect(await obligationOf(smoke("no-health"))).toBe("health");
    }, 30_000);

    it("names 'metrics' when the metrics exposition is gone", async () => {
        expect(await obligationOf(smoke("no-metrics"))).toBe("metrics");
    }, 30_000);

    it("names 'sigterm' when the drain never exits", async () => {
        expect(await obligationOf(smoke("ignore-sigterm"))).toBe("sigterm");
    }, 30_000);

    it("names 'sigterm' when SIGTERM is UNHANDLED and the process dies by signal", async () => {
        // The likeliest real regression: the entry never registers the handler
        // at all. The kernel's default disposition then kills it FAST, so it
        // stops promptly and looks fine to anything that only asks "did it
        // stop?" — the opposite timing to `ignore-sigterm`, and the branch that
        // reads a death-by-signal as a non-zero exit.
        expect(await obligationOf(smoke("unhandled-sigterm"))).toBe("sigterm");
    }, 30_000);

    it("says the process died BY SIGNAL, not that it exited 0", async () => {
        const err = (await smoke("unhandled-sigterm").catch(
            (e: PostCompileSmokeError) => e,
        )) as PostCompileSmokeError;
        // Non-vacuity for the case above: the drain branch could be satisfied
        // by any non-zero code, so the message has to distinguish a signal
        // death from a crash with a code — an operator reads this line.
        expect(err.message).toMatch(/SIGTERM/);
        expect(err.message).not.toMatch(/exited 0/);
    }, 30_000);

    it("names 'boot' when the binary exits instead of listening", async () => {
        expect(await obligationOf(smoke("crash"))).toBe("boot");
    }, 30_000);

    it("names 'boot' when the startup signal never arrives", async () => {
        expect(
            await obligationOf(
                runPostCompileSmoke({
                    binaryPath: FIXTURE,
                    // A short boot budget ONLY here: this fixture listens
                    // forever without announcing, so the budget IS the assertion.
                    budgets: { ...FAST, bootMs: 4_000 },
                    env: { KNEXT_SMOKE_FIXTURE_MODE: "no-boot-line" },
                }),
            ),
        ).toBe("boot");
    }, 30_000);

    it("names 'boot' when the binary does not exist at all", async () => {
        expect(
            await obligationOf(
                runPostCompileSmoke({
                    binaryPath: resolve(
                        import.meta.dir,
                        "fixtures/not-a-binary",
                    ),
                    budgets: { ...FAST, bootMs: 4_000 },
                }),
            ),
        ).toBe("boot");
    }, 30_000);
});

describe("#894 a process that is already gone is not a drain failure", () => {
    // The DETERMINISTIC half. Whether a child that exits the instant it finishes
    // serving is dead *before* or *after* our SIGTERM lands is a genuine race of
    // microseconds, so the verdict for each outcome is decided by one pure
    // function and asserted here directly. All four kinds, no timing.
    it("reports an already-exited child as exactly that", () => {
        const msg = describeDrainFailure(
            { kind: "early", code: 0, signal: null },
            20_000,
        );
        expect(msg).toBeDefined();
        // Before the fix this outcome could not be distinguished at all: the
        // child was already gone, the timer ran to completion, and the CLI told
        // the developer the opposite of the truth.
        expect(msg).not.toMatch(/still running/);
        expect(msg).toMatch(/ALREADY EXITED/);
        expect(msg).toMatch(/exit code 0/);
    });

    it("keeps the other three verdicts distinct", () => {
        expect(describeDrainFailure({ kind: "timeout" }, 20_000)).toMatch(
            /still running 20000 ms after SIGTERM/,
        );
        expect(
            describeDrainFailure(
                { kind: "exited", code: null, signal: "SIGTERM" },
                20_000,
            ),
        ).toMatch(/KILLED BY SIGTERM/);
        expect(
            describeDrainFailure(
                { kind: "exited", code: 3, signal: null },
                20_000,
            ),
        ).toMatch(/exited 3 on SIGTERM/);
        // The ONLY passing shape — non-vacuity for every case above.
        expect(
            describeDrainFailure(
                { kind: "exited", code: 0, signal: null },
                20_000,
            ),
        ).toBeUndefined();
    });

    it("classifies an ALREADY-DEAD child as 'early', without waiting", async () => {
        // Deterministic where the end-to-end case cannot be: the child is
        // reaped BEFORE terminate() is called, so the already-exited branch is
        // the only one reachable. Without that branch this falls to the timer —
        // 5 s here — which is precisely the defect (budget burned, then the
        // wrong verdict). The integration case below is race-tolerant by
        // necessity and therefore cannot pin this.
        const dead = spawn(process.execPath, ["-e", "process.exit(7)"]);
        await new Promise((r) => dead.once("exit", r));

        const startedAt = Date.now();
        const outcome = await terminate(dead, 5_000);

        expect(outcome.kind).toBe("early");
        expect(outcome).toMatchObject({ code: 7 });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
    }, 30_000);

    it("never burns the term budget on a child that stopped by itself", async () => {
        // The integration half, asserting the property that holds either way the
        // race falls: a self-terminating child is resolved FAST and is never
        // described as still running. (Which of the two verdicts it gets is the
        // race; that both are correct is the pure test above.)
        const startedAt = Date.now();
        const outcome = await smoke("exits-after-serving").catch(
            (e: PostCompileSmokeError) => e,
        );
        if (outcome instanceof PostCompileSmokeError) {
            expect(outcome.message).not.toMatch(/still running/);
        }
        // The budget here is 3 s; anything near it means the timeout path ran.
        expect(Date.now() - startedAt).toBeLessThan(2_500);
    }, 30_000);
});

describe("#894 a late spawn error never crashes the CLI", () => {
    it("keeps an 'error' listener for the child's whole lifetime", () => {
        // Node throws on an 'error' event with no listener, and the only
        // listener used to be removed once startup succeeded — so an EPERM from
        // the later kill() would take down `kn-next build` with an uncaught
        // exception instead of a build failure. Proved on a bare emitter, both
        // halves: unguarded throws, guarded does not.
        const bare = new EventEmitter();
        expect(() => bare.emit("error", new Error("EPERM"))).toThrow();

        const guarded = new EventEmitter();
        keepErrorsNonFatal(guarded as unknown as ChildProcess);
        expect(() => guarded.emit("error", new Error("EPERM"))).not.toThrow();
    });

    it("is installed by the smoke itself, not merely available", () => {
        // A helper nothing calls is decoration. Pinned by scanning the source:
        // an enumerated call site is how the second one gets missed, and there
        // is exactly one child here.
        const src = readFileSync(
            resolve(import.meta.dir, "../cli/postcompile-smoke.ts"),
            "utf8",
        );
        expect(src).toMatch(/keepErrorsNonFatal\(child\)/);
    });
});

describe("#894 post-compile smoke — the failure a developer reads", () => {
    it("names the obligation AND the binary in the message", async () => {
        try {
            await smoke("no-health");
            throw new Error("expected a failure");
        } catch (err) {
            expect(err).toBeInstanceOf(PostCompileSmokeError);
            const message = (err as Error).message;
            expect(message).toContain("health");
            expect(message).toContain(FIXTURE);
            // The build must FAIL, so the error carries the CLI's usage code
            // rather than surfacing as an unhandled crash.
            expect((err as PostCompileSmokeError).code).toBe(USAGE_ERROR_CODE);
        }
    }, 30_000);

    it("leaves no child behind when it fails", async () => {
        const failed = await smoke("ignore-sigterm").catch(
            (e: PostCompileSmokeError) => e,
        );
        expect(failed).toBeInstanceOf(PostCompileSmokeError);
        const pid = (failed as PostCompileSmokeError).pid;
        expect(pid).toBeGreaterThan(0);
        // SIGKILL follows the missed drain budget, so the process is gone.
        // `kill(pid, 0)` throws ESRCH for a reaped child.
        await new Promise((r) => setTimeout(r, 500));
        expect(() => process.kill(pid as number, 0)).toThrow();
    }, 30_000);
});
