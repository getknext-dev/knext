import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBody,
  compareSemver,
  isPrerelease,
  PACKAGES,
  releaseFlags,
} from '../scripts/release-notes-body.mjs';

/**
 * UNIT + CLI TESTS for `scripts/release-notes-body.mjs`: the body and the
 * prerelease / latest decision of the ONE readable GitHub release per version
 * that `release.yml`'s `github-release` job publishes.
 *
 * The workflow wiring (permissions, needs, no credential) is graded separately in
 * `tests/release-github-release-workflow.test.ts`. The target format is the
 * hand-made `v1.3.0` / `v1.0.0` releases: the notes file body, a "Packages" table
 * linking npm and each package's CHANGELOG at the tag, then a link to the notes file.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/release-notes-body.mjs');
const REPO = 'getknext-dev/knext';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(version: string, notes: string | null, tags = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-body-'));
  fixtures.push(root);
  mkdirSync(join(root, 'packages', 'kn-next'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kn-next', 'package.json'), JSON.stringify({ version }));
  if (notes !== null) {
    mkdirSync(join(root, 'docs', 'release'), { recursive: true });
    writeFileSync(join(root, 'docs', 'release', `v${version}.md`), notes);
  }
  writeFileSync(join(root, 'tags.txt'), tags);
  return root;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

describe('buildBody — the target format of the hand-made releases', () => {
  const notes = '# knext v1.3.0\n\nSome notes.\n';
  const body = buildBody({ version: '1.3.0', notes, repo: REPO });

  it('starts with the notes file body, verbatim', () => {
    expect(body.startsWith('# knext v1.3.0\n\nSome notes.\n')).toBe(true);
  });

  it('then a rule, a Packages heading and a table with one row per package', () => {
    expect(body).toContain(
      '\n\n---\n\n## Packages\n\n| Package | npm | Changelog |\n|---|---|---|\n',
    );
    expect(body).toContain(
      '| `@getknext/core` | [1.3.0](https://www.npmjs.com/package/@getknext/core/v/1.3.0) | [CHANGELOG](https://github.com/getknext-dev/knext/blob/v1.3.0/packages/kn-next/CHANGELOG.md) |',
    );
    expect(body).toContain(
      '| `@getknext/lib` | [1.3.0](https://www.npmjs.com/package/@getknext/lib/v/1.3.0) | [CHANGELOG](https://github.com/getknext-dev/knext/blob/v1.3.0/packages/lib/CHANGELOG.md) |',
    );
    expect(body).toContain(
      '| `@getknext/db` | [1.3.0](https://www.npmjs.com/package/@getknext/db/v/1.3.0) | [CHANGELOG](https://github.com/getknext-dev/knext/blob/v1.3.0/packages/db/CHANGELOG.md) |',
    );
  });

  it('ends with a link to the notes file at the tag, and a single trailing newline', () => {
    expect(
      body.endsWith(
        'These notes are also in the repository at [`docs/release/v1.3.0.md`](https://github.com/getknext-dev/knext/blob/v1.3.0/docs/release/v1.3.0.md).\n',
      ),
    ).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });

  it('does not grow the gap when the notes file ends with extra newlines', () => {
    const padded = buildBody({ version: '1.3.0', notes: `${notes}\n\n\n`, repo: REPO });
    expect(padded).toBe(body);
  });

  it('uses the prerelease version in every link', () => {
    const rc = buildBody({ version: '1.3.0-rc.10', notes: '# rc\n', repo: REPO });
    expect(rc).toContain('/blob/v1.3.0-rc.10/packages/lib/CHANGELOG.md');
    expect(rc).toContain('/v/1.3.0-rc.10)');
    expect(rc).toContain('`docs/release/v1.3.0-rc.10.md`');
  });

  it('the package list is the publishable packages minus the forwarding alias, each with a real CHANGELOG', () => {
    expect(PACKAGES.map((p: { name: string }) => p.name).sort()).toEqual([
      '@getknext/core',
      '@getknext/db',
      '@getknext/lib',
    ]);
    // A row whose dir has no CHANGELOG would publish a dead link in the release.
    for (const p of PACKAGES as Array<{ dir: string }>) {
      expect(existsSync(join(REPO_ROOT, p.dir, 'CHANGELOG.md'))).toBe(true);
    }
  });

  it('refuses a version that is not plain semver (it becomes a path and a URL)', () => {
    for (const bad of ['', '1.3', 'v1.3.0', '../1.3.0', '1.3.0/../../x', '1.3.0 ']) {
      expect(() => buildBody({ version: bad, notes, repo: REPO })).toThrow(/semver/i);
    }
  });
});

describe('isPrerelease / compareSemver', () => {
  it('a prerelease has a hyphenated suffix', () => {
    expect(isPrerelease('1.3.0-rc.10')).toBe(true);
    expect(isPrerelease('1.3.0')).toBe(false);
  });

  it('orders numerically, not lexically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('2.0.0', '10.0.0')).toBeLessThan(0);
  });
});

describe('releaseFlags — --latest only for the highest stable version', () => {
  it('the highest stable version is latest', () => {
    expect(releaseFlags('1.3.0', ['v1.0.0', 'v1.0.1'])).toEqual({
      prerelease: false,
      latest: true,
    });
  });

  it('a stable patch on an OLDER line is not latest', () => {
    expect(releaseFlags('1.0.1', ['v1.0.0', 'v1.3.0'])).toEqual({
      prerelease: false,
      latest: false,
    });
  });

  it('compares numerically (1.10.0 beats 1.9.0)', () => {
    expect(releaseFlags('1.9.0', ['v1.10.0'])).toEqual({ prerelease: false, latest: false });
    expect(releaseFlags('1.10.0', ['v1.9.0'])).toEqual({ prerelease: false, latest: true });
  });

  it('re-running the release for the current highest version keeps it latest', () => {
    expect(releaseFlags('1.3.0', ['v1.0.0', 'v1.3.0'])).toEqual({
      prerelease: false,
      latest: true,
    });
  });

  it('a prerelease is a prerelease and never latest, even above every stable tag', () => {
    expect(releaseFlags('1.3.1-rc.1', ['v1.3.0'])).toEqual({ prerelease: true, latest: false });
  });

  it('prerelease tags never block a stable from being latest', () => {
    expect(releaseFlags('1.3.0', ['v1.3.0-rc.10', 'v2.0.0-rc.1'])).toEqual({
      prerelease: false,
      latest: true,
    });
  });

  it('ignores tags that are not vX.Y.Z (package tags, operator tags)', () => {
    expect(
      releaseFlags('1.3.0', ['@getknext/core@9.9.9', 'kn-next@9.9.9', 'operator-v9.9.9', 'v9']),
    ).toEqual({ prerelease: false, latest: true });
  });
});

describe('CLI', () => {
  it('writes the body, and prerelease/latest/tag/title to GITHUB_OUTPUT', () => {
    const root = makeRoot(
      '1.3.0',
      '# knext v1.3.0\n\nhello\n',
      'v1.0.0\nv1.3.0-rc.10\n@getknext/core@1.3.0\n',
    );
    const out = join(root, 'body.md');
    const ghOut = join(root, 'gh-output');
    const r = run(
      ['--root', root, '--repo', REPO, '--out', out, '--tags-file', join(root, 'tags.txt')],
      { GITHUB_OUTPUT: ghOut },
    );
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(
      buildBody({ version: '1.3.0', notes: '# knext v1.3.0\n\nhello\n', repo: REPO }),
    );
    const outputs = readFileSync(ghOut, 'utf8');
    expect(outputs).toContain('tag=v1.3.0\n');
    expect(outputs).toContain('title=knext v1.3.0\n');
    expect(outputs).toContain('prerelease=false\n');
    expect(outputs).toContain('latest=true\n');
  });

  it('a prerelease gets prerelease=true, latest=false', () => {
    const root = makeRoot('1.3.1-rc.1', '# rc\n', 'v1.3.0\n');
    const ghOut = join(root, 'gh-output');
    const r = run(
      [
        '--root',
        root,
        '--repo',
        REPO,
        '--out',
        join(root, 'b.md'),
        '--tags-file',
        join(root, 'tags.txt'),
      ],
      { GITHUB_OUTPUT: ghOut },
    );
    expect(r.status).toBe(0);
    const outputs = readFileSync(ghOut, 'utf8');
    expect(outputs).toContain('prerelease=true\n');
    expect(outputs).toContain('latest=false\n');
  });

  it('FAILS with a clear message when the notes file is missing, and writes no body', () => {
    const root = makeRoot('1.3.1', null);
    const out = join(root, 'body.md');
    const r = run([
      '--root',
      root,
      '--repo',
      REPO,
      '--out',
      out,
      '--tags-file',
      join(root, 'tags.txt'),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('docs/release/v1.3.1.md');
    expect(r.stderr).toMatch(/missing|not found/i);
    expect(existsSync(out)).toBe(false);
  });

  it('FAILS on an empty notes file (an empty release is not a readable release)', () => {
    const root = makeRoot('1.3.1', '  \n');
    const r = run([
      '--root',
      root,
      '--repo',
      REPO,
      '--out',
      join(root, 'b.md'),
      '--tags-file',
      join(root, 'tags.txt'),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/empty/i);
  });

  it('FAILS (usage) without --repo or --out', () => {
    const root = makeRoot('1.3.1', '# x\n');
    expect(run(['--root', root, '--out', join(root, 'b.md')]).status).not.toBe(0);
    expect(run(['--root', root, '--repo', REPO]).status).not.toBe(0);
  });

  it('FAILS when the tags file is unreadable instead of assuming "no other tags" (that would mark any version latest)', () => {
    const root = makeRoot('1.0.1', '# x\n');
    const r = run([
      '--root',
      root,
      '--repo',
      REPO,
      '--out',
      join(root, 'b.md'),
      '--tags-file',
      join(root, 'nope.txt'),
    ]);
    expect(r.status).not.toBe(0);
  });

  it('--check only verifies the notes exist: exit 0 with them, non-zero without, no output file', () => {
    const ok = makeRoot('1.3.1', '# x\n');
    expect(run(['--root', ok, '--check']).status).toBe(0);
    const missing = makeRoot('1.3.1', null);
    const r = run(['--root', missing, '--check']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('docs/release/v1.3.1.md');
  });
});

describe('this checkout', () => {
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'))
    .version as string;

  it('has release notes for the version @getknext/core is currently at', () => {
    // The notes file is the release body. A Version PR that bumps the version
    // without adding docs/release/v<version>.md would publish to npm and THEN
    // fail to create the release, so it goes red here, before the merge.
    expect(existsSync(join(REPO_ROOT, 'docs/release', `v${version}.md`))).toBe(true);
    expect(run(['--check']).status).toBe(0);
  });
});
