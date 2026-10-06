import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLatestVTag, run } from '../scripts/crd-schema-diff.mjs';

/**
 * A tagless / shallow checkout must not silently pass the additive-only CRD
 * guard in CI. Real temp git repos drive the tag resolution.
 */
const dirs: string[] = [];
function makeRepo(withTag: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'crd-failclosed-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: dir,
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
  if (withTag) git('tag', 'v1.0.0');
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CRD = 'spec:\n  versions: []\n';

function setup(withTag: boolean) {
  const dir = makeRepo(withTag);
  const logs: string[] = [];
  return {
    logs,
    opts: (env: Record<string, string | undefined>) => ({
      log: (m: string) => logs.push(m),
      env,
      resolveLatestVTagFn: () => resolveLatestVTag(execFileSync as never, dir),
      execFileSyncFn: (() => CRD) as never,
      readFileSyncFn: (() => CRD) as never,
    }),
  };
}

describe('crd-schema-diff — no reachable v* tag', () => {
  it('CI set + no tag -> fails, naming shallow clone / fetch-depth 0 / fetch-tags', () => {
    const t = setup(false);
    expect(run([], t.opts({ CI: 'true' }))).toBe(1);
    const out = t.logs.join('\n');
    expect(out).toMatch(/shallow/i);
    expect(out).toMatch(/fetch-depth: 0/);
    expect(out).toMatch(/fetch-tags/);
  });

  it('CI set + CRD_DIFF_ALLOW_NO_BASELINE=1 -> passes', () => {
    const t = setup(false);
    expect(run([], t.opts({ CI: 'true', CRD_DIFF_ALLOW_NO_BASELINE: '1' }))).toBe(0);
  });

  it('CI unset -> passes with a warning', () => {
    const t = setup(false);
    expect(run([], t.opts({}))).toBe(0);
    expect(t.logs.join('\n')).toMatch(/warning/i);
  });

  it('a tag present -> compares as before (PASS)', () => {
    const t = setup(true);
    expect(run([], t.opts({ CI: 'true' }))).toBe(0);
    expect(t.logs.join('\n')).toMatch(/PASS:.*v1\.0\.0/);
  });
});
