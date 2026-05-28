/**
 * TDD (POC-ADAPTER-P1): NODE_COMPILE_CACHE smoke test.
 * RED: fails until .next/standalone/server.js exists (needs a successful build).
 *
 * Verifies that starting the standalone server with NODE_COMPILE_CACHE set
 * results in .v8-compile-cache-* files being created in the designated dir.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKTREE = '/Users/banna/alpheya/pocs/worktrees/knext/POC-ADAPTER';
const APP_DIR = join(WORKTREE, 'apps/file-manager');
const STANDALONE_SERVER = join(APP_DIR, '.next/standalone/apps/file-manager/server.js');
const CACHE_DIR = join(tmpdir(), 'knext-compile-cache-test');

describe('NODE_COMPILE_CACHE proof (POC-ADAPTER-P1)', () => {
  beforeAll(() => {
    mkdirSync(CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  });

  it('standalone server.js exists after next build', () => {
    // This test confirms the build produced standalone output.
    // If it fails, run: cd apps/file-manager && next build --webpack
    expect(existsSync(STANDALONE_SERVER)).toBe(true);
  });

  it('NODE_COMPILE_CACHE dir is populated when standalone server is required', () => {
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
        cwd: join(APP_DIR, '.next/standalone/apps/file-manager'),
      });
    } catch {
      // Exit 0 from our process.exit(0) or any error — we just need V8 to flush
    }

    const cacheFiles = readdirSync(CACHE_DIR);
    expect(cacheFiles.length).toBeGreaterThan(0);
  });
});
