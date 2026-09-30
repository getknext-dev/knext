import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #1572 — the shipped standalone-node compile-cache BAKE driver must get a
 * genuine readiness answer from a server that IS answering, whatever its
 * routing config (redirects, rewrites, basePath, i18n).
 *
 * Measured mechanism (next@16.3.5, upstream fixture
 * test/e2e/app-dir/redirect-rewrite-dynamic, built `output: 'standalone'`):
 * with the bake's `HOSTNAME=127.0.0.1`, the fixture's proxy (`/a` → redirect
 * `/`, `/` → rewrite `/a`) answers `GET /` with `307 Location: /` — a
 * self-redirect. (With HOSTNAME emptied the same request answers 200.) The
 * driver's readiness probe used `fetch()`'s default `redirect: 'follow'`,
 * which throws "redirect count exceeded" after 20 hops; the probe's catch read
 * that as "not listening yet" and retried until
 * `standalone server did not answer within 60000ms` — although the server had
 * printed "Ready" and answered every single request.
 *
 * Each shape below is a fake standalone server.js reproducing one routing
 * config. Both halves are pinned: a loop is recognised FAST as an answer (and
 * graded non-2xx — the strict driver still fails it, the harness wrapper
 * tolerates it), while a legitimate redirect to a 2xx still passes the strict
 * driver, as it did when `fetch` followed redirects itself.
 */

const ROOT = resolve(import.meta.dir, '..');
const SHIPPED_BAKE = join(
  ROOT,
  'packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs',
);
const WRAPPER = join(ROOT, 'scripts/e2e-bake-accept.mjs');

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** routes: path → [status, location?]. Anything unlisted answers 404. */
type Routes = Record<string, readonly [number, string?]>;

/**
 * `patchFetch`: like Next's server, replace `globalThis.fetch` in the process
 * that loads server.js — the bake driver IS that process. The replacement
 * never settles, standing in for the measured next@16.3.5 behaviour (a
 * `redirect: "manual"` call through the patched fetch hung the in-process bake
 * for minutes). The driver must not route its own requests through it.
 */
function fakeStandalone(routes: Routes, patchFetch = false, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bake-readiness-'));
  temps.push(dir);
  writeFileSync(
    join(dir, 'server.js'),
    [
      `const routes = ${JSON.stringify(routes)};`,
      ...(patchFetch ? ['globalThis.fetch = () => new Promise(() => {});'] : []),
      "require('node:http').createServer((req, res) => {",
      '  setTimeout(() => {',
      '  const r = routes[req.url];',
      "  if (!r) { res.writeHead(404); res.end('nf'); return; }",
      '  const [status, location] = r;',
      "  const loc = location && location.startsWith('ABS:') ? 'http://127.0.0.1:' + process.env.PORT + location.slice(4) : location;",
      '  res.writeHead(status, loc ? { location: loc } : {});',
      "  res.end('ok');",
      `  }, ${delayMs});`,
      '}).listen(Number(process.env.PORT), process.env.HOSTNAME);',
    ].join('\n'),
  );
  const driver = join(dir, 'knext-compile-cache-bake.mjs');
  copyFileSync(SHIPPED_BAKE, driver);
  return { dir, driver, server: join(dir, 'server.js') };
}

let port = 41_200 + Math.floor(Math.random() * 500);

function bake(
  routes: Routes,
  warm: string,
  opts: { wrapper?: boolean; accept?: boolean; patchFetch?: boolean; delayMs?: number } = {},
) {
  const { dir, driver, server } = fakeStandalone(routes, opts.patchFetch, opts.delayMs);
  port += 1;
  const t0 = Date.now();
  const r = spawnSync('node', opts.wrapper ? [WRAPPER, 'node', driver] : [driver], {
    encoding: 'utf8',
    timeout: 80_000,
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      STANDALONE_SERVER_PATH: server,
      NODE_COMPILE_CACHE: join(dir, '.cc'),
      KNEXT_WARM_PATH: warm,
      ...(opts.accept ? { KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } : {}),
    },
  });
  return { ...r, ms: Date.now() - t0, out: `${r.stdout}\n${r.stderr}` };
}

/** Well under the driver's 60s readiness deadline: the server answers at once. */
const FAST_MS = 20_000;

// The exact 16.3.5 shape: `/` → 307 `/` (proxy rewrite + redirect under a
// 127.0.0.1 bind).
const SELF_REDIRECT_ROOT: Routes = { '/': [307, '/'] };
// The basePath variant: trailing-slash 308 into the basePath root, which then
// self-redirects.
const BASEPATH_LOOP: Routes = {
  '/base/path/': [308, '/base/path'],
  '/base/path': [307, '/base/path'],
};
// A two-hop cycle (`/a` → `/b` → `/a`) with absolute Location headers.
const TWO_HOP_CYCLE: Routes = { '/a': [307, 'ABS:/b'], '/b': [307, 'ABS:/a'] };

describe('bake readiness: a redirect loop is an ANSWER, not "not listening" (#1572)', () => {
  for (const [name, routes, warm, loopStatus] of [
    ['self-redirect at / (redirect-rewrite-dynamic)', SELF_REDIRECT_ROOT, '/', 307],
    ['basePath root loop (redirect-rewrite-dynamic-basepath)', BASEPATH_LOOP, '/base/path/', 307],
    ['two-hop cycle with absolute Locations', TWO_HOP_CYCLE, '/a', 307],
  ] as const) {
    it(`${name}: the strict driver answers fast, flushes, and fails the loop as non-2xx`, () => {
      const r = bake(routes, warm);
      expect(r.ms, r.out).toBeLessThan(FAST_MS);
      expect(r.out).not.toContain('did not answer within');
      expect(r.stdout).toContain('[knext bake] standalone server answered after');
      expect(r.stdout).toContain(`WARMED:${warm} status=${loopStatus} `);
      expect(r.stdout).toContain('COMPILE_CACHE:');
      expect(r.stderr).toContain('redirect loop');
      // Still strict for a real user's docker build: a loop is not 2xx.
      expect(r.status, r.out).not.toBe(0);
    }, 90_000);

    it(`${name}: the harness wrapper tolerates it (a real numeric status + a flush)`, () => {
      const r = bake(routes, warm, { wrapper: true, accept: true });
      expect(r.ms, r.out).toBeLessThan(FAST_MS);
      expect(r.status, r.out).toBe(0);
    }, 90_000);
  }
});

