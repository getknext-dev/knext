import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Unit tests for the immutability guard behind operator semver releases
 * (#1667): `packages/kn-next-operator/hack/check-release-immutable.sh`.
 *
 * `softprops/action-gh-release` UPDATES an existing release for a given tag
 * rather than refusing to touch one, so without this guard a re-pushed or
 * force-moved `operator-vX.Y.Z` tag could silently overwrite a previously
 * published install.yaml — exactly what "immutable release" is supposed to
 * rule out. These tests stub the `gh` CLI (a tiny fake script placed first on
 * PATH) so the guard's decision logic is exercised without any real GitHub
 * API access.
 */

const SCRIPT = resolve(
  import.meta.dirname,
  '../packages/kn-next-operator/hack/check-release-immutable.sh',
);

/** Every fake-`gh` PATH dir created below, removed in afterAll (#880/D9). */
const fakeGhDirs: string[] = [];

afterAll(() => {
  for (const dir of fakeGhDirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes a fake `gh` on a fresh PATH dir that behaves per `behavior`. */
function fakeGhBin(
  behavior: 'no-release' | 'release-with-asset' | 'release-no-asset' | 'api-error',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  fakeGhDirs.push(dir);
  const bin = join(dir, 'gh');
  let body: string;
  switch (behavior) {
    case 'no-release':
      body = `#!/usr/bin/env bash\necho "release not found" >&2\nexit 1\n`;
      break;
    case 'release-with-asset':
      body = `#!/usr/bin/env bash\necho '{"assets":[{"name":"install.yaml"},{"name":"checksums.txt"}]}'\nexit 0\n`;
      break;
    case 'release-no-asset':
      body = `#!/usr/bin/env bash\necho '{"assets":[]}'\nexit 0\n`;
      break;
    case 'api-error':
      body = `#!/usr/bin/env bash\necho "gh: rate limit exceeded" >&2\nexit 1\n`;
      break;
  }
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return dir;
}

function run(behavior: Parameters<typeof fakeGhBin>[0]) {
  const fakeDir = fakeGhBin(behavior);
  const result = spawnSync('bash', [SCRIPT, 'getknext-dev/knext', 'operator-v1.2.3'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}` },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('check-release-immutable.sh: guards operator-vX.Y.Z releases (#1667)', () => {
  it('exits 0 when no release exists yet for the tag', () => {
    const { code, stdout } = run('no-release');
    expect(code).toBe(0);
    expect(stdout).toContain('safe to publish');
  });

  it('exits 0 when a release exists but has not (yet) had install.yaml attached', () => {
    const { code, stdout } = run('release-no-asset');
    expect(code).toBe(0);
    expect(stdout).toContain('safe to publish');
  });

  it('exits 1 (fail loud) when the release ALREADY carries an install.yaml asset', () => {
    const { code, stderr } = run('release-with-asset');
    expect(code).toBe(1);
    expect(stderr).toContain('immutable');
    expect(stderr).toContain('operator-v1.2.3');
  });

  it('exits 2 (never a silent pass) when gh fails for a reason other than "release not found"', () => {
    const { code, stderr } = run('api-error');
    expect(code).toBe(2);
    expect(stderr).toContain('rate limit');
  });
});
