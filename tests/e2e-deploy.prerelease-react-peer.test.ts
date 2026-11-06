import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * v1.3 credential lane on the Next.js v16.4.3 harness: ~10 deploy fixtures die in
 * scripts/e2e-deploy.sh's `npm install` with ERESOLVE. The fixtures pin an EXACT React
 * canary (`react@19.3.0-canary-fef12a01-20260413`, also `-da9325b5-20260417`); next@16.4.3
 * peers `react@"^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0"`, and a semver
 * prerelease of 19.3.0 does not satisfy `^19.0.0`. This is the same pair upstream's
 * `prepareLocalPackages` reconciles by rewriting peers to exact versions.
 *
 * The fix is TARGETED, and so is this test: only an exact-prerelease react / react-dom
 * pin gets next's react / react-dom peer edge overridden (npm `overrides`, scoped under
 * `next`), nothing else loosens. So the negatives matter as much as the positive:
 *   - a non-prerelease react conflict still ERESOLVEs,
 *   - an unrelated peer conflict (sass) still ERESOLVEs even next to a canary pin,
 *   - the fixture's package.json is byte-identical afterwards (the install is --no-save
 *     and the temporary overrides must not leak).
 *
 * Real bash through the REAL `npm install` path against a local in-process registry
 * serving stub next/react/react-dom (real peer ranges), so it is offline and exact.
 */
setDefaultTimeout(120_000);

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const CANARY = '19.3.0-canary-fef12a01-20260413';
// A canary of a React line next@16.4.3 does NOT support (below ^18.2.0): its base version
// 18.0.0 is out of the peer range, so the install must keep failing.
const OLD_CANARY = '18.0.0-canary-abcdef12-20240101';
const NEXT_PEER_REACT = '^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0';

const FAKE_SERVER_JS = `
const http = require('node:http');
http.createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT || 3000), process.env.HOSTNAME || '0.0.0.0');
`;

