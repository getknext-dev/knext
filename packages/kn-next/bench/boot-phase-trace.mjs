// Boot PHASE decomposition for the knext supervisor (#441 / #592).
//
//   node packages/kn-next/bench/boot-phase-trace.mjs        [N=12]
//   KNEXT_BENCH_STANDALONE=/abs/path/to/.next/standalone/apps/x/server.js \
//     node packages/kn-next/bench/boot-phase-trace.mjs
//
// The sibling harness (coldstart-supervisor-overhead.mjs) answers "how much does
// the wrapper add"; it cannot answer "where did that go". This one runs the
// SHIPPED @getknext/core bundle with KNEXT_BOOT_TRACE=1 and reads the phase marks
// the supervisor emits about itself, so every interval is attributed from INSIDE
// the process rather than inferred from outside it:
//
//   process start   → entry-eval        node bootstrap + the entry's module graph
//   entry-eval      → spawn-issued      the supervisor's eager (pre-spawn) wiring
//   spawn-issued    → child-listening   the child's own boot (Next.js, or fixture)
//   child-listening → supervisor-ready  the deferred init, past the critical path
//
// Three reference arms put those numbers in context:
//   FLOOR wall       `node -e ""` start→exit — the bare second process, as the
//                    PARENT sees it (fork/exec + bootstrap + teardown)
//   FLOOR in-process node's bootstrap measured on the SAME clock as entry-eval,
//                    so `entry-eval − this` isolates knext's own module graph
//   DIRECT           the child booted with no supervisor at all
//
// The child-listening mark comes from the supervisor's own TCP probe, so its
// resolution is the probe interval; the harness tightens it to 10ms
// (KNEXT_CHILD_READY_PROBE_MS). Production keeps the 250ms default.
//
// Absolute numbers are machine-specific — report the SHAPE (which interval owns
// the time) and re-run on the target cluster before claiming a deployed result.
import { spawn, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const N = Number(process.env.N || 12);
const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
);

// 1. Self-contained @getknext/core deploy (dist + prod node_modules) = shipped layout.
const deploy = mkdtempSync(join(tmpdir(), "knext-core-deploy-"));
process.stderr.write("deploying @getknext/core (prod)…\n");
const dep = spawnSync(
    "pnpm",
    ["--filter", "@getknext/core", "--prod", "deploy", "--legacy", deploy],
    { cwd: repoRoot, encoding: "utf8" },
);
if (
    dep.status !== 0 ||
    !existsSync(join(deploy, "dist/adapters/node-server.js"))
) {
    console.error(
        "deploy failed — run `pnpm --filter @getknext/core build` first",
    );
    console.error((dep.stderr || "").split("\n").slice(-6).join("\n"));
    process.exit(2);
}

// 2. Runner dir whose node_modules/@getknext/core -> the deploy.
const runner = mkdtempSync(join(tmpdir(), "knext-bpt-runner-"));
mkdirSync(join(runner, "node_modules", "@getknext"), { recursive: true });
symlinkSync(deploy, join(runner, "node_modules", "@getknext", "core"));

// 3. The child: a real standalone build if given one, else a fast fixture that
//    removes Next's own boot so only the wrapper's phases remain.
const realStandalone = process.env.KNEXT_BENCH_STANDALONE;
const fixture = realStandalone || join(runner, "fast-server.mjs");
if (!realStandalone) {
    writeFileSync(
        fixture,
        `import http from "node:http";
const port = Number(process.env.PORT || 3000);
http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(port, "0.0.0.0");
`,
    );
}
// A real standalone server.js resolves its tree relative to itself, so run it
// from its own directory; the fixture is self-contained and runs from `runner`.
const childCwd = realStandalone ? dirname(realStandalone) : runner;
// The supervisor inherits that cwd, where a bare "@getknext/core/..." specifier
// would not resolve. Address the deployed entry by absolute path instead — it is
// the SAME file the bare specifier resolves to (exports "./internal/node-server"
// → dist/adapters/node-server.js), so the run stays shape-identical to the
// shipped CMD while working from any cwd.
const supervisorEntry = pathToFileURL(
    join(deploy, "dist", "adapters", "node-server.js"),
).href;

