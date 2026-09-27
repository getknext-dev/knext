/**
 * Round 3 (R2-B2, N2 #1457): the `/app/server.js` compat shim in the
 * self-contained image is what an operator-rendered pod actually runs today
 * (`bun run server.js`), so on scale-down it is PID 1 and the ONLY thing that
 * can pass SIGTERM on to the compiled executable that owns the drain. Round 2
 * only checked that the Dockerfile COPYs it, so a shim that stopped forwarding
 * signals, or pointed at the wrong binary, stayed green in the fast lane.
 *
 * This runs the real shim template under `bun run server.js` (the operator's
 * command) with a stub child placed at the exact path the Dockerfile's
 * self-contained stage puts the executable, then signals the shim and checks
 * that the stub received the same signal and that the shim exited with the
 * stub's own exit code.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";

const TEMPLATE_DIR = resolve(
    import.meta.dirname,
    "..",
    "..",
    "templates",
    "runtime-standalone",
);
const DOCKERFILE = join(TEMPLATE_DIR, "Dockerfile.standalone.hbs");
const SHIM_TEMPLATE = join(
    TEMPLATE_DIR,
    "knext-self-contained-server-shim.js.hbs",
);
const SHIM_SOURCE_NAME = "knext-self-contained-server-shim.js";
const SC_STAGE = "standalone-bun-self-contained";

/**
 * Where the Dockerfile's self-contained stage puts the shim and the
 * executable. Read from the Dockerfile rather than hardcoded, so a shim whose
 * target drifts from what the image actually ships reds here.
 */
function selfContainedLayout(): { shimDest: string; execDest: string } {
    const text = readFileSync(DOCKERFILE, "utf8");
    const start = text.search(new RegExp(`^FROM .* AS ${SC_STAGE}$`, "m"));
    expect(
        start,
        `no ${SC_STAGE} stage in Dockerfile.standalone.hbs`,
    ).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/^FROM /m);
    const stage = next === -1 ? rest : rest.slice(0, next);

    const shimCopies = [
        ...stage.matchAll(
            new RegExp(
                `^COPY ${SHIM_SOURCE_NAME.replace(/\./g, "\\.")} (\\S+)$`,
                "gm",
            ),
        ),
    ];
    expect(shimCopies.length, "the stage must COPY the shim exactly once").toBe(
        1,
    );

    const entry = stage.match(/^ENTRYPOINT \["([^"]+)"/m);
    expect(entry, "the stage has no exec-form ENTRYPOINT").not.toBeNull();
    const execDest = (entry as RegExpMatchArray)[1];

    // The executable the ENTRYPOINT names must be one the stage COPYs in.
    const execCopied = new RegExp(
        `^COPY \\S+ ${execDest.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`,
        "m",
    );
    expect(stage, `the stage never COPYs ${execDest}`).toMatch(execCopied);

    return { shimDest: shimCopies[0][1], execDest };
}

// A POSIX-sh stub standing in for the compiled executable. It installs its
// traps BEFORE announcing readiness (no race), reports the signal it got, and
// exits with a code the shim can only reproduce by propagating it.
//
// Round 4: it also reports whether NEXT_MANUAL_SIG_HANDLE reached it (the shim
// must never set it — that flag turns off Next's own SIGTERM handler, which is
// the one that waits for after() work), and STUB_KILL_SELF makes it die from a
// signal the shim never relayed, standing in for an out-of-memory kill.
const STUB = `#!/bin/sh
trap 'echo STUB_GOT_TERM; exit 42' TERM
trap 'echo STUB_GOT_INT; exit 43' INT
echo "STUB_MANUAL_SIG_HANDLE=\${NEXT_MANUAL_SIG_HANDLE-unset}"
if [ -n "$STUB_EXIT_NOW" ]; then echo "STUB_READY pid=$$ argv=$*"; exit "$STUB_EXIT_NOW"; fi
if [ -n "$STUB_KILL_SELF" ]; then echo "STUB_READY pid=$$ argv=$*"; kill -"$STUB_KILL_SELF" $$; sleep 5; exit 99; fi
echo "STUB_READY pid=$$ argv=$*"
while :; do sleep 0.05; done
`;

let workDir = "";
let shim: ChildProcess | undefined;
let stubPid = 0;

afterEach(() => {
    if (shim && shim.exitCode === null && shim.signalCode === null) {
        shim.kill("SIGKILL");
    }
    if (stubPid) {
        try {
            process.kill(stubPid, "SIGKILL");
        } catch {
            // already gone
        }
    }
    shim = undefined;
    stubPid = 0;
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = "";
});