const FAKE_NEXT_BIN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'build') process.exit(0);
const app = process.cwd();
const n = path.join(app, '.next'); const s = path.join(n, 'standalone');
fs.mkdirSync(path.join(n, 'static'), { recursive: true });
fs.mkdirSync(path.join(s, 'node_modules', 'next', 'dist', 'server', 'lib'), { recursive: true });
fs.writeFileSync(path.join(n, 'BUILD_ID'), 'b');
fs.writeFileSync(path.join(s, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
const tn = path.join(s, 'node_modules', 'next');
fs.writeFileSync(path.join(tn, 'package.json'), '{"name":"next","main":"index.js"}');
fs.writeFileSync(path.join(tn, 'index.js'), 'module.exports = {};');
fs.writeFileSync(path.join(tn, 'dist', 'server', 'lib', 'start-server.js'), 'module.exports = {};');
`;

type Stub = {
  name: string;
  version: string;
  extra?: Record<string, unknown>;
  files: Record<string, string>;
};

const stubs: Stub[] = [
  {
    name: 'next',
    version: '16.4.3',
    extra: {
      bin: { next: './bin/next.js' },
      peerDependencies: { react: NEXT_PEER_REACT, 'react-dom': NEXT_PEER_REACT, sass: '^1.3.0' },
      peerDependenciesMeta: { sass: { optional: true } },
    },
    files: { 'bin/next.js': FAKE_NEXT_BIN },
  },
  { name: 'react', version: CANARY, files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react-dom', version: CANARY, files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react', version: '18.0.0', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react-dom', version: '18.0.0', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react', version: OLD_CANARY, files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react-dom', version: OLD_CANARY, files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react', version: '17.0.2', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react-dom', version: '17.0.2', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react', version: '19.1.0', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'react-dom', version: '19.1.0', files: { 'index.js': 'module.exports = {};\n' } },
  { name: 'sass', version: '1.0.0', files: { 'index.js': 'module.exports = {};\n' } },
];

let work = '';
let tarballsDir = '';
let registryDir = '';
let server: ReturnType<typeof Bun.serve>;
let registryUrl = '';
const apps: string[] = [];
let shimDir = '';
let beFile = '';
let markerSeq = 0;

function pack(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
  dest: string,
): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', dest], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return join(dest, out.split('\n').pop() as string);
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'knext-prerel-peer-'));
  // A PATH shim in front of the real npm: `viewfail` makes `npm view` fail (peer range
  // unreadable), `hang` makes `npm install` record the package.json it was handed and
  // then sleep until it is killed. Everything else is the real npm.
  const realNpm = Bun.which('npm');
  if (!realNpm) throw new Error('npm not on PATH');
  shimDir = join(work, 'shim');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    join(shimDir, 'npm'),
    [
      '#!/bin/bash',
      'if [ "$1" = view ] && [ "${KNEXT_TEST_NPM_MODE:-}" = viewfail ]; then exit 1; fi',
      'if [ "$1" = install ] && [ "${KNEXT_TEST_NPM_MODE:-}" = hang ]; then',
      '  cp package.json "$KNEXT_TEST_MARKERS/pkg-at-install.json"',
      '  : > "$KNEXT_TEST_MARKERS/started"',
      '  exec sleep 300',
      'fi',
      `exec "${realNpm}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  // BASH_ENV arms a pre-existing EXIT trap (+ INT/TERM/HUP traps are left alone) in the
  // deploy script's own shell ONLY (children inherit the guard variable and skip it), so a
  // test can prove the install's signal handling never clobbers an EXIT trap.
  beFile = join(work, 'bash-env.sh');
  writeFileSync(
    beFile,
    [
      'if [ -z "${KNEXT_TEST_BE_DONE:-}" ]; then',
      '  export KNEXT_TEST_BE_DONE=1',
      '  trap \'echo ran >> "$KNEXT_TEST_MARKERS/exit-trap"\' EXIT',
      'fi',
      '',
    ].join('\n'),
  );
  tarballsDir = join(work, 'adapter-tarballs');
  registryDir = join(work, 'registry');
  mkdirSync(tarballsDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  const stage = join(work, 'stage');

  pack(
    join(stage, 'lib'),
    { name: '@getknext/lib', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
    tarballsDir,
  );
  pack(
    join(stage, 'db'),
    { name: '@getknext/db', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
    tarballsDir,
  );
  pack(
    join(stage, 'core'),
    {
      name: '@getknext/core',
      version: '0.0.0-test',
      exports: {
        './adapter': './a.js',
        './internal/cache-control-normalize': './cc.cjs',
        './internal/bun-keepalive-guard': './bk.cjs',
        './internal/standalone-adapter-path': './ap.mjs',
      },
      dependencies: { '@getknext/lib': '0.0.0-test' },
    },
    {
      'a.js': 'module.exports = {};\n',
      'cc.cjs': 'module.exports = {};\n',
      'bk.cjs': 'module.exports = {};\n',
      'ap.mjs':
        'export function blankStandaloneAdapterPath() { return { applied: false, nextVersion: "stub", reason: "stub" }; }\n',
    },
    tarballsDir,
  );

  // name -> version -> { tarball path, packument version entry }
  const index = new Map<string, Record<string, unknown>>();
  const tgzByFile = new Map<string, string>();
  for (const s of stubs) {
    const tgz = pack(
      join(stage, `${s.name}-${s.version}`),
      { name: s.name, version: s.version, ...(s.extra ?? {}) },
      s.files,
      registryDir,
    );
    const buf = readFileSync(tgz);
    const file = tgz.split('/').pop() as string;
    // The packument advertises the registry's real peer metadata for this version.
    const versions = (index.get(s.name) ?? {}) as Record<string, unknown>;
    versions[s.version] = {
      name: s.name,
      version: s.version,
      ...(s.extra ?? {}),
      dist: {
        integrity: `sha512-${createHash('sha512').update(buf).digest('base64')}`,
        shasum: createHash('sha1').update(buf).digest('hex'),
        tarball: `@@REGISTRY@@/tarballs/${file}`,
      },
    };
    index.set(s.name, versions);
    tgzByFile.set(file, tgz);
  }

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith('/tarballs/')) {
        const p = tgzByFile.get(decodeURIComponent(u.pathname.slice('/tarballs/'.length)));
        return p ? new Response(Bun.file(p)) : new Response('nope', { status: 404 });
      }
      const name = decodeURIComponent(u.pathname.slice(1));
      const versions = index.get(name);
      if (!versions) return new Response('{"error":"not found"}', { status: 404 });
      const body = JSON.stringify({
        name,
        'dist-tags': { latest: Object.keys(versions)[0] },
        versions,
      }).replaceAll('@@REGISTRY@@', registryUrl);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  });
  registryUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  for (const a of apps) {
    spawnSync('bash', [CLEANUP_SH], { cwd: a, env: { ...process.env }, timeout: 20_000 });
    rmSync(a, { recursive: true, force: true });
  }
  if (work && existsSync(work)) rmSync(work, { recursive: true, force: true });
});

