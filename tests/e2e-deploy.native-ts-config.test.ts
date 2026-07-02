import { execFileSync } from 'node:child_process';
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
import { afterAll, describe, expect, it } from 'vitest';

/**
 * B2 (#173, A3-3 #147): the 18 `next-config-ts-native-ts` / `-native-mts` compat
 * failures were NOT an adapter-packaging gap — the adapter dist is require()-safe
 * (see packages/kn-next/src/__tests__/adapter-require-safe.test.ts). The top-level
 * await sits in the FIXTURE'S OWN next.config.ts: every fixture in those families
 * deliberately contains `await Promise.resolve()` ("top-level await will only work
 * in Native TS mode"). Without Node-native TS resolution enabled, `next build`
 * falls back to the legacy swc-transpile path, which `requireFromString()`s the
 * transpiled config — and Node throws the exact CI error:
 *
 *   Error: require() cannot be used on an ESM graph with top-level await.
 *
 * Upstream CI runs those families in DEDICATED jobs with
 * `__NEXT_NODE_NATIVE_TS_LOADER_ENABLED=true` exported (next.js
 * .github/workflows/build_and_test.yml, test-next-config-ts-native-ts-*). knext's
 * aggregate deploy run has no per-family env, so the deploy script must enable
 * native TS resolution itself: pass `--experimental-next-config-strip-types` to
 * `next build` whenever the fixture has a next.config.ts/.mts. This is SAFE for
 * legacy (non-native) TS-config fixtures: when native import() fails (tsconfig
 * paths aliases, extensionless imports, JSON without attributes), Next warns and
 * falls back to legacy resolution in the same call (verified against
 * next@16.2.0 dist/build/next-config-ts/transpile-config.js and reproduced with
 * the import-alias-paths-only fixture).
 *
 * Contract under test: the deploy script's `next build` argv
 *   - includes --experimental-next-config-strip-types when next.config.ts exists
 *   - includes it for next.config.mts too
 *   - does NOT include it for a plain next.config.js fixture
 *
 * Same fake fixture-local `next` technique as e2e-deploy.contract.test.ts: the
 * shim records its argv so the test asserts what the REAL script passed.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

/** server.js the fake build emits — must boot or the deploy script exits non-zero. */
const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body>native-ts fixture ok</body></html>');
}).listen(port, host);
`;

/** A fake `next` CLI that records its argv, then emits a standalone tree. */
function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const app = ${JSON.stringify(targetAppDir)};
if (process.argv[2] !== 'build') { process.exit(0); }
const nextDir = path.join(app, '.next');
const standalone = path.join(nextDir, 'standalone');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
fs.writeFileSync(path.join(standalone, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
// Record the exact build argv so the test can assert the deploy script's flags.
fs.writeFileSync(path.join(nextDir, 'BUILD_ARGV'), JSON.stringify(process.argv.slice(2)));
console.log('[fake-next] build complete (fixture)');
`;
}

const madeDirs: string[] = [];

/** Create a minimal fixture app with the given config file, deploy it, return build argv. */
function deployAndReadBuildArgv(configFileName: string, configContent: string): string[] {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-nativets-'));
  madeDirs.push(appDir);

  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true }, null, 2),
  );
  writeFileSync(join(appDir, configFileName), configContent);

  const nextBin = join(appDir, 'node_modules', '.bin', 'next');
  mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(nextBin, fakeNextScript(appDir));
  chmodSync(nextBin, 0o755);

  execFileSync('bash', [DEPLOY_SH], {
    cwd: appDir,
    env: { ...process.env, KNEXT_E2E_SKIP_PACK: '1', KNEXT_RUNTIME: 'node' },
    encoding: 'utf8',
    timeout: 60000,
  });

  const argvPath = join(appDir, '.next', 'BUILD_ARGV');
  expect(existsSync(argvPath), 'fake next never ran a build').toBe(true);
  return JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
}

afterAll(() => {
  for (const d of madeDirs) {
    if (existsSync(CLEANUP_SH)) {
      try {
        execFileSync('bash', [CLEANUP_SH], { cwd: d, encoding: 'utf8', timeout: 20000 });
      } catch {
        // best-effort: the deploy may have failed before booting a server
      }
    }
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('scripts/e2e-deploy.sh — native-TS config resolution (B2, #173)', () => {
  it('passes --experimental-next-config-strip-types when the fixture has next.config.ts', () => {
    const argv = deployAndReadBuildArgv(
      'next.config.ts',
      // the native-ts fixture family's marker: top-level await in the config
      "await Promise.resolve()\nexport default { output: 'standalone' }\n",
    );
    expect(argv[0]).toBe('build');
    expect(argv).toContain('--experimental-next-config-strip-types');
  });

  it('passes --experimental-next-config-strip-types when the fixture has next.config.mts', () => {
    const argv = deployAndReadBuildArgv(
      'next.config.mts',
      "await Promise.resolve()\nexport default { output: 'standalone' }\n",
    );
    expect(argv).toContain('--experimental-next-config-strip-types');
  });

  it('does NOT pass the flag for a plain next.config.js fixture', () => {
    const argv = deployAndReadBuildArgv(
      'next.config.js',
      "module.exports = { output: 'standalone' };\n",
    );
    expect(argv[0]).toBe('build');
    expect(argv).not.toContain('--experimental-next-config-strip-types');
  });
});
