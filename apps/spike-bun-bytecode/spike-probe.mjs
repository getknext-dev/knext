// Boot the compiled binary and probe SSR + dynamic route + API. Argv[2] = cwd to
// run the binary in (the standalone app dir, which has .next/server on disk).
import { spawn } from 'node:child_process';

const BIN =
  '/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad/spike-plugin';
const CWD = process.argv[2];
const PORT = 3187;
const base = `http://127.0.0.1:${PORT}`;

const proc = spawn(BIN, [], {
  cwd: CWD,
  env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => (log += d));
proc.stderr.on('data', (d) => (log += d));

async function waitReady(ms = 12000) {
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
const out = {};
if (!ready) {
  out.ready = false;
} else {
  out.ready = true;
  for (const [name, path] of [
    ['home_SSR', '/'],
    ['dynamic_route', '/item/42'],
    ['api_route', '/api/health'],
  ]) {
    try {
      const r = await fetch(base + path);
      const body = await r.text();
      out[name] = {
        status: r.status,
        len: body.length,
        snippet: body.slice(0, 60).replace(/\n/g, ' '),
      };
    } catch (e) {
      out[name] = { error: String(e) };
    }
  }
}
proc.kill('SIGKILL');
console.log(JSON.stringify(out, null, 2));
console.log('--- server log tail ---\n' + log.slice(-2800));
