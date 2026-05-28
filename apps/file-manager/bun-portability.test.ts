// @vitest-environment node
/**
 * TDD (POC-ADAPTER-P2): Bun portability proof.
 *
 * Must run in 'node' environment (not happy-dom) so child_process + net work.
 *
 * SKIP CONDITIONS (CI-safe):
 *   - Bun is not on PATH (no BUN_BIN env var and `bun` not found)
 *   - .next/standalone/.../server.js does not exist (no production build present)
 *
 * Both conditions are absent locally after `next build --webpack`; they are present
 * on CI runners that don't install Bun or run the build step.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve paths relative to this test file so they work from any checkout location.
const __filename = fileURLToPath(import.meta.url);
const APP_DIR = dirname(__filename);
const STANDALONE_SERVER = resolve(APP_DIR, '.next/standalone/apps/file-manager/server.js');
const STANDALONE_CWD = resolve(APP_DIR, '.next/standalone/apps/file-manager');

// Prefer BUN_BIN env var (set in CI if bun is available); fall back to 'bun' on PATH.
const BUN_BIN = process.env.BUN_BIN ?? 'bun';
const BUN_PORT = 3993;

/** Return the bun version string, or null if bun is not on PATH. */
function bunVersion(): string | null {
  try {
    return execSync(`${BUN_BIN} --version`, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

const serverExists = existsSync(STANDALONE_SERVER);
const bunAvailable = bunVersion() !== null;

// Skip the whole suite when prerequisites are absent.
// These skips are precise: they fire only when bun or the build output is absent.
const skipReason = !serverExists
  ? 'standalone server.js not found — run `next build --webpack` first'
  : !bunAvailable
    ? 'bun not on PATH — install Bun or set BUN_BIN env var'
    : null;

describe('Bun portability proof (POC-ADAPTER-P2)', () => {
  it('standalone server.js exists (produced by next build --webpack)', () => {
    if (!serverExists) {
      console.log(`SKIP: ${skipReason}`);
      return;
    }
    expect(existsSync(STANDALONE_SERVER)).toBe(true);
  });

  it.skipIf(skipReason !== null)('bun binary is available', () => {
    const ver = bunVersion()!;
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(skipReason !== null)(
    'bun server.js starts and serves HTTP 200 on / and /api/health',
    () => {
      // Self-contained Node.js probe: spawns Bun, polls until ready, GETs routes, kills Bun.
      const probe = /* js */ `
      const { spawn } = require('node:child_process');
      const { createConnection } = require('node:net');

      const PORT = ${BUN_PORT};
      const SERVER = ${JSON.stringify(STANDALONE_SERVER)};
      const CWD = ${JSON.stringify(STANDALONE_CWD)};
      const BUN_BIN = ${JSON.stringify(BUN_BIN)};

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
        const bun = spawn(BUN_BIN, [SERVER], {
          env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
          cwd: CWD,
          stdio: 'pipe',
        });

        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try { await httpGet('/api/health', 2000); break; }
          catch { await new Promise(r => setTimeout(r, 400)); }
        }

        const [home, health] = await Promise.all([httpGet('/'), httpGet('/api/health')]);
        bun.kill('SIGTERM');
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
    },
    35000,
  );
});
