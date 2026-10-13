import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #2296 — at vercel/next.js v16.4.0 three deploy-suite files that used to set
 * `skipDeployment` now deploy (gssp-redirect, gssp-redirect-base-path,
 * router-hash-navigation), and each pins `react@19.3.0-canary-…` in its own
 * fixture. next@16.4.0 peers on `react ^19.0.0`, which excludes prereleases,
 * so e2e-deploy.sh's `npm install <knext tarballs>` into that tree failed with
 * ERESOLVE before knext was ever built (v2 run 38384745675, shards 3/7/8).
 * Vercel installs the same fixtures with pnpm, which only warns on a peer
 * mismatch. The conflict is the fixture's own pin against next's peer range,
 * not anything knext ships.
 *
 * The fix retries the tarball install ONCE with --legacy-peer-deps, and only
 * when the first attempt failed with ERESOLVE, so every fixture that installs
 * today keeps exactly today's install. This test runs the REAL deploy script
 * through its REAL npm path, offline, on a tree that reproduces the ERESOLVE,
 * and checks the other half too: a non-ERESOLVE install failure still fails
 * the deploy (no blanket retry).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(port, host, () => console.log('fixture server on ' + host + ':' + port));
`;

function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'build') { process.exit(0); }
const app = ${JSON.stringify(targetAppDir)};
const nextDir = path.join(app, '.next');
const standalone = path.join(nextDir, 'standalone');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
fs.writeFileSync(path.join(standalone, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
const tracedNext = path.join(standalone, 'node_modules', 'next');
fs.mkdirSync(path.join(tracedNext, 'dist', 'server', 'lib'), { recursive: true });
fs.writeFileSync(path.join(tracedNext, 'package.json'), '{"name":"next","main":"index.js"}');
fs.writeFileSync(path.join(tracedNext, 'index.js'), 'module.exports = {};');
fs.writeFileSync(path.join(tracedNext, 'dist', 'server', 'lib', 'start-server.js'), 'module.exports = {};');
console.log('[fake-next] build complete (fixture)');
`;
}

function packStub(
  stageDir: string,
  tarballsDir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const dir = join(stageDir, String(pkg.name).replace('/', '__'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('npm', ['pack', '--pack-destination', tarballsDir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function packKnextStubs(stageDir: string, tarballsDir: string): void {
  packStub(
    stageDir,
    tarballsDir,
    { name: '@getknext/lib', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
  );
  packStub(
    stageDir,
    tarballsDir,
    { name: '@getknext/db', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
  );
  packStub(
    stageDir,
    tarballsDir,
    {
      name: '@getknext/core',
      version: '0.0.0-test',
      exports: {
        './adapter': './dist/adapters/next-adapter.js',
        './internal/cache-control-normalize': './dist/adapters/cache-control-normalize.cjs',
        './internal/bun-keepalive-guard': './dist/adapters/bun-keepalive-guard.cjs',
      },
      dependencies: { '@getknext/lib': '0.0.0-test' },
    },
    {
      'dist/adapters/next-adapter.js': 'module.exports = {};\n',
      'dist/adapters/cache-control-normalize.cjs': 'module.exports = {};\n',
      'dist/adapters/bun-keepalive-guard.cjs': 'module.exports = {};\n',
    },
  );
}

/**
 * A harness test dir shaped like the v16.4.0 gssp-redirect fixture after the
 * harness's own install: the root pins a prerelease react, and an installed
 * package (standing in for next@16.4.0) peers on `react ^19.0.0`.
 */
function makeCanaryPinnedApp(): string {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-eresolve-'));
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        version: '0.0.0',
        private: true,
        dependencies: { 'peer-host': '1.0.0', react: '19.3.0-canary-fef12a01-20260413' },
      },
      null,
      2,
    ),
  );
  const nm = join(appDir, 'node_modules');
  mkdirSync(join(nm, 'peer-host'), { recursive: true });
  writeFileSync(
    join(nm, 'peer-host', 'package.json'),
    JSON.stringify({ name: 'peer-host', version: '1.0.0', peerDependencies: { react: '^19.0.0' } }),
  );
  mkdirSync(join(nm, 'react'), { recursive: true });
  writeFileSync(
    join(nm, 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '19.3.0-canary-fef12a01-20260413', main: 'index.js' }),
  );
  writeFileSync(join(nm, 'react', 'index.js'), "module.exports = 'canary-react';\n");
  mkdirSync(join(nm, '.bin'), { recursive: true });
  const nextBin = join(nm, '.bin', 'next');
  writeFileSync(nextBin, fakeNextScript(appDir));
  chmodSync(nextBin, 0o755);
  return appDir;
}

function runDeploy(appDir: string, tarballsDir: string) {
  return spawnSync('bash', [DEPLOY_SH], {
    cwd: appDir,
    env: {
      ...process.env,
      KNEXT_E2E_TARBALLS_DIR: tarballsDir,
      KNEXT_RUNTIME: 'node',
      // Hermetic: every package involved is local; never reach a registry.
      npm_config_offline: 'true',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
}

function cleanup(appDir: string): void {
  if (existsSync(CLEANUP_SH) && appDir) {
    spawnSync('bash', [CLEANUP_SH], { cwd: appDir, env: { ...process.env }, timeout: 20000 });
  }
  if (appDir && existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
}

describe('scripts/e2e-deploy.sh — a fixture pinning a prerelease react still installs the knext tarballs (#2296)', () => {
  let stageDir = '';
  let tarballsDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-eresolve-stubs-'));
    tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    appDir = makeCanaryPinnedApp();
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('self-check: a plain npm install of a tarball into this tree really fails with ERESOLVE', () => {
    const probeApp = makeCanaryPinnedApp();
    try {
      const r = spawnSync(
        'npm',
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          join(tarballsDir, 'getknext-lib-0.0.0-test.tgz'),
        ],
        { cwd: probeApp, env: { ...process.env, npm_config_offline: 'true' }, encoding: 'utf8' },
      );
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('ERESOLVE');
    } finally {
      rmSync(probeApp, { recursive: true, force: true });
    }
  });

  it('the deploy succeeds and prints exactly one URL line', () => {
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(() => new URL(lines[0])).not.toThrow();
  });

  it('the knext adapter tarball really installed into the fixture', () => {
    const r = spawnSync(
      'node',
      ['-e', 'process.stdout.write(require.resolve("@getknext/core/adapter"))'],
      { cwd: appDir, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join('@getknext', 'core'));
  });

  it("the fixture's own prerelease react pin is left in place", () => {
    const r = spawnSync('node', ['-e', 'process.stdout.write(require("react"))'], {
      cwd: appDir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('canary-react');
  });

  it('the retry is logged, naming ERESOLVE and --legacy-peer-deps', () => {
    expect(result.stderr).toMatch(/ERESOLVE.*--legacy-peer-deps|--legacy-peer-deps.*ERESOLVE/);
  });
});

describe('scripts/e2e-deploy.sh — a NON-ERESOLVE install failure still fails the deploy (#2296)', () => {
  let stageDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-badtgz-stubs-'));
    const tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    // Corrupt the core tarball: npm fails with a tar/gzip error, not ERESOLVE.
    writeFileSync(join(tarballsDir, 'getknext-core-0.0.0-test.tgz'), 'not a gzip stream\n');
    appDir = makeCanaryPinnedApp();
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('exits non-zero and does not print a URL', () => {
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('does not retry with --legacy-peer-deps', () => {
    expect(result.stderr).not.toContain('--legacy-peer-deps');
  });
});
