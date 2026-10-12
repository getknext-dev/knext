import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #2214 — two Next >= 16.4 harness faults in scripts/e2e-deploy.sh, both gated on the
 * same stable-version read as the #2085 flag forwarding (NEXT_FLAGS_BAKED), so the
 * <= 16.3.x lanes (and the frozen credential tag's own copy of the script) stay
 * byte-identical in behaviour.
 *
 *  1. adapter-rsc-query-leak: the fixture redirects via `request.url`, which the
 *     standalone server builds from its BIND address (0.0.0.0). knext's public-origin
 *     preload rewrites that Location to a KNEXT_PUBLIC_ORIGINS entry, but the harness
 *     never set it. The deployed app must see exactly the URL the harness hands the
 *     tests (http://localhost:<the port it printed>).
 *  2. upward-distdir: Next's verifyDistDir resolves against `repoRoot`, which is
 *     NEXT_PRIVATE_OUTPUT_TRACE_ROOT when set (what a deploying platform's builder sets)
 *     and otherwise the nearest lockfile's dir. The staged project has no lockfile, so
 *     the build must see the staged repo root in NEXT_PRIVATE_OUTPUT_TRACE_ROOT.
 *
 * Real bash against a fake fixture-local `next` and a fake server; no network.
 */
setDefaultTimeout(60_000);

const REPO_ROOT = resolve(import.meta.dir, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const dirs: string[] = [];

type Seen = {
  traceRoot: string | null;
  serverOrigins: string | null;
  url: string;
  appDir: string;
};

function deploy(nextVersion: string | null, extraEnv: Record<string, string> = {}): Seen {
  const app = mkdtempSync(join(tmpdir(), 'knext-n164-'));
  dirs.push(app);
  const seenServer = join(app, 'SERVER_SEEN');
  // The fake server records the env it was BOOTED with, then serves.
  const fakeServer = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(seenServer)}, JSON.stringify({ origins: process.env.KNEXT_PUBLIC_ORIGINS ?? null }));
const http = require('node:http');
http.createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT || 3000), process.env.HOSTNAME || '0.0.0.0');
`;
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
fs.writeFileSync(path.join(s, 'server.js'), ${JSON.stringify(fakeServer)});
fs.writeFileSync(path.join(n, 'BUILD_SEEN'), JSON.stringify({
  traceRoot: process.env.NEXT_PRIVATE_OUTPUT_TRACE_ROOT ?? null,
}));
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
    ...extraEnv,
  };
  // A developer shell exporting either name must not leak into the case under test.
  for (const k of ['NEXT_PRIVATE_OUTPUT_TRACE_ROOT', 'KNEXT_PUBLIC_ORIGINS']) {
    if (!(k in extraEnv)) delete env[k];
  }
  const stdout = execFileSync('bash', [DEPLOY_SH], {
    cwd: app,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const build = JSON.parse(readFileSync(join(app, '.next', 'BUILD_SEEN'), 'utf8'));
  // The server writes SERVER_SEEN at boot; the deploy only returns after readiness.
  const server = JSON.parse(readFileSync(seenServer, 'utf8'));
  spawnSync('bash', [CLEANUP_SH], { cwd: app, env: { ...process.env }, timeout: 20_000 });
  return {
    traceRoot: build.traceRoot,
    serverOrigins: server.origins,
    url: stdout.trim(),
    appDir: realpathSync(app),
  };
}

afterAll(() => {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('e2e-deploy.sh Next >= 16.4 harness faults (#2214)', () => {
  it('16.4.0 hands the deployed app the exact URL the tests use as its public origin (adapter-rsc-query-leak)', () => {
    const s = deploy('16.4.0');
    expect(s.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(s.serverOrigins).toBe(s.url);
  });

  it('16.4.0 builds with the staged repo root as NEXT_PRIVATE_OUTPUT_TRACE_ROOT (upward-distdir)', () => {
    const s = deploy('16.4.0');
    expect(s.traceRoot).not.toBeNull();
    expect(realpathSync(s.traceRoot as string)).toBe(s.appDir);
  });

  it('later minors/majors take the same path', () => {
    for (const v of ['16.5.1', '17.0.0']) {
      const s = deploy(v);
      expect(s.serverOrigins).toBe(s.url);
      expect(realpathSync(s.traceRoot as string)).toBe(s.appDir);
    }
  });

  it('16.3.8, an unreadable version and a 16.4.0 prerelease keep the previous behaviour (neither is set)', () => {
    for (const v of ['16.3.8', null, '16.4.0-canary.3']) {
      const s = deploy(v);
      expect(s.traceRoot).toBeNull();
      expect(s.serverOrigins).toBeNull();
    }
  });

  it('every docker run that SERVES the suite (exec lane, bun) forwards KNEXT_PUBLIC_ORIGINS by name', () => {
    // docker is not available to this test, so scan the script instead of enumerating
    // call sites: any `exec docker run` that passes NEXT_DEPLOYMENT_ID is a serving boot
    // and must carry the forwarding args, or the compiled-exec lane silently loses the origin.
    const text = readFileSync(DEPLOY_SH, 'utf8');
    const serving = [
      ...text.matchAll(/exec docker run[\s\S]*?\n\s*"\.\/\$\(basename[^\n]*\n/g),
    ].map((m) => m[0]);
    expect(serving.length).toBe(2);
    for (const block of serving) {
      expect(block).toContain('-e NEXT_DEPLOYMENT_ID=');
      expect(block).toMatch(
        /PUBLIC_ORIGIN_DOCKER_ARGS\[@\]\+"\$\{PUBLIC_ORIGIN_DOCKER_ARGS\[@\]\}"/,
      );
    }
    // and the args are only ever non-empty on the gated path
    expect(text).toContain('PUBLIC_ORIGIN_DOCKER_ARGS=(-e KNEXT_PUBLIC_ORIGINS)');
  });

  it('a caller-supplied NEXT_PRIVATE_OUTPUT_TRACE_ROOT is respected, not overwritten', () => {
    const s = deploy('16.4.0', { NEXT_PRIVATE_OUTPUT_TRACE_ROOT: '/somewhere/else' });
    expect(s.traceRoot).toBe('/somewhere/else');
  });
});
