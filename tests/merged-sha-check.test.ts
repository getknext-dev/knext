import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The merged-SHA check: the commit that landed on a protected branch must
 * contain the PR's final head. Real git, throwaway repo under tmpdir(); the
 * verdict is the process EXIT CODE (never output text).
 */
const script = resolve(import.meta.dir, '..', 'scripts', 'merged-sha-check.mjs');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function run(cwd: string, ...args: string[]) {
  return spawnSync('node', [script, '--repo', cwd, ...args], { encoding: 'utf8' });
}

function withRepo<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'knext-merged-sha-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'base');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('merged-sha-check', () => {
  it('passes when the head is an ancestor of the merge commit (merge/rebase style)', () =>
    withRepo((dir) => {
      git(dir, 'switch', '-q', '-c', 'pr');
      writeFileSync(join(dir, 'a.txt'), '2\n');
      git(dir, 'commit', '-q', '-am', 'fix');
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      const merge = git(dir, 'rev-parse', 'HEAD');
      expect(run(dir, '--head', head, '--merge', merge).status).toBe(0);
    }));

  it('fails (exit 1) when the merge commit landed at a PRE-fix head', () =>
    withRepo((dir) => {
      git(dir, 'switch', '-q', '-c', 'pr');
      writeFileSync(join(dir, 'a.txt'), '2\n');
      git(dir, 'commit', '-q', '-am', 'first');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      const merge = git(dir, 'rev-parse', 'HEAD');
      // a fix pushed to the branch AFTER the merge SHA was locked
      git(dir, 'switch', '-q', 'pr');
      writeFileSync(join(dir, 'a.txt'), '3\n');
      git(dir, 'commit', '-q', '-am', 'fix');
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = run(dir, '--head', head, '--merge', merge, '--paths', 'a.txt');
      expect(r.status).toBe(1);
    }));

  it('squash: passes when every PR file has the head blob in the merge commit', () =>
    withRepo((dir) => {
      git(dir, 'switch', '-q', '-c', 'pr');
      mkdirSync(join(dir, 'd'));
      writeFileSync(join(dir, 'd', 'b.txt'), 'b\n');
      git(dir, 'add', 'd/b.txt');
      git(dir, 'commit', '-q', '-m', 'pr');
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--squash', 'pr');
      git(dir, 'commit', '-q', '-m', 'squashed');
      const merge = git(dir, 'rev-parse', 'HEAD');
      expect(run(dir, '--head', head, '--merge', merge, '--paths', 'd/b.txt').status).toBe(0);
    }));

  it('squash: fails when a PR file differs from the head blob', () =>
    withRepo((dir) => {
      git(dir, 'switch', '-q', '-c', 'pr');
      writeFileSync(join(dir, 'a.txt'), 'final\n');
      git(dir, 'commit', '-q', '-am', 'pr');
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', 'main');
      writeFileSync(join(dir, 'a.txt'), 'stale\n');
      git(dir, 'commit', '-q', '-am', 'squashed at old head');
      const merge = git(dir, 'rev-parse', 'HEAD');
      expect(run(dir, '--head', head, '--merge', merge, '--paths', 'a.txt').status).toBe(1);
    }));

  it('fails closed (exit 1) on an unknown SHA or missing arguments', () =>
    withRepo((dir) => {
      expect(run(dir, '--head', 'f'.repeat(40), '--merge', 'e'.repeat(40)).status).toBe(1);
      expect(run(dir).status).toBe(1);
    }));
});
