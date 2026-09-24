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
function fakeNextScript(appDir: string, emitWebpackRuntime: boolean): string {
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
fs.writeFileSync(path.join(nextDir, 'standalone', 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
if (${emitWebpackRuntime}) fs.writeFileSync(path.join(nextDir, 'server', 'webpack-runtime.js'), '// webpack');
console.log('[fake-next] build complete');
`;
}

const madeDirs: string[] = [];

function deploy(builder: string | undefined, emitWebpackRuntime: boolean) {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-builder-'));
  madeDirs.push(appDir);
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', private: true }),
  );
  writeFileSync(join(appDir, 'next.config.js'), "module.exports = { output: 'standalone' }\n");
  mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
  const nextBin = join(appDir, 'node_modules', '.bin', 'next');
  writeFileSync(nextBin, fakeNextScript(appDir, emitWebpackRuntime));
  chmodSync(nextBin, 0o755);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KNEXT_E2E_SKIP_PACK: '1',
    KNEXT_RUNTIME: 'node',
  };
  delete env.KNEXT_BUILDER;
  if (builder !== undefined) env.KNEXT_BUILDER = builder;
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

  it('turbopack (and an unset builder) is unaffected — no webpack runtime required', () => {
    expect(deploy('turbopack', false).status).toBe(0);
    expect(deploy(undefined, false).status).toBe(0);
  });
});
