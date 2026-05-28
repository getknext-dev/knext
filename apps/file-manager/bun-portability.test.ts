// @vitest-environment node
/**
 * TDD (POC-ADAPTER-P2): Bun portability proof.
 *
 * Must run in 'node' environment (not happy-dom) so child_process + net work.
 *
 * Verifies that the same .next/standalone/server.js produced by `next build`
 * can be run under the Bun runtime (plain `bun server.js`, no --compile).
 * Bun's Node.js compat layer handles Next.js internals.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKTREE = '/Users/banna/alpheya/pocs/worktrees/knext/POC-ADAPTER';
const APP_DIR = join(WORKTREE, 'apps/file-manager');
const STANDALONE_SERVER = join(APP_DIR, '.next/standalone/apps/file-manager/server.js');
const STANDALONE_CWD = join(APP_DIR, '.next/standalone/apps/file-manager');
const BUN_BIN = '/Users/banna/.bun/bin/bun';
const BUN_PORT = 3993;

describe('Bun portability proof (POC-ADAPTER-P2)', () => {
  it('standalone server.js exists (produced by next build --webpack)', () => {
    expect(existsSync(STANDALONE_SERVER)).toBe(true);
  });

  it('bun binary is available', () => {
    const ver = execSync(`${BUN_BIN} --version`, { encoding: 'utf8' }).trim();
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('bun server.js starts and serves HTTP 200 on / and /api/health', () => {
    // Use a self-contained Node.js probe script run via execFileSync so the
    // TCP connection is made in a fresh child process (avoids vitest env shims).
    // The probe starts Bun, polls until ready, makes GET requests, kills Bun, prints results.
    const probe = /* js */ `
      const { spawn } = require('node:child_process');
      const { createConnection } = require('node:net');

      const PORT = ${BUN_PORT};
      const SERVER = ${JSON.stringify(STANDALONE_SERVER)};
      const CWD = ${JSON.stringify(STANDALONE_CWD)};

      function httpGet(path, timeoutMs) {
        return new Promise((resolve, reject) => {
          const s = createConnection(PORT, '127.0.0.1');
          let raw = '';
          s.on('connect', () => s.write('GET ' + path + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + PORT + '\\r\\nConnection: close\\r\\n\\r\\n'));
          s.on('data', d => raw += d);
          s.on('end', () => {
            const status = Number(raw.split('\\r\\n')[0].split(' ')[1]);
            resolve({ status, body: raw });
          });
          s.on('error', reject);
          setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs || 3000);
        });
      }

      async function main() {
        const bun = spawn(${JSON.stringify(BUN_BIN)}, [SERVER], {
          env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
          cwd: CWD,
          stdio: 'pipe',
        });

        // Poll until server is ready (max 15s)
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            await httpGet('/api/health', 2000);
            break;
          } catch {
            await new Promise(r => setTimeout(r, 400));
          }
        }

        const [home, health] = await Promise.all([httpGet('/'), httpGet('/api/health')]);
        bun.kill('SIGTERM');

        // Output JSON for the test to parse
        console.log(JSON.stringify({ homeStatus: home.status, healthStatus: health.status, healthBody: health.body.split('\\r\\n\\r\\n')[1] }));
      }
      main().catch(e => { console.error(e); process.exit(1); });
    `;

    const result = execFileSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      timeout: 30000,
    });

    const { homeStatus, healthStatus, healthBody } = JSON.parse(result.trim());
    expect(homeStatus).toBe(200);
    expect(healthStatus).toBe(200);
    expect(healthBody).toContain('"status"');
  }, 35000);
});
