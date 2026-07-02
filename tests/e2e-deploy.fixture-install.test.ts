import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #147 A3-3 fix round 2 — B1 + B3 of the feature-area triage of compat run
 * 28564443662 (knext-plan-out/compat-feature-triage.md).
 *
 * B3 (12 files): the official harness copies fixture files — INCLUDING
 * hand-made packages the fixtures ship inside their own `node_modules/`
 * (`node_modules/example`, `node_modules/my-pkg`, scoped ones, …) — on top of
 * the pnpm-installed test dir. Our `npm install --no-save <tarballs>` then
 * reifies the tree and PRUNES every package not in npm's ideal tree (verified
 * empirically: plain `--no-save`, `--no-package-lock`, `--install-links=false`,
 * `--install-strategy=shallow|linked` ALL prune; scoped children are pruned
 * even when the scope dir survives; `.bin` entries survive). The only
 * npm-native escape is listing the entries in package.json, which we must not
 * mutate — so e2e-deploy.sh snapshots package-level node_modules entries
 * before the install and restores whatever the reify removed.
 *
 * This test runs the REAL deploy script through its REAL npm-install path
 * (KNEXT_E2E_TARBALLS_DIR with locally packed stand-in tarballs — offline) and
 * asserts the fixture-shipped packages still resolve afterwards.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(port, host, () => {
  console.log('fixture standalone server listening on ' + host + ':' + port);
});
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
console.log('[fake-next] build complete (fixture)');
`;
}

/** Write a minimal package dir and `npm pack` it into tarballsDir. */
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
let tarballsDir = '';
let appDir = '';
let deployStdout = '';

describe('scripts/e2e-deploy.sh — fixture-shipped node_modules survive the tarball install (B3, #147 round 2)', () => {
  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-stubs-'));
    tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });

    // Stand-ins for the real pnpm-packed tarballs (same names find_tarball
    // globs for; @knext/core keeps its real "./adapter" export shape so the
    // script's require.resolve("@knext/core/adapter") is exercised for real).
    packStub(
      stageDir,
      tarballsDir,
      { name: '@knext/lib', version: '0.0.0-test', main: 'index.js' },
      { 'index.js': 'module.exports = {};\n' },
    );
    packStub(
      stageDir,
      tarballsDir,
      {
        name: '@knext/core',
        version: '0.0.0-test',
        exports: {
          './adapter': './dist/adapters/next-adapter.js',
          // #175: the deploy script also resolves the Cache-Control preload
          // from the installed package — the stub mirrors that surface so the
          // require.resolve is exercised for real.
          './internal/cache-control-normalize': './dist/adapters/cache-control-normalize.cjs',
        },
        dependencies: { '@knext/lib': '0.0.0-test' },
      },
      {
        'dist/adapters/next-adapter.js': 'module.exports = {};\n',
        'dist/adapters/cache-control-normalize.cjs': 'module.exports = {};\n',
      },
    );

    // The fixture app, shaped like a harness test dir AFTER fixture-file copy:
    // hand-made packages living inside node_modules (test material, not
    // installable from any registry) + the harness-installed next binary.
    appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-fixture-nm-'));
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true }, null, 2),
    );
    const example = join(appDir, 'node_modules', 'example');
    mkdirSync(example, { recursive: true });
    writeFileSync(
      join(example, 'package.json'),
      JSON.stringify({ name: 'example', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(example, 'index.js'), "module.exports = 'fixture-example';\n");
    const scoped = join(appDir, 'node_modules', '@fixture', 'local-pkg');
    mkdirSync(scoped, { recursive: true });
    writeFileSync(
      join(scoped, 'package.json'),
      JSON.stringify({ name: '@fixture/local-pkg', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(scoped, 'index.js'), "module.exports = 'fixture-scoped';\n");

    const nextBin = join(appDir, 'node_modules', '.bin', 'next');
    mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(nextBin, fakeNextScript(appDir));
    chmodSync(nextBin, 0o755);

    // REAL install path: no KNEXT_E2E_SKIP_PACK — the script npm-installs the
    // stand-in tarballs (offline: local tgz, no other deps).
    deployStdout = execFileSync('bash', [DEPLOY_SH], {
      cwd: appDir,
      env: {
        ...process.env,
        KNEXT_E2E_TARBALLS_DIR: tarballsDir,
        KNEXT_RUNTIME: 'node',
      },
      encoding: 'utf8',
      timeout: 120000,
    });
  }, 150000);

  afterAll(() => {
    if (existsSync(CLEANUP_SH) && appDir) {
      spawnSync('bash', [CLEANUP_SH], {
        cwd: appDir,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 20000,
      });
    }
    for (const d of [appDir, stageDir]) {
      if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  it('deploy still emits exactly one stdout line (the URL)', () => {
    const lines = deployStdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(() => new URL(lines[0])).not.toThrow();
  });

  it('the adapter tarballs really installed (@knext/core/adapter resolves from the fixture)', () => {
    const r = spawnSync(
      'node',
      ['-e', 'process.stdout.write(require.resolve("@knext/core/adapter"))'],
      { cwd: appDir, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join('@knext', 'core'));
  });

  it("fixture-shipped node_modules/example survives the install and resolves (npm's reify pruned it before)", () => {
    const r = spawnSync('node', ['-e', 'process.stdout.write(require("example"))'], {
      cwd: appDir,
      encoding: 'utf8',
    });
    expect(r.status, `require('example') failed:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('fixture-example');
  });

  it('fixture-shipped SCOPED package survives (scope children are pruned even when the scope dir is kept)', () => {
    const r = spawnSync('node', ['-e', 'process.stdout.write(require("@fixture/local-pkg"))'], {
      cwd: appDir,
      encoding: 'utf8',
    });
    expect(r.status, `require('@fixture/local-pkg') failed:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('fixture-scoped');
  });
});

describe('scripts/e2e-deploy.sh — TypeScript 5 pin for fixture type-checks (B1, #147 round 2)', () => {
  // 282/327 failures in run 28564443662: the harness installs
  // `typescript: 'latest'` into EVERY fixture (vercel/next.js@v16.2.0
  // test/lib/next-modes/base.ts:248); `latest` now resolves to TypeScript 6.x,
  // which turns the auto-generated tsconfig defaults (moduleResolution=node10,
  // baseUrl) into hard deprecation ERRORS, aborting `next build`'s type-check.
  // Upstream's own repo pins typescript 5.9.2 (v16.2.0 root package.json
  // devDependencies), so Next's own CI type-checks fixtures with TS 5 — the
  // deploy script must mirror that exact pin. These are text-contract guards
  // (the real registry install is exercised in CI compat runs, not vitest).
  const script = () => execFileSync('cat', [DEPLOY_SH], { encoding: 'utf8' }) as unknown as string;

  it('pins the exact upstream TypeScript version (5.9.2, vercel/next.js@v16.2.0 devDependencies)', () => {
    expect(script()).toContain('typescript@5.9.2');
  });

  it('documents the provenance of the pin (harness base.ts installs typescript latest)', () => {
    const s = script();
    expect(s).toMatch(/base\.ts/);
    expect(s).toMatch(/devDependencies/);
  });

  it('only overrides a "latest" (or unpinned-but-installed) typescript — never a fixture-pinned version', () => {
    // The pin must be conditional: fixtures that deliberately pin their own
    // typescript keep it; the harness default "latest" gets the TS5 pin.
    const s = script();
    expect(s).toMatch(/latest/);
  });

  it('both harness scripts stay valid bash (bash -n)', () => {
    for (const f of ['scripts/e2e-deploy.sh', 'scripts/e2e-logs.sh', 'scripts/e2e-cleanup.sh']) {
      const r = spawnSync('bash', ['-n', resolve(REPO_ROOT, f)], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });
});
