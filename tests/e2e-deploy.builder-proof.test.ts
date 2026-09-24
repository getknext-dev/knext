import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #1245 — the webpack credential cells must PROVE, per deploy, that the fixture
 * was really built by webpack.
 *
 * The bundler is chosen by `next build` reading IS_WEBPACK_TEST from the env it
 * inherits through run-tests.js → jest → next-deploy.ts → scripts/e2e-deploy.sh.
 * If that env were ever dropped on the way, `next build` silently defaults to
 * Turbopack, every deploy still goes green, and the webpack cell would bank
 * nights for turbopack output. So on KNEXT_BUILDER=webpack the deploy script
 * refuses a build that lacks webpack's server runtime
 * (`.next/server/webpack-runtime.js`, which Turbopack never emits).
 *
 * Same fake fixture-local `next` technique as e2e-deploy.native-ts-config.test.ts.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body>builder-proof fixture ok</body></html>');
}).listen(port, host);
`;

/** A fake `next` that emits a standalone tree, with or without webpack's server runtime. */
function fakeNextScript(appDir: string, emitWebpackRuntime: boolean, appSubdir = ''): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const app = ${JSON.stringify(appDir)};
if (process.argv[2] !== 'build') { process.exit(0); }
const nextDir = path.join(app, '.next');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'server'), { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
const appRoot = path.join(nextDir, 'standalone', ${JSON.stringify(appSubdir)});
fs.mkdirSync(appRoot, { recursive: true });
fs.writeFileSync(path.join(appRoot, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
// webpack traces react-dom into the standalone tree, so DECOY server.js files
// sit under node_modules — at the standalone root AND nested under the app
// root (monorepo) and deeper in a package; booting one serves nothing.
for (const d of [
  path.join(nextDir, 'standalone', 'node_modules', 'react-dom'),
  path.join(appRoot, 'node_modules', 'react-dom'),
  path.join(nextDir, 'standalone', 'node_modules', 'next', 'dist'),
]) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'server.js'), 'process.exit(1);');
}
if (${emitWebpackRuntime}) fs.writeFileSync(path.join(nextDir, 'server', 'webpack-runtime.js'), '// webpack');
console.log('[fake-next] build complete');
`;
}

const madeDirs: string[] = [];

/**
 * A `find` shim that returns real results SORTED, which lists
 * `.next/standalone/node_modules/…/server.js` before `.next/standalone/server.js`
 * — the order ext4 produced on a CI runner (a whole bun×webpack shard booted
 * react-dom's server.js). Makes that adverse order deterministic here.
 */
function sortedFindDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-find-shim-'));
  madeDirs.push(dir);
  const realFind = spawnSync('bash', ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(dir, 'find'), `#!/usr/bin/env bash\n"${realFind}" "$@" | LC_ALL=C sort\n`);
  chmodSync(join(dir, 'find'), 0o755);
  return dir;
}

function deploy(
  builder: string | undefined,
  emitWebpackRuntime: boolean,
  opts: { appSubdir?: string; adverseFind?: boolean } = {},
) {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-builder-'));
  madeDirs.push(appDir);
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', private: true }),
  );
  writeFileSync(join(appDir, 'next.config.js'), "module.exports = { output: 'standalone' }\n");
  mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
  const nextBin = join(appDir, 'node_modules', '.bin', 'next');
  writeFileSync(nextBin, fakeNextScript(appDir, emitWebpackRuntime, opts.appSubdir ?? ''));
  chmodSync(nextBin, 0o755);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KNEXT_E2E_SKIP_PACK: '1',
    KNEXT_RUNTIME: 'node',
  };
  delete env.KNEXT_BUILDER;
  if (builder !== undefined) env.KNEXT_BUILDER = builder;
  if (opts.adverseFind) env.PATH = `${sortedFindDir()}:${env.PATH}`;
  const r = spawnSync('bash', [DEPLOY_SH], { cwd: appDir, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

afterAll(() => {
  for (const d of madeDirs) {
    if (existsSync(CLEANUP_SH)) {
      spawnSync('bash', [CLEANUP_SH], { cwd: d, encoding: 'utf8', timeout: 20000 });
    }
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('scripts/e2e-deploy.sh — a webpack cell proves its build was webpack (#1245)', () => {
  it('KNEXT_BUILDER=webpack + a build WITHOUT webpack-runtime.js (Turbopack output) is refused', () => {
    const r = deploy('webpack', false);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(
      /KNEXT_BUILDER=webpack but the build emitted no \.next\/server\/webpack-runtime\.js/,
    );
  });

  it('the other half: KNEXT_BUILDER=webpack + a real webpack build deploys', () => {
    const r = deploy('webpack', true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^http:\/\//);
  });

  it('boots the APP server.js, never a node_modules/**/server.js listed before it', () => {
    const r = deploy('webpack', true, { adverseFind: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/standalone server: \S*\/\.next\/standalone\/server\.js\n/);
    expect(r.stderr).not.toMatch(/standalone server: \S*node_modules/);
  });

  it('…including a monorepo standalone tree (the app nested under its workspace path)', () => {
    // `packages/web/server.js` is the SAME depth as `node_modules/react-dom/server.js`
    // and sorts after it, so depth alone cannot pick the app — the node_modules
    // filter has to.
    const r = deploy('webpack', true, { adverseFind: true, appSubdir: 'packages/web' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(
      /standalone server: \S*\/\.next\/standalone\/packages\/web\/server\.js\n/,
    );
  });

  it('turbopack (and an unset builder) is unaffected — no webpack runtime required', () => {
    expect(deploy('turbopack', false).status).toBe(0);
    expect(deploy(undefined, false).status).toBe(0);
  });
});
