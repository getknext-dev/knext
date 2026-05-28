// Debug probe: same logic as the vitest test, run standalone
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const SERVER = '/Users/banna/alpheya/pocs/worktrees/knext/POC-ADAPTER/apps/file-manager/.next/standalone/apps/file-manager/server.js';
const CWD = '/Users/banna/alpheya/pocs/worktrees/knext/POC-ADAPTER/apps/file-manager/.next/standalone/apps/file-manager';
const PORT = 3994;

console.log('Spawning bun...');
const p = spawn('/Users/banna/.bun/bin/bun', [SERVER], {
  env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
  cwd: CWD,
  stdio: 'pipe',
});

p.stdout.on('data', (d) => console.log('STDOUT:', d.toString().trim()));
p.stderr.on('data', (d) => console.log('STDERR:', d.toString().trim()));
p.on('error', (e) => { console.error('SPAWN ERROR:', e); process.exit(1); });

// Poll for ready
let attempts = 0;
const poll = setInterval(async () => {
  attempts++;
  try {
    const res = await new Promise((resolve, reject) => {
      const s = createConnection(PORT, '127.0.0.1');
      let raw = '';
      s.on('connect', () => s.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`));
      s.on('data', d => raw += d);
      s.on('end', () => {
        const status = Number(raw.split('\r\n')[0].split(' ')[1]);
        resolve(status);
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 1500);
    });
    console.log(`Attempt ${attempts}: HTTP status ${res} ✓`);
    clearInterval(poll);
    p.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    console.log(`Attempt ${attempts}: ${e.message}`);
    if (attempts > 20) {
      console.log('FAILED: server did not start');
      p.kill('SIGTERM');
      process.exit(1);
    }
  }
}, 500);
