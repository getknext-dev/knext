/**
 * #1989 — the guard that fails a run which leaves files in the repo tree.
 *
 * Both halves are asserted: the script's verdict (by EXIT CODE, against a
 * throwaway git repo) and the CI wiring (snapshot BEFORE the suite, check
 * AFTER it) — a script nobody calls, or one called in the wrong order, guards
 * nothing.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'assert-tree-unchanged.mjs');

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function makeRepo(): string {
  const r = mkdtempSync(join(tmpdir(), 'knext-tree-guard-'));
  tempRoots.push(r);
  spawnSync('git', ['init', '-q'], { cwd: r });
  writeFileSync(join(r, 'tracked.txt'), 'x');
  return r;
}

function guard(repo: string, mode: string, file: string) {
  return spawnSync('node', [SCRIPT, mode, file], {
    env: { ...process.env, KNEXT_TREE_GUARD_REPO: repo },
    encoding: 'utf8',
  });
}

describe('assert-tree-unchanged.mjs', () => {
  it('passes when the run leaves the tree as it found it', () => {
    const repo = makeRepo();
    const snap = join(repo, '..', `${Date.now()}-snap-a.txt`);
    tempRoots.push(snap);
    expect(guard(repo, 'snapshot', snap).status).toBe(0);
    expect(guard(repo, 'check', snap).status).toBe(0);
  });

  it('fails (exit 1) naming a file the run leaves at the root', () => {
    const repo = makeRepo();
    const snap = join(repo, '..', `${Date.now()}-snap-b.txt`);
    tempRoots.push(snap);
    expect(guard(repo, 'snapshot', snap).status).toBe(0);
    writeFileSync(join(repo, 'knext-standalone-entry.mjs'), 'leak');
    const r = guard(repo, 'check', snap);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('knext-standalone-entry.mjs');
  });

  it('does not blame a file that was already there before the run', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'preexisting.txt'), 'x');
    const snap = join(repo, '..', `${Date.now()}-snap-c.txt`);
    tempRoots.push(snap);
    expect(guard(repo, 'snapshot', snap).status).toBe(0);
    expect(guard(repo, 'check', snap).status).toBe(0);
  });
});

describe('ci.yml wires the guard around the suite', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const snap = ci.indexOf('assert-tree-unchanged.mjs snapshot');
  const suite = ci.indexOf('node scripts/bun-test.mjs --coverage');
  const check = ci.indexOf('assert-tree-unchanged.mjs check');

  it('snapshots before and checks after the suite', () => {
    expect(snap).toBeGreaterThan(-1);
    expect(suite).toBeGreaterThan(snap);
    expect(check).toBeGreaterThan(suite);
  });
});

describe('the known leaker no longer stages into the repo', () => {
  it('gc-build-no-storage runs in a scratch project, not the checkout', () => {
    const src = readFileSync(
      join(ROOT, 'packages/kn-next/src/__tests__/gc-build-no-storage.test.ts'),
      'utf8',
    );
    expect(src).toContain('tempRoots.push(r)');
    expect(src).toContain('process.chdir(r)');
  });
});
