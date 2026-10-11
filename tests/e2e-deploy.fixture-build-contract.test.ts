import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * #2123 — scripts/e2e-deploy.sh reproduces the build and start contract the Next 16.4
 * fixtures assume. Real bash against fake fixtures (no network, no real Next):
 *
 *  1. A fixture build script that does NOT start with `next build` (monorepo wrappers,
 *     `pnpm run --dir apps/web build`, `nx run ...`) is EXECUTED, with its `prebuild` and
 *     `postbuild` hooks. It used to be logged and replaced by a bare `next build` at the
 *     project root, which finds no app directory or no symlink the hook creates.
 *  2. The harness tail `&& pnpm post-build` is NOT run (e2e-logs.sh provides those ids).
 *  3. `vercel.json` `outputDirectory` says where the build emitted its distDir
 *     (`apps/web/.next`, `apps/.next`): the server is found, and booted, from there.
 *  4. The port is chosen BEFORE the build and `PORT` is identical at build and at run, so a
 *     config that reads `process.env.PORT` while `next build` evaluates it (the
 *     `serverActions.allowedOrigins` fixture) sees the port the server binds.
 */
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER = `
const http = require('node:http');
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'SERVER_PORT'), String(process.env.PORT));
http.createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT || 3000), process.env.HOSTNAME || '0.0.0.0');
`;

const dirs: string[] = [];

function put(root: string, rel: string, body: string, mode?: number) {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
  if (mode) chmodSync(f, mode);
}

/** A build step in plain node that emits `<dist>/standalone/<appRel>/server.js` + BUILD_ID. */
function emitScript(
  appDirAbs: string,
  distRel: string,
  appRel: string,
  embeddedDistDir = './.next',
): string {
  // Next embeds the (standalone-relative) distDir in the generated server.js config.
  const server = `const nextConfig = {"distDir":${JSON.stringify(embeddedDistDir)}}\n${FAKE_SERVER}`;
  return `
const fs = require('node:fs'); const path = require('node:path');
const dist = path.join(${JSON.stringify(appDirAbs)}, ${JSON.stringify(distRel)});
const s = path.join(dist, 'standalone', ${JSON.stringify(appRel)});
fs.mkdirSync(path.join(dist, 'static'), { recursive: true }); fs.mkdirSync(s, { recursive: true });
fs.writeFileSync(path.join(dist, 'BUILD_ID'), 'b');
fs.writeFileSync(path.join(dist, 'static', 'chunk.js'), 'x');
fs.writeFileSync(path.join(s, 'server.js'), ${JSON.stringify(server)});
`;
}

