import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLatestVTag } from '../scripts/crd-schema-diff.mjs';

/**
 * ADR-0063 release lines: `v1.3.0-rc.*` tags are cut from `integration/v1.3`,
 * whose CRD has fields `main` lacks. The additive-only baseline must be the
 * latest `v*` tag REACHABLE from HEAD, never the globally highest one.
 * Real-git fixture (no fakes) so the reachability filter itself is exercised.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'crd-tags-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'c1');
  git('tag', 'v1.0.0-rc.5');
  git('switch', '-q', '-c', 'integration');
  git('commit', '-q', '--allow-empty', '-m', 'c2');
  git('tag', 'v1.3.0-rc.3'); // higher, but only on the integration line
  git('switch', '-q', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'c3');
  return { dir, git };
}

describe('resolveLatestVTag — release-line reachability', () => {
  it('on main ignores a newer unreachable tag on another line and uses the reachable one', () => {
    const { dir } = makeRepo();
    try {
      expect(resolveLatestVTag(execFileSync as never, dir)).toBe('v1.0.0-rc.5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on the integration line still compares against that line's own latest tag", () => {
    const { dir, git } = makeRepo();
    try {
      git('switch', '-q', 'integration');
      expect(resolveLatestVTag(execFileSync as never, dir)).toBe('v1.3.0-rc.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
