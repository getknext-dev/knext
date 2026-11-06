import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectMergedInPins,
  markerArrivedViaMerge,
  sameAuthorization,
} from '../scripts/lib/merged-in-pins.mjs';

/**
 * `scripts/lib/merged-in-pins.mjs` (#2342) — the merged-in-parent collection
 * and the date + reason match, shared so the freeze guards apply one rule to
 * a marker that reaches a PR through a merged branch (the rule #2325 added to
 * the credential freeze guard). The end-to-end wiring is exercised by
 * `tests/published-bytes-freeze-guard-workflow.test.ts`; this file pins the
 * module's own edges against real git.
 */

const FIELD = 'publishedBytesBumpMarker';
const PIN = '.github/compat-credential-ref.json';
const A = { date: '2026-09-23', expires: '2026-10-01', reason: 'branch A' };
const B = { date: '2026-09-24', expires: '2026-10-01', reason: 'branch B' };

/** The real git, run in `cwd` — what scripts/collect-merged-in-pins.mjs injects. */
const gitIn =
  (cwd: string) =>
  (...a: string[]) =>
    execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('sameAuthorization / markerArrivedViaMerge', () => {
  it('same date + reason is the same authorization; expires and paths do not matter', () => {
    expect(sameAuthorization(A, { ...A, expires: '2026-09-30', paths: ['x'] })).toBe(true);
    expect(sameAuthorization(A, { ...A, reason: 'other' })).toBe(false);
    expect(sameAuthorization(A, { ...A, date: '2026-09-22' })).toBe(false);
    expect(sameAuthorization(A, undefined)).toBe(false);
  });

  it('matches only the named field', () => {
    expect(markerArrivedViaMerge({ [FIELD]: A }, [{ [FIELD]: A }], FIELD)).toBe(true);
    expect(markerArrivedViaMerge({ [FIELD]: A }, [{ rcBumpMarker: A }], FIELD)).toBe(false);
    expect(markerArrivedViaMerge({ rcBumpMarker: A }, [{ rcBumpMarker: A }], 'rcBumpMarker')).toBe(
      true,
    );
  });

  it('a non-object head marker never matches', () => {
    expect(markerArrivedViaMerge({ [FIELD]: [A] }, [{ [FIELD]: [A] }], FIELD)).toBe(false);
    expect(markerArrivedViaMerge(null, [{ [FIELD]: A }], FIELD)).toBe(false);
  });
});

describe('collectMergedInPins against real git', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'merged-in-pins-'));
    dirs.push(dir);
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    const put = (path: string, content: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    const commit = (msg: string) => {
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    };
    git('init', '-q', '-b', 'main');
    put('x.txt', '0');
    commit('root');
    return { dir, git, put, commit };
  }

  /** Branch `name` off main with one commit writing `pinText` (or no pin). */
  function branch(
    r: ReturnType<typeof repo>,
    name: string,
    pinText: string | null,
    file = 'y.txt',
  ) {
    r.git('checkout', '-q', '-b', name, 'main');
    if (pinText !== null) r.put(PIN, pinText);
    r.put(file, name);
    r.commit(name);
  }

  const collect = (r: ReturnType<typeof repo>, head: string, eventName = 'pull_request') =>
    collectMergedInPins({
      git: gitIn(r.dir),
      baseSha: r.git('rev-parse', 'main'),
      headSha: r.git('rev-parse', head),
      eventName,
      pinFile: PIN,
      field: FIELD,
      log: () => {},
    });

  it('a merged-in parent with no pin file, or a pin with no marker, contributes nothing', () => {
    const r = repo();
    branch(r, 'nopin', null, 'a.txt');
    branch(r, 'nomarker', JSON.stringify({ rcTag: 'v1.0.0-rc.1' }), 'b.txt');
    r.git('checkout', '-q', '-b', 'pr', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'm1', 'nopin');
    r.git('merge', '-q', '--no-ff', '-m', 'm2', 'nomarker');
    expect(collect(r, 'pr')).toEqual([]);
  });

  it('an unparsable pin at a merged-in parent is skipped and logged, not thrown', () => {
    const r = repo();
    branch(r, 'broken', '{not json', 'a.txt');
    r.git('checkout', '-q', '-b', 'pr', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'm', 'broken');
    const logs: string[] = [];
    const pins = collectMergedInPins({
      git: gitIn(r.dir),
      baseSha: r.git('rev-parse', 'main'),
      headSha: r.git('rev-parse', 'pr'),
      eventName: 'pull_request',
      pinFile: PIN,
      field: FIELD,
      log: (m: string) => logs.push(m),
    });
    expect(pins).toEqual([]);
    expect(logs.join('\n')).toMatch(/unparsable pin/);
  });

  it('collects every distinct marker across merged-in parents, deduplicated', () => {
    const r = repo();
    branch(r, 'a1', JSON.stringify({ [FIELD]: A }), 'a.txt');
    branch(r, 'a2', JSON.stringify({ [FIELD]: A }), 'c.txt');
    branch(r, 'b', JSON.stringify({ [FIELD]: B }), 'b.txt');
    r.git('checkout', '-q', '-b', 'pr', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'm1', 'a1');
    r.git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'm2', 'a2');
    r.git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'm3', 'b');
    // rev-list walks newest first: m3 (B), then m2 and m1 (A, once).
    expect(collect(r, 'pr')).toEqual([{ [FIELD]: B }, { [FIELD]: A }]);
  });

  it("merge_group skips only the queue's own first-parent merges, not merges inside a queued PR", () => {
    const r = repo();
    branch(r, 'a', JSON.stringify({ [FIELD]: A }), 'a.txt');
    branch(r, 'pr', JSON.stringify({ [FIELD]: B }), 'b.txt');
    r.git('merge', '-q', '--no-ff', '-X', 'ours', '-m', 'pr merges a', 'a');
    r.git('checkout', '-q', '-b', 'queue', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'queue: pr', 'pr');
    // The queue's own merge has `pr` (marker B) as its second parent: skipped
    // on merge_group; the merge inside the PR (marker A) is still read.
    expect(collect(r, 'queue', 'merge_group')).toEqual([{ [FIELD]: A }]);
    // On pull_request there is no queue, so every merge counts.
    expect(collect(r, 'queue', 'pull_request')).toEqual(
      expect.arrayContaining([{ [FIELD]: A }, { [FIELD]: B }]),
    );
  });

  it('an unresolvable head fails closed (throws), never reads as "no merges"', () => {
    const r = repo();
    expect(() =>
      collectMergedInPins({
        git: gitIn(r.dir),
        baseSha: r.git('rev-parse', 'main'),
        headSha: 'f'.repeat(40),
        eventName: 'pull_request',
        pinFile: PIN,
        field: FIELD,
        log: () => {},
      }),
    ).toThrow();
  });
});
