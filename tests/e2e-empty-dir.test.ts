import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
});
