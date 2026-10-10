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
 * #2085 — experimental-flag forwarding is version-branched in scripts/e2e-deploy.sh.
 *
 * <= 16.3.x: the harness hands the deploy script the raw jest env
 * (__NEXT_CACHE_COMPONENTS ...) and the script maps it to the
 * NEXT_PRIVATE_EXPERIMENTAL_* names the harness-appended next.config snippet reads.
 * >= 16.4.0: the harness bakes the flags into the generated next.config itself
 * (getDeploymentTestEnvAssignments, vercel/next.js#99446) and the
 * NEXT_PRIVATE_EXPERIMENTAL_* alias is gone, so the mapping is dead and must not run.
 * An unreadable next version keeps the legacy mapping (16.3.8 behaviour unchanged).
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

function deploy(nextVersion: string | null): Record<string, string | null> {
  const app = mkdtempSync(join(tmpdir(), 'knext-flagfwd-'));
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
fs.writeFileSync(path.join(n, 'SEEN'), JSON.stringify({
  cc: process.env.NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS ?? null,
  cn: process.env.NEXT_PRIVATE_EXPERIMENTAL_CACHED_NAVIGATIONS ?? null,
  sh: process.env.NEXT_PRIVATE_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER ?? null,
}));
`,
  );
  chmodSync(bin, 0o755);
  // Stub the < 16.4.0 adapterPath workaround module: it is not under test here.
  const fix = join(app, 'adapter-path-fix-stub.mjs');
  writeFileSync(
    fix,
    'export function blankStandaloneAdapterPath() { return { applied: false, nextVersion: "stub", reason: "stub" }; }\n',
  );
  execFileSync('bash', [DEPLOY_SH], {
    cwd: app,
    env: {
      ...process.env,
      KNEXT_E2E_SKIP_PACK: '1',
      KNEXT_RUNTIME: 'node',
      KNEXT_ADAPTER_PATH_FIX: fix,
      NEXT_TEST_MODE: 'deploy',
      NEXT_PRIVATE_TEST_MODE: '',
      __NEXT_CACHE_COMPONENTS: 'true',
      __NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS: 'cn-1',
      __NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER: 'sh-1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const seen = JSON.parse(readFileSync(join(app, '.next', 'SEEN'), 'utf8'));
  spawnSync('bash', [CLEANUP_SH], { cwd: app, env: { ...process.env }, timeout: 20_000 });
  return seen;
}

afterAll(() => {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('e2e-deploy.sh experimental-flag forwarding is version-branched (#2085)', () => {
  it('16.3.8 keeps the legacy __NEXT_* -> NEXT_PRIVATE_EXPERIMENTAL_* mapping', () => {
    expect(deploy('16.3.8')).toEqual({ cc: 'true', cn: 'cn-1', sh: 'sh-1' });
  });

  it('an unreadable next version keeps the legacy mapping', () => {
    expect(deploy(null)).toEqual({ cc: 'true', cn: 'cn-1', sh: 'sh-1' });
  });

  it('16.4.0 does NOT export the dead NEXT_PRIVATE_EXPERIMENTAL_* alias (flags are baked)', () => {
    expect(deploy('16.4.0')).toEqual({ cc: null, cn: null, sh: null });
  });

  it('later minors/majors take the baked path; a 16.4.0 prerelease keeps the harmless legacy mapping', () => {
    expect(deploy('16.5.1')).toEqual({ cc: null, cn: null, sh: null });
    expect(deploy('17.0.0')).toEqual({ cc: null, cn: null, sh: null });
    // A canary may pre-date the baking change (#99446); exporting a dead alias is harmless,
    // dropping a live one is not.
    expect(deploy('16.4.0-canary.3')).toEqual({ cc: 'true', cn: 'cn-1', sh: 'sh-1' });
  });
});
