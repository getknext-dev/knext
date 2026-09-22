// Probe the UNCOMPILED standalone: `bun run server.js` in the app dir.
import { spawn } from 'node:child_process';
const CWD = process.argv[2];
const PORT = 3188;
const base = `http://127.0.0.1:${PORT}`;
const proc = spawn('bun', ['run', 'server.js'], {
  cwd: CWD,
  env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => (log += d));
proc.stderr.on('data', (d) => (log += d));
async function waitReady(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const ready = await waitReady();
const out = { ready };
if (ready) {
  for (const [n, p] of [
    ['home', '/'],
    ['dynamic', '/item/42'],
    ['api', '/api/health'],
  ]) {
    try {
      const r = await fetch(base + p);
      out[n] = { status: r.status, len: (await r.text()).length };
    } catch (e) {
      out[n] = { error: String(e) };
    }
  }
}
proc.kill('SIGKILL');
console.log(JSON.stringify(out, null, 2));
if (!ready || Object.values(out).some((v) => v?.status === 500))
  console.log('--- log ---\n' + log.slice(-2000));
