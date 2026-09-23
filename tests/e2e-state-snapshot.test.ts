import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
      if (e.isDirectory()) {
        out.push(`d ${rel}`);
        walk(p);
      } else {
        out.push(`f ${rel} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
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
