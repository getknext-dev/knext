// General HTTP throughput/latency load tester for any running knext endpoint —
// the bun-exec binary, the node standalone, or a deployed Knative URL. Drives C
// concurrent keep-alive workers at a path for DURATION_MS and reports RPS +
// p50/p95/p99/max. Does NOT start a server (point it at a running one), so the
// same tool works locally and against OKE.
//
//   KNEXT_BENCH_URL=http://127.0.0.1:8080 [PATH=/api/health] [C=50] [DURATION_MS=8000] \
//     node packages/kn-next/bench/http-loadtest.mjs
//
// On one machine the Node client competes with the server for CPU, so local RPS
// is client-limited (a floor on server capacity, not a ceiling); latency
// percentiles are the more portable signal. Against a remote URL it is a real
// closed-loop load test.
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE = process.env.KNEXT_BENCH_URL || "http://127.0.0.1:8080";
const PATH = process.env.PATH_ || process.env.BENCH_PATH || "/api/health";
const C = Number(process.env.C || 50);
const DURATION_MS = Number(process.env.DURATION_MS || 8000);
const WARMUP = Number(process.env.WARMUP || 2000);

const u = new URL(BASE);
const lib = u.protocol === "https:" ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: C + 10 });

function get() {
    return new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint();
        const req = lib.get(
            {
                host: u.hostname,
                port: u.port || (u.protocol === "https:" ? 443 : 80),
                path: PATH,
                agent,
            },
            (res) => {
                res.resume();
                res.on("end", () =>
                    resolve({
                        status: res.statusCode,
                        us: Number(process.hrtime.bigint() - t0) / 1000,
                    }),
                );
            },
        );
        req.on("error", reject);
    });
}

for (let i = 0; i < WARMUP; i++) await get().catch(() => {});

const lat = [];
let ok = 0;
let err = 0;
const deadline = Date.now() + DURATION_MS;
async function worker() {
    while (Date.now() < deadline) {
        try {
            const r = await get();
            if (r.status === 200) {
                ok++;
                lat.push(r.us);
            } else err++;
        } catch {
            err++;
        }
    }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: C }, worker));
const elapsed = (Date.now() - t0) / 1000;

lat.sort((a, b) => a - b);
const p = (q) => (lat.length ? lat[Math.floor((lat.length - 1) * q)] / 1000 : NaN);
console.log(`\n=== ${BASE}${PATH} throughput (C=${C}, ${elapsed.toFixed(1)}s) ===`);
console.log(`requests: ${ok} ok, ${err} err`);
console.log(`throughput: ${Math.round(ok / elapsed)} req/s`);
console.log(
    `latency ms — p50 ${p(0.5).toFixed(3)}  p95 ${p(0.95).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${(lat[lat.length - 1] / 1000).toFixed(3)}`,
);
