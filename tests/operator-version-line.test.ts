import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The operator's pinnable version line (#1947), built on the tag-triggered
 * release channel (#1667):
 *
 *   - `hack/release-channel.sh` also reports the bare `version` (so no step
 *     re-derives it from the tag by string surgery);
 *   - `hack/stamp-release-version.sh` writes that version into the two places a
 *     client can read it back from the cluster — the image tag in
 *     `config/manager/kustomization.yaml` and the `app.kubernetes.io/version`
 *     label on the manager Deployment — and fails LOUD if either anchor is
 *     missing or ambiguous (a silent no-op would ship a bundle that claims a
 *     version it does not carry);
 *   - the publisher attaches a digest-pinned `install-vX.Y.Z.yaml` to the
 *     immutable per-version release, and still moves `operator-latest` with
 *     `install.yaml` on a stable tag.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OP = resolve(REPO_ROOT, 'packages/kn-next-operator');
const CHANNEL = resolve(OP, 'hack/release-channel.sh');
const STAMP = resolve(OP, 'hack/stamp-release-version.sh');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');

function channelOut(ref: string, refName: string): Record<string, string> {
  const r = spawnSync('bash', [CHANNEL, ref, refName], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? '';
  }
  return out;
}

describe('release-channel.sh reports the bare version (#1947)', () => {
  it('a stable tag reports X.Y.Z', () => {
    expect(channelOut('refs/tags/operator-v1.2.3', 'operator-v1.2.3').version).toBe('1.2.3');
  });
  it('an rc tag reports the full prerelease version', () => {
    expect(channelOut('refs/tags/operator-v1.2.3-rc.1', 'operator-v1.2.3-rc.1').version).toBe(
      '1.2.3-rc.1',
    );
  });
  it('main (operator-edge) and non-publishing refs report an empty version', () => {
    expect(channelOut('refs/heads/main', 'main').version).toBe('');
    expect(channelOut('refs/heads/feat/x', 'feat/x').version).toBe('');
  });
});

describe('stamp-release-version.sh (#1947)', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** A scratch copy of the two files the stamp script edits. */
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'op-stamp-'));
    made.push(dir);
    mkdirSync(join(dir, 'config/manager'), { recursive: true });
    for (const f of ['kustomization.yaml', 'manager.yaml']) {
      cpSync(join(OP, 'config/manager', f), join(dir, 'config/manager', f));
    }
    return dir;
  }

  function stamp(dir: string, version: string) {
    return spawnSync('bash', [STAMP, version, dir], { encoding: 'utf8' });
  }

  it('rewrites the image tag (keeping the digest) and the version label', () => {
    const dir = scratch();
    const kust0 = readFileSync(join(dir, 'config/manager/kustomization.yaml'), 'utf8');
    const digest0 = /@sha256:([0-9a-f]{64})/.exec(kust0)?.[1];
    expect(digest0).toBeDefined();

    const r = stamp(dir, '1.2.3');
    expect(r.status).toBe(0);

    const kust = readFileSync(join(dir, 'config/manager/kustomization.yaml'), 'utf8');
    expect(kust).toContain(`newTag: v1.2.3@sha256:${digest0}`);
    const mgr = readFileSync(join(dir, 'config/manager/manager.yaml'), 'utf8');
    // Deployment metadata AND pod template carry the label.
    expect(mgr.match(/app\.kubernetes\.io\/version: "?1\.2\.3"?/g)?.length).toBe(2);
    expect(mgr).not.toContain('version: unreleased');
  });

  it('accepts a prerelease version (rc) as a valid image tag', () => {
    const dir = scratch();
    expect(stamp(dir, '1.2.3-rc.1').status).toBe(0);
    expect(readFileSync(join(dir, 'config/manager/kustomization.yaml'), 'utf8')).toContain(
      'newTag: v1.2.3-rc.1@sha256:',
    );
  });

  it('rejects a version that is not semver', () => {
    const dir = scratch();
    const r = stamp(dir, 'latest');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/semver/i);
  });

  it('fails loud, and changes nothing, when the manager label anchor is missing', () => {
    const dir = scratch();
    const mgrPath = join(dir, 'config/manager/manager.yaml');
    const stripped = readFileSync(mgrPath, 'utf8').replaceAll(
      /^\s*app\.kubernetes\.io\/version:.*\n/gm,
      '',
    );
    // Rewrite via the shell-free path: Bun's fs is fine in a test.
    writeFileSync(mgrPath, stripped);
    const kustBefore = readFileSync(join(dir, 'config/manager/kustomization.yaml'), 'utf8');
    const r = stamp(dir, '1.2.3');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/app\.kubernetes\.io\/version/);
    expect(readFileSync(join(dir, 'config/manager/kustomization.yaml'), 'utf8')).toBe(kustBefore);
  });

  it('fails loud when the kustomization tag anchor is missing', () => {
    const dir = scratch();
    const kPath = join(dir, 'config/manager/kustomization.yaml');
    writeFileSync(
      kPath,
      readFileSync(kPath, 'utf8').replace(/^(\s*)newTag: .*$/m, '$1newTag: latest'),
    );
    const r = stamp(dir, '1.2.3');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/newTag/);
  });
});

