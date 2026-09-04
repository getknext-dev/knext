/**
 * The post-compile RuntimeContract smoke (#894).
 *
 * ## What it exists to catch
 *
 * `bun build --compile` bakes `.output/server/index.mjs` into a binary WHATEVER
 * that entry contains. The obligations the platform actually depends on live in
 * the app's own entry (`knext-bun-entry.mjs`), not in knext:
 *
 *   1. the health route the operator's readiness probe hits,
 *   2. the `:9091` Prometheus exposition the shipped PodMonitor scrapes,
 *   3. the SIGTERM drain that makes scale-down lossless.
 *
 * An app that swapped or broke that entry compiles cleanly, produces an image,
 * and then never goes Ready / never drains / never exposes metrics — discovered
 * on a cluster, at deploy time, by whoever is on call. This module moves that
 * discovery to the developer's machine, at build time, with the missing
 * obligation NAMED.
 *
 * ## How it probes — and the shape this repo has already measured to be wrong
 *
 * It boots the binary and speaks HTTP to it. It never re-executes the binary
 * with a `--version`-style argv flag to interrogate it: the baked nitro entry
 * does not parse argv, so such a probe simply BOOTS A SECOND SERVER and reports
 * whatever the caller hoped to see.
 *
 * Ports are handed to the child as `PORT=0` / `METRICS_PORT=0` and read back
 * from its `LISTENING:<port> METRICS:<port>` startup line — the same startup-order
 * signal the RuntimeContract already requires. A child that binds its own ports
 * cannot collide with a concurrent smoke, which is the collision class the
 * repo's port-reservation helpers exist to work around in the one case (docker
 * `--publish`) where the parent must know the number up front. This is not that
 * case, so no reservation is made.
 *
 * ## Fail, never skip
 *
 * Every path out of here is pass or throw. There is no "docker/bun unavailable,
 * assume fine" branch: a smoke that goes green when it could not run is exactly
 * the anti-pattern the compat runner had removed from it. The ONE escape is an
 * explicit, LOUD, caller-supplied skip in `build.ts` — a decision the user
 * makes, never one this module makes for them.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { UsageError } from "./shared";

/** The RuntimeContract obligation a failed smoke names. */
export type SmokeObligation = "boot" | "health" | "metrics" | "sigterm";

/**
 * A failed obligation. Extends `UsageError` so `kn-next build` exits with the
 * CLI's usage code and prints the message, rather than dumping a stack.
 */
export class PostCompileSmokeError extends UsageError {
    readonly obligation: SmokeObligation;
    /** The child's pid, so a caller (and the tests) can assert it was reaped. */
    readonly pid?: number;

    constructor(obligation: SmokeObligation, message: string, pid?: number) {
        super(message);
        this.name = "PostCompileSmokeError";
        this.obligation = obligation;
        this.pid = pid;
    }
}

/** Time budgets, milliseconds. Explicit because "eventually" is not a gate. */
export interface SmokeBudgets {
    /** Spawn → the `LISTENING:… METRICS:…` startup line. */
    readonly bootMs: number;
    /** Startup line → a 200 on the health path. */
    readonly healthMs: number;
    /** → a 200 with a body on `/metrics`. */
    readonly metricsMs: number;
    /** SIGTERM → process exit. */
    readonly termMs: number;
}

/**
 * Defaults sized against measurement, not taste. A compiled binary's cold start
 * is 61 ms median (`docs/benchmarks/vinext-bun14-single-exec-2026-08-27.md`), so
 * a 60 s boot budget is ~1000x headroom for a cold page cache on a loaded CI
 * box — generous enough that a red here means BROKEN, not slow.
 */
export const DEFAULT_BUDGETS: SmokeBudgets = {
    bootMs: 60_000,
    healthMs: 20_000,
    metricsMs: 10_000,
    termMs: 20_000,
};

