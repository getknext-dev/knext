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
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Contract test for scripts/e2e-deploy.sh + scripts/e2e-cleanup.sh (#89, ADR-0007 A3-2).
 *
 * The official Next.js deploy-test harness invokes our deploy script per fixture app
 * (cwd = the app's temp dir) and reads exactly ONE stdout line — the deployment URL —
 * to drive its e2e tests. This test verifies that contract WITHOUT cloning
 * vercel/next.js, by planting a fake `next` at the FIXTURE-LOCAL
 * node_modules/.bin/next — the exact path the script must resolve — so the build
 * fabricates a minimal standalone server. (#147 fix round 1 follow-up, branch run
 * 28561839378: the script used to invoke a bare `next build`, which is NOT on
 * PATH in the harness env → `next: command not found` (127) in every real test;
 * an earlier version of this test shimmed `next` on PATH, which masked precisely
 * that bug. The shim now lives where the harness install puts the real binary,
 * so a bare-invocation regression fails HERE.) It exercises the REAL deploy-script logic: build invocation,
 * asset staging, server boot on a free port, TCP readiness probe, single-line URL
 * echo, and BUILD_ID/DEPLOYMENT_ID persistence to .adapter-build.log. cleanup then
 * frees the port.
 *
 * Deploy / logs / cleanup are SEPARATE processes that communicate only via the log
 * file — exactly as the harness runs them.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');
const LOGS_SH = resolve(REPO_ROOT, 'scripts/e2e-logs.sh');

let appDir = '';
let deployStdout = '';
let parsedPort = 0;

/**
 * A standalone server.js that a fake `next build` would emit: serves HTTP on
 * $PORT. Mirrors the REAL generated standalone server.js, which reads
 * `process.env.HOSTNAME || '0.0.0.0'` — and records the HOSTNAME it was booted
 * with so the test can assert the deploy script's boot env (B7a, #174). The
 * extra routes emit the EXACT origin Cache-Control values Next's standalone
 * server produces (getCacheControlHeader + the pages-router fallback shell),
 * so the contract test can assert the deploy script's serving layer normalizes
 * them to the deployed-platform values the official deploy suite expects
 * (#175, prerender.test.ts caching-header failures).
 */
const FAKE_SERVER_JS = `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
fs.writeFileSync(
  path.join(__dirname, 'HOSTNAME_AT_BOOT'),
  JSON.stringify(process.env.HOSTNAME ?? null),
);
http.createServer((req, res) => {
  if (req.url === '/isr') {
    // Next origin for revalidate:2 pages (prerender.test.ts "revalidate page")
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-nextjs-cache': 'HIT',
      'cache-control': 's-maxage=2, stale-while-revalidate=31535998',
    });
    return res.end('isr');
  }
  if (req.url === '/no-revalidate') {
    // Next origin for revalidate:false pages ("no-revalidate page")
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-nextjs-cache': 'HIT',
      'cache-control': 's-maxage=31536000',
    });
    return res.end('no-revalidate');
  }
  if (req.url === '/fallback-shell') {
    // Next origin for a fallback:true first MISS (HTML shell)
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-nextjs-cache': 'MISS',
      'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
    });
    return res.end('shell');
  }
  if (req.url.startsWith('/_next/data/')) {
    // data requests are never fallback shells — private stays private
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-nextjs-cache': 'MISS',
      'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
    });
    return res.end('{}');
  }
  if (req.url === '/dynamic') {
    // genuinely dynamic SSR (no x-nextjs-cache marker) — must stay private
    res.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
    });
    return res.end('dynamic');
  }
  if (req.url === '/static-asset') {
    // immutable static assets must pass through untouched
    res.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return res.end(';');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body>knext e2e fixture ok</body></html>');
}).listen(port, host, () => {
  console.log('fixture standalone server listening on ' + host + ':' + port);
});
`;

/** A fake `next` CLI: on `build`, emit BUILD_ID + a standalone server tree. */
function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cmd = process.argv[2];
if (cmd !== 'build') { process.exit(0); }
const app = ${JSON.stringify(targetAppDir)};
const nextDir = path.join(app, '.next');
const standalone = path.join(nextDir, 'standalone');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
fs.writeFileSync(path.join(standalone, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
// B5 (#147 round 2): record what the BUILD process saw, so the test can assert
// the deploy script exported NEXT_DEPLOYMENT_ID into the build env (Next stamps
// dpl= asset/image URLs and skew headers from it AT BUILD TIME).
fs.writeFileSync(
  path.join(nextDir, 'DEPLOYMENT_ID_AT_BUILD'),
  String(process.env.NEXT_DEPLOYMENT_ID || ''),
);
// #175: record what the BUILD process saw for NEXT_PRIVATE_TEST_MODE. The
// harness appends a next.config.js snippet that maps it to __NEXT_TEST_MODE,
// which define-env inlines into the CLIENT bundle — without it the
// window.__NEXT_HYDRATED test marker is absent and every webdriver hydration
// wait falls back to a 10s timeout (the lazy-catchall failures).
fs.writeFileSync(
  path.join(nextDir, 'TEST_MODE_AT_BUILD'),
  String(process.env.NEXT_PRIVATE_TEST_MODE || ''),
);
// B4 (#147 round 2): build warnings land on both streams in real next builds.
console.log('[fake-next] FAKE_BUILD_STDOUT_WARNING_MARKER');
console.error('[fake-next] FAKE_BUILD_STDERR_WARNING_MARKER');
console.log('[fake-next] build complete (fixture)');
`;
}

function tcpConnects(port: number, host = '127.0.0.1', timeoutMs = 3000): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

describe('scripts/e2e-deploy.sh — official deploy-script contract (#89)', () => {
  beforeAll(() => {
    appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-app-'));

    // minimal fixture app
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true }, null, 2),
    );
    writeFileSync(join(appDir, 'next.config.js'), "module.exports = { output: 'standalone' };\n");

    // Fixture-LOCAL `next` shim — at node_modules/.bin/next, the path the script
    // resolves explicitly. Deliberately NOT a PATH shim: the harness env has no
    // `next` on PATH, and a PATH shim here previously masked the bare-`next build`
    // 127 bug (branch run 28561839378).
    const nextBin = join(appDir, 'node_modules', '.bin', 'next');
    mkdirSync(join(appDir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(nextBin, fakeNextScript(appDir));
    chmodSync(nextBin, 0o755);

    // Run the deploy script with cwd = the fixture app. KNEXT_E2E_SKIP_PACK lets
    // the contract test bypass the real tarball install (network + build heavy);
    // the script still does everything else for real — including resolving the
    // fixture-local next binary.
    const out = execFileSync('bash', [DEPLOY_SH], {
      cwd: appDir,
      env: {
        ...process.env,
        KNEXT_E2E_SKIP_PACK: '1',
        KNEXT_RUNTIME: 'node',
        // The harness always runs deploy tests with NEXT_TEST_MODE=deploy in
        // the deploy-script env (run-tests.js → jest → NextDeployInstance).
        NEXT_TEST_MODE: 'deploy',
        // Ensure the script derives it rather than inheriting a stale value.
        NEXT_PRIVATE_TEST_MODE: '',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    deployStdout = out;
  });

  afterAll(() => {
    if (existsSync(CLEANUP_SH) && appDir) {
      spawnSync('bash', [CLEANUP_SH], {
        cwd: appDir,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 20000,
      });
    }
    for (const d of [appDir]) {
      if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  it('emits EXACTLY one stdout line (the deployment URL)', () => {
    const lines = deployStdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it('the single stdout line is a parseable http://localhost:<port> URL', () => {
    const line = deployStdout.trim();
    const url = new URL(line);
    expect(url.protocol).toBe('http:');
    expect(['localhost', '127.0.0.1']).toContain(url.hostname);
    parsedPort = Number(url.port);
    expect(parsedPort).toBeGreaterThan(0);
  });

  it('the advertised port accepts a TCP connection (server really booted)', async () => {
    expect(parsedPort).toBeGreaterThan(0);
    expect(await tcpConnects(parsedPort)).toBe(true);
  });

  it('.adapter-build.log records BUILD_ID and DEPLOYMENT_ID', () => {
    const logPath = join(appDir, '.adapter-build.log');
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toMatch(/BUILD_ID=.+/);
    expect(log).toMatch(/DEPLOYMENT_ID=.+/);
    expect(log).toMatch(/PORT=\d+/);
    expect(log).toMatch(/PID=\d+/);
  });

  it("e2e-logs.sh output parses with the harness's REAL id regexes (next-deploy.ts@v16.2.0)", () => {
    // GROUND TRUTH (vercel/next.js@v16.2.0, test/lib/next-modes/next-deploy.ts,
    // parseIdsFromCliOuput(), lines 159-182): after fetching logs the harness
    // combines stdout+stderr (line 123) and REQUIRES all three of
    //   /BUILD_ID: (.+)/              (line 160 — throws "Failed to get buildId
    //                                  from logs …" if absent; run 28563269411
    //                                  failed EVERY test here: we printed the
    //                                  equals-form `BUILD_ID=<id>`, no match)
    //   /DEPLOYMENT_ID: (.+)/         (line 165)
    //   /IMMUTABLE_ASSET_TOKEN: (.+)/ (line 171 — the literal string
    //                                  "undefined" is accepted and mapped to
    //                                  undefined at line 179; knext has no
    //                                  Vercel-style skew token)
    // This test runs the REAL logs script and applies the REAL regexes.
    const r = spawnSync('bash', [LOGS_SH], {
      cwd: appDir,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    const cliOutput = `${r.stdout}${r.stderr}`;
    const buildId = cliOutput.match(/BUILD_ID: (.+)/)?.[1]?.trim();
    const deploymentId = cliOutput.match(/DEPLOYMENT_ID: (.+)/)?.[1]?.trim();
    const immutableAssetToken = cliOutput.match(/IMMUTABLE_ASSET_TOKEN: (.+)/)?.[1]?.trim();
    expect(
      buildId,
      `harness would throw: Failed to get buildId from logs\n${cliOutput}`,
    ).toBeTruthy();
    expect(deploymentId, 'harness would throw: Failed to get deploymentId from logs').toBeTruthy();
    expect(
      immutableAssetToken,
      'harness would throw: Failed to get immutableAssetToken from logs',
    ).toBeTruthy();
    // knext has no immutable-asset token — the harness's documented escape is
    // the literal string "undefined".
    expect(immutableAssetToken).toBe('undefined');
    // The parsed ids must equal what the deploy persisted, not decoration.
    const meta = readFileSync(join(appDir, '.adapter-build.log'), 'utf8');
    expect(meta).toContain(`BUILD_ID=${buildId}`);
    expect(meta).toContain(`DEPLOYMENT_ID=${deploymentId}`);
  });

  it('exports NEXT_DEPLOYMENT_ID into the `next build` environment (B5, #147 round 2)', () => {
    // Triage of run 28564443662 (B5): the deploy script generated DEPLOYMENT_ID
    // AFTER `next build` and exported it only to the runtime server, so Next
    // never stamped `dpl=` into image/asset URLs (next-image: 5 assertion
    // diffs) and `segment-cache/deployment-skew` aborted at build with
    // "Neither NEXT_PUBLIC_BUILD_ID nor NEXT_DEPLOYMENT_ID is set".
    const seenAtBuild = readFileSync(
      join(appDir, '.next', 'DEPLOYMENT_ID_AT_BUILD'),
      'utf8',
    ).trim();
    expect(seenAtBuild, 'NEXT_DEPLOYMENT_ID was not in the next build env').toBeTruthy();
    // …and it must be the SAME id the deploy persisted for the harness/runtime,
    // otherwise build-stamped dpl= URLs and served assets would skew apart.
    const meta = readFileSync(join(appDir, '.adapter-build.log'), 'utf8');
    expect(meta).toContain(`DEPLOYMENT_ID=${seenAtBuild}`);
  });

  it('captures `next build` output and e2e-logs.sh exposes it to the harness (B4, #147 round 2)', () => {
    // Triage of run 28564443662 (B4): tests like next-config-warnings and
    // app-middleware assert that `fetchCliOutputs()` (which runs THIS logs
    // script) contains next-build warnings. We only emitted metadata + the
    // server log, so every build-warning assertion failed.
    const r = spawnSync('bash', [LOGS_SH], {
      cwd: appDir,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    const cliOutput = `${r.stdout}${r.stderr}`;
    expect(cliOutput).toContain('FAKE_BUILD_STDOUT_WARNING_MARKER');
    expect(cliOutput).toContain('FAKE_BUILD_STDERR_WARNING_MARKER');
    // The harness-parseable id block must still LEAD stdout: parseIdsFromCliOuput
    // takes the FIRST /BUILD_ID: (.+)/ match, so the build-log dump must not
    // shadow it.
    const firstBuildId = r.stdout.match(/BUILD_ID: (.+)/)?.[1]?.trim();
    const meta = readFileSync(join(appDir, '.adapter-build.log'), 'utf8');
    expect(meta).toContain(`BUILD_ID=${firstBuildId}`);
  });

  it('boots the server WITHOUT pinning HOSTNAME to 127.0.0.1 (B7a, #174 — middleware rewrites)', () => {
    // Triage of run 28564443662 → #174 (middleware-custom-matchers, 6 assertion
    // failures): the deploy script booted the standalone server with
    // HOSTNAME=127.0.0.1. In next@16.2.0's standalone server the middleware-visible
    // request origin is ALWAYS http://localhost:<port> (verified via the
    // x-middleware-rewrite response header), while the router's initUrl uses the
    // configured hostname VERBATIM (server/lib/router-utils/resolve-routes.js:116).
    // getRelativeURL(rewrite, initUrl) then sees localhost !== 127.0.0.1, so every
    // same-origin middleware rewrite (NextResponse.rewrite(new URL('/', request.url)))
    // is misclassified as an EXTERNAL rewrite and proxied back to the server itself
    // → 500 locally / proxy-loop timeouts in CI, exactly on the matcher-conditioned
    // routes (has/missing) whose tests assert the rewritten 200.
    //
    // The empirically verified safe boot env (upstream fixture rebuilt through this
    // script, next@16.2.0): HOSTNAME empty/unset → server binds 0.0.0.0 and Next
    // normalizes the origin to localhost on BOTH sides → rewrite relativized to '/'
    // → 200. HOSTNAME must be explicitly EMPTIED (not merely dropped): Docker/CI
    // images export HOSTNAME=<container-id>, which would reintroduce the mismatch.
    const recorded = readFileSync(join(appDir, '.next', 'standalone', 'HOSTNAME_AT_BOOT'), 'utf8');
    const hostnameAtBoot = JSON.parse(recorded) as string | null;
    expect(
      hostnameAtBoot,
      'deploy script must boot server.js with HOSTNAME explicitly emptied (or localhost) — any other value desyncs the middleware-visible origin from the router initUrl and breaks same-origin middleware rewrites (#174)',
    ).toSatisfy((v: string | null) => v === '' || v === 'localhost');
  });

  it('build output stays on stderr during deploy (stdout is the URL contract)', () => {
    // The B4 capture must not leak build output onto deploy stdout — the
    // harness reads stdout as the deployment URL.
    expect(deployStdout).not.toContain('FAKE_BUILD_STDOUT_WARNING_MARKER');
  });

  it('exports NEXT_PRIVATE_TEST_MODE into the `next build` env from NEXT_TEST_MODE (#175 lazy-catchall fix)', () => {
    // Run 28578203671: `should support (nested) lazy catchall route` failed with
    // received "Hi delayby3s" instead of "fallback" and a ~10.2s test time — the
    // webdriver hydration wait's 10s fallback timeout. Without
    // NEXT_PRIVATE_TEST_MODE at build, the harness-appended next.config.js
    // snippet never sets __NEXT_TEST_MODE, the client bundle lacks the
    // window.__NEXT_HYDRATED marker, and the 3s-delayed getStaticProps resolves
    // before the test reads the element. The official reference adapter
    // (nextjs/adapter-bun scripts/e2e-deploy.sh) exports it the same way.
    const seenAtBuild = readFileSync(join(appDir, '.next', 'TEST_MODE_AT_BUILD'), 'utf8').trim();
    expect(seenAtBuild, 'NEXT_PRIVATE_TEST_MODE was not in the next build env').toBe('deploy');
  });

  describe('deployed-platform Cache-Control normalization at the serving layer (#175)', () => {
    // Evidence: compat run 28578203671, prerender.test.ts deploy-mode diffs.
    // The official reference adapter (nextjs/adapter-bun src/runtime/server.ts,
    // normalizeCacheControlHeader) applies exactly these rules in its serving
    // layer; knext applies them to the standalone server via a --require preload.
    const PUBLIC_DEPLOY = 'public, max-age=0, must-revalidate';

    // node:http, NOT fetch — the vitest environment (happy-dom) applies CORS
    // to fetch; this asserts raw server headers exactly as the harness does.
    function headerOf(path: string): Promise<string | undefined> {
      return new Promise((res, rej) => {
        const req = httpGet(`http://127.0.0.1:${parsedPort}${path}`, (r) => {
          r.resume(); // drain
          const value = r.headers['cache-control'];
          res(Array.isArray(value) ? value.join(', ') : value);
        });
        req.on('error', rej);
      });
    }

    it('rewrites ISR s-maxage/stale-while-revalidate responses to the deploy value', async () => {
      expect(await headerOf('/isr')).toBe(PUBLIC_DEPLOY);
    });

    it('rewrites no-revalidate s-maxage=31536000 responses to the deploy value', async () => {
      expect(await headerOf('/no-revalidate')).toBe(PUBLIC_DEPLOY);
    });

    it('rewrites the fallback-shell private response (x-nextjs-cache marker present) to the deploy value', async () => {
      expect(await headerOf('/fallback-shell')).toBe(PUBLIC_DEPLOY);
    });

    it('keeps /_next/data/ private responses private', async () => {
      expect(await headerOf('/_next/data/BUILDID/fallback-true/second.json')).toBe(
        'private, no-cache, no-store, max-age=0, must-revalidate',
      );
    });

    it('keeps marker-less dynamic private responses private', async () => {
      expect(await headerOf('/dynamic')).toBe(
        'private, no-cache, no-store, max-age=0, must-revalidate',
      );
    });

    it('keeps immutable static-asset responses untouched', async () => {
      expect(await headerOf('/static-asset')).toBe('public, max-age=31536000, immutable');
    });
  });

  it('e2e-cleanup.sh frees the port (server torn down)', async () => {
    expect(parsedPort).toBeGreaterThan(0);
    const r = spawnSync('bash', [CLEANUP_SH], {
      cwd: appDir,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    // give SIGTERM a beat to release the socket
    await new Promise((res) => setTimeout(res, 1500));
    expect(await tcpConnects(parsedPort)).toBe(false);
  });
});
