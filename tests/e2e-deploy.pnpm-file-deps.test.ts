import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #2316 — vercel/next.js v16.4.0 deploys `transpile-packages-typescript-foreign`
 * for the first time. Its `should fail` case expects `next build` to REJECT
 * an untranspiled TypeScript `file:./pkg` dependency. The fixture's
 * `vercel.json` sets `"installCommand": "pnpm install"`, and pnpm installs a
 * `file:` directory as a real package inside node_modules, so Next treats it as
 * a foreign package. e2e-deploy.sh installs with npm, which SYMLINKS
 * `node_modules/pkg -> ../pkg`; Next then compiles the realpath as app code and
 * the build succeeds, so the test fails (v2 runs 38392886692, 38470935854).
 *
 * `--install-links` does not help: npm >= 10 always links a project-internal
 * `file:./` dependency (arborist's isProjectInternalFileSpec), measured on npm
 * 11.9. So after the install, for a fixture whose vercel.json installCommand
 * names pnpm ONLY, the harness replaces each `file:` directory dependency's
 * node_modules symlink with a copy of its target. Every other fixture keeps
 * today's install (the native-addon `file:` fixtures carry no such vercel.json).
 *
 * This runs the REAL deploy script through its REAL npm path, offline, and has
 * the fake `next build` record the layout it sees AT BUILD TIME.
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

const LAYOUT_RECORD = '.knext-test-pkg-layout';

function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'build') { process.exit(0); }
const app = ${JSON.stringify(targetAppDir)};
// What a real next build would see: is node_modules/pkg a symlink to the
// fixture source, or a real package directory?
const dep = path.join(app, 'node_modules', 'pkg');
let layout = 'missing';
try { layout = fs.lstatSync(dep).isSymbolicLink() ? 'symlink' : 'dir'; } catch (_) {}
fs.writeFileSync(path.join(app, ${JSON.stringify(LAYOUT_RECORD)}), layout);
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
 * A harness test dir shaped like transpile-packages-typescript-foreign in
 * deploy mode (skipInstall: the platform installs): the root depends on
 * `pkg: file:./pkg`, a TypeScript package shipped inside the fixture, and
 * carries a vercel.json with the given installCommand.
 */
function makeFileDepApp(installCommand: string): string {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-filedep-'));
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      { name: 'fixture-app', version: '0.0.0', private: true, dependencies: { pkg: 'file:./pkg' } },
      null,
      2,
    ),
  );
  writeFileSync(join(appDir, 'vercel.json'), JSON.stringify({ installCommand }));
  mkdirSync(join(appDir, 'pkg'), { recursive: true });
  writeFileSync(
    join(appDir, 'pkg', 'package.json'),
    JSON.stringify({ name: 'pkg', version: '1.0.0' }),
  );
  writeFileSync(join(appDir, 'pkg', 'index.ts'), 'export const Foo: number = 123\n');
  mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
  const nextBin = join(appDir, 'node_modules', '.bin', 'next');
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

describe('scripts/e2e-deploy.sh — a fixture whose vercel.json installs with pnpm gets its file: deps as real packages (#2316)', () => {
  let stageDir = '';
  let tarballsDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-filedep-stubs-'));
    tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    appDir = makeFileDepApp('pnpm install');
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('self-check: npm --install-links still SYMLINKS a project-internal file: dep (so it is not the fix)', () => {
    const probeApp = makeFileDepApp('pnpm install');
    try {
      const r = spawnSync(
        'npm',
        ['install', '--install-links', '--no-save', '--no-audit', '--no-fund'],
        {
          cwd: probeApp,
          env: { ...process.env, npm_config_offline: 'true' },
          encoding: 'utf8',
        },
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(lstatSync(join(probeApp, 'node_modules', 'pkg')).isSymbolicLink()).toBe(true);
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

  it('next build saw node_modules/pkg as a real package directory, not a symlink', () => {
    expect(readFileSync(join(appDir, LAYOUT_RECORD), 'utf8')).toBe('dir');
  });

  it('the copied package carries the fixture source', () => {
    expect(readFileSync(join(appDir, 'node_modules', 'pkg', 'index.ts'), 'utf8')).toBe(
      'export const Foo: number = 123\n',
    );
    // The fixture's own source dir is left in place.
    expect(existsSync(join(appDir, 'pkg', 'index.ts'))).toBe(true);
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

  it('the copy is logged, naming the dependency and the pnpm installCommand', () => {
    expect(result.stderr).toMatch(/pnpm/);
    expect(result.stderr).toContain('node_modules/pkg');
  });
});

describe('scripts/e2e-deploy.sh — a fixture whose vercel.json does NOT install with pnpm keeps npm’s symlink (#2316)', () => {
  let stageDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-filedep-npm-stubs-'));
    const tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    appDir = makeFileDepApp('npm install');
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('the deploy succeeds', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('next build saw node_modules/pkg as npm’s symlink, exactly as before', () => {
    expect(readFileSync(join(appDir, LAYOUT_RECORD), 'utf8')).toBe('symlink');
  });
});