export interface PostCompileSmokeOptions {
    /** The freshly compiled executable. */
    readonly binaryPath: string;
    /** Working directory for the child; the app root, so it finds `.output/public`. */
    readonly cwd?: string;
    /** `config.healthCheckPath`, defaulting the same way the operator does. */
    readonly healthPath?: string;
    readonly budgets?: Partial<SmokeBudgets>;
    /** Extra env for the child. `PORT`/`METRICS_PORT` are always overridden. */
    readonly env?: Record<string, string>;
    readonly log?: (message: string) => void;
}

export interface PostCompileSmokeResult {
    readonly appPort: number;
    readonly metricsPort: number;
    readonly healthStatus: number;
    readonly metricsStatus: number;
    /** The child's exit code after SIGTERM — 0, or the smoke would have thrown. */
    readonly exitCode: number;
    readonly bootMs: number;
    readonly termMs: number;
}

/**
 * The startup-order signal every knext server entry prints once BOTH listeners
 * are bound. Exported because it is a CONTRACT with the scaffolded entry, not a
 * private detail: `postcompile-smoke-startup-contract.test.ts` scan-pins it
 * against what the templates actually print, so renaming the line in a template
 * cannot silently turn this smoke into a boot-timeout for every app.
 */
export const STARTUP_LINE = /LISTENING:(\d+)\s+METRICS:(\d+)/;
/** Keep the tail of the child's output for the failure message, not all of it. */
const MAX_CAPTURED_BYTES = 8192;

/**
 * Install a permanent no-op `error` listener on the child.
 *
 * Node THROWS on an `error` event with no listener. The startup watcher installs
 * one, but removes it again the moment the child announces itself — so an
 * `EPERM` from the later `kill()` (a child that changed uid, a restrictive
 * sandbox) arrived at an unlistened emitter and took `kn-next build` down with
 * an uncaught exception rather than a build failure. The listener must outlive
 * every phase, so it is installed once at spawn and never removed.
 */
export function keepErrorsNonFatal(child: ChildProcess): void {
    child.on("error", () => {
        // Deliberately empty: every phase already decides for itself what an
        // unreachable child means. This exists only so the emitter never throws.
    });
}

/**
 * Boot the binary, assert the three obligations, and stop it.
 *
 * Throws {@link PostCompileSmokeError} naming the first obligation that fails.
 * Always reaps the child, including on the SIGTERM-ignored path, where SIGKILL
 * follows the missed budget — an ignored drain must not leave a process behind
 * on the developer's machine.
 */
