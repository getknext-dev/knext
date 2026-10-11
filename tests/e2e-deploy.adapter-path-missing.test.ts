import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #2124 — scripts/e2e-deploy.sh must FAIL the deploy when the adapterPath-blanking
 * module is unavailable and the installed Next version is readable (the module is
 * required on every Next version now). When the version is unreadable (the contract
 * tests' fake `next`) it only warns. Real bash against a fake fixture-local `next`.
 */
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER = `
const http = require('node:http');
http.createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT || 3000), process.env.HOSTNAME || '0.0.0.0');
`;

const dirs: string[] = [];

function deploy(nextVersion: string | null): number | null {
  const app = mkdtempSync(join(tmpdir(), 'knext-adapterfix-'));
  dirs.push(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'f', private: true, scripts: { build: 'next build' } }),
  );
  writeFileSync(join(app, 'next.config.js'), "module.exports = { output: 'standalone' };\n");
  mkdirSync(join(app, 'node_modules', '.bin'), { recursive: true });
  if (nextVersion !== null) {
    mkdirSync(join(app, 'node_modules', 'next'), { recursive: true });
    writeFileSync(
      join(app, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', version: nextVersion }),
    );
  }
  const bin = join(app, 'node_modules', '.bin', 'next');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
if (process.argv[2] !== 'build') process.exit(0);
const n = path.join(${JSON.stringify(app)}, '.next'); const s = path.join(n, 'standalone');
fs.mkdirSync(path.join(n, 'static'), { recursive: true }); fs.mkdirSync(s, { recursive: true });
fs.writeFileSync(path.join(n, 'BUILD_ID'), 'b');
fs.writeFileSync(path.join(s, 'server.js'), ${JSON.stringify(FAKE_SERVER)});
`,
  );
  chmodSync(bin, 0o755);
  const r = spawnSync('bash', [DEPLOY_SH], {
    cwd: app,
    env: {
      ...process.env,
      KNEXT_E2E_SKIP_PACK: '1',
      KNEXT_RUNTIME: 'node',
      // The module is missing: points at a file that does not exist.
      KNEXT_ADAPTER_PATH_FIX: join(app, 'no-such-adapter-path-fix.mjs'),
      NEXT_TEST_MODE: 'deploy',
      NEXT_PRIVATE_TEST_MODE: '',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  spawnSync('bash', [CLEANUP_SH], { cwd: app, env: { ...process.env }, timeout: 20_000 });
  return r.status;
}

afterAll(() => {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('e2e-deploy.sh requires the adapterPath-blanking module on a readable Next (#2124)', () => {
  for (const v of ['16.3.8', '16.4.0', '17.0.0']) {
    it(`Next ${v} with the module missing fails the deploy (exit 1)`, () => {
      expect(deploy(v)).toBe(1);
    });
  }

  it('an unreadable Next version only warns and the deploy succeeds (exit 0)', () => {
    expect(deploy(null)).toBe(0);
  });
});
