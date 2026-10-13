import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #2296 — at vercel/next.js v16.4.0, transpile-packages-typescript-foreign
 * deploys for the first time. Its fixture declares `pkg: file:./pkg` (a
 * TypeScript package) and asserts that `next build` FAILS without
 * `transpilePackages`, because the platform installs `file:` dependencies
 * inside node_modules (pnpm copies them into its virtual store), where Next
 * does not transpile them. e2e-deploy.sh's `npm install <knext tarballs>`
 * re-pointed `node_modules/pkg` at the fixture SOURCE (npm links `file:`
 * directories), so Next compiled it as app code and the build passed (v2 run
 * 38384745675, shard 13/16, FINAL 3/3).
 *
 * The fix restores, after the install, every `file:` dependency the fixture
 * declares whose node_modules entry npm re-pointed. This test runs the REAL
 * deploy script through its REAL npm path, offline, on a pnpm-shaped tree.
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

let stageDir = '';
let appDir = '';
let result: ReturnType<typeof spawnSync>;

describe('scripts/e2e-deploy.sh — fixture file: dependencies keep their installed location (#2296)', () => {
  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-filedep-stubs-'));
    const tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
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

    // The harness test dir as pnpm leaves it: the file: dependency's source
    // in the app, a COPY in the virtual store, and node_modules/pkg linking to
    // the copy (never to the source).
    appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-filedep-'));
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture-app',
          version: '0.0.0',
          private: true,
          dependencies: { pkg: 'file:./pkg' },
        },
        null,
        2,
      ),
    );
    const pkgJson = JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.ts' });
    mkdirSync(join(appDir, 'pkg'), { recursive: true });
    writeFileSync(join(appDir, 'pkg', 'package.json'), pkgJson);
    writeFileSync(join(appDir, 'pkg', 'index.ts'), 'export const x: number = 1\n');
    const store = join(appDir, 'node_modules', '.pnpm', 'pkg@file+pkg', 'node_modules', 'pkg');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'package.json'), pkgJson);
    writeFileSync(join(store, 'index.ts'), 'export const x: number = 1\n');
    symlinkSync(
      join('.pnpm', 'pkg@file+pkg', 'node_modules', 'pkg'),
      join(appDir, 'node_modules', 'pkg'),
    );
    mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
    const nextBin = join(appDir, 'node_modules', '.bin', 'next');
    writeFileSync(nextBin, fakeNextScript(appDir));
    chmodSync(nextBin, 0o755);

    result = spawnSync('bash', [DEPLOY_SH], {
      cwd: appDir,
      env: {
        ...process.env,
        KNEXT_E2E_TARBALLS_DIR: tarballsDir,
        KNEXT_RUNTIME: 'node',
        npm_config_offline: 'true',
      },
      encoding: 'utf8',
      timeout: 120000,
    });
  }, 150000);

  afterAll(() => {
    if (existsSync(CLEANUP_SH) && appDir) {
      spawnSync('bash', [CLEANUP_SH], { cwd: appDir, env: { ...process.env }, timeout: 20000 });
    }
    if (appDir && existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('the deploy succeeds', () => {
    expect(result.status, String(result.stderr)).toBe(0);
  });

  it('the knext adapter tarball really installed', () => {
    const r = spawnSync(
      'node',
      ['-e', 'process.stdout.write(require.resolve("@getknext/core/adapter"))'],
      { cwd: appDir, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
  });

  it('node_modules/pkg still resolves inside node_modules (the virtual-store copy), not to the fixture source', () => {
    const real = realpathSync(join(appDir, 'node_modules', 'pkg'));
    expect(real).toBe(
      realpathSync(join(appDir, 'node_modules', '.pnpm', 'pkg@file+pkg', 'node_modules', 'pkg')),
    );
    expect(real).not.toBe(realpathSync(join(appDir, 'pkg')));
  });

  it('the restore is logged', () => {
    expect(String(result.stderr)).toContain('restoring fixture file: dependency node_modules/pkg');
  });
});
