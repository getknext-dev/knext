import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  collectHarness,
  readHarnessServedFrom,
  SC_SERVED_FROM,
  SERVED_FROM_LIB,
} from '../scripts/compat-window-fingerprint.mjs';

/**
 * The KNEXT_SELF_CONTAINED=1 empty-dir lane step (#1455, ADR-0060 decision 5 /
 * action item F6): scripts/lib/e2e-empty-dir.sh, sourced by both
 * scripts/e2e-deploy.sh and scripts/e2e-deploy-vinext.sh.
 *
 * `ed_assert_clean` is mutation-proved
 * (scripts/mutation-prove-empty-dir-guard.mjs) against exactly the scenario
 * F6's own exit criterion names: a PLANTED `node_modules` beside the binary
 * must red the check — at ANY depth, and regardless of which allowlisted
 * top-level directory it hides under (round-2 review, BLOCKING-3/non-blocking
 * nested-leak item).
 *
 * The boot+probe half is exercised here against a SYNTHETIC fixture (a tiny
 * node http server), not a real Next/vinext build — booting a REAL compiled
 * artifact from an empty dir is what N1 (#1456) / V1 (#1460) still have to
 * make possible (ADR-0060 §Context); this suite proves the STEP's own
 * mechanics, which is all F6 owns.
 */
const ROOT = resolve(import.meta.dir, '..');
const LIB = join(ROOT, 'scripts/lib/e2e-empty-dir.sh');

// Round-2 review, BLOCKING-1: `tests/temp-dirs-outside-the-repo.test.ts` reds
// on any `mkdtempSync` whose directory is never removed in the same file. ONE
// tracked list + ONE afterAll, same pattern as
// tests/actionlint-workflow.test.ts — several fixtures here are built from a
// shared helper called by many `it()`s, so a per-call try/finally would need
// threading a dir back out of each.
const trackedTempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of trackedTempDirs) rmSync(dir, { recursive: true, force: true });
});

function sh(script: string) {
  return spawnSync('bash', ['-c', `set -uo pipefail; . "${LIB}"; ${script}`], {
    encoding: 'utf8',
  });
}

function freePortExpr(): string {
  return `node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'`;
}

function makeServerFixture(
  dir: string,
  name = 'server.js',
  opts: { status?: number; onlyStatus?: boolean } = {},
): string {
  const p = join(dir, name);
  const status = opts.status ?? 200;
  const body = opts.onlyStatus
    ? // Every route — health included — answers with the same status. Used
      // to prove BLOCKING-4: a server that 500s on everything must not pass.
      [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        `http.createServer((req, res) => { res.writeHead(${status}, { 'content-type': 'text/plain' }); res.end('x'); }).listen(port, '127.0.0.1');`,
        '',
      ].join('\n')
    : [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        "http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + req.url); }).listen(port, '127.0.0.1');",
        '',
      ].join('\n');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

// Round-3 review, B1/N4: a fixture that answers the HEALTH path differently
// from every other route, so a health-mode regression is exercised in
// isolation from ed_probe_http's `non5xx` (extra-path) branch. The round-2
// `onlyStatus` fixture answers every route identically, which meant a
// mutation that widened the health branch's threshold went undetected: the
// extra-path probe failed regardless of what the health branch did, so the
// overall check stayed red for the WRONG reason.
function makeHealthSplitFixture(
  dir: string,
  name: string,
  opts: { healthStatus: number; otherStatus: number },
): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      'const port = Number(process.env.PORT);',
      `http.createServer((req, res) => { const status = req.url === '/api/health' ? ${opts.healthStatus} : ${opts.otherStatus}; res.writeHead(status, { 'content-type': 'text/plain' }); res.end('x'); }).listen(port, '127.0.0.1');`,
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  return p;
}

// Round-3 review, N4: a route that accepts the connection and never
// responds at all (the socket stays open, unlike the existing
// "never-answered" fixture, which destroys it) — used to prove
// ed_probe_http's 5s timeout actually bounds the wait rather than hanging
// forever.
function makeHangingFixture(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      'const port = Number(process.env.PORT);',
      "http.createServer((req, res) => { if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; } /* never respond — socket left open on purpose */ }).listen(port, '127.0.0.1');",
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  return p;
}

