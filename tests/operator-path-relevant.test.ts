import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Unit tests for `packages/kn-next-operator/hack/path-relevant.sh` — restores
 * push.paths-filter behavior for MAIN-BRANCH pushes (#1667 review round 2),
 * without applying that same filter to operator-vX.Y.Z tag pushes (a tag
 * push may legitimately repoint at a commit whose own diff does not touch
 * these paths — the caller treats every tag push as relevant unconditionally
 * and never calls this script for one; see operator-supply-chain.yml).
 *
 * Builds a real throwaway git repo (not a fake) since the script's whole job
 * is to run `git diff` correctly.
 */

const SCRIPT = resolve(import.meta.dirname, '../packages/kn-next-operator/hack/path-relevant.sh');

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'path-relevant-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

function commit(dir: string, relPath: string, content: string, message: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(dir, ['add', '-A']);
  // -c commit.gpgsign=false: the ambient global config may have gpgsign=true,
  // which hangs waiting on a passphrase prompt for a throwaway test repo.
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function run(before: string, after: string, dir: string) {
  const result = spawnSync('bash', [SCRIPT, before, after, dir], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

const repos: string[] = [];
function trackedRepo(): string {
  const dir = makeRepo();
  repos.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

describe('path-relevant.sh: restores paths-filter behavior for main pushes only (#1667)', () => {
  it('reports true when the diff touches packages/kn-next-operator/', () => {
    const dir = trackedRepo();
    const before = commit(dir, 'docs/readme.md', 'a', 'c1');
    const after = commit(dir, 'packages/kn-next-operator/foo.go', 'b', 'c2 touches operator');
    const { code, stdout } = run(before, after, dir);
    expect(code).toBe(0);
    expect(stdout).toBe('true');
  });

  it('reports true when the diff touches the workflow file itself', () => {
    const dir = trackedRepo();
    const before = commit(dir, 'docs/readme.md', 'a', 'c1');
    const after = commit(
      dir,
      '.github/workflows/operator-supply-chain.yml',
      'x',
      'c2 touches the workflow',
    );
    const { code, stdout } = run(before, after, dir);
    expect(code).toBe(0);
    expect(stdout).toBe('true');
  });

  it('reports false when the diff touches neither operator paths nor the workflow', () => {
    const dir = trackedRepo();
    const before = commit(dir, 'docs/readme.md', 'a', 'c1');
    const after = commit(dir, 'docs/readme2.md', 'c', 'c2 docs-only');
    const { code, stdout } = run(before, after, dir);
    expect(code).toBe(0);
    expect(stdout).toBe('false');
  });

  it("reports true (never silently skips) on an all-zeros before SHA (a branch's first push)", () => {
    const dir = trackedRepo();
    const after = commit(dir, 'docs/readme.md', 'a', 'c1');
    const { code, stdout } = run('0'.repeat(40), after, dir);
    expect(code).toBe(0);
    expect(stdout).toBe('true');
  });
});
