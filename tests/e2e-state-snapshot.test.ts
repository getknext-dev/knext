import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/**
 * The compile-cache bake renders a route in the tree the fixture then boots
 * from. The harness snapshots the tree first and restores it after, keeping only
 * the compile cache — so the fixture starts pristine.
 */
const ROOT = resolve(import.meta.dir, '..');
const HELPER = join(ROOT, 'scripts/lib/e2e-state-snapshot.sh');
const DEPLOY = readFileSync(join(ROOT, 'scripts/e2e-deploy.sh'), 'utf8');
const KEEP = '.next/compile-cache';

function tree(dir: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel === skip) continue;
      const mode = (lstatSync(p).mode & 0o777).toString(8);
      if (e.isSymbolicLink()) {
        out.push(`l ${rel} -> ${readlinkSync(p)}`);
      } else if (e.isDirectory()) {
        out.push(`d ${rel} ${mode}`);
        walk(p);
      } else {
        out.push(`f ${rel} ${mode} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out;
}

function sh(script: string) {
  return spawnSync('bash', ['-c', `set -euo pipefail; . "${HELPER}"; ${script}`], {
    encoding: 'utf8',
  });
}

function fixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), 'state-snap-'));
  mkdirSync(join(dir, '.next/server/app'), { recursive: true });
  mkdirSync(join(dir, '.next/cache/fetch-cache'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/next'), { recursive: true });
  writeFileSync(join(dir, 'server.js'), 'x');
  writeFileSync(join(dir, '.next/server/app/index.html'), '<p>pristine</p>');
  writeFileSync(join(dir, 'node_modules/next/index.js'), 'm');
  symlinkSync('../server.js', join(dir, '.next/link-to-server'));
  symlinkSync('node_modules', join(dir, 'dirlink'));
  writeFileSync(join(dir, 'bin.sh'), '#!/bin/sh');
  chmodSync(join(dir, 'bin.sh'), 0o755);
  mkdirSync(join(dir, KEEP), { recursive: true });
  return dir;
}

/** What a bake render can do to the tree. */
function dirty(dir: string) {
  writeFileSync(join(dir, '.next/cache/fetch-cache/entry'), 'seeded');
  writeFileSync(join(dir, '.next/server/app/index.html'), '<p>ISR rewrote me</p>');
  writeFileSync(join(dir, '.next/server/app/new.rsc'), 'new');
  rmSync(join(dir, 'server.js'));
  writeFileSync(join(dir, '.next/counter'), '1');
  writeFileSync(join(dir, KEEP, 'baked.cache'), 'v8-bytes');
}

describe('e2e-state-snapshot: the fixture tree after the bake equals the tree before it', () => {
  it('restores every state change, keeps ONLY the compile cache', () => {
    const dir = fixtureTree();
    const tar = `${dir}.tar`;
    const before = tree(dir, KEEP);
    expect(sh(`snapshot_state "${dir}" "${tar}" "${KEEP}"`).status).toBe(0);
    dirty(dir);
    expect(tree(dir, KEEP)).not.toEqual(before); // the dirtying is real
    expect(sh(`restore_state "${dir}" "${tar}" "${KEEP}"`).status).toBe(0);
    expect(tree(dir, KEEP)).toEqual(before); // byte-identical
    expect(readFileSync(join(dir, KEEP, 'baked.cache'), 'utf8')).toBe('v8-bytes');
    expect(statSync(join(dir, '.next/compile-cache')).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(tar, { force: true });
  });

  it('a READ-ONLY dirty dir left by the bake is cleaned (or restore fails loudly — never silent)', () => {
    const dir = fixtureTree();
    const tar = `${dir}.tar`;
    const before = tree(dir, KEEP);
    expect(sh(`snapshot_state "${dir}" "${tar}" "${KEEP}"`).status).toBe(0);
    mkdirSync(join(dir, '.next/ro-dirty'));
    writeFileSync(join(dir, '.next/ro-dirty/seeded'), 'x');
    chmodSync(join(dir, '.next/ro-dirty'), 0o555);
    const r = sh(`restore_state "${dir}" "${tar}" "${KEEP}"`);
    if (r.status === 0) {
      expect(tree(dir, KEEP)).toEqual(before);
    } else {
      expect(r.stderr.length).toBeGreaterThan(0);
    }
    try {
      chmodSync(join(dir, '.next/ro-dirty'), 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(tar, { force: true });
  });

  it('a leftover the restore cannot remove FAILS the restore (verification, not silence)', () => {
    const dir = fixtureTree();
    const tar = `${dir}.tar`;
    expect(sh(`snapshot_state "${dir}" "${tar}" "${KEEP}"`).status).toBe(0);
    writeFileSync(join(dir, '.next/leftover'), 'x');
    // Simulate a delete that silently did nothing: restore with a no-op find.
    const r = sh(`find() { :; }; restore_state "${dir}" "${tar}" "${KEEP}"`);
    expect(r.status).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
    rmSync(tar, { force: true });
  });

  it('restore_state never silences a failure (no `|| true`, no stderr discard)', () => {
    const src = readFileSync(HELPER, 'utf8');
    const body = src.slice(src.indexOf('restore_state() {'));
    expect(body).not.toContain('|| true');
    expect(body).not.toContain('2>/dev/null');
  });

  it('e2e-deploy.sh snapshots before the bake loop and restores after it', () => {
    const snap = DEPLOY.indexOf('snapshot_state "${STANDALONE_APP_DIR}"');
    const loop = DEPLOY.indexOf('for WARM_TRY in ${WARM_PATH}; do');
    const rest = DEPLOY.indexOf('restore_state "${STANDALONE_APP_DIR}"');
    expect(snap).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(snap);
    expect(rest).toBeGreaterThan(loop);
    expect(DEPLOY.split('restore_state "${STANDALONE_APP_DIR}"').length - 1).toBe(1);
  });
});