describe('e2e-empty-dir — ed_assert_clean allowlist (#1455, round-2 review)', () => {
  it('passes on a directory holding only the binary, .next/static, public and native', () => {
    const dir = tempDir('ed-clean-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.next/static'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    mkdirSync(join(dir, 'native'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).toBe(0);
  });

  it('passes on a directory holding only the binary and .output/public — the vinext shape (BLOCKING-2)', () => {
    const dir = tempDir('ed-vinext-clean-');
    writeFileSync(join(dir, 'knext-exec-e2e'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.output/public'), { recursive: true });
    mkdirSync(join(dir, 'native'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" knext-exec-e2e`);
    expect(r.status).toBe(0);
  });

  // THE exit criterion (#1455): "guard reds on a planted node_modules", now
  // proved at the top level AND nested under every allowlisted directory —
  // BLOCKING-2's fix (allowing `.output/public`) must not reopen the door to
  // `.output/node_modules` or any nested node_modules under an allowed dir.
  it('reds on a top-level planted node_modules beside the binary', () => {
    const dir = tempDir('ed-nm-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('node_modules');
  });

  it.each([
    ['native/node_modules', 'native'],
    ['public/node_modules', 'public'],
    ['.next/static/node_modules', '.next/static'],
    ['.output/public/node_modules', '.output/public'],
  ])('reds on a nested node_modules leak at %s', (nestedPath) => {
    const dir = tempDir('ed-nested-nm-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, nestedPath), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('node_modules');
  });

  it('reds on an unexpected top-level entry not in the allowlist (package.json + server.js leak)', () => {
    const dir = tempDir('ed-stray-toplevel-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'server.js'), '');
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('package.json');
  });

  it('reds on a stray .bun cache directory (unexpected top-level entry)', () => {
    const dir = tempDir('ed-bun-cache-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.bun'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.bun');
  });

  it('reds on a server/ directory of nitro chunks (unexpected top-level entry)', () => {
    const dir = tempDir('ed-server-chunks-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, 'server/chunks'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('server');
  });

  it('reds on a .next entry other than static — the disk-mode tree leaking in', () => {
    const dir = tempDir('ed-next-server-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.next/server'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.next');
  });

  it('reds on a .output entry other than public — the nitro disk-mode tree leaking in (BLOCKING-2 symmetry)', () => {
    const dir = tempDir('ed-output-server-');
    writeFileSync(join(dir, 'knext-exec-e2e'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.output/server'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}" knext-exec-e2e`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.output');
  });

  it('reds on a stray dotfile under .next too, not only visible entries', () => {
    const dir = tempDir('ed-next-dotfile-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, '.next/.rscinfo'), 'x');
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
  });

  it('an absent .next/.output/node_modules is fine (a minimal fixture with no static assets)', () => {
    const dir = tempDir('ed-minimal-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).toBe(0);
  });

  // Round-3 review, N2 (promoted to load-bearing): the single-dot glob
  // (`.[!.]*`) matches a name with exactly ONE leading dot followed by a
  // non-dot character, so a name starting with TWO dots matched neither it
  // nor the plain `*` — measured, rc 0 before this fix.
  it('reds on a top-level name starting with two dots ("..leak"), which the single-dot glob used to miss', () => {
    const dir = tempDir('ed-dotdot-leak-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    writeFileSync(join(dir, '..leak'), 'x');
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('..leak');
  });

  // Round-3 review, N2 (promoted to load-bearing): `find -type d -name
  // node_modules` only matches real directories, so a SYMLINK named
  // node_modules under an allowlisted directory was invisible to the nested
  // sweep — measured, rc 0 before this fix.
  it('reds on native/node_modules planted as a SYMLINK, not just a real directory', () => {
    const dir = tempDir('ed-native-nm-symlink-');
    const outside = tempDir('ed-outside-nm-target-');
    mkdirSync(join(outside, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, 'native'), { recursive: true });
    symlinkSync(join(outside, 'node_modules'), join(dir, 'native/node_modules'));
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('symlink');
  });

  it('reds on an allowlisted top-level name ("public") that is itself a symlink pointing outside the empty dir', () => {
    const dir = tempDir('ed-public-symlink-');
    const outside = tempDir('ed-outside-public-target-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    symlinkSync(outside, join(dir, 'public'));
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('symlink');
  });

  it('reds on .next/static symlinked to .next/server (aliasing the disk-mode tree under an allowed name)', () => {
    // The sub-dir check only inspects the NAME ("static" is the only
    // permitted entry under .next), so a symlink literally named "static"
    // that actually points at "server" content must be caught by the
    // symlink sweep, not the name comparison.
    const dir = tempDir('ed-next-static-symlink-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.next/server'), { recursive: true });
    symlinkSync(join(dir, '.next/server'), join(dir, '.next/static'));
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('symlink');
  });

  it('reds on a symlink nested inside an otherwise-real public/ directory', () => {
    const dir = tempDir('ed-public-nested-symlink-');
    const outsideFile = join(tempDir('ed-outside-file-'), 'leaked.txt');
    writeFileSync(outsideFile, 'x');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, 'public'), { recursive: true });
    symlinkSync(outsideFile, join(dir, 'public/leaked.txt'));
    const r = sh(`ed_assert_clean "${dir}" app`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('symlink');
  });
});

describe('e2e-empty-dir — ed_stage (#1455)', () => {
  it('copies only the binary and the given specs, never anything else from the source', () => {
    const src = tempDir('ed-src-');
    writeFileSync(join(src, 'exe'), '#!/bin/sh\n');
    mkdirSync(join(src, 'public'), { recursive: true });
    writeFileSync(join(src, 'public/a.txt'), 'a');
    mkdirSync(join(src, 'node_modules/foo'), { recursive: true });
    writeFileSync(join(src, 'node_modules/foo/index.js'), '');
    mkdirSync(join(src, '.next/server'), { recursive: true });
    writeFileSync(join(src, '.next/server/x.js'), '');

    const dest = tempDir('ed-dest-');
    const r = sh(`ed_stage "${dest}" "${src}/exe" "${src}/public:public"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(dest, 'exe'));

    // The staged dir must be clean — node_modules/.next from the SOURCE were
    // never named in a copy-spec, so ed_stage must not have brought them along.
    const clean = sh(`ed_assert_clean "${dest}" exe`);
    expect(clean.status).toBe(0);
  });

  it('skips a copy-spec whose source does not exist, silently (e.g. no native/)', () => {
    const src = tempDir('ed-src2-');
    writeFileSync(join(src, 'exe'), '#!/bin/sh\n');
    const dest = tempDir('ed-dest2-');
    const r = sh(`ed_stage "${dest}" "${src}/exe" "${src}/native:native"`);
    expect(r.status).toBe(0);
    const clean = sh(`ed_assert_clean "${dest}" exe`);
    expect(clean.status).toBe(0);
  });
});

describe('e2e-empty-dir — ed_probe_http status validation (#1455, round-2 review BLOCKING-4)', () => {
  it('a health path that answers 500 fails the health probe (2xx/3xx required)', () => {
    const dir = tempDir('ed-500-health-');
    makeServerFixture(dir, 'server.js', { status: 500, onlyStatus: true });
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /anything node ./server.js
    `);
    expect(r.status).not.toBe(0);
  });

  it('a server that 500s on EVERY route fails the whole boot check (the "500-only server" fixture)', () => {
    const dir = tempDir('ed-500-all-');
    makeServerFixture(dir, 'server.js', { status: 500, onlyStatus: true });
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health / node ./server.js
    `);
    expect(r.status).not.toBe(0);
  });

  it('a 404 on the extra path is a legitimate pass (non-5xx, not "any status")', () => {
    const dir = tempDir('ed-404-extra-');
    const p = join(dir, 'server.js');
    writeFileSync(
      p,
      [
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        "http.createServer((req, res) => { if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); } else { res.writeHead(404); res.end('nope'); } }).listen(port, '127.0.0.1');",
        '',
      ].join('\n'),
    );
    chmodSync(p, 0o755);
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /nonexistent node ./server.js
    `);
    expect(r.status).toBe(0);
  });

  // Round-3 review, B1 (blocking): the round-2 `onlyStatus` fixture answers
  // EVERY route identically, so a health-mode regression was invisible — the
  // extra-path probe already failed for its own reason regardless of what
  // the health branch did. This fixture answers the health path and every
  // other route DIFFERENTLY, isolating the health branch.
  it('a health path that answers 500 while every OTHER route is healthy still fails (B1: isolates the health branch from the extra-path branch)', () => {
    const dir = tempDir('ed-health-only-500-');
    makeHealthSplitFixture(dir, 'server.js', { healthStatus: 500, otherStatus: 200 });
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health / node ./server.js
    `);
    expect(r.status).not.toBe(0);
  });

  it('health 200 / extra-path 404 still passes even when isolated from the 500-only fixture (the good-path half of B1)', () => {
    const dir = tempDir('ed-health-ok-extra-404-');
    makeHealthSplitFixture(dir, 'server.js', { healthStatus: 200, otherStatus: 404 });
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health / node ./server.js
    `);
    expect(r.status).toBe(0);
  });

  // Round-3 review, N4 (promoted to load-bearing): the health path used to
  // accept 2xx/3xx, so a redirect counted as "alive" with nothing behind it
  // confirmed. Health is now 2xx only.
  it('a 302 on the health path fails the health probe — 2xx only, not 2xx/3xx', () => {
    const dir = tempDir('ed-health-302-');
    makeHealthSplitFixture(dir, 'server.js', { healthStatus: 302, otherStatus: 200 });
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health / node ./server.js
    `);
    expect(r.status).not.toBe(0);
  });

  // Round-3 review, N4 (promoted to load-bearing): a route that hangs
  // (accepts the connection, never responds) must fail WITHIN the 5s
  // ed_probe_http timeout, never hang the whole check indefinitely.
  it('a route that hangs without responding fails within a bounded time, never hangs the probe (N4)', () => {
    const dir = tempDir('ed-hanging-');
    makeHangingFixture(dir, 'server.js');
    const start = Date.now();
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /anything node ./server.js
    `);
    const elapsedMs = Date.now() - start;
    expect(r.status).not.toBe(0);
    // Bounded by ed_probe_http's own 5s timeout plus the kill escalation —
    // must not approach the outer harness's much longer wrapper timeouts.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});

describe('e2e-empty-dir — ed_refuse_self_contained_noop (#1455, round-3 review N3)', () => {
  // scripts/e2e-deploy.sh (RUNTIME=node or KNEXT_SANDBOX_FETCH_DEBUG=1) and
  // scripts/e2e-deploy-vinext.sh (KNEXT_COMPILE=0) each call this when
  // KNEXT_SELF_CONTAINED=1 was requested on an axis with no compiled binary
  // to check. It used to be a WARNING-and-continue at each call site (no
  // shared function, no test, no mutation); this proves the extracted,
  // shared refusal fails closed instead.
  it('fails closed (non-zero) and names the reason, rather than warning and continuing', () => {
    const r = sh(
      `ed_refuse_self_contained_noop "RUNTIME=node, KNEXT_SANDBOX_FETCH_DEBUG=0 — needs RUNTIME=bun"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ERROR');
    expect(r.stderr).toContain('KNEXT_SELF_CONTAINED=1');
    expect(r.stderr).toContain('RUNTIME=node');
  });
});

// Round-3 review (non-blocking item (a)): ed_refuse_self_contained_noop's
// own logic is unit-tested above, but nothing asserted that either deploy
// script actually PROPAGATES its failure. Deleting `|| exit 1` at either
// call site would leave the (docker-requiring, not runnable here) deploy
// scripts silently continuing under `set -e` in most shapes, but nothing in
// this suite would go red — a text-scan test closes that, and it is
// mutation-proved the same way every other guard in this file is.
describe('e2e-empty-dir — deploy-script call sites propagate the refusal (#1455, round-3 review non-blocking (a))', () => {
  const CALL_SITE = /ed_refuse_self_contained_noop\s+"[^"]*"\s+\|\|\s+exit\s+1\b/;

  it('scripts/e2e-deploy.sh calls ed_refuse_self_contained_noop and propagates failure with `|| exit 1`', () => {
    const src = readFileSync(join(ROOT, 'scripts/e2e-deploy.sh'), 'utf8');
    expect(src).toMatch(CALL_SITE);
  });

  it('scripts/e2e-deploy-vinext.sh calls ed_refuse_self_contained_noop and propagates failure with `|| exit 1`', () => {
    const src = readFileSync(join(ROOT, 'scripts/e2e-deploy-vinext.sh'), 'utf8');
    expect(src).toMatch(CALL_SITE);
  });
});

describe('e2e-empty-dir — ed_boot_probe_kill / ed_check_or_die (#1455)', () => {
  it('boots a synthetic binary from an empty dir and answers both probes', () => {
    const dir = tempDir('ed-boot-');
    makeServerFixture(dir);
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /anything node ./server.js
    `);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails when the process never opens the port', () => {
    const r = sh(`ed_boot_probe_kill 0 /api/health /anything bash -c 'sleep 1'`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('exited before becoming ready');
  });

  it('fails when the process listens but never answers the extra path (never fabricates a pass)', () => {
    const dir = tempDir('ed-partial-');
    const p = join(dir, 'partial.js');
    writeFileSync(
      p,
      [
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        "http.createServer((req, res) => { if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); } else { req.socket.destroy(); } }).listen(port, '127.0.0.1');",
        '',
      ].join('\n'),
    );
    const r = sh(`
      PORT="$(${freePortExpr()})"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /never-answered node ./partial.js
    `);
    expect(r.status).not.toBe(0);
  });

  it('kills a process that ignores SIGTERM via the SIGKILL escalation, and never orphans it (round-2 review, non-blocking)', () => {
    const dir = tempDir('ed-ignore-term-');
    const p = join(dir, 'stubborn.js');
    const marker = `knext-stubborn-marker-${Date.now()}`;
    writeFileSync(
      p,
      [
        "process.on('SIGTERM', () => {});", // swallow it — only SIGKILL can end this one
        `process.title = '${marker}';`,
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        "http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        '',
      ].join('\n'),
    );
    const start = Date.now();
    const r = sh(`
        PORT="$(${freePortExpr()})"
        export PORT
        cd "${dir}"
        ed_boot_probe_kill "\${PORT}" /api/health /anything node ./stubborn.js
      `);
    const elapsedMs = Date.now() - start;
    // The escalation (TERM, wait up to ~5s, then KILL) must bound the wait
    // rather than hang forever — this is the timing half of the guard.
    expect(elapsedMs).toBeLessThan(15_000);
    expect(r.status).toBe(0);
    // The orphan half: nothing matching the marker may still be running.
    const survivor = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    expect(survivor.stdout.trim()).toBe('');
  }, 20_000);

  it('ed_check_or_die runs the whole pipeline end to end from a real source layout', () => {
    const src = tempDir('ed-e2e-src-');
    makeServerFixture(src, 'server.js');
    mkdirSync(join(src, 'public'), { recursive: true });
    writeFileSync(join(src, 'public/a.txt'), 'a');
    const dest = tempDir('ed-e2e-dest-');
    const r = sh(`
      PORT="$(${freePortExpr()})"
      ed_check_or_die "unit-test" "${dest}" "${src}/server.js" /api/health /anything "\${PORT}" "${src}/public:public"
    `);
    expect(r.status).toBe(0);
  });

  it('ed_check_or_die fails closed when the staged dir was contaminated after staging', () => {
    // Simulate the exact regression the exit criterion guards: something
    // leaves a node_modules beside the binary before boot. ed_check_or_die
    // must refuse to boot at all, not merely warn.
    const src = tempDir('ed-contam-src-');
    makeServerFixture(src, 'server.js');
    const dest = tempDir('ed-contam-dest-');
    mkdirSync(dest, { recursive: true });
    mkdirSync(join(dest, 'node_modules'), { recursive: true });
    const r = sh(`
      ed_stage "${dest}" "${src}/server.js" >/dev/null
      ed_check_or_die "unit-test" "${dest}" "${src}/server.js" /api/health /anything 0
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not clean');
  });

  it("ED_HIDE_DURING_BOOT hides a leak binary would otherwise walk up and find (BLOCKING-3, the reviewer's leak-binary repro)", () => {
    // The exact scenario the round-2 review measured: a fresh empty dir
    // whose PARENT still has a real node_modules with a require()-able
    // package in it. Without hiding, a binary that `require`s it succeeds
    // (module resolution walks up); with ED_HIDE_DURING_BOOT naming that
    // parent path, the require must fail during the boot.
    const parent = tempDir('ed-hide-parent-');
    mkdirSync(join(parent, 'node_modules/leakpkg'), { recursive: true });
    writeFileSync(join(parent, 'node_modules/leakpkg/index.js'), "module.exports = 'leaked';\n");
    writeFileSync(join(parent, 'node_modules/leakpkg/package.json'), '{"main":"index.js"}');
    const src = tempDir('ed-hide-src-');
    const binPath = join(src, 'leak-check.js');
    writeFileSync(
      binPath,
      [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        'let reachable;',
        "try { require('leakpkg'); reachable = true; } catch { reachable = false; }",
        'http.createServer((req, res) => {',
        "  if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }",
        // 500 when the leak package WAS reachable — proves via the probe,
        // not just a log line, that hiding worked.
        '  res.writeHead(reachable ? 500 : 200);',
        "  res.end(reachable ? 'leaked' : 'clean');",
        '}).listen(port, "127.0.0.1");',
        '',
      ].join('\n'),
    );
    chmodSync(binPath, 0o755);
    const dest = join(parent, 'ed-empty-dir-inside-parent');
    const r = sh(`
      PORT="$(${freePortExpr()})"
      ED_HIDE_DURING_BOOT=("${parent}/node_modules")
      ed_check_or_die "hide-test" "${dest}" "${binPath}" /api/health / "\${PORT}"
    `);
    expect(r.status).toBe(0);
    // node_modules must be back in place afterwards — the hide is transient.
    const restored = sh(`test -d "${parent}/node_modules/leakpkg" && echo present`);
    expect(restored.stdout.trim()).toBe('present');
  });

  it('without ED_HIDE_DURING_BOOT, the same leak binary DOES see the parent node_modules (proves the repro is real)', () => {
    const parent = tempDir('ed-nohide-parent-');
    mkdirSync(join(parent, 'node_modules/leakpkg'), { recursive: true });
    writeFileSync(join(parent, 'node_modules/leakpkg/index.js'), "module.exports = 'leaked';\n");
    writeFileSync(join(parent, 'node_modules/leakpkg/package.json'), '{"main":"index.js"}');
    const src = tempDir('ed-nohide-src-');
    const binPath = join(src, 'leak-check.js');
    writeFileSync(
      binPath,
      [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        'const port = Number(process.env.PORT);',
        'let reachable;',
        "try { require('leakpkg'); reachable = true; } catch { reachable = false; }",
        'http.createServer((req, res) => {',
        "  if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }",
        '  res.writeHead(reachable ? 500 : 200);',
        "  res.end(reachable ? 'leaked' : 'clean');",
        '}).listen(port, "127.0.0.1");',
        '',
      ].join('\n'),
    );
    chmodSync(binPath, 0o755);
    const dest = join(parent, 'ed-empty-dir-inside-parent');
    const r = sh(`
      PORT="$(${freePortExpr()})"
      ed_check_or_die "nohide-test" "${dest}" "${binPath}" /api/health / "\${PORT}"
    `);
    // The extra path (`/`) 500s because the leak WAS reachable — ed_probe_http's
    // non5xx requirement (BLOCKING-4) turns that into a failing check, which is
    // the correct outcome, but for a DIFFERENT reason than BLOCKING-3 — so this
    // assertion only proves the repro's premise (unhidden = reachable), not the
    // fix. The fix is proved by the test above.
    expect(r.status).not.toBe(0);
  });

  // Round-3 review, N1 (promoted to load-bearing): a SIGKILL of the whole
  // process group skips the subshell's own EXIT trap, so a previous run's
  // hide is never restored and "<p>.ed-hidden" is left on disk. A naive
  // re-run would then `mv <p> <p>.ed-hidden` INTO the existing hidden copy,
  // nesting the fresh tree inside the stale one. Must fail closed instead.
  it('ed_check_or_die fails closed (never hides again) when a stale <p>.ed-hidden already exists from a killed prior run', () => {
    // Reproduces the measured residue exactly: a prior run's SIGKILL (of the
    // whole process group, so its EXIT trap never fired) left
    // node_modules.ed-hidden on disk with the OLD tree inside. This run's
    // own pipeline has since rebuilt a FRESH node_modules alongside it —
    // both paths coexist, which is precisely when a naive `mv node_modules
    // node_modules.ed-hidden` would move the fresh tree INTO the stale
    // directory (nesting) rather than failing.
    const parent = tempDir('ed-stale-hidden-parent-');
    const staleHidden = join(parent, 'node_modules.ed-hidden');
    mkdirSync(staleHidden, { recursive: true });
    writeFileSync(join(staleHidden, 'MARKER-stale-real-copy'), 'x');
    mkdirSync(join(parent, 'node_modules/freshpkg'), { recursive: true });
    writeFileSync(join(parent, 'node_modules/freshpkg/index.js'), "module.exports = 'fresh';\n");

    const src = tempDir('ed-stale-hidden-src-');
    makeServerFixture(src, 'server.js');
    const dest = join(parent, 'ed-empty-dir-inside-parent');
    const r = sh(`
      PORT="$(${freePortExpr()})"
      ED_HIDE_DURING_BOOT=("${parent}/node_modules")
      ed_check_or_die "stale-hidden-test" "${dest}" "${src}/server.js" /api/health / "\${PORT}"
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already exists');
    expect(r.stderr).toContain('restore');
    // Neither copy may have moved: the stale hidden copy stays exactly as
    // found (never nested into), and the fresh node_modules stays named
    // node_modules (never renamed on top of it).
    const staleSurvived = sh(`test -f "${staleHidden}/MARKER-stale-real-copy" && echo present`);
    expect(staleSurvived.stdout.trim()).toBe('present');
    const notNested = sh(`test -e "${staleHidden}/node_modules" && echo nested || echo clean`);
    expect(notNested.stdout.trim()).toBe('clean');
    const freshUntouched = sh(`test -d "${parent}/node_modules/freshpkg" && echo present`);
    expect(freshUntouched.stdout.trim()).toBe('present');
  });
});

// ══ #1514 — the SUITE server is served from the empty dir, not APP_DIR ════════
//
// Three guards, one per half of the fix:
//   (a) TEXT: in both deploy scripts, the self-contained branch of the suite
//       boot cds into EMPTY_DIR and execs the STAGED binary (standalone: the
//       container mounts only EMPTY_DIR), after arming the restore trap and
//       hiding APP_DIR; the metadata records SERVED_FROM; the isolation check
//       runs before the URL is handed over.
//   (b) RUNTIME: while the suite server is up, node_modules / .output /
//       .next/server are unreachable from its cwd and via the hidden APP_DIR,
//       and APP_DIR is restored on every exit path.
//   (c) FINGERPRINT: a self-contained fingerprint requires the frozen harness
//       to declare served_from=empty-dir; missing or `disk` fails it.

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** The text from `start` (which must occur exactly once) to the first `end` after it. */
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(src.indexOf(start, i + 1)).toBe(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

/** Every `cd "<target>"` target in a block, in order. */
function cdTargets(text: string): string[] {
  return [...text.matchAll(/^\s*cd\s+"([^"]+)"/gm)].map((m) => m[1]);
}

/** Asserts `needles` occur in `text` in the given order (each at least once). */
function expectInOrder(text: string, needles: string[]) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    expect({ needle: n, found: i > at }).toEqual({ needle: n, found: true });
    at = i;
  }
}

describe('#1514 (a) — the self-contained suite boot runs from EMPTY_DIR (text scan)', () => {
  it('scripts/e2e-deploy-vinext.sh: the SC branch cds ONLY into EMPTY_DIR and execs the staged binary', () => {
    const src = readRepo('scripts/e2e-deploy-vinext.sh');
    const sc = block(
      src,
      'if [ "${KNEXT_COMPILE}" != "0" ] && [ "${KNEXT_SELF_CONTAINED:-0}" = "1" ]; then',
      '\nelif [ "${KNEXT_COMPILE}" != "0" ]; then',
    );
    expect(cdTargets(sc)).toEqual(['${EMPTY_DIR}']);
    expect(sc).toMatch(/^\s*exec "\$\{EMPTY_DIR_STAGED\}"$/m);
    expect(sc).not.toMatch(/exec\s+"\$\{KNEXT_EXEC\}"/);
    expect(sc).toContain('EMPTY_DIR_STAGED="$(ed_suite_stage "${EMPTY_DIR}" "${KNEXT_EXEC}"');
    expectInOrder(sc, [
      'ed_suite_arm_restore_trap "${APP_DIR}"',
      'ed_suite_hide_app_dir "${APP_DIR}" || exit 1',
      'SERVED_FROM="${ED_SUITE_SERVED_FROM_SC}"',
      'cd "${EMPTY_DIR}"',
      'ED_SUITE_SERVER_PID="${SERVER_PID}"',
    ]);
  });

  it('scripts/e2e-deploy.sh: the SC container cds into EMPTY_DIR and mounts ONLY EMPTY_DIR', () => {
    const src = readRepo('scripts/e2e-deploy.sh');
    const boot = block(
      src,
      '(\n  if [ "${SERVED_FROM}" != "disk" ]; then',
      '\n  fi\n  cd "${STANDALONE_APP_DIR}"',
    );
    expect(cdTargets(boot)).toEqual(['${EMPTY_DIR}']);
    expect([...boot.matchAll(/-v\s+"([^"]+)"/g)].map((m) => m[1])).toEqual([
      '${EMPTY_DIR}:${EMPTY_DIR}',
    ]);
    expect(boot).toContain('-w "${EMPTY_DIR}"');
    expect(boot).toContain('"./$(basename "${EMPTY_DIR_STAGED}")"');
    // ED_SUITE_CONTAINER is CONTAINER_NAME (asserted in the setup block
    // below), so e2e-cleanup.sh's `docker rm -f` and the port-ownership
    // `docker inspect` both still find it.
    expect(boot).toContain('exec docker run --rm --name "${ED_SUITE_CONTAINER}"');
    for (const disk of ['STANDALONE_ROOT', 'STANDALONE_APP_DIR', 'CONTAINER_ROOT', '{APP_DIR}']) {
      expect({ disk, present: boot.includes(disk) }).toEqual({ disk, present: false });
    }
    const setup = block(
      src,
      'if [ -n "${STANDALONE_EXEC}" ] && [ "${KNEXT_SELF_CONTAINED:-0}" = "1" ]; then',
      '\nfi\n(',
    );
    expect(setup).toContain(
      'EMPTY_DIR_STAGED="$(ed_suite_stage "${EMPTY_DIR}" "${STANDALONE_EXEC}"',
    );
    expectInOrder(setup, [
      'ed_suite_arm_restore_trap "${APP_DIR}"',
      'ED_SUITE_CONTAINER="${CONTAINER_NAME}"',
      'ed_suite_hide_app_dir "${APP_DIR}" || exit 1',
      'SERVED_FROM="${ED_SUITE_SERVED_FROM_SC}"',
    ]);
  });

  for (const script of ['scripts/e2e-deploy.sh', 'scripts/e2e-deploy-vinext.sh']) {
    it(`${script}: records SERVED_FROM in the metadata and checks isolation BEFORE handing the URL over`, () => {
      const src = readRepo(script);
      expect(src.split('SERVED_FROM="disk"').length - 1).toBe(1);
      const meta = block(src, '{\n  echo "BUILD_ID=${BUILD_ID}"', '} >"${LOG_FILE}"');
      expect(meta).toContain('echo "SERVED_FROM=${SERVED_FROM}"');
      const tail = src.slice(src.lastIndexOf('if [ "${SERVED_FROM}" != "disk" ]; then'));
      expectInOrder(tail, [
        'if ! ed_assert_suite_isolated "${EMPTY_DIR}" "${APP_DIR}"; then',
        'exit 1',
        'ed_suite_hand_off',
        'echo "http://localhost:${PORT}"',
      ]);
    });
  }
});

/** A synthetic "binary": answers /api/health, and /reach with 500 if ANY disk-tree path is reachable. */
function makeReachFixture(dir: string, appDir: string): string {
  const p = join(dir, 'knext-exec');
  writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      'const port = Number(process.env.PORT);',
      `const APP = ${JSON.stringify(appDir)};`,
      'const probes = () => [',
      "  'node_modules', '.next/server', '.output/server',",
      "  APP + '/node_modules', APP + '/.next/server', APP + '/.output/server',",
      '].filter((q) => fs.existsSync(q));',
      'function leak() {',
      "  try { require('leakpkg'); return ['require(leakpkg)']; } catch { return probes(); }",
      '}',
      'http.createServer((req, res) => {',
      "  if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }",
      '  const found = leak();',
      '  res.writeHead(found.length ? 500 : 200); res.end(found.join(","));',
      "}).listen(port, '127.0.0.1');",
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  return p;
}

/**
 * A temp dir for the suite server's EMPTY_DIR parent, rooted at /tmp when it
 * exists: ed_assert_suite_isolated rejects a node_modules in ANY ancestor of
 * the cwd, and the test runner's tmpdir() can resolve inside a checkout.
 */
function outsideTempDir(prefix: string): string {
  const dir = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

/** An APP_DIR shaped like a built fixture: the disk tree the suite server must NOT see. */
function makeAppDir(): string {
  const app = tempDir('ed-suite-app-');
  mkdirSync(join(app, 'node_modules/leakpkg'), { recursive: true });
  writeFileSync(join(app, 'node_modules/leakpkg/index.js'), "module.exports = 'leaked';\n");
  writeFileSync(join(app, 'node_modules/leakpkg/package.json'), '{"main":"index.js"}');
  mkdirSync(join(app, '.next/server'), { recursive: true });
  writeFileSync(join(app, '.next/server/page.js'), 'x');
  mkdirSync(join(app, '.output/server'), { recursive: true });
  writeFileSync(join(app, '.output/server/index.mjs'), 'x');
  mkdirSync(join(app, '.output/public'), { recursive: true });
  writeFileSync(join(app, '.output/public/a.txt'), 'a');
  makeReachFixture(app, app);
  return app;
}

/**
 * The SC suite-serving sequence both deploy scripts run (stage → arm → hide →
 * boot from EMPTY_DIR → ready → <plant> → isolation check → reach probe →
 * hand off), as a standalone bash script against the real lib. `plant` runs
 * while the server is UP, before the isolation check.
 */
function suiteScript(app: string, emptyParent: string, plant = '', afterHandOff = ''): string {
  return `
    set -euo pipefail
    . "${LIB}"
    APP_DIR="${app}"
    EMPTY_DIR="$(mktemp -d "${emptyParent}/knext-empty-dir-suite.XXXXXX")"
    EMPTY_DIR_STAGED="$(ed_suite_stage "\${EMPTY_DIR}" "\${APP_DIR}/knext-exec" "\${APP_DIR}/.output/public:.output/public")"
    ed_suite_arm_restore_trap "\${APP_DIR}"
    ed_suite_hide_app_dir "\${APP_DIR}" || exit 1
    PORT="$(${freePortExpr()})"
    ( cd "\${EMPTY_DIR}"; PORT="\${PORT}" exec "\${EMPTY_DIR_STAGED}" ) >/dev/null 2>&1 &
    SERVER_PID=$!
    ED_SUITE_SERVER_PID="\${SERVER_PID}"
    echo "PID=\${SERVER_PID}"
    echo "EMPTY_DIR=\${EMPTY_DIR}"
    for _ in $(seq 1 100); do
      node -e "require('net').connect(\${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break
      sleep 0.1
    done
    ${plant}
    ed_assert_suite_isolated "\${EMPTY_DIR}" "\${APP_DIR}" || exit 1
    node "${join(ROOT, 'scripts/lib/e2e-probe-http.mjs')}" "\${PORT}" /reach 2xx3xx || { echo "REACHABLE" >&2; exit 1; }
    ed_suite_hand_off
    echo HANDED_OFF
    ${afterHandOff}
  `;
}

function runSuite(script: string) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
}

function field(stdout: string, key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout);
  return m ? m[1] : '';
}

function alive(pid: string): boolean {
  if (!pid) return false;
  return spawnSync('kill', ['-0', pid]).status === 0;
}

function hiddenState(app: string) {
  return {
    node_modules: existsSync(join(app, 'node_modules')),
    '.next': existsSync(join(app, '.next')),
    '.output': existsSync(join(app, '.output')),
    hidden: ['node_modules', '.next', '.output'].filter((n) =>
      existsSync(join(app, `${n}.ed-hidden`)),
    ),
  };
}

const RESTORED = { node_modules: true, '.next': true, '.output': true, hidden: [] };
const HIDDEN = {
  node_modules: false,
  '.next': false,
  '.output': false,
  hidden: ['node_modules', '.next', '.output'],
};

describe('#1514 (b) — the suite server runs with the disk tree unreachable (runtime)', () => {
  it('serves from EMPTY_DIR with node_modules/.next/.output hidden, hands off, and e2e-cleanup.sh restores after stopping it', () => {
    const app = makeAppDir();
    const r = runSuite(suiteScript(app, outsideTempDir('ed-suite-parent-')));
    const pid = field(r.stdout, 'PID');
    try {
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('HANDED_OFF');
      // Handed off: the tree STAYS hidden for the whole suite run, and the
      // server keeps running — the deploy script's exit must not restore it.
      expect(hiddenState(app)).toEqual(HIDDEN);
      expect(alive(pid)).toBe(true);
      // Teardown, exactly as the harness runs it: cwd = APP_DIR, metadata present.
      writeFileSync(join(app, '.adapter-build.log'), `PID=${pid}\nSERVED_FROM=empty-dir\n`);
      const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
        cwd: app,
        encoding: 'utf8',
      });
      expect(c.status).toBe(0);
      expect(alive(pid)).toBe(false);
      expect(hiddenState(app)).toEqual(RESTORED);
      expect(readFileSync(join(app, 'node_modules/leakpkg/index.js'), 'utf8')).toContain('leaked');
    } finally {
      if (alive(pid)) spawnSync('kill', ['-KILL', pid]);
    }
  }, 60_000);

  // Each plant re-exposes the disk tree to the RUNNING server in a different
  // way; each must red the isolation check — and the failed deploy must stop
  // its server and restore APP_DIR on the way out.
  const PLANTS: Record<string, string> = {
    'symlinked node_modules in the cwd':
      'ln -s "${APP_DIR}/node_modules.ed-hidden" "${EMPTY_DIR}/node_modules"',
    'symlinked .output/server in the cwd':
      'ln -s "${APP_DIR}/.output.ed-hidden/server" "${EMPTY_DIR}/.output/server"',
    'symlinked .next/server in the cwd':
      'mkdir -p "${EMPTY_DIR}/.next" && ln -s "${APP_DIR}/.next.ed-hidden/server" "${EMPTY_DIR}/.next/server"',
    // Real directories, not symlinks — the symlink sweep cannot see these, so
    // they isolate the cwd-path check itself (prover mutation 20).
    'a REAL node_modules directory created in the cwd': 'mkdir "${EMPTY_DIR}/node_modules"',
    'a REAL .output/server directory created in the cwd': 'mkdir "${EMPTY_DIR}/.output/server"',
    'a REAL .next/server directory created in the cwd': 'mkdir -p "${EMPTY_DIR}/.next/server"',
    'a symlink nested under the staged static assets':
      'ln -s /nonexistent-knext-leak "${EMPTY_DIR}/.output/public/leak"',
    'node_modules in an ANCESTOR of the cwd (module resolution walks up)':
      'mkdir "$(dirname "${EMPTY_DIR}")/node_modules"',
    'the hidden APP_DIR/node_modules symlinked back under its real name':
      'ln -s "${APP_DIR}/node_modules.ed-hidden" "${APP_DIR}/node_modules"',
    'the hidden APP_DIR/.next symlinked back under its real name':
      'ln -s "${APP_DIR}/.next.ed-hidden" "${APP_DIR}/.next"',
    'the hidden APP_DIR/.output symlinked back under its real name':
      'ln -s "${APP_DIR}/.output.ed-hidden" "${APP_DIR}/.output"',
  };
  for (const [label, plant] of Object.entries(PLANTS)) {
    it(`a planted leak reds the isolation check: ${label}`, () => {
      const app = makeAppDir();
      const parent = outsideTempDir('ed-suite-plant-');
      // The plants that re-create an APP_DIR name as a symlink must be undone
      // before the trap restores, or the restore (correctly) refuses to nest.
      const r = runSuite(suiteScript(app, parent, plant));
      const pid = field(r.stdout, 'PID');
      try {
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain('HANDED_OFF');
        expect(r.stderr).toContain('suite:');
        expect(alive(pid)).toBe(false);
      } finally {
        if (alive(pid)) spawnSync('kill', ['-KILL', pid]);
      }
    }, 60_000);
  }

  it('without the hide, the running server DOES reach the disk tree (the probe is not decoration)', () => {
    const app = makeAppDir();
    // Both the hide AND the static isolation check removed: only the
    // server's own view (the /reach probe) is left to notice.
    const script = suiteScript(app, outsideTempDir('ed-suite-nohide-'))
      .replace('ed_suite_hide_app_dir "${APP_DIR}" || exit 1', ':')
      .replace('ed_assert_suite_isolated "${EMPTY_DIR}" "${APP_DIR}" || exit 1', ':');
    expect(script).not.toContain('ed_suite_hide_app_dir');
    expect(script).not.toContain('ed_assert_suite_isolated');
    const r = runSuite(script);
    const pid = field(r.stdout, 'PID');
    try {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('REACHABLE');
      expect(r.stdout).not.toContain('HANDED_OFF');
    } finally {
      if (alive(pid)) spawnSync('kill', ['-KILL', pid]);
    }
  }, 60_000);
});

describe('#1514 (b) — APP_DIR is restored on EVERY exit path before hand-off', () => {
  it('an explicit `exit 1` after hiding: server stopped, APP_DIR restored, exit code preserved', () => {
    const app = makeAppDir();
    const r = runSuite(suiteScript(app, outsideTempDir('ed-exit-'), 'exit 7'));
    expect(r.status).toBe(7);
    expect(alive(field(r.stdout, 'PID'))).toBe(false);
    expect(hiddenState(app)).toEqual(RESTORED);
  }, 60_000);

  it('a `set -e` failure after hiding restores APP_DIR', () => {
    const app = makeAppDir();
    const r = runSuite(suiteScript(app, outsideTempDir('ed-sete-'), 'false'));
    expect(r.status).not.toBe(0);
    expect(alive(field(r.stdout, 'PID'))).toBe(false);
    expect(hiddenState(app)).toEqual(RESTORED);
  }, 60_000);

  it('SIGTERM to the deploy script after hiding restores APP_DIR (the trap converts it into an exit)', async () => {
    const app = makeAppDir();
    const parent = outsideTempDir('ed-term-');
    const marker = join(parent, 'HIDDEN-NOW');
    const script = suiteScript(app, parent, `touch "${marker}"; while :; do sleep 0.1; done`);
    const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    for (let i = 0; i < 300 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    expect(hiddenState(app)).toEqual(HIDDEN);
    child.kill('SIGTERM');
    const code = await exited;
    expect(code).toBe(143);
    expect(alive(field(out, 'PID'))).toBe(false);
    expect(hiddenState(app)).toEqual(RESTORED);
  }, 60_000);

  it('the hide refuses (and restores what it hid) when a stale <name>.ed-hidden exists from a killed run', () => {
    const app = makeAppDir();
    mkdirSync(join(app, '.output.ed-hidden'));
    writeFileSync(join(app, '.output.ed-hidden/STALE'), 'x');
    const r = runSuite(suiteScript(app, outsideTempDir('ed-stale-')));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already exists');
    // node_modules/.next were hidden before the refusal; the trap put them back.
    expect(existsSync(join(app, 'node_modules/leakpkg'))).toBe(true);
    expect(existsSync(join(app, '.next/server'))).toBe(true);
    // Neither copy of .output moved.
    expect(existsSync(join(app, '.output/server'))).toBe(true);
    expect(existsSync(join(app, '.output.ed-hidden/STALE'))).toBe(true);
  }, 60_000);

  it('restore refuses to nest when BOTH <name> and <name>.ed-hidden exist', () => {
    const app = tempDir('ed-both-');
    mkdirSync(join(app, 'node_modules'));
    mkdirSync(join(app, 'node_modules.ed-hidden'));
    writeFileSync(join(app, 'node_modules.ed-hidden/REAL'), 'x');
    const r = sh(`ed_suite_restore_app_dir "${app}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('refusing to restore');
    expect(existsSync(join(app, 'node_modules/node_modules.ed-hidden'))).toBe(false);
    expect(existsSync(join(app, 'node_modules.ed-hidden/REAL'))).toBe(true);
  });

  it('e2e-cleanup.sh restores a hidden APP_DIR even when the deploy died before writing metadata', () => {
    const app = makeAppDir();
    for (const n of ['node_modules', '.next', '.output']) {
      spawnSync('mv', [join(app, n), join(app, `${n}.ed-hidden`)]);
    }
    expect(hiddenState(app)).toEqual(HIDDEN);
    const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
      cwd: app,
      encoding: 'utf8',
    });
    expect(c.status).toBe(0);
    expect(hiddenState(app)).toEqual(RESTORED);
  });
});

/** A copy of the REAL frozen harness (every file collectHarness hashes), so the fingerprint runs against today's scripts. */
function harnessCopy(): string {
  const root = tempDir('ed-fp-repo-');
  for (const e of collectHarness(ROOT, 'node', {}) as { path: string }[]) {
    mkdirSync(dirname(join(root, e.path)), { recursive: true });
    copyFileSync(join(ROOT, e.path), join(root, e.path));
  }
  return root;
}

function tarballsDir(): string {
  const dir = tempDir('ed-fp-tgz-');
  const stage = tempDir('ed-fp-pkg-');
  mkdirSync(join(stage, 'package'));
  writeFileSync(
    join(stage, 'package/package.json'),
    '{"name":"@getknext/core","version":"0.0.0-test"}\n',
  );
  const t = spawnSync('tar', ['czf', join(dir, 'core.tgz'), '-C', stage, 'package']);
  expect(t.status).toBe(0);
  return dir;
}

function fingerprintCli(repoRoot: string, tgz: string, selfContained: boolean) {
  const args = [
    join(ROOT, 'scripts/compat-window-fingerprint.mjs'),
    '--repo-root',
    repoRoot,
    '--tarballs-dir',
    tgz,
    '--json',
  ];
  if (selfContained) args.push('--self-contained');
  return spawnSync('node', args, { encoding: 'utf8' });
}

function setDeclaration(repoRoot: string, replacement: string) {
  const lib = join(repoRoot, 'scripts/lib/e2e-empty-dir.sh');
  const src = readFileSync(lib, 'utf8');
  const decl = 'ED_SUITE_SERVED_FROM_SC="empty-dir"\n';
  expect(src.split(decl).length - 1).toBe(1);
  writeFileSync(lib, src.replace(decl, replacement));
}

describe('#1514 (c) — a self-contained fingerprint requires served_from=empty-dir', () => {
  it('the real harness declares empty-dir: the self-contained fingerprint folds it and records it', () => {
    const r = fingerprintCli(harnessCopy(), tarballsDir(), true);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.recorded.selfContained).toEqual({
      value: true,
      frozen: true,
      servedFrom: 'empty-dir',
    });
    // Never the pre-#1514 marker: a window served from disk under the
    // self-contained label cannot share this digest.
    const pre1514 = `sha256:${createHash('sha256').update('selfContained\ttrue').digest('hex')}`;
    expect(out.components.selfContained).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.components.selfContained).not.toBe(pre1514);
  });

  it('served_from=disk under --self-contained FAILS the fingerprint', () => {
    const repo = harnessCopy();
    setDeclaration(repo, 'ED_SUITE_SERVED_FROM_SC="disk"\n');
    const r = fingerprintCli(repo, tarballsDir(), true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('served_from=disk');
  });

  it('a MISSING served_from declaration under --self-contained FAILS the fingerprint', () => {
    const repo = harnessCopy();
    setDeclaration(repo, '');
    const r = fingerprintCli(repo, tarballsDir(), true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('served_from=MISSING');
  });

  it('disk mode (no --self-contained) needs no declaration and folds nothing', () => {
    const repo = harnessCopy();
    setDeclaration(repo, 'ED_SUITE_SERVED_FROM_SC="disk"\n');
    const r = fingerprintCli(repo, tarballsDir(), false);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.components).not.toHaveProperty('selfContained');
    expect(out.recorded.selfContained).toEqual({ value: false, frozen: false, servedFrom: null });
  });
});

// ══ #1515 — the pre-check probe measured nothing in run 36312054519 ═══════════
//
// (1) the probe server's `➜ Listening on: …` banner went to the deploy
//     script's STDOUT, which the Next harness reads as the deployment URL;
// (2) the probe demanded /api/health 2xx, a route ordinary compat fixtures do
//     not have. The compat lanes now probe ONE staged static file for 2xx and
//     `/` for non-5xx; /api/health stays available via KNEXT_EMPTY_DIR_HEALTH_PATH.

/**
 * A stand-in for a compiled compat fixture: prints nitro's banner to STDOUT,
 * serves files from `.output/public` (cwd-relative) with 200, has NO
 * /api/health (404), and answers `/` with `rootStatus`.
 */
function makeCompatFixture(dir: string, rootStatus: number): string {
  const p = join(dir, 'knext-exec-e2e');
  writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const port = Number(process.env.PORT);',
      'http.createServer((req, res) => {',
      "  if (req.url === '/') { res.writeHead(" +
        String(rootStatus) +
        "); res.end('root'); return; }",
      "  const f = path.join(process.cwd(), '.output/public', decodeURIComponent(req.url));",
      '  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200); res.end(fs.readFileSync(f)); return; }',
      "  res.writeHead(404); res.end('not found');",
      "}).listen(port, '127.0.0.1', () => { console.log('➜ Listening on: http://localhost:' + port + '/ (all interfaces)'); });",
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  mkdirSync(join(dir, '.output/public/assets'), { recursive: true });
  writeFileSync(join(dir, '.output/public/assets/app-abc.js'), 'console.log(1)');
  return p;
}

/**
 * The deploy-script shape around the pre-check: the probe, then the ONE
 * stdout line. Its stdout must be exactly that line whatever the probe
 * server prints.
 */
function miniDeploy(src: string, dest: string, health: string) {
  return sh(`
    set -e
    PORT="$(${freePortExpr()})"
    ed_check_or_die "compat" "${dest}" "${src}/knext-exec-e2e" "${health}" / "\${PORT}" \\
      "${src}/.output/public:.output/public"
    echo "http://localhost:4242"
  `);
}

describe('#1515 — the empty-dir pre-check probe (stdout contract + per-lane health path)', () => {
  it("the probe server's stdout banner never reaches the deploy script's stdout: it stays exactly the one URL line", () => {
    const src = tempDir('ed-1515-stdout-src-');
    makeCompatFixture(src, 200);
    const r = miniDeploy(src, join(tempDir('ed-1515-stdout-dest-'), 'd'), '@static');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('http://localhost:4242\n');
    // The banner WAS printed — it went to stderr, not nowhere.
    expect(r.stderr).toContain('➜ Listening on:');
  });

  it('a compat fixture with NO /api/health (404) and a 404 at / passes the static-file probe', () => {
    const src = tempDir('ed-1515-compat-src-');
    makeCompatFixture(src, 404);
    const r = miniDeploy(src, join(tempDir('ed-1515-compat-dest-'), 'd'), '@static');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('probing the staged static file /assets/app-abc.js');
  });

  it('the SAME fixture fails when the lane demands /api/health (the run-36312054519 defect, reproduced)', () => {
    const src = tempDir('ed-1515-oldhealth-src-');
    makeCompatFixture(src, 200);
    const r = miniDeploy(src, join(tempDir('ed-1515-oldhealth-dest-'), 'd'), '/api/health');
    expect(r.status).not.toBe(0);
  });

  it('a 5xx at / fails the probe even when the static file answers 200', () => {
    const src = tempDir('ed-1515-root500-src-');
    makeCompatFixture(src, 500);
    const r = miniDeploy(src, join(tempDir('ed-1515-root500-dest-'), 'd'), '@static');
    expect(r.status).not.toBe(0);
  });

  it('a missing static file fails the probe (2xx is required of the staged asset)', () => {
    const src = tempDir('ed-1515-nostatic-src-');
    makeCompatFixture(src, 200);
    rmSync(join(src, '.output/public/assets/app-abc.js'));
    writeFileSync(join(src, '.output/public/assets/.keep-dir'), '');
    // The staged file exists but the server is told a path it does not serve.
    const dest = join(tempDir('ed-1515-nostatic-dest-'), 'd');
    const r = sh(`
      PORT="$(${freePortExpr()})"
      ed_check_or_die "compat" "${dest}" "${src}/knext-exec-e2e" /assets/not-staged.js / "\${PORT}" \\
        "${src}/.output/public:.output/public"
    `);
    expect(r.status).not.toBe(0);
  });

  it('ed_static_probe_path: .output/public first, .next/static under /_next/static, public, basePath prefix; fails on none', () => {
    const d = tempDir('ed-1515-pick-');
    mkdirSync(join(d, '.next/static/chunks'), { recursive: true });
    writeFileSync(join(d, '.next/static/chunks/b.js'), 'x');
    writeFileSync(join(d, '.next/static/chunks/a.js'), 'x');
    mkdirSync(join(d, 'public'), { recursive: true });
    writeFileSync(join(d, 'public/robots.txt'), 'x');
    expect(sh(`ed_static_probe_path "${d}"`).stdout).toBe('/_next/static/chunks/a.js\n');
    expect(sh(`ed_static_probe_path "${d}" /docs`).stdout).toBe('/docs/_next/static/chunks/a.js\n');
    mkdirSync(join(d, '.output/public'), { recursive: true });
    writeFileSync(join(d, '.output/public/favicon.ico'), 'x');
    expect(sh(`ed_static_probe_path "${d}"`).stdout).toBe('/favicon.ico\n');
    const empty = tempDir('ed-1515-pick-empty-');
    const r = sh(`ed_static_probe_path "${empty}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no static file was staged');
  });

  for (const script of ['scripts/e2e-deploy.sh', 'scripts/e2e-deploy-vinext.sh']) {
    it(`${script}: the compat pre-check defaults to the staged static file, never a hardcoded /api/health`, () => {
      const src = readRepo(script);
      expect(src).toContain('"${KNEXT_EMPTY_DIR_HEALTH_PATH:-${ED_STATIC_PROBE}}"');
      expect(src).not.toMatch(/(ed_check_or_die|ed_boot_probe_kill)\b[^\n]*\/api\/health/);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PR #1521 round 2 — reviewer findings 1-4 (review-1521.md)
// ═══════════════════════════════════════════════════════════════════════════

/** A tiny fixture that, on SIGTERM, records whether <checkPath> already exists
 * (i.e. whether e2e-cleanup.sh had already restored it) BEFORE exiting. Used
 * to make the "stop before restore" invariant order-sensitive rather than
 * only end-state-sensitive (finding 1 / mutation R16). */
function makeSigtermOrderFixture(dir: string): string {
  const p = join(dir, 'sigterm-order-server.js');
  const body = [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const checkPath = process.argv[2];',
    'const resultFile = process.argv[3];',
    "process.on('SIGTERM', () => {",
    '  const restoredBeforeStop = fs.existsSync(checkPath);',
    '  fs.writeFileSync(resultFile, JSON.stringify({ restoredBeforeStop }));',
    '  process.exit(0);',
    '});',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe('#1521 round-2, finding 1 — e2e-cleanup.sh stops the server BEFORE restoring APP_DIR', () => {
  it('the server observes node_modules still hidden at the moment it receives SIGTERM', () => {
    const app = makeAppDir();
    const hide = sh(`ed_suite_hide_app_dir "${app}"`);
    expect(hide.status).toBe(0);
    expect(hiddenState(app)).toEqual(HIDDEN);

    const workDir = tempDir('ed-r16-work-');
    const resultFile = join(workDir, 'result.json');
    const checkPath = join(app, 'node_modules'); // the RESTORED (real) name
    const script = makeSigtermOrderFixture(workDir);
    // Backgrounded via bash (mirrors suiteScript()/runSuite() elsewhere in
    // this file), NOT via a direct node child_process.spawn() from this test
    // process: the test runner stays busy inside the synchronous
    // spawnSync(e2e-cleanup.sh) call below, so a child spawned directly by IT
    // sits as a zombie (exited but unreaped) for that whole window, and
    // `kill -0`/`kill -TERM` from e2e-cleanup.sh see a zombie as "alive" the
    // entire time — a harness artifact, not a defect in the order under
    // test. Backgrounding via bash instead: the bash process is this
    // spawnSync's child, it exits once the fixture is backgrounded and
    // handed off, and the fixture is reparented to init, which reaps it
    // immediately on exit — the same reparenting the real deploy scripts and
    // e2e-cleanup.sh depend on for the SAME reason.
    const launch = spawnSync(
      'bash',
      ['-c', `node "${script}" "${checkPath}" "${resultFile}" >/dev/null 2>&1 & echo "PID=$!"`],
      { encoding: 'utf8' },
    );
    const pid = field(launch.stdout, 'PID');
    expect(pid).toBeTruthy();
    expect(alive(pid)).toBe(true);

    try {
      writeFileSync(join(app, '.adapter-build.log'), `PID=${pid}\nSERVED_FROM=empty-dir\n`);
      const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
        cwd: app,
        encoding: 'utf8',
      });
      expect(c.status).toBe(0);
      expect(alive(pid)).toBe(false);
      expect(hiddenState(app)).toEqual(RESTORED);

      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      // If the restore ran BEFORE the stop (R16), node_modules would already
      // exist by the time the SIGTERM handler ran, and this would be `true`.
      expect(result.restoredBeforeStop).toBe(false);
    } finally {
      if (alive(pid)) spawnSync('kill', ['-KILL', pid]);
    }
  }, 30_000);
});

describe('#1521 round-2, finding 2 — scripts/lib/e2e-read-base-path.mjs (standalone basePath probe, R13/R14)', () => {
  const READ_BASE_PATH = join(ROOT, 'scripts/lib/e2e-read-base-path.mjs');
  function readBasePath(manifestPath: string) {
    return spawnSync('node', [READ_BASE_PATH, manifestPath], { encoding: 'utf8' });
  }
  function manifestFixture(contents: string): string {
    const dir = tempDir('ed-basepath-');
    const p = join(dir, 'required-server-files.json');
    writeFileSync(p, contents);
    return p;
  }

  it('reads a configured basePath ("/docs")', () => {
    const r = readBasePath(manifestFixture(JSON.stringify({ config: { basePath: '/docs' } })));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('/docs');
    expect(r.stderr).toBe('');
  });

  it('assetPrefix alone is not read as basePath', () => {
    const r = readBasePath(
      manifestFixture(JSON.stringify({ config: { assetPrefix: 'https://cdn.example.com/x' } })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('no basePath configured resolves to "" — a legitimate case, not an error', () => {
    const r = readBasePath(manifestFixture(JSON.stringify({ config: {} })));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('a MISSING (unreadable) manifest fails loudly — exit 1 with a message, never a silent ""', () => {
    const dir = tempDir('ed-basepath-missing-');
    const r = readBasePath(join(dir, 'does-not-exist.json'));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('could not read/parse');
  });

  it('a MALFORMED (non-JSON) manifest fails loudly too', () => {
    const r = readBasePath(manifestFixture('{ this is not valid json'));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('could not read/parse');
  });

  it('scripts/e2e-deploy.sh calls the extracted script and fails closed rather than hardcoding ""', () => {
    const src = readRepo('scripts/e2e-deploy.sh');
    expect(src).toContain('node "${ED__LIB_DIR}/e2e-read-base-path.mjs"');
    expect(src).not.toContain(
      'try{process.stdout.write(String(require(process.argv[1]).config?.basePath||""))}catch{}',
    );
    // Failure of the read must abort the pre-check, not fall through with an
    // empty EMPTY_DIR_BASE_PATH.
    expect(src).toMatch(
      /node "\$\{ED__LIB_DIR\}\/e2e-read-base-path\.mjs"[^|]*\)"\s*\|\|\s*\{[\s\S]{0,500}?exit 1/,
    );
  });
});

describe('#1521 round-2, finding 2b — ED__LIB_DIR resolves absolutely regardless of sourcing style (R14)', () => {
  it('ed_probe_http still finds its helper after the shell cds away from the sourcing-time cwd, even when the lib was sourced via a RELATIVE path', () => {
    const workDir = tempDir('ed-r14-elsewhere-');
    const script = `
      set -euo pipefail
      PORT="$(${freePortExpr()})"
      PORT="\${PORT}" node -e "require('http').createServer((req,res)=>{res.writeHead(200);res.end('ok')}).listen(Number(process.env.PORT),'127.0.0.1')" >/dev/null 2>&1 &
      SERVER_PID=$!
      for _ in $(seq 1 50); do
        node -e "require('net').connect(\${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break
        sleep 0.1
      done
      cd "${ROOT}"
      . "scripts/lib/e2e-empty-dir.sh"
      cd "${workDir}"
      ed_probe_http "\${PORT}" / 2xx3xx
      RC=$?
      kill -KILL "\${SERVER_PID}" 2>/dev/null || true
      exit "\${RC}"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
  }, 25_000);
});

describe('#1521 round-2, finding 3 — the empty-dir lane cleans up its own staged copies (runner disk)', () => {
  it("e2e-cleanup.sh removes SERVED_FROM_DIR (the suite's staged empty dir) after teardown", () => {
    const app = makeAppDir();
    const stagedDir = tempDir('knext-empty-dir-suite.');
    writeFileSync(join(stagedDir, 'marker'), 'x');
    for (const n of ['node_modules', '.next', '.output']) {
      spawnSync('mv', [join(app, n), join(app, `${n}.ed-hidden`)]);
    }
    writeFileSync(
      join(app, '.adapter-build.log'),
      `PID=999999999\nSERVED_FROM=empty-dir\nSERVED_FROM_DIR=${stagedDir}\n`,
    );
    const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
      cwd: app,
      encoding: 'utf8',
    });
    expect(c.status).toBe(0);
    expect(existsSync(stagedDir)).toBe(false);
    expect(hiddenState(app)).toEqual(RESTORED);
  });

  it('a disk-mode teardown (no SERVED_FROM_DIR in metadata) is a clean no-op for that step', () => {
    const app = makeAppDir();
    writeFileSync(join(app, '.adapter-build.log'), 'PID=999999999\nSERVED_FROM=disk\n');
    const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
      cwd: app,
      encoding: 'utf8',
    });
    expect(c.status).toBe(0);
  });

  it('a deploy killed before it wrote metadata: an orphaned pre-check/suite dir under RUNNER_TEMP is swept', () => {
    // Rooted DIRECTLY at tmpdir() (never a nested custom dir): the sweep's own
    // glob (`${RUNNER_TEMP}/knext-empty-dir.*`) only matches TOP-LEVEL
    // entries, mirroring the real mktemp calls in scripts/e2e-deploy*.sh —
    // and tests/temp-dirs-outside-the-repo.test.ts's location scan (#880)
    // only recognizes `join(tmpdir(), …)`-shaped calls, not one rooted at an
    // intermediate variable. No collision risk with this file's OTHER
    // suiteScript()-based tests: those nest under their own outsideTempDir()
    // parent, never directly at tmpdir() with this literal prefix.
    const runnerTemp = tmpdir();
    const orphanPrecheck = mkdtempSync(join(tmpdir(), 'knext-empty-dir.'));
    // #880/D9 (tests/temp-dirs-outside-the-repo.test.ts): every mkdtemp needs
    // a counted removal bound to its own name in THIS file — the bash-side
    // rm -rf that e2e-cleanup.sh performs on two of these three is invisible
    // to that static scan, so enroll all three in the shared registry the
    // same way tempDir() itself does (its own top-level afterAll drains it).
    trackedTempDirs.push(orphanPrecheck);
    const orphanSuite = mkdtempSync(join(tmpdir(), 'knext-empty-dir-suite.'));
    trackedTempDirs.push(orphanSuite);
    writeFileSync(join(orphanPrecheck, 'marker'), 'x');
    writeFileSync(join(orphanSuite, 'marker'), 'x');
    // Backdate: ED_RUN_START_EPOCH has 1-SECOND resolution (`date +%s`), so a
    // dir created in the same wall-clock second as the cleanup invocation
    // would not be strictly older and would (correctly, in production —
    // this is what stops a concurrently-running deploy's dir from being
    // swept) survive. Push the mtime safely into the past instead of
    // sleeping past a second boundary.
    const past = new Date(Date.now() - 120_000);
    utimesSync(orphanPrecheck, past, past);
    utimesSync(orphanSuite, past, past);
    const unrelated = mkdtempSync(join(tmpdir(), 'knext-not-related-to-empty-dir.'));
    trackedTempDirs.push(unrelated);
    const app = tempDir('ed-r3-nometa-app-');
    const c = spawnSync('bash', [join(ROOT, 'scripts/e2e-cleanup.sh')], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: runnerTemp },
    });
    expect(c.status).toBe(0);
    expect(existsSync(orphanPrecheck)).toBe(false);
    expect(existsSync(orphanSuite)).toBe(false);
    // Sweep is scoped to the knext-empty-dir* prefixes — nothing else under
    // RUNNER_TEMP is touched.
    expect(existsSync(unrelated)).toBe(true);
  });

  for (const script of ['scripts/e2e-deploy.sh', 'scripts/e2e-deploy-vinext.sh']) {
    it(`${script}: the pre-check's staged EMPTY_DIR is removed on every exit from that block`, () => {
      const src = readRepo(script);
      // Every `exit 1` inside the KNEXT_SELF_CONTAINED pre-check block, and
      // its success path, must be preceded by an `rm -rf "${EMPTY_DIR}"` —
      // checked loosely (scanning, not enumerating a specific line number)
      // so a future edit that adds another exit path in this block cannot
      // silently skip the cleanup.
      expect(src).toContain('rm -rf "${EMPTY_DIR}"');
    });
  }
});

describe('#1521 round-2, finding 4 — self-contained native-addon limitation is documented AND read', () => {
  it('the two known #1515(c) fixtures are recognized by the lane helper', () => {
    expect(sh('ed_sc_is_known_native_addon_limitation "turbopack-reports"').status).toBe(0);
    expect(sh('ed_sc_is_known_native_addon_limitation "prerender-native-module"').status).toBe(0);
  });

  it('an arbitrary fixture name is NOT in the quarantine list', () => {
    expect(sh('ed_sc_is_known_native_addon_limitation "some-other-fixture"').status).not.toBe(0);
  });

  it('docs/compat-matrix.md states the limitation in plain language, naming both fixtures', () => {
    const docs = readRepo('docs/compat-matrix.md');
    expect(docs).toContain('turbopack-reports');
    expect(docs).toContain('prerender-native-module');
    expect(docs).toMatch(/native addon/i);
  });
});

describe('#1521 round-2, finding 5 (R8) — ed_assert_suite_isolated also checks inherited env', () => {
  function cleanCwdAppDir(): { cwd: string; app: string } {
    // Both otherwise clean: no node_modules/.next/.output anywhere, no
    // ancestor node_modules, no symlinks — every OTHER branch of
    // ed_assert_suite_isolated must pass so only the env check is exercised.
    return { cwd: tempDir('ed-r8-cwd-'), app: tempDir('ed-r8-app-') };
  }

  it('passes with a clean environment', () => {
    const { cwd, app } = cleanCwdAppDir();
    const r = sh(`ed_assert_suite_isolated "${cwd}" "${app}"`);
    expect(r.status).toBe(0);
  });

  it('fails when NODE_PATH points into the hidden APP_DIR', () => {
    const { cwd, app } = cleanCwdAppDir();
    const r = sh(
      `export NODE_PATH="${join(app, 'node_modules')}"; ed_assert_suite_isolated "${cwd}" "${app}"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_PATH');
  });

  it('fails when BUN_INSTALL points into the hidden APP_DIR', () => {
    const { cwd, app } = cleanCwdAppDir();
    const r = sh(
      `export BUN_INSTALL="${join(app, '.bun')}"; ed_assert_suite_isolated "${cwd}" "${app}"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('BUN_INSTALL');
  });

  it('fails when NODE_OPTIONS (-r a shim inside the hidden APP_DIR) is set', () => {
    const { cwd, app } = cleanCwdAppDir();
    const r = sh(
      `export NODE_OPTIONS="-r ${join(app, 'node_modules/shim.js')}"; ed_assert_suite_isolated "${cwd}" "${app}"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_OPTIONS');
  });

  it('an env var referencing an UNRELATED path is not flagged', () => {
    const { cwd, app } = cleanCwdAppDir();
    const r = sh(
      `export NODE_PATH="/some/totally/unrelated/node_modules"; ed_assert_suite_isolated "${cwd}" "${app}"`,
    );
    expect(r.status).toBe(0);
  });

  // Mutation R8 (review-1521.md) targets the REAL vinext boot line, not the
  // synthetic suiteScript() harness above — nothing in this file actually
  // execs scripts/e2e-deploy-vinext.sh's SC branch (it needs a compiled
  // exec), so the env check above cannot observe that specific injection at
  // runtime. Text-scan the boot line instead: it must set nothing but the
  // known-safe env vars, so an explicit NODE_PATH/BUN_INSTALL/NODE_OPTIONS
  // added there is caught even though it can never reach ed_assert_suite_isolated
  // in this suite.
  it('scripts/e2e-deploy-vinext.sh: the SC suite boot line sets no env var but the known-safe ones', () => {
    const src = readRepo('scripts/e2e-deploy-vinext.sh');
    const bootLine = src.match(
      /PORT="\$\{PORT\}" HOSTNAME="" NODE_ENV="production"[^\n]*\n\s*NEXT_DEPLOYMENT_ID="\$\{DEPLOYMENT_ID\}"[^\n]*\n\s*exec "\$\{EMPTY_DIR_STAGED\}"/,
    );
    expect(bootLine).not.toBeNull();
    expect(bootLine![0]).not.toMatch(/NODE_PATH|BUN_INSTALL|NODE_OPTIONS/);
  });
});

describe('#1521 round-2, finding 6a (R6) — the EXIT trap removes the recorded SC container', () => {
  it("ed__suite_on_exit still docker rm -f's ED_SUITE_CONTAINER when one is set", () => {
    // Text-scan, not a runtime invocation: this repo's task instructions are
    // explicit that this round must not run docker locally, and the guard's
    // own runtime behaviour (a live `docker run`/`docker rm` cycle) is
    // exercised by the OKE/CI integration round, not this unit suite.
    const src = readRepo('scripts/lib/e2e-empty-dir.sh');
    expect(src).toContain(
      'if [ -n "${ED_SUITE_CONTAINER:-}" ] && command -v docker >/dev/null 2>&1; then\n    docker rm -f "${ED_SUITE_CONTAINER}"',
    );
  });
});

describe('#1521 round-2, finding 6b (R11) — the HUP trap is converted into an exit', () => {
  it('SIGHUP to the deploy script after hiding restores APP_DIR (exit 129)', async () => {
    const app = makeAppDir();
    const parent = outsideTempDir('ed-hup-');
    const marker = join(parent, 'HIDDEN-NOW');
    const script = suiteScript(app, parent, `touch "${marker}"; while :; do sleep 0.1; done`);
    const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    for (let i = 0; i < 300 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    expect(hiddenState(app)).toEqual(HIDDEN);
    child.kill('SIGHUP');
    const code = await exited;
    expect(code).toBe(129);
    expect(alive(field(out, 'PID'))).toBe(false);
    expect(hiddenState(app)).toEqual(RESTORED);
  }, 60_000);
});

describe('#1521 round-2, finding 6c (R18) — the fingerprint only reads served_from when the lib is IN the harness closure', () => {
  it('returns null when SERVED_FROM_LIB is absent from the harness list, even though the real file on disk declares empty-dir', () => {
    const harnessWithoutLib = (collectHarness(ROOT, 'node', {}) as { path: string }[]).filter(
      (e) => e.path !== SERVED_FROM_LIB,
    );
    expect(harnessWithoutLib.some((e) => e.path === SERVED_FROM_LIB)).toBe(false);
    expect(readHarnessServedFrom(ROOT, harnessWithoutLib)).toBeNull();
  });

  it('returns the declared value when the lib IS in the harness closure', () => {
    const fullHarness = collectHarness(ROOT, 'node', {}) as { path: string }[];
    expect(fullHarness.some((e) => e.path === SERVED_FROM_LIB)).toBe(true);
    expect(readHarnessServedFrom(ROOT, fullHarness)).toBe(SC_SERVED_FROM);
  });
});

describe('#1521 round-2, finding 2c (R13) — the standalone pre-check threads EMPTY_DIR_BASE_PATH through to the probe call', () => {
  it('scripts/e2e-deploy.sh: ed_static_probe_path is called WITH the resolved basePath variable, never a hardcoded ""', () => {
    const src = readRepo('scripts/e2e-deploy.sh');
    expect(src).toContain('ed_static_probe_path "${EMPTY_DIR}" "${EMPTY_DIR_BASE_PATH}")"');
  });
});
