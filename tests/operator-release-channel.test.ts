import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Unit tests for the tag-parsing/channel logic behind operator semver
 * releases (#1667): `packages/kn-next-operator/hack/release-channel.sh`.
 *
 * Kept as a standalone script (not inline workflow bash) specifically so
 * this logic is directly unit-testable without executing the workflow.
 *
 * Contract:
 *   - a `refs/tags/operator-vX.Y.Z` push is an immutable release on channel
 *     `operator-vX.Y.Z`; stable (no prerelease suffix) ALSO moves
 *     `operator-latest`.
 *   - a `refs/tags/operator-vX.Y.Z-<prerelease>` push (e.g. `-rc.1`) is an
 *     immutable release on its own tag, but never moves `operator-latest`.
 *   - a `refs/heads/main` push publishes to the rolling `operator-edge`
 *     channel, never `operator-latest`.
 *   - anything else does not publish at all.
 *   - a malformed operator-v* tag fails loud (exit 1) rather than silently
 *     guessing a channel.
 */

const SCRIPT = resolve(import.meta.dirname, '../packages/kn-next-operator/hack/release-channel.sh');

interface ChannelOutput {
  publish: string;
  release_tag: string;
  is_stable: string;
}

function run(
  ref: string,
  refName: string,
): { code: number | null; out: ChannelOutput | null; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ref, refName], { encoding: 'utf8' });
  const out: Partial<ChannelOutput> = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^(publish|release_tag|is_stable)=(.*)$/.exec(line);
    if (match) out[match[1] as keyof ChannelOutput] = match[2];
  }
  return {
    code: result.status,
    out: result.status === 0 ? (out as ChannelOutput) : null,
    stderr: result.stderr,
  };
}

describe('release-channel.sh: tag-parsing / channel logic (#1667)', () => {
  it('a stable version tag publishes an immutable release AND moves operator-latest', () => {
    const { code, out } = run('refs/tags/operator-v1.2.3', 'operator-v1.2.3');
    expect(code).toBe(0);
    expect(out).toEqual({ publish: 'true', release_tag: 'operator-v1.2.3', is_stable: 'true' });
  });

  it('an rc (prerelease) tag publishes its own immutable release but does NOT move operator-latest', () => {
    const { code, out } = run('refs/tags/operator-v1.2.3-rc.1', 'operator-v1.2.3-rc.1');
    expect(code).toBe(0);
    expect(out).toEqual({
      publish: 'true',
      release_tag: 'operator-v1.2.3-rc.1',
      is_stable: 'false',
    });
  });

  it('other prerelease suffixes (e.g. -beta.2) are also treated as unstable', () => {
    const { code, out } = run('refs/tags/operator-v2.0.0-beta.2', 'operator-v2.0.0-beta.2');
    expect(code).toBe(0);
    expect(out?.is_stable).toBe('false');
  });

  it('a push to main publishes to the rolling operator-edge channel, never operator-latest', () => {
    const { code, out } = run('refs/heads/main', 'main');
    expect(code).toBe(0);
    expect(out).toEqual({ publish: 'true', release_tag: 'operator-edge', is_stable: 'false' });
  });

  it('a push to a non-main branch does not publish at all', () => {
    const { code, out } = run('refs/heads/feature/foo', 'feature/foo');
    expect(code).toBe(0);
    expect(out).toEqual({ publish: 'false', release_tag: '', is_stable: 'false' });
  });

  it('a malformed operator-v* tag fails loud rather than guessing a channel', () => {
    const { code, out, stderr } = run('refs/tags/operator-vBAD', 'operator-vBAD');
    expect(code).toBe(1);
    expect(out).toBeNull();
    expect(stderr).toContain('is not a valid operator release tag');
  });

  it('a tag that only coincidentally starts with operator-v but is not semver still fails loud', () => {
    const { code } = run('refs/tags/operator-vNext', 'operator-vNext');
    expect(code).toBe(1);
  });
});