function killTree(child) {
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            /* gone */
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the supervisor once with the trace on; return its phase marks. */
async function traceOnce(port, deadlineMs = 30_000) {
    const marks = [];
    const child = spawn(
        process.execPath,
        ["-e", `import(${JSON.stringify(supervisorEntry)})`],
        {
            cwd: childCwd,
            env: {
                ...process.env,
                PORT: String(port),
                METRICS_PORT: String(port + 10000),
                STANDALONE_SERVER_PATH: fixture,
                CACHE_INVALIDATE_TOKEN: "bench",
                KNEXT_BOOT_TRACE: "1",
                // Tighten the child-ready probe so the child-listening mark is
                // not quantised to the 250ms production cadence.
                KNEXT_CHILD_READY_PROBE_MS: "10",
                NODE_ENV: "production",
            },
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
        },
    );

    let buf = "";
    child.stderr.on("data", (chunk) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.includes("knextBootTrace")) {
                try {
                    marks.push(JSON.parse(line));
                } catch {
                    /* interleaved output — skip */
                }
            }
            nl = buf.indexOf("\n");
        }
    });

    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        if (marks.some((m) => m.phase === "supervisor-ready")) break;
        await sleep(10);
    }
    killTree(child);
    await sleep(150);
    return marks;
}

/** Wall-clock for a plain process to reach a listening socket (or to exit). */
async function timeProcess(argv, port, cwd, extraEnv = {}) {
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, {
        cwd,
        env: { ...process.env, PORT: String(port), ...extraEnv },
        detached: true,
        stdio: "ignore",
    });
    if (port === 0) {
        await new Promise((r) => child.once("exit", r));
        return Date.now() - t0;
    }
    const net = await import("node:net");
    const deadline = Date.now() + 60_000;
    for (;;) {
        const ok = await new Promise((r) => {
            const s = net.connect({ port, host: "127.0.0.1" });
            s.once("connect", () => {
                s.destroy();
                r(true);
            });
            s.once("error", () => {
                s.destroy();
                r(false);
            });
        });
        if (ok) break;
        if (Date.now() > deadline) {
            killTree(child);
            return null;
        }
        await sleep(5);
    }
    const dt = Date.now() - t0;
    killTree(child);
    await sleep(150);
    return dt;
}

/**
 * Node's own bootstrap, measured the SAME way the entry-eval mark is: from
 * inside the process, via process.uptime(), at the first line of user code.
 * This is the honest comparator for entry-eval — the wall-clock FLOOR arm also
 * carries the parent's fork/exec and the child's teardown, and subtracting THAT
 * would credit knext with time it never spent.
 */
async function inProcessFloorMs() {
    return await new Promise((r) => {
        const c = spawn(
            process.execPath,
            ["-e", "process.stderr.write(String(process.uptime()*1000))"],
            { cwd: runner, stdio: ["ignore", "ignore", "pipe"] },
        );
        let out = "";
        c.stderr.on("data", (d) => {
            out += d;
        });
        c.once("exit", () => r(Number(out) || Number.NaN));
    });
}

/**
 * Same in-process clock, but paying the cost of a DYNAMIC IMPORT of an empty
 * module — i.e. node's bootstrap plus ESM-loader initialisation, which the
 * shipped CMD (`node -e "import(...)"`) pays before any knext code is reached.
 * `entry-eval − this` is therefore knext's OWN module graph, with the loader's
 * fixed cost taken out rather than billed to us.
 */
