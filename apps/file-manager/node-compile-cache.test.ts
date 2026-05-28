/**
 * TDD (POC-ADAPTER-P1): NODE_COMPILE_CACHE smoke test.
 *
 * SKIP CONDITION (CI-safe):
 *   .next/standalone/.../server.js does not exist (no production build present).
 *   Runs locally after `next build --webpack`; skips cleanly on CI without a build.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Resolve paths relative to this test file — portable across any checkout.
const __filename = fileURLToPath(import.meta.url);
const APP_DIR = dirname(__filename);
const STANDALONE_SERVER = resolve(APP_DIR, '.next/standalone/apps/file-manager/server.js');
const STANDALONE_CWD = resolve(APP_DIR, '.next/standalone/apps/file-manager');
const CACHE_DIR = join(tmpdir(), 'knext-compile-cache-test');

const serverExists = existsSync(STANDALONE_SERVER);
const skipReason = serverExists
  ? null
  : 'standalone server.js not found — run `next build --webpack` first';

describe('NODE_COMPILE_CACHE proof (POC-ADAPTER-P1)', () => {
  beforeAll(() => {
    if (serverExists) mkdirSync(CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    if (serverExists) rmSync(CACHE_DIR, { recursive: true, force: true });
  });

  it('standalone server.js exists after next build', () => {
    if (!serverExists) {
      console.log(`SKIP: ${skipReason}`);
      return;
    }
    expect(existsSync(STANDALONE_SERVER)).toBe(true);
  });

  it.skipIf(skipReason !== null)(
    'NODE_COMPILE_CACHE dir is populated when standalone server is required',
    () => {
      // Probe: require the standalone server module in a child process with
      // NODE_COMPILE_CACHE set. The process exits immediately after load,
      // but V8 flushes compile cache on exit.
      const probe = `
      process.env.HOSTNAME = '127.0.0.1';
      process.env.PORT = '0';
      // Suppress actual server startup by stubbing listen
      const http = require('http');
      http.Server.prototype.listen = function() { process.exit(0); };
      try { require(${JSON.stringify(STANDALONE_SERVER)}); } catch(e) { process.exit(0); }
    `;

      try {
        execSync(`node -e ${JSON.stringify(probe)}`, {
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: CACHE_DIR,
            NODE_ENV: 'production',
          },
          timeout: 10000,
          cwd: STANDALONE_CWD,
        });
      } catch {
        // Exit 0 from our process.exit(0) or any error — we just need V8 to flush
      }

      const cacheFiles = readdirSync(CACHE_DIR);
      expect(cacheFiles.length).toBeGreaterThan(0);
    },
  );
});