type DeployOpts = {
  /** PATH-shim behaviour for npm (see beforeAll). */
  npmMode?: 'viewfail' | 'hang';
  /** With npmMode 'hang': send this signal to the script once npm install is running. */
  killWith?: NodeJS.Signals;
};

async function deploy(deps: Record<string, string>, opts: DeployOpts = {}) {
  const app = mkdtempSync(join(tmpdir(), 'knext-prerel-app-'));
  apps.push(app);
  const markers = join(work, `markers-${markerSeq++}`);
  mkdirSync(markers, { recursive: true });
  const pkgText = `${JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true, scripts: { build: 'next build' }, dependencies: deps }, null, 2)}\n`;
  writeFileSync(join(app, 'package.json'), pkgText);
  writeFileSync(join(app, 'next.config.js'), "module.exports = { output: 'standalone' };\n");
  // ASYNC spawn on purpose: the registry runs in THIS process, so a blocking spawnSync
  // would deadlock the npm fetch against its own server.
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn('bash', [DEPLOY_SH], {
      cwd: app,
      env: {
        ...process.env,
        npm_config_registry: registryUrl,
        npm_config_cache: join(work, 'npm-cache'),
        KNEXT_E2E_TARBALLS_DIR: tarballsDir,
        KNEXT_RUNTIME: 'node',
        NEXT_TEST_MODE: 'deploy',
        NEXT_PRIVATE_TEST_MODE: '',
        ...(opts.npmMode
          ? {
              PATH: `${shimDir}:${process.env.PATH ?? ''}`,
              KNEXT_TEST_NPM_MODE: opts.npmMode,
              KNEXT_TEST_MARKERS: markers,
              BASH_ENV: beFile,
            }
          : {}),
      },
    });
    if (opts.killWith) {
      const poll = setInterval(() => {
        if (existsSync(join(markers, 'started'))) {
          clearInterval(poll);
          child.kill(opts.killWith);
        }
      }, 50);
      child.on('close', () => clearInterval(poll));
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const t = setTimeout(() => child.kill('SIGKILL'), 100_000);
    child.on('close', (status) => {
      clearTimeout(t);
      done({ status, stdout, stderr });
    });
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    app,
    markers,
    pkgBefore: pkgText,
    pkgAfter: readFileSync(join(app, 'package.json'), 'utf8'),
  };
}