async function esmImportFloorMs() {
    const empty = join(runner, "empty-module.mjs");
    writeFileSync(empty, "export default 0;\n");
    const code = `import(${JSON.stringify(pathToFileURL(empty).href)}).then(() => process.stderr.write(String(process.uptime() * 1000)))`;
    return await new Promise((r) => {
        const c = spawn(process.execPath, ["-e", code], {
            cwd: runner,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let out = "";
        c.stderr.on("data", (d) => {
            out += d;
        });
        c.once("exit", () => r(Number(out) || Number.NaN));
    });
}

const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const range = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? `${fmt(s[0])}..${fmt(s[s.length - 1])}` : "—";
};

// ── run ───────────────────────────────────────────────────────────────────────
process.stderr.write(
    `child = ${realStandalone ? `REAL standalone (${fixture})` : "fast fixture"}\n`,
);
await traceOnce(43900); // warm-up, discarded
await timeProcess([fixture], 43901, childCwd);

// The ordered boot chain. Intervals are derived from each rep's ABSOLUTE
// sinceStartMs values rather than from the marks' own sinceLastMs, so the table
// stays correct no matter what order the async marks (e.g. the :9091 bind, which
// races the spawn by design) happen to land in.
const CHAIN = [
    ["entry-eval", "process start → entry module graph evaluated"],
    ["spawn-issued", "entry-eval → child spawn issued (eager wiring)"],
    ["child-listening", "spawn issued → child accepting on $PORT"],
    ["supervisor-ready", "child listening → deferred supervisor init done"],
];

const floors = [];
const floorsInproc = [];
const floorsEsm = [];
const directs = [];
/** phase -> sinceStartMs[] */
const absolute = new Map();
const push = (phase, ms) => {
    if (!absolute.has(phase)) absolute.set(phase, []);
    absolute.get(phase).push(ms);
};

for (let i = 0; i < N; i++) {
    const port = 44000 + i * 4;
    floors.push(await timeProcess(["-e", ""], 0, runner));
    floorsInproc.push(await inProcessFloorMs());
    floorsEsm.push(await esmImportFloorMs());
    directs.push(await timeProcess([fixture], port, childCwd));
    const marks = await traceOnce(port + 1);
    const seen = new Map();
    for (const m of marks) {
        // First occurrence wins; each phase is marked once per boot.
        if (!seen.has(m.phase)) seen.set(m.phase, m.sinceStartMs);
    }
    for (const [phase, ms] of seen) push(phase, ms);
    process.stderr.write(
        `rep ${i + 1}/${N}: floor=${floors[i]}ms direct=${directs[i]}ms ready=${fmt(seen.get("supervisor-ready"))}ms\n`,
    );
}

/** Per-rep interval between two phases, dropping reps missing either mark. */
function intervals(fromPhase, toPhase) {
    const from = absolute.get(fromPhase) ?? [];
    const to = absolute.get(toPhase) ?? [];
    const out = [];
    for (let i = 0; i < Math.min(from.length, to.length); i++) {
        out.push(to[i] - from[i]);
    }
    return out;
}

console.log(`\n=== supervisor boot phase decomposition (n=${N}) ===`);
console.log(
    `child: ${realStandalone ? `REAL standalone build (${fixture})` : "fast fixture (isolates the wrapper)"}`,
);
console.log(
    `\n${"phase".padEnd(18)} ${"interval ms".padStart(12)} ${"range".padStart(16)} ${"cum ms".padStart(8)}   meaning`,
);
let prev = null;
for (const [phase, meaning] of CHAIN) {
    const abs = absolute.get(phase);
    if (!abs?.length) continue;
    const iv = prev ? intervals(prev, phase) : abs;
    console.log(
        `${phase.padEnd(18)} ${fmt(median(iv)).padStart(12)} ${range(iv).padStart(16)} ${fmt(median(abs)).padStart(8)}   ${meaning}`,
    );
    prev = phase;
}

const bind = absolute.get("metrics-listening");
if (bind?.length) {
    console.log(
        `\n(async, off the chain) metrics-listening — :9091 bound at median ${fmt(median(bind))}ms since process start`,
    );
}

console.log(
    `\nreference  FLOOR wall (node -e ""):   median ${fmt(median(floors))}ms  [${range(floors)}]`,
);
console.log(
    `reference  FLOOR in-process:          median ${fmt(median(floorsInproc))}ms  [${range(floorsInproc)}]`,
);
console.log(
    `reference  FLOOR esm-import:          median ${fmt(median(floorsEsm))}ms  [${range(floorsEsm)}]`,
);
console.log(
    `reference  DIRECT (child alone):      median ${fmt(median(directs))}ms  [${range(directs)}]`,
);
const sup = absolute.get("child-listening") ?? [];
console.log(
    `derived    SUPERVISOR to child-ready: median ${fmt(median(sup))}ms  [${range(sup)}]`,
);
console.log(
    `derived    wrapper overhead:          ${fmt(median(sup) - median(directs))}ms (supervisor-to-child-ready − direct)`,
);
const entryEval = absolute.get("entry-eval") ?? [];
console.log(
    `derived    entry graph + esm loader:  ${fmt(median(entryEval) - median(floorsInproc))}ms (entry-eval − in-process floor)`,
);
console.log(
    `derived    knext entry graph ALONE:   ${fmt(median(entryEval) - median(floorsEsm))}ms (entry-eval − esm-import floor)`,
);