/** Lay out shim + stub as the image does, start `bun run server.js`. */
function startShim(env: Record<string, string> = {}) {
    const { shimDest, execDest } = selfContainedLayout();
    expect(
        posix.dirname(shimDest),
        "the shim execs the binary NEXT TO ITSELF, so the Dockerfile must put both in one directory",
    ).toBe(posix.dirname(execDest));

    workDir = realpathSync(mkdtempSync(join(tmpdir(), "knext-sc-shim-")));
    copyFileSync(SHIM_TEMPLATE, join(workDir, basename(shimDest)));
    const stubPath = join(workDir, basename(execDest));
    writeFileSync(stubPath, STUB);
    chmodSync(stubPath, 0o755);

    let out = "";
    // Start from an environment WITHOUT the flag, so the stub's report of it
    // reflects only what the shim itself adds.
    const baseEnv = { ...process.env };
    delete baseEnv.NEXT_MANUAL_SIG_HANDLE;
    const child = spawn(
        process.execPath,
        ["run", basename(shimDest), "--from-operator"],
        {
            cwd: workDir,
            env: { ...baseEnv, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    shim = child;
    child.stdout?.on("data", (d) => {
        out += String(d);
        const m = out.match(/STUB_READY pid=(\d+)/);
        if (m) stubPid = Number(m[1]);
    });
    child.stderr?.on("data", (d) => {
        out += String(d);
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
        (res) => child.on("exit", (code, signal) => res({ code, signal })),
    );
    return { child, exited, output: () => out };
}

async function until(cond: () => boolean, what: string, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    what: string,
): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        clearTimeout(t);
    }
}

describe("the self-contained /app/server.js shim (what `bun run server.js` runs)", () => {
    it("launches the binary the Dockerfile ships next to it, passing argv through", async () => {
        const { output } = startShim();
        await until(
            () => /STUB_READY/.test(output()),
            `the stub to start\n${output()}`,
        );
        expect(output()).toContain("argv=--from-operator");
    });

    it("forwards SIGTERM to the executable and exits with the executable's own code", async () => {
        const { child, exited, output } = startShim();
        await until(() => stubPid > 0, `the stub to start\n${output()}`);
        child.kill("SIGTERM");
        const res = await withTimeout(
            exited,
            10_000,
            `the shim to exit after SIGTERM (it did not forward it?)\n${output()}`,
        );
        expect(output(), "the executable never received SIGTERM").toContain(
            "STUB_GOT_TERM",
        );
        expect(res).toEqual({ code: 42, signal: null });
    });

    it("forwards SIGINT to the executable and exits with the executable's own code", async () => {
        const { child, exited, output } = startShim();
        await until(() => stubPid > 0, `the stub to start\n${output()}`);
        child.kill("SIGINT");
        const res = await withTimeout(
            exited,
            10_000,
            `the shim to exit after SIGINT (it did not forward it?)\n${output()}`,
        );
        expect(output(), "the executable never received SIGINT").toContain(
            "STUB_GOT_INT",
        );
        expect(res).toEqual({ code: 43, signal: null });
    });

    it("exits with the executable's code when it exits on its own", async () => {
        const { exited, output } = startShim({ STUB_EXIT_NOW: "5" });
        const res = await withTimeout(
            exited,
            10_000,
            `the shim to exit\n${output()}`,
        );
        expect(output()).toContain("STUB_READY");
        expect(res).toEqual({ code: 5, signal: null });
    });

    // Round 4 (C3): a child that dies from a signal the shim never relayed
    // (an OOM kill is SIGKILL) must surface as that same signal, not be
    // laundered into `exit(1)` — the platform reads the cause from it.
    it("re-raises a signal death it did not relay (SIGKILL) as the same signal, not exit 1", async () => {
        const { exited, output } = startShim({ STUB_KILL_SELF: "KILL" });
        const res = await withTimeout(
            exited,
            10_000,
            `the shim to exit after its child was SIGKILLed\n${output()}`,
        );
        expect(output()).toContain("STUB_READY");
        expect(res).toEqual({ code: null, signal: "SIGKILL" });
    });

    // Round 4 (A4), behaviour half: the shim must not hand the executable
    // NEXT_MANUAL_SIG_HANDLE. With it set, Next skips its own SIGTERM handler
    // — the one that awaits after() work — which is the round-1 defect.
    it("does not set NEXT_MANUAL_SIG_HANDLE in the executable's environment", async () => {
        const { output } = startShim();
        await until(
            () => /STUB_READY/.test(output()),
            `the stub to start\n${output()}`,
        );
        expect(output()).toContain("STUB_MANUAL_SIG_HANDLE=unset");
    });
});

describe("nothing in the self-contained image sets NEXT_MANUAL_SIG_HANDLE (round 4, A3/A4)", () => {
    // Scan halves: the docker e2e would catch either only through its 30 s
    // `docker wait` against the 120 s grace window, so the fast lane checks
    // the two places it could be introduced.
    it("the Dockerfile's self-contained stage never sets it (outside comments)", () => {
        const text = readFileSync(DOCKERFILE, "utf8");
        const start = text.search(new RegExp(`^FROM .* AS ${SC_STAGE}$`, "m"));
        expect(start, `no ${SC_STAGE} stage`).toBeGreaterThan(-1);
        const rest = text.slice(start + 1);
        const next = rest.search(/^FROM /m);
        const stage = next === -1 ? rest : rest.slice(0, next);
        expect(stage, "the stage looks truncated").toMatch(/^ENTRYPOINT /m);
        const offending = stage
            .split("\n")
            .filter((l) => !/^\s*#/.test(l))
            .filter((l) => /NEXT_MANUAL/.test(l));
        expect(
            offending,
            "the self-contained stage sets NEXT_MANUAL_SIG_HANDLE, which disables Next's own after()-draining SIGTERM handler",
        ).toEqual([]);
    });

    it("the shim spawns the executable with the inherited environment only", () => {
        const text = readFileSync(SHIM_TEMPLATE, "utf8");
        const code = text
            .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
            .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
        expect(
            code,
            "the shim mentions NEXT_MANUAL outside a comment",
        ).not.toMatch(/NEXT_MANUAL/);
        const spawns = [...code.matchAll(/\bspawn\s*\(/g)];
        expect(spawns.length, "the shim must spawn exactly once").toBe(1);
        // No `env:` override: the child gets process.env as-is.
        expect(code).toMatch(
            /\bspawn\(\s*bin\s*,\s*process\.argv\.slice\(2\)\s*,\s*\{\s*stdio:\s*'inherit'\s*\}\s*\)/,
        );
        expect(code, "the shim writes to process.env").not.toMatch(
            /process\.env\s*(?:\[|\.\s*[A-Z_])[^\n]*=[^=]/,
        );
    });
});
