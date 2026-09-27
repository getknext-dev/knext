import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
 * must red the check.
 *
 * The boot+probe half is exercised here against a SYNTHETIC fixture (a tiny
 * node http server), not a real Next/vinext build — booting a REAL compiled
 * artifact from an empty dir is what N1 (#1456) / V1 (#1460) still have to
 * make possible (ADR-0060 §Context); this suite proves the STEP's own
 * mechanics, which is all F6 owns.
 */
const ROOT = resolve(import.meta.dir, '..');
const LIB = join(ROOT, 'scripts/lib/e2e-empty-dir.sh');

function sh(script: string) {
  return spawnSync('bash', ['-c', `set -uo pipefail; . "${LIB}"; ${script}`], {
    encoding: 'utf8',
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeServerFixture(dir: string, name = 'server.js'): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      'const port = Number(process.env.PORT);',
      "http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + req.url); }).listen(port, '127.0.0.1');",
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  return p;
}

describe('e2e-empty-dir — ed_assert_clean (#1455)', () => {
  it('passes on a directory holding only a binary and .next/static', () => {
    const dir = tempDir('ed-clean-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    mkdirSync(join(dir, '.next/static'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    mkdirSync(join(dir, 'native'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}"`);
    expect(r.status).toBe(0);
  });

  // THE exit criterion (#1455): "guard reds on a planted node_modules".
  it('reds on a planted node_modules beside the binary', () => {
    const dir = tempDir('ed-nm-');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('node_modules');
  });

  it('reds on a planted .output', () => {
    const dir = tempDir('ed-output-');
    mkdirSync(join(dir, '.output'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.output');
  });

  it('reds on a .next entry other than static — the disk-mode tree leaking in', () => {
    const dir = tempDir('ed-next-server-');
    mkdirSync(join(dir, '.next/server'), { recursive: true });
    const r = sh(`ed_assert_clean "${dir}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.next');
  });

  it('reds on a stray dotfile under .next too, not only visible entries', () => {
    const dir = tempDir('ed-next-dotfile-');
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, '.next/.rscinfo'), 'x');
    const r = sh(`ed_assert_clean "${dir}"`);
    expect(r.status).not.toBe(0);
  });

  it('an absent .next/.output/node_modules is fine (a minimal fixture with no static assets)', () => {
    const dir = tempDir('ed-minimal-');
    writeFileSync(join(dir, 'app'), '#!/bin/sh\n');
    const r = sh(`ed_assert_clean "${dir}"`);
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
    const clean = sh(`ed_assert_clean "${dest}"`);
    expect(clean.status).toBe(0);
  });

  it('skips a copy-spec whose source does not exist, silently (e.g. no native/)', () => {
    const src = tempDir('ed-src2-');
    writeFileSync(join(src, 'exe'), '#!/bin/sh\n');
    const dest = tempDir('ed-dest2-');
    const r = sh(`ed_stage "${dest}" "${src}/exe" "${src}/native:native"`);
    expect(r.status).toBe(0);
    const clean = sh(`ed_assert_clean "${dest}"`);
    expect(clean.status).toBe(0);
  });
});

describe('e2e-empty-dir — ed_boot_probe_kill / ed_check_or_die (#1455)', () => {
  it('boots a synthetic binary from an empty dir and answers both probes', () => {
    const dir = tempDir('ed-boot-');
    makeServerFixture(dir);
    const r = sh(`
      PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});')"
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
      PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});')"
      export PORT
      cd "${dir}"
      ed_boot_probe_kill "\${PORT}" /api/health /never-answered node ./partial.js
    `);
    expect(r.status).not.toBe(0);
  });

  it('ed_check_or_die runs the whole pipeline end to end from a real source layout', () => {
    const src = tempDir('ed-e2e-src-');
    makeServerFixture(src, 'server.js');
    mkdirSync(join(src, 'public'), { recursive: true });
    writeFileSync(join(src, 'public/a.txt'), 'a');
    const dest = tempDir('ed-e2e-dest-');
    const r = sh(`
      PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});')"
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
});