describe('e2e-deploy.sh installs fixtures that pin an exact React canary under next@16.4.3 (ERESOLVE)', () => {
  it('react + react-dom pinned to an exact canary install and deploy (peer edge reconciled)', async () => {
    const r = await deploy({ next: '16.4.3', react: CANARY, 'react-dom': CANARY });
    expect(r.stderr).not.toContain('ERESOLVE');
    expect(r.status, r.stderr).toBe(0);
    expect(new URL(r.stdout.trim()).protocol).toBe('http:');
    // The canary the fixture asked for is the one installed — not swapped for a stable.
    const installed = JSON.parse(
      readFileSync(join(r.app, 'node_modules', 'react', 'package.json'), 'utf8'),
    );
    expect(installed.version).toBe(CANARY);
  });

  it('the fixture package.json is byte-identical afterwards (the override is temporary)', async () => {
    const r = await deploy({ next: '16.4.3', react: CANARY, 'react-dom': CANARY });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });

  it('does NOT mask a stable-version conflict: react@18.0.0 vs next peer still ERESOLVEs', async () => {
    // Positive control for the peer range: 18.0.0 is below ^18.2.0, so this must stay red.
    const r = await deploy({ next: '16.4.3', react: '18.0.0', 'react-dom': '18.0.0' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ERESOLVE');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });

  it('does NOT mask an unrelated peer conflict next to a canary pin: sass@1.0.0 still ERESOLVEs', async () => {
    const r = await deploy({ next: '16.4.3', react: CANARY, 'react-dom': CANARY, sass: '1.0.0' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ERESOLVE');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });

  it('a stable React pin that already satisfies the peer is untouched (no reconcile applied)', async () => {
    const r = await deploy({ next: '16.4.3', react: '19.1.0', 'react-dom': '19.1.0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reconciling');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });
});

describe("the override is conditional on next's own peer range (fail closed)", () => {
  it("a canary whose BASE version is outside next's peer range is NOT reconciled: 18.0.0-canary-x still ERESOLVEs", async () => {
    const r = await deploy({ next: '16.4.3', react: OLD_CANARY, 'react-dom': OLD_CANARY });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ERESOLVE');
    expect(r.stderr).toContain('not reconciling react@');
    expect(r.stderr).not.toContain('reconciling next');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });

  it('an unreadable peer range (npm view fails) fails closed: no override, ERESOLVE as before', async () => {
    const r = await deploy(
      { next: '16.4.3', react: CANARY, 'react-dom': CANARY },
      { npmMode: 'viewfail' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ERESOLVE');
    expect(r.stderr).toContain('could not read next@16.4.3 peerDependencies');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });

  it('a fixture with no next dependency has no peer range to read: no override', async () => {
    const r = await deploy({ react: CANARY, 'react-dom': CANARY });
    expect(r.stderr).toContain('declares no next dependency');
    expect(r.stderr).not.toContain('reconciling next');
    expect(r.pkgAfter).toBe(r.pkgBefore);
  });
});

describe('package.json is restored when the install is killed (signal safety)', () => {
  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const) {
    it(`${signal} mid-install restores the fixture package.json, removes the scratch copy and still runs a pre-existing EXIT trap`, async () => {
      const r = await deploy(
        { next: '16.4.3', react: CANARY, 'react-dom': CANARY },
        { npmMode: 'hang', killWith: signal },
      );
      // The rewrite really was live while npm was hanging…
      const during = JSON.parse(readFileSync(join(r.markers, 'pkg-at-install.json'), 'utf8'));
      expect(during.overrides?.next?.react).toBe('$react');
      // …and is gone afterwards, byte for byte.
      expect(r.status).toBe(code);
      expect(r.pkgAfter).toBe(r.pkgBefore);
      expect(readdirSync(r.app).filter((f) => f.startsWith('.knext-pkg-orig.'))).toEqual([]);
      // The EXIT trap armed before the install survived the INT/TERM/HUP handling.
      expect(existsSync(join(r.markers, 'exit-trap'))).toBe(true);
    });
  }
});

describe('the install block never touches EXIT traps and puts the signal traps back', () => {
  const src = readFileSync(DEPLOY_SH, 'utf8');
  const start = src.indexOf('SAVED_SIGNAL_TRAPS="$(trap -p INT TERM HUP)"');
  const end = src.indexOf('# Restore fixture-shipped packages the reify pruned');

  it('saves INT/TERM/HUP, restores them after the wait, and never names EXIT', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('wait "${NPM_PID}"');
    expect(block).toContain('trap - INT TERM HUP');
    expect(block).toContain('eval "${SAVED_SIGNAL_TRAPS}"');
    const code = block
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\btrap\b[^\n]*\bEXIT\b/);
    expect(code).not.toMatch(/\btrap\s+-\s*(\n|$)/);
  });
});
