// Reproducible cold-start micro-benchmark for the knext supervisor overhead (#441,
// benchmark doc "Run 20"). Self-contained: deploys a self-contained @knext/core
// (the shipped-image layout), stubs Next's server.js with a fast fixture, and
// times the supervisor's ADDITIVE cold-start cost in alternating pairs (the
// project's evidence bar = distribution separation).
//
//   node packages/kn-next/bench/coldstart-supervisor-overhead.mjs   [N=12]
//
// DIRECT     = `node <fast-fixture>` binding $PORT (Next's own boot, stubbed fast).
// SUPERVISOR = shipped CMD `node -e import('@knext/core/internal/node-server')`
//              spawning the SAME fixture via STANDALONE_SERVER_PATH.
// The DELTA is the wrapper's own overhead (parent module load + eager wiring +
// :9091 bind + spawn + the inherent second Node process). A fast fixture removes
// Next's ~1957ms boot so only the supervisor cost remains.
//
// Absolute numbers are machine-specific; report the DELTA and the separation. An
// OKE re-measure with `KNEXT_BENCH_STANDALONE` pointed at a real standalone build
// is what closes #441 for the deployed path.
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
import { fileURLToPath } from "node:url";

const N = Number(process.env.N || 12);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// 1. Self-contained @knext/core deploy (dist + prod node_modules), the shipped layout.
const deploy = mkdtempSync(join(tmpdir(), "knext-core-deploy-"));
process.stderr.write("deploying @knext/core (prod)…\n");
const dep = spawnSync(
    "pnpm",
    ["--filter", "@knext/core", "--prod", "deploy", "--legacy", deploy],
    { cwd: repoRoot, encoding: "utf8" },
);
if (
    dep.status !== 0 ||
    !existsSync(join(deploy, "dist/adapters/node-server.js"))
) {
    console.error("deploy failed — run `pnpm --filter @knext/core build` first");
    console.error((dep.stderr || "").split("\n").slice(-6).join("\n"));
    process.exit(2);
}

// 2. Runner dir whose node_modules/@knext/core -> the deploy (one resolvable core).
const runner = mkdtempSync(join(tmpdir(), "knext-cs-runner-"));
mkdirSync(join(runner, "node_modules", "@knext"), { recursive: true });
symlinkSync(deploy, join(runner, "node_modules", "@knext", "core"));

// 3. Fast fixture: instant-boot stand-in for Next's server.js.
const fixture =
    process.env.KNEXT_BENCH_STANDALONE || join(runner, "fast-server.mjs");
if (!process.env.KNEXT_BENCH_STANDALONE) {
    writeFileSync(
        fixture,
        `import http from "node:http";
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, {"content-type":"application/json"}); res.end('{"status":"ok"}'); return; }
  res.writeHead(200); res.end("ok");
}).listen(port, "0.0.0.0");
`,
    );
}

async function ready(port, deadlineMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200)
                return true;
        } catch {
            /* not up */
        }
        await new Promise((r) => setTimeout(r, 5));
    }
    return false;
}

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

async function measure(port, argv, extraEnv) {
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, {
        cwd: runner,
        env: { ...process.env, PORT: String(port), ...extraEnv },
        detached: true,
        stdio: "ignore",
    });
    const ok = await ready(port, 20000);
    const dt = Date.now() - t0;
    killTree(child);
    await new Promise((r) => setTimeout(r, 200));
    return ok ? dt : null;
}

const direct = (p) => measure(p, [fixture], {});
const supervisor = (p) =>
    measure(p, ["-e", "import('@knext/core/internal/node-server')"], {
        METRICS_PORT: String(p + 10000),
        STANDALONE_SERVER_PATH: fixture,
        CACHE_INVALIDATE_TOKEN: "bench",
    });

await direct(41000); // warm-up (discarded)
await supervisor(41001);
const dArr = [];
const sArr = [];
for (let i = 0; i < N; i++) {
    const p = 42000 + i * 4;
    dArr.push(await direct(p));
    sArr.push(await supervisor(p + 1));
    process.stderr.write(
        `pair ${i + 1}/${N}: direct=${dArr[i]}ms supervisor=${sArr[i]}ms\n`,
    );
}

const clean = (a) => a.filter((x) => x != null).sort((x, y) => x - y);
const med = (a) => {
    const s = clean(a);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const d = clean(dArr);
const s = clean(sArr);
console.log("\n=== supervisor cold-start overhead (local, fast fixture) ===");
console.log(`samples: ${N} pairs`);
console.log(`DIRECT:     median ${med(dArr)}ms  range [${d[0]}..${d[d.length - 1]}]`);
console.log(`SUPERVISOR: median ${med(sArr)}ms  range [${s[0]}..${s[s.length - 1]}]`);
console.log(`DELTA (overhead): ${med(sArr) - med(dArr)}ms`);
console.log(
    `distribution separation: ${s[0] > d[d.length - 1] ? "YES" : "NO (overlap)"}`,
);