export async function runPostCompileSmoke(
    opts: PostCompileSmokeOptions,
): Promise<PostCompileSmokeResult> {
    const budgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
    const healthPath = opts.healthPath ?? "/api/health";
    const log = opts.log ?? (() => {});

    const child = spawn(opts.binaryPath, [], {
        cwd: opts.cwd,
        env: {
            ...process.env,
            // The drain's ceiling, not its speed: there are no in-flight
            // requests here, so an entry that drains correctly exits at once.
            // Bounding it keeps a BROKEN drain from eating the term budget as
            // if it were the app's own configured 25 s grace.
            SHUTDOWN_GRACE_MS: "5000",
            ...opts.env,
            // Last: the child must never bind a fixed port, whatever the caller
            // passed, or two concurrent smokes fight over 3000/9091.
            PORT: "0",
            METRICS_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    // FIRST thing after spawn, and never removed: an `error` event with no
    // listener throws, and the phases below each install and REMOVE their own.
    keepErrorsNonFatal(child);

    let output = "";
    const capture = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-MAX_CAPTURED_BYTES);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const startedAt = Date.now();
    try {
        const ports = await waitForStartupLine(
            child,
            budgets.bootMs,
            () => output,
        );
        if (!ports) {
            throw new PostCompileSmokeError(
                "boot",
                obligationMessage(
                    "boot",
                    opts.binaryPath,
                    `it never printed its startup line (LISTENING:<port> METRICS:<port>) within ${budgets.bootMs} ms`,
                    output,
                ),
                child.pid,
            );
        }
        const bootMs = Date.now() - startedAt;
        log(
            `smoke: booted in ${bootMs} ms (app :${ports.appPort}, metrics :${ports.metricsPort})`,
        );

        const health = await probe(
            `http://127.0.0.1:${ports.appPort}${healthPath}`,
            budgets.healthMs,
        );
        if (health?.status !== 200) {
            throw new PostCompileSmokeError(
                "health",
                obligationMessage(
                    "health",
                    opts.binaryPath,
                    `GET ${healthPath} answered ${health ? health.status : "nothing"} — the operator's readiness probe would never pass, so the revision never goes Ready`,
                    output,
                ),
                child.pid,
            );
        }

        const metrics = await probe(
            `http://127.0.0.1:${ports.metricsPort}/metrics`,
            budgets.metricsMs,
        );
        if (metrics?.status !== 200 || metrics.body.trim().length === 0) {
            throw new PostCompileSmokeError(
                "metrics",
                obligationMessage(
                    "metrics",
                    opts.binaryPath,
                    `GET :${ports.metricsPort}/metrics answered ${metrics ? `${metrics.status} with ${metrics.body.length} bytes` : "nothing"} — the shipped PodMonitor scrapes this port and would collect nothing`,
                    output,
                ),
                child.pid,
            );
        }

        const termStartedAt = Date.now();
        const outcome = await terminate(child, budgets.termMs);
        const drainFailure = describeDrainFailure(outcome, budgets.termMs);
        if (drainFailure) {
            throw new PostCompileSmokeError(
                "sigterm",
                obligationMessage(
                    "sigterm",
                    opts.binaryPath,
                    drainFailure,
                    output,
                ),
                child.pid,
            );
        }

        return {
            appPort: ports.appPort,
            metricsPort: ports.metricsPort,
            healthStatus: health.status,
            metricsStatus: metrics.status,
            exitCode: 0,
            bootMs,
            termMs: Date.now() - termStartedAt,
        };
    } finally {
        // Unconditional. Every failure above leaves a process that would
        // otherwise outlive the build — including the one whose whole defect is
        // that it ignores SIGTERM.
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
    }
}

/**
 * What is wrong with how the child ended, or undefined if it drained cleanly.
 *
 * Split out so every drain verdict is decided in ONE place, from the outcome's
 * own shape. The three failures are genuinely different events and reporting
 * them interchangeably is how the CLI ended up telling a developer their
 * already-dead process was "still running".
 */
export function describeDrainFailure(
    outcome: TerminateOutcome,
    termBudgetMs: number,
): string | undefined {
    switch (outcome.kind) {
        case "early":
            return (
                `it had ALREADY EXITED (${formatEnd(outcome.code, outcome.signal)}) before SIGTERM was sent — ` +
                "the server did not stay up, so its drain could not be checked at all"
            );
        case "timeout":
            return `it was still running ${termBudgetMs} ms after SIGTERM — on scale-down Kubernetes would SIGKILL it and drop in-flight requests`;
        default:
            if (outcome.signal) {
                // No handler at all: the kernel's default disposition killed it.
                // Fast, tidy-looking, and nothing drained.
                return (
                    `it was KILLED BY ${outcome.signal} rather than handling it — the entry registers no ` +
                    "SIGTERM handler, so in-flight requests and after() callbacks are dropped on every scale-down"
                );
            }
            return outcome.code === 0
                ? undefined
                : `it exited ${outcome.code} on SIGTERM rather than 0 — a non-zero exit reads as a crash to the kubelet`;
    }
}

/** "exit code 3" / "signal SIGKILL" / "cause unknown" — never a bare number. */
function formatEnd(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `signal ${signal}`;
    if (code !== null) return `exit code ${code}`;
    return "cause unknown";
}

/** The message shape: obligation, binary, what happened, and the child's tail. */
function obligationMessage(
    obligation: SmokeObligation,
    binaryPath: string,
    detail: string,
    output: string,
): string {
    const tail = output.trim();
    return (
        `Post-compile smoke FAILED — obligation '${obligation}'.\n\n` +
        `The compiled executable ${binaryPath} booted from this build, and ${detail}.\n\n` +
        "That obligation lives in the app's own server entry, not in knext, so a broken or\n" +
        "swapped entry compiles cleanly and only fails on a cluster. Fix the entry, or pass\n" +
        "--skip-smoke if this machine genuinely cannot execute the binary.\n" +
        (tail ? `\n--- last output from the binary ---\n${tail}\n` : "")
    );
}

/**
 * Resolve when the child announces both listeners, or undefined on timeout /
 * early exit / spawn error. An exited child will never announce, so it is not
 * waited out — that is the "compiles but does not run" shape.
 */
function waitForStartupLine(
    child: ChildProcess,
    timeoutMs: number,
    read: () => string,
): Promise<{ appPort: number; metricsPort: number } | undefined> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (
            v: { appPort: number; metricsPort: number } | undefined,
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            child.stderr?.off("data", onData);
            child.off("exit", onExit);
            child.off("error", onExit);
            resolve(v);
        };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        const onData = () => {
            const m = STARTUP_LINE.exec(read());
            if (m) done({ appPort: Number(m[1]), metricsPort: Number(m[2]) });
        };
        const onExit = () => done(undefined);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("exit", onExit);
        // ENOENT / EACCES on the binary itself — also a boot failure.
        child.on("error", onExit);
        onData();
    });
}

