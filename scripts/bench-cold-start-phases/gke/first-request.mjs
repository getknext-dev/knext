// First-request micro-trace (2026-10-01 GKE runtime/minimisation sitting).
// Runs INSIDE a pod built from a bench image (same CPU limit as the bench), so it
// isolates the app's own cost from Knative/kubelet:
//
//   node first-request.mjs [--gap=<ms>] <server command...>
//   bun  first-request.mjs [--gap=<ms>] <server command...>
//
// Spawns the server, polls 127.0.0.1:3000 every 5 ms until it accepts a TCP
// connection ("listening"), optionally idles --gap ms (so a CPU profile can tell
// boot samples from first-request samples), then times, back to back: GET
// /api/health twice, then GET / twice. Prints one JSON line, then SIGINTs the
// server (Next exits on SIGINT, which is when --cpu-prof writes its profile).
import { spawn } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
const gap = Number(argv.find((a) => a.startsWith('--gap='))?.split('=')[1] ?? 0);
const [cmd, ...args] = argv.filter((a) => !a.startsWith('--gap='));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
let log = '';
child.stdout.on('data', (d) => {
  log += d;
});
child.stderr.on('data', (d) => {
  log += d;
});
const accepts = () =>
  new Promise((res) => {
    const s = net.connect(3000, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
  });
while (!(await accepts())) await sleep(5);
const listen = performance.now() - t0;
if (gap) await sleep(gap);
const time = async (p) => {
  const a = performance.now();
  const r = await fetch(`http://127.0.0.1:3000${p}`);
  await r.text();
  return { status: r.status, ms: Math.round(performance.now() - a) };
};
const health1 = await time('/api/health');
const health2 = await time('/api/health');
const root1 = await time('/');
const root2 = await time('/');
// biome-ignore lint/suspicious/noConsole: bench script, stdout is its output contract
console.log(
  JSON.stringify({
    cmd: [cmd, ...args].join(' '),
    listen_ms: Math.round(listen),
    health1,
    health2,
    root1,
    root2,
    compile_cache_lines: (log.match(/\[compile cache\][^\n]*/g) ?? []).length,
    cc_accepted: (log.match(/was accepted/g) ?? []).length,
    cc_rejected: (log.match(/rejected|mismatch|failed/gi) ?? []).length,
  }),
);
child.kill('SIGINT');
await sleep(2000);
process.exit(0);