function makeApp(): string {
  const app = mkdtempSync(join(tmpdir(), 'knext-fxbuild-'));
  dirs.push(app);
  mkdirSync(join(app, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(app, 'node_modules', 'next'), { recursive: true });
  writeFileSync(
    join(app, 'node_modules', 'next', 'package.json'),
    JSON.stringify({ name: 'next', version: '16.4.0' }),
  );
  // Stub the < 16.4.0 adapterPath workaround module: it is not under test here.
  put(
    app,
    'adapter-path-fix-stub.mjs',
    'export function blankStandaloneAdapterPath() { return { applied: false, nextVersion: "stub", reason: "stub" }; }\n',
  );
  return app;
}

function deploy(app: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [DEPLOY_SH], {
    cwd: app,
    env: {
      ...process.env,
      KNEXT_E2E_SKIP_PACK: '1',
      KNEXT_RUNTIME: 'node',
      KNEXT_ADAPTER_PATH_FIX: join(app, 'adapter-path-fix-stub.mjs'),
      NEXT_TEST_MODE: 'deploy',
      NEXT_PRIVATE_TEST_MODE: '',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = { status: r.status, stdout: r.stdout, stderr: r.stderr };
  spawnSync('bash', [CLEANUP_SH], { cwd: app, env: { ...process.env }, timeout: 20_000 });
  return out;
}

/** Fails WITH the deploy script's stderr, so a red run names its reason. */
function expectOk(r: { status: number | null; stderr: string }) {
  expect({ status: r.status, stderr: r.status === 0 ? '' : r.stderr.slice(-2000) }).toEqual({
    status: 0,
    stderr: '',
  });
}

afterAll(() => {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('e2e-deploy.sh runs the fixture build script (#2123)', () => {
  it('executes a build script that does not start with `next build`, with its pre/post hooks, and not the harness post-build tail', () => {
    const app = makeApp();
    // A bare `next build` at the root must NOT be what produces the server.
    put(
      app,
      'node_modules/.bin/next',
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' +
        JSON.stringify(join(app, 'BARE_NEXT_RAN')) +
        ', "1");\nprocess.exit(1);\n',
      0o755,
    );
    put(app, 'emit.js', emitScript(app, '.next', ''));
    put(
      app,
      'package.json',
      JSON.stringify({
        name: 'wrapped',
        private: true,
        scripts: {
          prebuild: "node -e \"require('fs').writeFileSync('PREBUILD_RAN','1')\"",
          build: "node emit.js && node -e \"require('fs').writeFileSync('BUILD_RAN','1')\"",
          postbuild: "node -e \"require('fs').writeFileSync('POSTBUILD_RAN','1')\"",
          // What the Next harness appends; its pnpm may not exist and its ids come from e2e-logs.sh.
          'post-build': "node -e \"require('fs').writeFileSync('HARNESS_POSTBUILD_RAN','1')\"",
        },
      }),
    );
    // The harness-synthesised shape: <fixture script> && pnpm post-build
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    pkg.scripts.build = `${pkg.scripts.build} && pnpm post-build`;
    writeFileSync(join(app, 'package.json'), JSON.stringify(pkg));

    const r = deploy(app);
    expect(r.stderr).not.toContain('running the pinned binary without its args');
    expectOk(r);
    expect(existsSync(join(app, 'PREBUILD_RAN'))).toBe(true);
    expect(existsSync(join(app, 'BUILD_RAN'))).toBe(true);
    expect(existsSync(join(app, 'POSTBUILD_RAN'))).toBe(true);
    expect(existsSync(join(app, 'HARNESS_POSTBUILD_RAN'))).toBe(false);
    expect(existsSync(join(app, 'BARE_NEXT_RAN'))).toBe(false);
  });

  it('a failing fixture build script fails the deploy', () => {
    const app = makeApp();
    put(app, 'node_modules/.bin/next', '#!/usr/bin/env node\nprocess.exit(0);\n', 0o755);
    put(
      app,
      'package.json',
      JSON.stringify({
        name: 'bad',
        private: true,
        scripts: { build: 'node -e "process.exit(3)"' },
      }),
    );
    const r = deploy(app);
    expect(r.status).not.toBe(0);
  });

  it('honours vercel.json outputDirectory: finds and boots the server under apps/web/.next', () => {
    const app = makeApp();
    put(app, 'node_modules/.bin/next', '#!/usr/bin/env node\nprocess.exit(1);\n', 0o755);
    put(app, 'vercel.json', JSON.stringify({ outputDirectory: 'apps/web/.next' }));
    put(app, 'emit.js', emitScript(app, 'apps/web/.next', 'apps/web'));
    put(
      app,
      'package.json',
      JSON.stringify({ name: 'mono', private: true, scripts: { build: 'node emit.js' } }),
    );
    const r = deploy(app);
    expectOk(r);
    expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:\d+$/);
    expect(r.stderr).toContain('apps/web/.next');
    // The default layout: static assets are staged next to the server.
    expect(existsSync(join(app, 'apps/web/.next/standalone/apps/web/.next/static/chunk.js'))).toBe(
      true,
    );
  });

  it('an upward distDir (apps/.next, server distDir ./../.next): static assets land where the server looks', () => {
    const app = makeApp();
    put(app, 'node_modules/.bin/next', '#!/usr/bin/env node\nprocess.exit(1);\n', 0o755);
    put(app, 'vercel.json', JSON.stringify({ outputDirectory: 'apps/.next' }));
    put(app, 'emit.js', emitScript(app, 'apps/.next', 'apps/web', './../.next'));
    put(
      app,
      'package.json',
      JSON.stringify({ name: 'up', private: true, scripts: { build: 'node emit.js' } }),
    );
    expectOk(deploy(app));
    expect(existsSync(join(app, 'apps/.next/standalone/apps/.next/static/chunk.js'))).toBe(true);
  });

  it('a vercel.json outputDirectory that escapes the project is ignored', () => {
    const app = makeApp();
    put(app, 'node_modules/.bin/next', '#!/usr/bin/env node\nprocess.exit(1);\n', 0o755);
    put(app, 'vercel.json', JSON.stringify({ outputDirectory: '../elsewhere/.next' }));
    put(app, 'emit.js', emitScript(app, '.next', ''));
    put(
      app,
      'package.json',
      JSON.stringify({ name: 'esc', private: true, scripts: { build: 'node emit.js' } }),
    );
    const r = deploy(app);
    expectOk(r);
    expect(r.stderr).not.toContain('vercel.json outputDirectory');
  });
});

describe('e2e-deploy.sh PORT is the same at build and at run (#2123)', () => {
  it('a `next build` script sees the PORT the server binds', () => {
    const app = makeApp();
    put(
      app,
      'node_modules/.bin/next',
      `#!/usr/bin/env node
if (process.argv[2] !== 'build') process.exit(0);
require('node:fs').writeFileSync(${JSON.stringify(join(app, 'BUILD_PORT'))}, String(process.env.PORT));
${emitScript(app, '.next', '')}
`,
      0o755,
    );
    put(
      app,
      'package.json',
      JSON.stringify({ name: 'p', private: true, scripts: { build: 'next build' } }),
    );
    const r = deploy(app);
    expectOk(r);
    const buildPort = readFileSync(join(app, 'BUILD_PORT'), 'utf8');
    const advertised = r.stdout.trim().split(':').pop();
    expect(buildPort).toMatch(/^\d+$/);
    expect(advertised).toBe(buildPort);
    expect(readFileSync(join(app, '.next', 'standalone', 'SERVER_PORT'), 'utf8')).toBe(buildPort);
  });

  it('a non-`next build` script sees the same PORT', () => {
    const app = makeApp();
    put(app, 'node_modules/.bin/next', '#!/usr/bin/env node\nprocess.exit(1);\n', 0o755);
    put(
      app,
      'emit.js',
      `require('node:fs').writeFileSync(${JSON.stringify(join(app, 'BUILD_PORT'))}, String(process.env.PORT));\n${emitScript(app, '.next', '')}`,
    );
    put(
      app,
      'package.json',
      JSON.stringify({ name: 'p2', private: true, scripts: { build: 'node emit.js' } }),
    );
    const r = deploy(app);
    expectOk(r);
    const buildPort = readFileSync(join(app, 'BUILD_PORT'), 'utf8');
    expect(r.stdout.trim().split(':').pop()).toBe(buildPort);
  });
});