/**
 * GET the url, retrying until the budget runs out.
 *
 * Retried rather than asked once because a bound listener is not necessarily
 * serving yet, and the entry's warmup can answer 5xx briefly after it binds.
 *
 * But a response BELOW 500 is DEFINITIVE and returns immediately: a route that
 * is not in the bundle answers 404 on the first request and on the last one, so
 * waiting out the budget would only make every real failure take the full
 * budget — and this smoke runs on every build.
 */
async function probe(
    url: string,
    budgetMs: number,
): Promise<{ status: number; body: string } | undefined> {
    const deadline = Date.now() + budgetMs;
    let last: { status: number; body: string } | undefined;
    for (;;) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            });
            last = { status: res.status, body: await res.text() };
            if (res.status < 500) return last;
        } catch {
            // not accepting connections yet, or the budget expired mid-flight
        }
        if (Date.now() >= deadline) return last;
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** How the child's life ended, relative to the SIGTERM we sent. */
export type TerminateOutcome =
    /** Exited on its own BEFORE any SIGTERM was sent. */
    | {
          readonly kind: "early";
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
      }
    /** Exited after SIGTERM. `signal` set ⇒ the kernel killed it, no handler. */
    | {
          readonly kind: "exited";
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
      }
    /** Still running when the budget ran out. */
    | { readonly kind: "timeout" };

/**
 * SIGTERM, then how it ended.
 *
 * The already-exited case is checked FIRST and reported as its own outcome. It
 * used to fall through to the timer, which burned the whole term budget and
 * then reported "still running after SIGTERM" — the exact opposite of the truth,
 * under the wrong obligation, at the cost of the budget.
 */
function terminate(
    child: ChildProcess,
    timeoutMs: number,
): Promise<TerminateOutcome> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({
            kind: "early",
            code: child.exitCode,
            signal: child.signalCode,
        });
    }
    return new Promise((resolve) => {
        let settled = false;
        const done = (outcome: TerminateOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };
        const timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs);
        child.once("exit", (code, signal) => {
            done({ kind: "exited", code, signal });
        });
        // Racy by nature: the child can die between the check above and here.
        // `exit` still fires, so that lands on the `exited` path rather than
        // the timeout — which is why the check above is an optimisation for the
        // ALREADY-dead case, not the only guard against it.
        child.kill("SIGTERM");
    });
}
