import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { execFileSync, spawnSync } from 'node:child_process';
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
import { join, resolve } from 'node:path';

/**
 * The deploy script's build must not inherit jest's NODE_ENV=test.
 *
 * `next build` keeps an inherited NODE_ENV (next/dist/bin/next:
 * `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv`). The deploy harness
 * hands this script the raw jest env, so a build under it ran as NODE_ENV=test and
 * the webpack SWC plugin saw `env=test` (test/e2e/swc-plugins-env). Next's own
 * start/dev modes blank NODE_ENV for the child (`NODE_ENV: this.env.NODE_ENV || ''`);
 * this script must do the same for every process that builds: the plain `next build`
 * and the fixture's prebuild / postbuild hooks.
 *
 * Only jest's own value (`test`) is cleared: an explicit production/development
 * from the environment is the caller's choice and is kept.
 *
 * Real bash against a fake fixture-local `next`; no network.
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

type Seen = { build: string | null; prebuild: string | null; postbuild: string | null };

// `null` = the variable was not set at all; '' = set but empty.
function deploy(nodeEnv: string | null): Seen {
  const app = mkdtempSync(join(tmpdir(), 'knext-nodeenv-'));
  dirs.push(app);
  const record = (file: string) =>
    `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env.NODE_ENV ?? null))" ${join(app, file)}`;
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'f',
      private: true,
      scripts: {
        build: 'next build',
        prebuild: record('SEEN_PREBUILD'),
        postbuild: record('SEEN_POSTBUILD'),
      },
    }),
  );
  writeFileSync(join(app, 'next.config.js'), "module.exports = { output: 'standalone' };\n");
  mkdirSync(join(app, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(app, 'node_modules', 'next'), { recursive: true });
  // >= 16.4.0 so the fixture prebuild/postbuild hooks run (#2123).
  writeFileSync(
    join(app, 'node_modules', 'next', 'package.json'),
    JSON.stringify({ name: 'next', version: '16.4.3' }),
  );
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
fs.writeFileSync(path.join(${JSON.stringify(app)}, 'SEEN_BUILD'), JSON.stringify(process.env.NODE_ENV ?? null));
`,
  );
  chmodSync(bin, 0o755);
  const fix = join(app, 'adapter-path-fix-stub.mjs');
  writeFileSync(
    fix,
    'export function blankStandaloneAdapterPath() { return { applied: false, nextVersion: "stub", reason: "stub" }; }\n',
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    KNEXT_E2E_SKIP_PACK: '1',
    KNEXT_RUNTIME: 'node',
    KNEXT_ADAPTER_PATH_FIX: fix,
    NEXT_TEST_MODE: 'deploy',
    NEXT_PRIVATE_TEST_MODE: '',
  };
  if (nodeEnv === null) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  execFileSync('bash', [DEPLOY_SH], { cwd: app, env, encoding: 'utf8', timeout: 60_000 });
  const read = (f: string): string | null => JSON.parse(readFileSync(join(app, f), 'utf8'));
  const seen = {
    build: read('SEEN_BUILD'),
    prebuild: read('SEEN_PREBUILD'),
    postbuild: read('SEEN_POSTBUILD'),
  };
  spawnSync('bash', [CLEANUP_SH], { cwd: app, env: { ...process.env }, timeout: 20_000 });
  return seen;
}

afterAll(() => {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('e2e-deploy.sh does not build under the jest NODE_ENV=test', () => {
  it('clears an inherited NODE_ENV=test for next build and both fixture hooks', () => {
    const seen = deploy('test');
    // Not 'test'. Blank or unset both let `next build` default to production.
    expect(seen.build).not.toBe('test');
    expect(seen.prebuild).not.toBe('test');
    expect(seen.postbuild).not.toBe('test');
    expect([null, '', 'production']).toContain(seen.build);
    expect([null, '', 'production']).toContain(seen.prebuild);
    expect([null, '', 'production']).toContain(seen.postbuild);
  });

  it('keeps an explicit NODE_ENV=production', () => {
    expect(deploy('production')).toEqual({
      build: 'production',
      prebuild: 'production',
      postbuild: 'production',
    });
  });

  it('leaves an unset NODE_ENV unset', () => {
    expect(deploy(null)).toEqual({ build: null, prebuild: null, postbuild: null });
  });
});
