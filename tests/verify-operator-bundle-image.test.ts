import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Release-integrity guard for operator bundles: `operator-vX.Y.Z` must ship an
 * install.yaml pinning image tag `vX.Y.Z` at the digest THIS run built. The published
 * operator-v1.0.0 pinned `v0.1.0`; the fixture below is that exact asset
 * (`gh release download operator-v1.0.0 -p install.yaml`).
 * Mutation-proved by `scripts/mutation-prove-operator-bundle-image.mjs`.
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/verify-operator-bundle-image.mjs');
const REAL_V100 = resolve(import.meta.dirname, 'fixtures/operator-v1.0.0-install.yaml');
const REAL_V100_DIGEST = 'sha256:3b35d33efcd68ef2799bf740452c0ad42d5ab20e42cef2b7dfeee65e518e29b9';
const D = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const IMG = 'ghcr.io/getknext-dev/kn-next-operator';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'op-bundle-'));
  dirs.push(dir);
  return dir;
}

function bundle(imageLine: string | null): string {
  const img = imageLine === null ? '' : `        ${imageLine}\n`;
  return `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - name: manager\n${img}`;
}

function run(args: string[]) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function check(tag: string, digest: string, content: string | null) {
  const file = join(tmp(), 'install.yaml');
  if (content !== null) writeFileSync(file, content);
  return run(['--tag', tag, '--digest', digest, '--install', file]);
}

describe('verify-operator-bundle-image', () => {
  it('passes when tag and digest both match', () => {
    expect(check('operator-v1.4.0', D, bundle(`image: ${IMG}:v1.4.0@${D}`)).code).toBe(0);
  });

  it('passes for a prerelease tag', () => {
    expect(check('operator-v1.4.0-rc.1', D, bundle(`image: ${IMG}:v1.4.0-rc.1@${D}`)).code).toBe(0);
  });

  it('FAILS the real operator-v1.0.0 install.yaml (pins v0.1.0)', () => {
    // The digest matches what that run built; only the TAG lies. It must still be refused.
    const r = run([
      '--tag',
      'operator-v1.0.0',
      '--digest',
      REAL_V100_DIGEST,
      '--install',
      REAL_V100,
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("image tag 'v0.1.0'");
  });

  it('fails when the tag differs from the release tag', () => {
    const r = check('operator-v1.4.0', D, bundle(`image: ${IMG}:v1.3.0@${D}`));
    expect(r.code).toBe(1);
    expect(r.out).toContain("'v1.3.0'");
  });

  it('fails when the digest is not the one built in this run', () => {
    const r = check('operator-v1.4.0', D, bundle(`image: ${IMG}:v1.4.0@${OTHER}`));
    expect(r.code).toBe(1);
    expect(r.out).toContain('this run built');
  });

  it('fails on a tag-only reference (no digest)', () => {
    expect(check('operator-v1.4.0', D, bundle(`image: ${IMG}:v1.4.0`)).code).toBe(1);
  });

  it('fails on a digest-only reference (tag not recorded)', () => {
    expect(check('operator-v1.4.0', D, bundle(`image: ${IMG}@${D}`)).code).toBe(1);
  });

  it('fails when the bundle has no operator image line', () => {
    expect(check('operator-v1.4.0', D, bundle(null)).code).toBe(1);
  });

  it('fails when the bundle pins two different operator images', () => {
    const two = `${bundle(`image: ${IMG}:v1.4.0@${D}`)}${bundle(`image: ${IMG}:v1.4.0@${OTHER}`)}`;
    expect(check('operator-v1.4.0', D, two).code).toBe(1);
  });

  it('fails closed on an unreadable (missing) install.yaml', () => {
    const r = check('operator-v1.4.0', D, null);
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot read');
  });

  it('fails closed on an empty install.yaml', () => {
    expect(check('operator-v1.4.0', D, '').code).toBe(1);
  });

  it('fails closed on an unparseable install.yaml', () => {
    expect(check('operator-v1.4.0', D, '\u0000\u0001\u0002 not yaml {{{').code).toBe(1);
  });

  it('fails when --install is a directory (read error, not a pass)', () => {
    expect(run(['--tag', 'operator-v1.4.0', '--digest', D, '--install', tmp()]).code).toBe(1);
  });

  it('fails on a malformed release tag or digest', () => {
    expect(check('operator-latest', D, bundle(`image: ${IMG}:v1.4.0@${D}`)).code).toBe(1);
    expect(check('operator-v1.4.0', 'sha256:abc', bundle(`image: ${IMG}:v1.4.0@${D}`)).code).toBe(
      1,
    );
  });

  it('checks EVERY --install file (second one bad => fail)', () => {
    const dir = tmp();
    const good = join(dir, 'a.yaml');
    const bad = join(dir, 'b.yaml');
    writeFileSync(good, bundle(`image: ${IMG}:v1.4.0@${D}`));
    writeFileSync(bad, bundle(`image: ${IMG}:v0.1.0@${D}`));
    expect(
      run(['--tag', 'operator-v1.4.0', '--digest', D, '--install', good, '--install', bad]).code,
    ).toBe(1);
  });

  it('exits 2 on usage errors', () => {
    expect(run([]).code).toBe(2);
  });
});

describe('operator-supply-chain.yml wiring', () => {
  const wf = readFileSync(
    resolve(import.meta.dirname, '../.github/workflows/operator-supply-chain.yml'),
    'utf8',
  );
  const idx = (needle: string) => {
    const at = wf.indexOf(needle);
    expect(at).toBeGreaterThan(-1);
    return at;
  };
  const GUARD = '- name: Verify the bundle pins this release';
  const step = (() => {
    const at = idx(GUARD);
    const next = wf.indexOf('\n      - name:', at + 1);
    return wf.slice(at, next);
  })();

  it("runs the guard with the tag, this run's pushed digest, and BOTH attached assets", () => {
    expect(step).toContain('node scripts/verify-operator-bundle-image.mjs');
    expect(step).toContain('--tag "${RELEASE_TAG}"');
    expect(step).toContain('DIGEST: ${{ steps.push.outputs.digest }}');
    expect(step).toContain('--digest "${DIGEST}"');
    expect(step).toContain('--install packages/kn-next-operator/dist/install.yaml');
    expect(step).toContain('--install "${VERSIONED_ASSET}"');
  });

  it('is gated on version tags and is not continue-on-error', () => {
    expect(step).toContain("steps.channel.outputs.is_version_tag == 'true'");
    expect(step).not.toContain('continue-on-error');
  });

  it('runs before the release body is generated and before the release is published', () => {
    const guard = idx(GUARD);
    expect(guard).toBeLessThan(idx('- name: Generate the operator release body'));
    expect(guard).toBeLessThan(idx('- name: Publish install.yaml to its channel release'));
    expect(guard).toBeLessThan(idx('- name: Move operator-latest to this stable release'));
    expect(guard).toBeGreaterThan(idx('- name: Write install-vX.Y.Z.yaml'));
  });
});