describe('committed manager manifest carries a version label (#1947)', () => {
  it('Deployment metadata and the pod template both declare app.kubernetes.io/version: unreleased', () => {
    const mgr = readFileSync(join(OP, 'config/manager/manager.yaml'), 'utf8');
    // "unreleased" is the committed sentinel; ONLY a version-tag publish stamps a real value.
    expect(mgr.match(/app\.kubernetes\.io\/version: "?unreleased"?/g)?.length).toBe(2);
    // Never part of the selector (immutable on a Deployment): the selector block must not list it.
    const selector = /selector:\s*\n\s*matchLabels:\s*\n((?:\s+.*\n){1,4})/.exec(mgr)?.[1] ?? '';
    expect(selector).not.toContain('app.kubernetes.io/version');
  });
});

describe('operator-supply-chain.yml publishes install-vX.Y.Z.yaml (#1947)', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const idx = (re: RegExp) => code.search(re);

  it('stamps the version only for a version tag, BEFORE the digest pin and the render', () => {
    const stamp = idx(/hack\/stamp-release-version\.sh/);
    const render = idx(/make build-installer/);
    expect(stamp, 'workflow must call hack/stamp-release-version.sh').toBeGreaterThanOrEqual(0);
    expect(stamp).toBeLessThan(render);
    const around = code.slice(Math.max(0, stamp - 400), stamp + 400);
    expect(around).toMatch(/is_version_tag/);
  });

  it('the digest pin tolerates a prerelease tag (v1.2.3-rc.1@sha256:)', () => {
    // The old pattern only matched vN.N.N@sha256: and would silently skip an rc.
    expect(code).not.toMatch(/newTag: v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+@sha256:/);
  });

  it('tags the pushed digest vX.Y.Z in the registry (crane tag), only for a version tag, after the push', () => {
    const push = idx(/crane push operator-oci/);
    const tag = idx(/crane tag /);
    expect(tag, 'workflow must `crane tag` the pushed digest').toBeGreaterThan(push);
    expect(code.slice(Math.max(0, tag - 600), tag)).toMatch(/is_version_tag\s*==\s*'true'/);
  });

  it('writes a digest-pinned install-v<version>.yaml and attaches it to the per-version release', () => {
    expect(code).toMatch(
      /install-v\$\{VERSION\}\.yaml|install-v\$\{\{ steps\.channel\.outputs\.version \}\}\.yaml/,
    );
    // The versioned asset is still checked for the digest pin before upload.
    const copy = idx(/install-v/);
    const published = idx(/check-published-digest\.sh/);
    expect(published).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(published);
    // Attached by the channel-release step.
    const rel = code.slice(code.indexOf('Publish install.yaml to its channel release'));
    expect(rel.slice(0, rel.indexOf('Move operator-latest'))).toMatch(
      /steps\.versioned_asset\.outputs\.path/,
    );
  });

  it('operator-latest still gets install.yaml and still moves only on a stable tag', () => {
    const latest = code.slice(code.indexOf('Move operator-latest'));
    expect(latest).toMatch(/is_stable\s*==\s*'true'/);
    expect(latest).toMatch(/files:[\s\S]*dist\/install\.yaml/);
    // The rolling pointer must not accumulate versioned assets.
    expect(latest).not.toMatch(/install-v/);
  });
});

describe('docs show how to pin, upgrade to and roll back an operator version (#1947)', () => {
  const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

  it('the user-facing versioning page documents pin / upgrade / rollback with the versioned asset', () => {
    const page = read('apps/docs/content/docs/versioning.mdx');
    for (const heading of [
      '## Pin, upgrade and roll back the operator',
      '### Pin a version',
      '### Upgrade to a specific version',
      '### Roll back to a previous version',
    ]) {
      expect(page, `missing heading ${heading}`).toContain(heading);
    }
    expect(page).toContain('install-v${VERSION}.yaml');
    expect(page).toContain('knext doctor');
    expect(page).toMatch(/app\\?\.kubernetes\\?\.io\/version/);
  });

  it('the upgrade and rollback runbooks name a concrete pinned target', () => {
    expect(read('docs/runbooks/upgrade.md')).toContain('install-v${NEW}.yaml');
    expect(read('docs/runbooks/rollback.md')).toContain('install-v${LAST_GOOD}.yaml');
  });

  it('COMPATIBILITY.md no longer claims there is no operator semver line', () => {
    const compat = read('docs/COMPATIBILITY.md');
    expect(compat).not.toMatch(/no semver (release )?line today/i);
    expect(compat).not.toContain('the operator has no semver release line');
    expect(compat).toContain('### Operator versions');
  });
});