describe('bake readiness: legitimate redirects still land on their 2xx target (other half)', () => {
  for (const [name, routes, warm] of [
    ['relative redirect to a 2xx page', { '/old': [307, '/ok'], '/ok': [200] }, '/old'],
    ['i18n locale redirect of the root', { '/': [307, '/en'], '/en': [200] }, '/'],
    [
      'basePath trailing-slash 308 to a 2xx root',
      { '/base/': [308, '/base'], '/base': [200] },
      '/base/',
    ],
    [
      'absolute-Location chain of two hops',
      { '/x': [301, 'ABS:/y'], '/y': [302, '/z'], '/z': [200] },
      '/x',
    ],
  ] as const) {
    it(`${name}: the strict driver passes (status=200)`, () => {
      const r = bake(routes, warm);
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toContain(`WARMED:${warm} status=200 `);
      expect(r.ms, r.out).toBeLessThan(FAST_MS);
    }, 90_000);
  }

  it('a 404 warm path still fails the strict driver (no loosening)', () => {
    const r = bake({ '/ok': [200] }, '/missing');
    expect(r.status, r.out).not.toBe(0);
    expect(r.stdout).toContain('WARMED:/missing status=404 ');
  }, 90_000);
});

describe('bake readiness: the driver uses the fetch it had BEFORE importing server.js (#1572)', () => {
  it('a server that patches globalThis.fetch (as Next does) cannot hang the bake', () => {
    const r = bake({ '/': [307, '/'] }, '/', { wrapper: true, accept: true, patchFetch: true });
    expect(r.ms, r.out).toBeLessThan(FAST_MS);
    expect(r.stdout).toContain('WARMED:/ status=307 ');
    expect(r.status, r.out).toBe(0);
  }, 90_000);

  it('the other half: a 2xx warm through a fetch-patching server still passes strict', () => {
    const r = bake({ '/ok': [200] }, '/ok', { patchFetch: true });
    expect(r.ms, r.out).toBeLessThan(FAST_MS);
    expect(r.status, r.out).toBe(0);
  }, 90_000);
});

describe('bake readiness: a SLOW first answer is still an answer (#1572 round 2)', () => {
  // Measured on next@16.3.5 (upstream middleware-rewrite-dynamic, and
  // server-actions-redirect-middleware-rewrite): under the bake's 127.0.0.1
  // bind a middleware rewrite to `new URL(path, request.url)` is proxied
  // externally and the FIRST response (a 500) takes ~30s. A short per-attempt
  // timeout aborts every attempt and never sees it; the attempt must be allowed
  // to run to the overall deadline.
  it('a server whose every response takes 7s is answered, not timed out', () => {
    const r = bake({ '/': [500] }, '/', { wrapper: true, accept: true, delayMs: 7_000 });
    expect(r.out).not.toContain('did not answer within');
    expect(r.stdout).toContain('WARMED:/ status=500 ');
    expect(r.status, r.out).toBe(0);
  }, 90_000);
});

describe('bake readiness: a listening socket is ready — no HTTP round-trip through app routing (#1572 round 3)', () => {
  // next@16.3.5 middleware-rewrite-dynamic (`rewrite(new URL('/render/next', request.url))`)
  // and server-actions-redirect-middleware-rewrite (`rewrite(request.url)`):
  // under the bake's 127.0.0.1 bind the rewrite is proxied externally, hangs
  // up, and every response is a 500 after ~30s. Readiness must not spend its
  // deadline waiting on that — the server is up the moment it accepts a
  // connection; only the WARM request needs the (slow) HTTP answer.
  for (const [name, routes, warm] of [
    [
      'middleware rewrite of every path (middleware-rewrite-dynamic)',
      { '/': [500], '/render/next': [500] },
      '/',
    ],
    ['middleware self-rewrite + server-action redirect page', { '/redirect': [500] }, '/redirect'],
  ] as const) {
    it(`${name}: readiness returns before the slow answer, the warm still records it`, () => {
      const r = bake(routes, warm, { wrapper: true, accept: true, delayMs: 8_000 });
      const m = r.stdout.match(/standalone server answered after (\d+)ms/);
      expect(m, r.out).not.toBeNull();
      expect(Number(m?.[1])).toBeLessThan(4_000);
      expect(r.stdout).toContain(`WARMED:${warm} status=500 `);
      expect(r.status, r.out).toBe(0);
    }, 90_000);
  }

  it('the other half: nothing listening still fails at the deadline (fail-closed)', () => {
    const { dir, driver } = fakeStandalone({});
    const idle = join(dir, 'idle.js');
    writeFileSync(idle, 'setInterval(() => {}, 1000);');
    port += 1;
    const r = spawnSync('node', [driver], {
      encoding: 'utf8',
      timeout: 80_000,
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        STANDALONE_SERVER_PATH: idle,
        NODE_COMPILE_CACHE: join(dir, '.cc'),
        KNEXT_WARM_PATH: '/',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('did not answer within 60000ms');
  }, 90_000);
});
