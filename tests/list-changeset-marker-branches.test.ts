import { describe, expect, it } from 'bun:test';
import {
  classify,
  MARKER_PATHS,
  parseLsRemote,
} from '../scripts/list-changeset-marker-branches.mjs';
import { PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';

/**
 * The marker-branch deletion list (#2035, item e) is founder-approved and then
 * executed with `git push origin --delete`. The one thing it must never do is
 * list a live publish lane for deletion: a lane that carries the marker is a
 * lane to FIX. These cover the pure parts; the git reads are thin wrappers.
 */

const SHA = 'a'.repeat(40);

describe('parseLsRemote', () => {
  it('parses heads into sha, full ref and branch name', () => {
    expect(
      parseLsRemote(`${SHA}\trefs/heads/integration/v1-coldstart\n${SHA}\trefs/heads/main\n`),
    ).toEqual([
      { sha: SHA, ref: 'refs/heads/integration/v1-coldstart', branch: 'integration/v1-coldstart' },
      { sha: SHA, ref: 'refs/heads/main', branch: 'main' },
    ]);
  });

  it.each([
    `${SHA}\trefs/tags/v1.0.0`,
    `nothex\trefs/heads/main`,
    SHA,
  ])('refuses an unparseable line rather than skipping it: %j', (line) => {
    expect(() => parseLsRemote(line)).toThrow();
  });
});

describe('classify', () => {
  it('lists marker-carrying branches, sorted, and never a live publish lane', () => {
    const lanes = [...PUBLISH_LANES.keys()];
    expect(lanes.length).toBeGreaterThan(0);
    const result = classify([
      { ref: 'refs/heads/zzz-stale', branch: 'zzz-stale', carries: true },
      {
        ref: 'refs/heads/integration/v1-coldstart',
        branch: 'integration/v1-coldstart',
        carries: true,
      },
      { ref: 'refs/heads/clean', branch: 'clean', carries: false },
      ...lanes.map((ref) => ({ ref, branch: ref.slice('refs/heads/'.length), carries: true })),
    ]);
    expect(result.deletable).toEqual(['integration/v1-coldstart', 'zzz-stale']);
    expect(result.liveLanes).toEqual(lanes.map((ref) => ref.slice('refs/heads/'.length)).sort());
  });

  it('checks the path the plan names', () => {
    expect(MARKER_PATHS).toContain('.changeset/pre/v1-0-0-release-candidate.md');
  });
});
