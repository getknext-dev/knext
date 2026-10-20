import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  ageFailed,
  changedEntries,
  evaluateAges,
  isHashlessUrlSource,
  loadExceptions,
  parseLockfile,
  publishTime,
  readBunfig,
  registryUrl,
  renderAgeReport,
  renderUnscannable,
} from '../scripts/lib/release-age.mjs';

/**
 * GUARD: a change cannot land a lockfile entry younger than the quarantine.
 *
 * `bunfig.toml` keeps bun from RESOLVING a fresh release. That protects the machine
 * running `bun add` and nothing else: a Dependabot branch, a hand-edited lockfile,
 * a Cargo or Go bump, or an install with `--minimum-release-age 0` reach the tree
 * unchecked. This gate checks the RESULT, per added or altered lockfile entry, from
 * the registry's own publish time, and fails closed when the registry cannot answer.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 3 * 86400;
const NO_EXC = { active: [], expired: [] };
const TODAY = '2026-10-17';

const entry = (over: Record<string, unknown> = {}): any => ({
  lockfile: 'bun.lock',
  ecosystem: 'npm',
  name: 'left-pad',
  version: '1.3.0',
  ...over,
});

const run = (
  entries: any[],
  lookup: (e: any) => Promise<number>,
  over: Record<string, unknown> = {},
) =>
  evaluateAges({
    entries,
    lookup,
    now: NOW,
    minSeconds: MIN,
    excludes: [],
    exceptions: NO_EXC,
    ...over,
  });

describe('readBunfig: the same number the install-time quarantine uses', () => {
  it('reads the repo bunfig', () => {
    const { seconds, excludes } = readBunfig(
      readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8'),
    );
    expect(seconds).toBeGreaterThanOrEqual(3 * 86400);
    expect(excludes).toContain('@getknext/core');
  });
  it('throws when no quarantine is set (never a silent zero)', () => {
    expect(() => readBunfig('[install]\n')).toThrow(/minimumReleaseAge/);
  });
});

describe('parseLockfile', () => {
  const jsonc = (t: string) => Bun.JSONC.parse(t) as any;
  const unresolved = (list: any[]) => list.filter((e) => e.unresolved);

  describe('bun.lock', () => {
    it('registry versions, aliases resolved, local (workspace/file/link) skipped', () => {
      const text = `{
        "packages": {
          "a": ["a@1.0.0", "", {}, "sha"],
          "scoped": ["@s/pkg@2.1.3-rc.1", "", {}, "sha"],
          "alias": ["old@npm:real@3.0.0", "", {}, "sha"],
          "ws": ["pkg@workspace:packages/pkg"],
          "file": ["f@file:../f"],
          "link": ["l@link:../l"],
        }
      }`;
      expect(parseLockfile('bun.lock', text, jsonc)).toEqual([
        { ecosystem: 'npm', name: 'a', version: '1.0.0' },
        { ecosystem: 'npm', name: '@s/pkg', version: '2.1.3-rc.1' },
        { ecosystem: 'npm', name: 'real', version: '3.0.0' },
      ]);
    });
    it('a github: dependency is UNRESOLVED, not dropped', () => {
      const [e] = parseLockfile(
        'bun.lock',
        '{"packages":{"g":["g@github:o/r#abc",{},"tag"]}}',
        jsonc,
      );
      expect(e).toMatchObject({ ecosystem: 'npm', name: 'g', version: 'github:o/r#abc' });
      expect(e.unresolved).toBeTruthy();
    });
    it('a tarball URL dependency is UNRESOLVED', () => {
      const [e] = parseLockfile(
        'bun.lock',
        '{"packages":{"t":["t@https://example.com/t-1.0.0.tgz",{},"sha"]}}',
        jsonc,
      );
      expect(e.unresolved).toBeTruthy();
      expect(e.version).toBe('https://example.com/t-1.0.0.tgz');
    });
    it('a registry-looking version pinned to a NON-DEFAULT registry is UNRESOLVED', () => {
      const [e] = parseLockfile(
        'bun.lock',
        '{"packages":{"a":["a@1.0.0","https://npm.corp.example/",{},"sha"]}}',
        jsonc,
      );
      expect(e.unresolved).toMatch(/non-default registry/);
    });
    it('an unparseable id is UNRESOLVED, never skipped', () => {
      const [e] = parseLockfile('bun.lock', '{"packages":{"x":["nonsense",{},"sha"]}}', jsonc);
      expect(e.unresolved).toBeTruthy();
    });
  });

  describe('package-lock.json', () => {
    const lock = (packages: Record<string, unknown>) => JSON.stringify({ packages });
    it('registry-resolved packages, nested names; links, workspaces, bundled and file: skipped', () => {
      const text = lock({
        '': { name: 'root' },
        'node_modules/a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        },
        'node_modules/a/node_modules/@s/b': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz',
        },
        'node_modules/l': { link: true },
        'packages/member': { version: '0.0.1' },
        'node_modules/bundled': { version: '1.0.0', inBundle: true },
        'node_modules/loc': { version: '1.0.0', resolved: 'file:../loc' },
      });
      expect(parseLockfile('x/package-lock.json', text)).toEqual([
        { ecosystem: 'npm', name: 'a', version: '1.0.0' },
        { ecosystem: 'npm', name: '@s/b', version: '2.0.0' },
      ]);
    });
    it('a git+ resolved dependency is UNRESOLVED', () => {
      const out = parseLockfile(
        'package-lock.json',
        lock({ 'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://x/y.git#abc' } }),
      );
      expect(unresolved(out)).toHaveLength(1);
    });
    it('a package resolved from another registry host is UNRESOLVED', () => {
      const out = parseLockfile(
        'package-lock.json',
        lock({
          'node_modules/a': { version: '1.0.0', resolved: 'https://npm.corp.example/a-1.0.0.tgz' },
        }),
      );
      expect(unresolved(out)).toHaveLength(1);
    });
    it('a package with no resolved URL is UNRESOLVED', () => {
      const out = parseLockfile(
        'package-lock.json',
        lock({ 'node_modules/a': { version: '1.0.0' } }),
      );
      expect(unresolved(out)).toHaveLength(1);
    });
  });

  describe('Cargo.lock', () => {
    const block = (name: string, version: string, source?: string) =>
      `[[package]]\nname = "${name}"\nversion = "${version}"\n${source ? `source = "${source}"\n` : ''}\n`;
    it('crates.io (both index spellings) are registry entries; path crates are skipped', () => {
      const text =
        block('serde', '1.0.200', 'registry+https://github.com/rust-lang/crates.io-index') +
        block('tokio', '1.0.0', 'sparse+https://index.crates.io/') +
        block('local', '0.1.0');
      expect(parseLockfile('Cargo.lock', text)).toEqual([
        { ecosystem: 'crates', name: 'serde', version: '1.0.200' },
        { ecosystem: 'crates', name: 'tokio', version: '1.0.0' },
      ]);
    });
    it('a git+ crate is UNRESOLVED', () => {
      const out = parseLockfile(
        'Cargo.lock',
        block('time', '0.1.0', 'git+https://github.com/o/r?rev=abc#abc'),
      );
      expect(unresolved(out)).toHaveLength(1);
    });
    it('an alternate registry, even one with crates.io in its name, is UNRESOLVED', () => {
      const out = parseLockfile(
        'Cargo.lock',
        block('a', '1.0.0', 'registry+https://corp.example/index') +
          block('b', '1.0.0', 'registry+https://evil-crates.io/index'),
      );
      expect(unresolved(out)).toHaveLength(2);
    });
  });

  describe('go.mod', () => {
    it('required modules, blocks and single lines; exclude ignored', () => {
      const text = `module m

go 1.25

require github.com/a/b v1.2.3
require (
	github.com/c/d v0.4.0 // indirect
	golang.org/x/net v0.58.0
)
exclude (
	github.com/e/f v1.0.0
)
`;
      expect(parseLockfile('go.mod', text)).toEqual([
        { ecosystem: 'go', name: 'github.com/a/b', version: 'v1.2.3' },
        { ecosystem: 'go', name: 'github.com/c/d', version: 'v0.4.0' },
        { ecosystem: 'go', name: 'golang.org/x/net', version: 'v0.58.0' },
      ]);
    });
    it('a single-line replace to a module path is aged at the REPLACEMENT version', () => {
      const text = `require github.com/a/b v1.2.3\nreplace github.com/a/b => github.com/fork/b v1.2.4\n`;
      expect(parseLockfile('go.mod', text)).toEqual([
        { ecosystem: 'go', name: 'github.com/fork/b', version: 'v1.2.4' },
      ]);
    });
    it('a replace BLOCK is parsed the same way', () => {
      const text = `require (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.4.0\n)\nreplace (\n\tgithub.com/a/b => github.com/fork/b v1.2.4\n\tgithub.com/c/d v0.4.0 => github.com/fork/d v0.4.1\n)\n`;
      expect(parseLockfile('go.mod', text)).toEqual([
        { ecosystem: 'go', name: 'github.com/fork/b', version: 'v1.2.4' },
        { ecosystem: 'go', name: 'github.com/fork/d', version: 'v0.4.1' },
      ]);
    });
    it('a replace pinned to a different old version does not drop the require', () => {
      const text = `require github.com/a/b v1.2.3\nreplace github.com/a/b v9.9.9 => github.com/fork/b v1.0.0\n`;
      expect(parseLockfile('go.mod', text).map((e: any) => `${e.name}@${e.version}`)).toEqual([
        'github.com/a/b@v1.2.3',
        'github.com/fork/b@v1.0.0',
      ]);
    });
    it('a replace to a LOCAL directory is local code: skipped, and the require it replaces is dropped', () => {
      const text = `require github.com/c/d v0.4.0\nreplace github.com/c/d => ../d\n`;
      expect(parseLockfile('go.mod', text)).toEqual([]);
    });
    it('a replace to a module path with NO version is UNRESOLVED', () => {
      const out = parseLockfile('go.mod', `replace github.com/a/b => github.com/fork/b\n`);
      expect(unresolved(out)).toHaveLength(1);
    });
    it('an unparseable replace directive is UNRESOLVED, never skipped', () => {
      const out = parseLockfile('go.mod', `replace this is not valid\n`);
      expect(unresolved(out)).toHaveLength(1);
    });
  });

  it('throws on a lockfile it has no parser for', () => {
    expect(() => parseLockfile('yarn.lock', '')).toThrow();
  });
});

describe('integrity: a source re-pinned to new bytes is a change', () => {
  const jsonc = (t: string) => Bun.JSONC.parse(t) as any;
  const tarball = (sha: string) =>
    `{"packages":{"t":["t@https://example.com/t-1.0.0.tgz",{},"${sha}"]}}`;
  const heads = (text: string) =>
    parseLockfile('bun.lock', text, jsonc).map((e: any) => ({ ...e, lockfile: 'bun.lock' }));

  it('bun.lock: the integrity of an unresolved entry is read from the last string field', () => {
    const [shortForm] = heads(tarball('sha512-OLD'));
    expect(shortForm.integrity).toBe('sha512-OLD');
    const [registryForm] = parseLockfile(
      'bun.lock',
      '{"packages":{"a":["a@1.0.0","https://npm.corp.example/",{},"sha512-REG"]}}',
      jsonc,
    );
    expect(registryForm.integrity).toBe('sha512-REG');
  });

  it('bun.lock: re-pinning a tarball to new bytes under the SAME url is a changed entry', () => {
    const changed = changedEntries(heads(tarball('sha512-NEW')), heads(tarball('sha512-OLD')));
    expect(changed).toHaveLength(1);
    expect(changed[0].integrity).toBe('sha512-NEW');
  });

  it('bun.lock: the same hash is not a change', () => {
    expect(changedEntries(heads(tarball('sha512-OLD')), heads(tarball('sha512-OLD')))).toEqual([]);
  });

  it('package-lock.json: an integrity-only re-pin of a non-registry source is a changed entry', () => {
    const lock = (integrity: string) =>
      JSON.stringify({
        packages: {
          'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://x/y.git#abc', integrity },
        },
      });
    const mk = (i: string) =>
      parseLockfile('package-lock.json', lock(i)).map((e: any) => ({
        ...e,
        lockfile: 'package-lock.json',
      }));
    expect(mk('sha512-OLD')[0].integrity).toBe('sha512-OLD');
    expect(changedEntries(mk('sha512-NEW'), mk('sha512-OLD'))).toHaveLength(1);
    expect(changedEntries(mk('sha512-OLD'), mk('sha512-OLD'))).toEqual([]);
  });

  it('Cargo git sources carry the revision in the key: a new rev is a change', () => {
    const lock = (rev: string) =>
      `[[package]]\nname = "time"\nversion = "0.1.0"\nsource = "git+https://github.com/o/r?rev=${rev}#${rev}"\n`;
    const mk = (rev: string) =>
      parseLockfile('Cargo.lock', lock(rev)).map((e: any) => ({ ...e, lockfile: 'Cargo.lock' }));
    expect(changedEntries(mk('bbbb'), mk('aaaa'))).toHaveLength(1);
    expect(changedEntries(mk('aaaa'), mk('aaaa'))).toEqual([]);
  });

  it('go.mod replacements carry their version in the key: a new replacement version is a change', () => {
    const mk = (v: string) =>
      parseLockfile('go.mod', `require a/b v1.0.0\nreplace a/b => c/d ${v}\n`).map((e: any) => ({
        ...e,
        lockfile: 'go.mod',
      }));
    expect(changedEntries(mk('v1.0.2'), mk('v1.0.1'))).toHaveLength(1);
  });

  it('an exception without the hash does NOT excuse a hashed entry; one with the hash does', async () => {
    const base = {
      ecosystem: 'npm',
      package: 't',
      version: 'https://example.com/t-1.0.0.tgz',
      justification: 'vendored tarball with the fix, reviewed the unpacked contents',
      added: '2026-10-01',
      expires: '2026-12-01',
    };
    const e = (integrity: string) =>
      entry({ name: 't', version: base.version, unresolved: 'x', integrity });
    const unscoped = loadExceptions({ allow: [base] }, TODAY);
    const scoped = loadExceptions({ allow: [{ ...base, integrity: 'sha512-OLD' }] }, TODAY);
    const look = async () => NOW;
    expect((await run([e('sha512-OLD')], look, { exceptions: unscoped })).unresolved).toHaveLength(
      1,
    );
    expect((await run([e('sha512-OLD')], look, { exceptions: scoped })).unresolved).toEqual([]);
    // re-pinned to new bytes: the excepted hash no longer matches
    expect((await run([e('sha512-NEW')], look, { exceptions: scoped })).unresolved).toHaveLength(1);
    // an entry with no hash at all is NOT excusable, even by an exception that names none
    const noHash = entry({ name: 't', version: base.version, unresolved: 'x' });
    const r = await run([noHash], look, { exceptions: unscoped });
    expect(r.excepted).toEqual([]);
    expect(r.hashless).toHaveLength(1);
  });

  describe('a hashless URL dependency is refused even with an exception', () => {
    const tgz = 'https://example.com/t-1.0.0.tgz';
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 't',
            version: tgz,
            justification: 'vendored tarball with the fix, reviewed the unpacked contents',
            added: '2026-10-01',
            expires: '2026-12-01',
          },
        ],
      },
      TODAY,
    );
    const look = async () => NOW;

    it('an excepted tarball with no integrity fails the gate, with an actionable message', async () => {
      const e = entry({ name: 't', version: tgz, unresolved: 'not a registry version' });
      const r = await run([e], look, { exceptions: exc });
      expect(r.excepted).toEqual([]);
      expect(r.hashless).toHaveLength(1);
      expect(ageFailed(r)).toBe(true);
      expect(renderAgeReport(r, MIN)).toMatch(/no valid integrity hash/);
      expect(renderAgeReport(r, MIN)).toMatch(/exception cannot excuse/);
    });

    it('the same entry WITH an integrity hash and a matching exception is still allowed', async () => {
      const scoped = loadExceptions(
        { allow: [{ ...exc.active[0], integrity: 'sha512-OK' }] },
        TODAY,
      );
      const e = entry({
        name: 't',
        version: tgz,
        unresolved: 'not a registry version',
        integrity: 'sha512-OK',
      });
      const r = await run([e], look, { exceptions: scoped });
      expect(r.hashless).toEqual([]);
      expect(r.excepted).toHaveLength(1);
      expect(ageFailed(r)).toBe(false);
    });

    it('only a full commit sha pins a repo spec: branch, tag and range fragments are hashless', () => {
      const u = (version: string) => entry({ unresolved: 'x', version });
      const sha = 'a'.repeat(40);
      for (const v of [
        'github:o/r#main',
        'git+ssh://x/y.git#main',
        'github:o/r#semver:^1',
        'github:o/r#abc123',
        'github:o/r#',
        `github:o/r#${'a'.repeat(39)}`,
      ]) {
        expect(isHashlessUrlSource(u(v))).toBe(true);
      }
      expect(isHashlessUrlSource(u(`github:o/r#${sha}`))).toBe(false);
      expect(isHashlessUrlSource(u(`git+ssh://x/y.git#${'b'.repeat(64)}`))).toBe(false);
    });

    it('a junk integrity value does not count as a hash', () => {
      const u = (integrity: string) =>
        entry({ unresolved: 'x', version: 'https://example.com/t.tgz', integrity });
      for (const bad of ['junk', '   ', 'sha1-AAAA', 'sha512-', 'o-r-abc']) {
        expect(isHashlessUrlSource(u(bad))).toBe(true);
      }
      for (const ok of ['sha256-AAAA', 'sha384-AB+/==', 'sha512-AbC123+/=']) {
        expect(isHashlessUrlSource(u(ok))).toBe(false);
      }
    });

    it('a github: dependency resolved to a codeload tarball at a full commit is commit-addressed', () => {
      const sha = 'c'.repeat(40);
      const u = (v: string) => entry({ unresolved: 'x', version: v });
      expect(isHashlessUrlSource(u(`https://codeload.github.com/o/r/tar.gz/${sha}`))).toBe(false);
      expect(isHashlessUrlSource(u('https://codeload.github.com/o/r/tar.gz/main'))).toBe(true);
      expect(isHashlessUrlSource(u(`https://evil.example.com/o/r/tar.gz/${sha}`))).toBe(true);
    });

    it('bun.lock: a git-style trailing id on a tarball entry is not an integrity hash', () => {
      const text = '{"packages":{"t":["t@https://example.com/t-1.0.0.tgz",{},"o-r-abc"]}}';
      const [e] = parseLockfile('bun.lock', text, (t: string) => Bun.JSONC.parse(t) as any);
      expect(e.integrity).toBeUndefined();
      expect(isHashlessUrlSource(e)).toBe(true);
    });

    it('package-lock.json: a junk integrity on a non-registry source is not a hash', () => {
      const lock = (integrity: string) =>
        JSON.stringify({
          packages: {
            'node_modules/t': {
              version: '1.0.0',
              resolved: 'https://example.com/t.tgz',
              integrity,
            },
          },
        });
      const [bad] = parseLockfile('package-lock.json', lock('junk'));
      expect(isHashlessUrlSource(bad)).toBe(true);
      const [good] = parseLockfile('package-lock.json', lock('sha512-AbC='));
      expect(isHashlessUrlSource(good)).toBe(false);
    });

    it('the report says "no resolved URL" entries are not URL dependencies', async () => {
      const e = entry({ unresolved: 'no resolved URL' });
      const r = await run([e], look, { exceptions: exc });
      expect(r.hashless).toHaveLength(1);
      const text = renderAgeReport(r, MIN);
      expect(text).not.toMatch(/URL dependenc/);
      expect(text).toMatch(/no valid integrity hash/);
      expect(text).toMatch(/\[no resolved URL\]/);
    });

    it('classifies URL sources; a repo spec pins its commit in the spec and is not hashless', () => {
      const u = (version: string, over = {}) => entry({ unresolved: 'x', version, ...over });
      expect(isHashlessUrlSource(u(tgz))).toBe(true);
      expect(isHashlessUrlSource(u(tgz, { integrity: 'sha512-A' }))).toBe(false);
      expect(isHashlessUrlSource(u('github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBe(
        false,
      );
      expect(
        isHashlessUrlSource(u('git+ssh://x/y.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(false);
      expect(isHashlessUrlSource(u('github:o/r'))).toBe(true); // unpinned: a branch moves
      expect(isHashlessUrlSource(entry())).toBe(false); // resolved registry entry
      expect(isHashlessUrlSource(u('x', { ecosystem: 'crates' }))).toBe(false);
    });
  });

  it('loadExceptions accepts an integrity key and rejects a malformed one', () => {
    const ok = {
      ecosystem: 'npm',
      package: 't',
      version: 'https://example.com/t.tgz',
      integrity: 'sha512-AbC+/=',
      justification: 'vendored tarball with the fix, reviewed the unpacked contents',
      added: '2026-10-01',
      expires: '2026-12-01',
    };
    expect(() => loadExceptions({ allow: [ok] }, TODAY)).not.toThrow();
    expect(() => loadExceptions({ allow: [{ ...ok, integrity: 'has space' }] }, TODAY)).toThrow(
      /integrity/,
    );
  });
});

describe('changedEntries', () => {
  it('returns what head adds or alters, per lockfile, never removals', () => {
    const base = [entry(), entry({ name: 'gone' })];
    const head = [entry(), entry({ name: 'new' }), entry({ version: '1.4.0' })];
    expect(changedEntries(head, base).map((e) => `${e.name}@${e.version}`)).toEqual([
      'new@1.3.0',
      'left-pad@1.4.0',
    ]);
  });
  it('moving a dependency to a different source is a change (so a swap to git is judged)', () => {
    const before = [entry({ name: 'g', version: '1.0.0' })];
    const after = [entry({ name: 'g', version: 'github:o/r#abc', unresolved: 'x' })];
    expect(changedEntries(after, before)).toHaveLength(1);
  });
  it('the same package in a DIFFERENT lockfile is a change', () => {
    expect(changedEntries([entry({ lockfile: 'a/bun.lock' })], [entry()])).toHaveLength(1);
  });
});

describe('registry lookups', () => {
  it('builds the right URL for each ecosystem', () => {
    expect(registryUrl({ ecosystem: 'npm', name: 'left-pad', version: '1' } as any)).toBe(
      'https://registry.npmjs.org/left-pad',
    );
    expect(registryUrl({ ecosystem: 'npm', name: '@s/pkg', version: '1' } as any)).toBe(
      'https://registry.npmjs.org/@s%2Fpkg',
    );
    expect(registryUrl({ ecosystem: 'crates', name: 'serde', version: '1.0.1' } as any)).toBe(
      'https://crates.io/api/v1/crates/serde/1.0.1',
    );
    expect(
      registryUrl({ ecosystem: 'go', name: 'github.com/Azure/x', version: 'v1.0.0' } as any),
    ).toBe('https://proxy.golang.org/github.com/!azure/x/@v/v1.0.0.info');
  });
  it('reads the publish time from each registry shape, and THROWS when it is absent', () => {
    expect(
      publishTime({ ecosystem: 'npm', name: 'a', version: '1.0.0' } as any, {
        time: { '1.0.0': '2026-10-01T00:00:00Z' },
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(
      publishTime({ ecosystem: 'crates', name: 'a', version: '1' } as any, {
        version: { created_at: '2026-10-01T00:00:00Z' },
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(
      publishTime({ ecosystem: 'go', name: 'a', version: 'v1' } as any, {
        Time: '2026-10-01T00:00:00Z',
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(() =>
      publishTime({ ecosystem: 'npm', name: 'a', version: '9.9.9' } as any, { time: {} }),
    ).toThrow(/no publish time/);
    expect(() =>
      publishTime({ ecosystem: 'go', name: 'a', version: 'v1' } as any, { Time: 'garbage' }),
    ).toThrow();
    expect(() =>
      publishTime({ ecosystem: 'npm', name: 'a', version: '1.0.0' } as any, null),
    ).toThrow();
  });
});

describe('evaluateAges', () => {
  it('passes an entry at least as old as the quarantine, including exactly at the boundary', async () => {
    const r = await run([entry()], async () => NOW - 3 * DAY);
    expect(r.tooNew).toEqual([]);
    expect(ageFailed(r)).toBe(false);
  });
  it('fails an entry one second short of the quarantine', async () => {
    const r = await run([entry()], async () => NOW - 3 * DAY + 1000);
    expect(r.tooNew).toHaveLength(1);
    expect(ageFailed(r)).toBe(true);
  });
  it('fails a release published an hour ago and reports its age', async () => {
    const r = await run([entry()], async () => NOW - HOUR);
    expect(r.tooNew[0].ageHours).toBe(1);
    expect(renderAgeReport(r, MIN)).toMatch(/less than 3 days ago/);
  });
  it('FAILS CLOSED when the registry cannot answer', async () => {
    const r = await run([entry()], async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(r.errors).toHaveLength(1);
    expect(ageFailed(r)).toBe(true);
    expect(renderAgeReport(r, MIN)).toMatch(/could not be checked/);
  });
  it('fails closed on a lookup that returns a non-time', async () => {
    const r = await run([entry()], async () => Number.NaN);
    expect(r.errors).toHaveLength(1);
  });
  it('does not check first-party packages named in bunfig excludes', async () => {
    let calls = 0;
    const r = await run(
      [entry({ name: '@getknext/core' })],
      async () => {
        calls += 1;
        return NOW;
      },
      { excludes: ['@getknext/core'] },
    );
    expect(calls).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(ageFailed(r)).toBe(false);
  });
  it('checks everything else, and counts it', async () => {
    const r = await run(
      [entry(), entry({ name: 'b' }), entry({ name: 'c' })],
      async () => NOW - 10 * DAY,
    );
    expect(r.checked).toBe(3);
  });
  it('an UNRESOLVED entry fails without a publish time ever being looked up', async () => {
    let calls = 0;
    const r = await run(
      [
        entry({
          unresolved: 'not a registry version',
          version: 'github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      ],
      async () => {
        calls += 1;
        return NOW - 30 * DAY;
      },
    );
    expect(calls).toBe(0);
    expect(r.unresolved).toHaveLength(1);
    expect(ageFailed(r)).toBe(true);
    expect(renderAgeReport(r, MIN)).toMatch(
      /do(es)? not resolve to a version on the public registry/,
    );
  });
  it('first-party excludes do NOT excuse an unresolved source', async () => {
    const r = await run(
      [
        entry({
          name: '@getknext/core',
          unresolved: 'x',
          version: 'github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      ],
      async () => NOW,
      { excludes: ['@getknext/core'] },
    );
    expect(r.unresolved).toHaveLength(1);
  });
  it('a scoped exception naming the exact source spec allows it, and nothing else', async () => {
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 'g',
            version: 'github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            justification: 'pinned fork carrying the fix, reviewed the diff at that commit',
            added: '2026-10-01',
            expires: '2026-12-01',
          },
        ],
      },
      TODAY,
    );
    const mk = (version: string) => entry({ name: 'g', unresolved: 'x', version });
    expect(
      (
        await run([mk('github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')], async () => NOW, {
          exceptions: exc,
        })
      ).unresolved,
    ).toEqual([]);
    expect(
      (
        await run([mk('github:o/r#dddddddddddddddddddddddddddddddddddddddd')], async () => NOW, {
          exceptions: exc,
        })
      ).unresolved,
    ).toHaveLength(1);
  });
  it('an exception allows exactly one ecosystem, package and version', async () => {
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 'left-pad',
            version: '1.3.0',
            justification: 'security fix for CVE needed today, reviewed the diff',
            added: '2026-10-16',
            expires: '2026-10-20',
          },
        ],
      },
      TODAY,
    );
    const fresh = async () => NOW - HOUR;
    expect((await run([entry()], fresh, { exceptions: exc })).tooNew).toEqual([]);
    expect(
      (await run([entry({ version: '1.3.1' })], fresh, { exceptions: exc })).tooNew,
    ).toHaveLength(1);
    expect((await run([entry({ name: 'other' })], fresh, { exceptions: exc })).tooNew).toHaveLength(
      1,
    );
    expect(
      (await run([entry({ ecosystem: 'crates' })], fresh, { exceptions: exc })).tooNew,
    ).toHaveLength(1);
  });
  it('an expired exception stops allowing', async () => {
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 'left-pad',
            version: '1.3.0',
            justification: 'security fix for CVE needed today, reviewed the diff',
            added: '2026-10-01',
            expires: '2026-10-05',
          },
        ],
      },
      TODAY,
    );
    expect((await run([entry()], async () => NOW - HOUR, { exceptions: exc })).tooNew).toHaveLength(
      1,
    );
  });
});

describe('loadExceptions', () => {
  const ok = {
    ecosystem: 'npm',
    package: 'left-pad',
    version: '1.3.0',
    justification: 'security fix for CVE needed today, reviewed the diff',
    added: '2026-10-16',
    expires: '2026-10-20',
  };
  const bad = (over: Record<string, unknown>) => () =>
    loadExceptions({ allow: [{ ...ok, ...over }] }, TODAY);
  it('accepts a scoped entry and an empty list', () => {
    expect(bad({})).not.toThrow();
    expect(() => loadExceptions({ allow: [] }, TODAY)).not.toThrow();
  });
  it('rejects wildcards, ranges, a missing expiry, a long expiry, and unknown keys', () => {
    expect(bad({ package: '*' })).toThrow(/package/);
    expect(bad({ version: '^1.0.0' })).toThrow(/version/);
    expect(bad({ ecosystem: 'pypi' })).toThrow(/ecosystem/);
    expect(bad({ expires: undefined })).toThrow(/expires/);
    expect(bad({ added: '2026-10-01', expires: '2026-10-30' })).toThrow(/14/);
    expect(bad({ justification: 'ok' })).toThrow(/justification/);
    expect(bad({ extra: 1 })).toThrow(/unknown/);
  });
  it('rejects an added date in the future (it would push the expiry cap out with it)', () => {
    expect(bad({ added: '2026-10-25', expires: '2026-10-30' })).toThrow(/future/);
  });
  it('a source-spec exception may run longer than a freshness one, but not forever', () => {
    const spec = { version: 'github:o/r#abc', added: '2026-10-01' };
    expect(bad({ ...spec, expires: '2027-03-30' })).not.toThrow();
    expect(bad({ ...spec, expires: '2027-04-30' })).toThrow(/180/);
    expect(bad({ added: '2026-10-01', expires: '2026-10-30' })).toThrow(/14/);
  });
  it('rejects a range or wildcard even where a spec is allowed', () => {
    expect(bad({ version: '^1.0.0' })).toThrow(/version/);
    expect(bad({ version: 'github:o/*' })).toThrow(/version/);
  });
  it('the committed file parses', () => {
    const json = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/release-age-exceptions.json'), 'utf8'),
    );
    expect(() => loadExceptions(json, TODAY)).not.toThrow();
  });
});

describe('renderUnscannable', () => {
  it('is empty when everything resolves, and names each unresolved entry otherwise', () => {
    expect(renderUnscannable([entry()])).toBe('');
    const text = renderUnscannable([
      entry(),
      entry({ name: 'g', version: 'github:o/r#abc', unresolved: 'not a registry version' }),
    ]);
    expect(text).toMatch(/Not covered by version-matched scanning/);
    expect(text).toContain('g@github:o/r#abc');
    expect(text).not.toContain('left-pad');
  });
});

describe('the committed tree resolves everything to the public registry', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  it('no tracked lockfile carries an entry pinned to a non-default registry', () => {
    const offenders: string[] = [];
    for (const f of tracked.filter((p) => /(^|\/)(bun\.lock|package-lock\.json)$/.test(p))) {
      for (const e of parseLockfile(f, readFileSync(resolve(REPO_ROOT, f), 'utf8'))) {
        if (e.unresolved && /registry/.test(e.unresolved)) offenders.push(`${f}: ${e.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no .npmrc or bunfig points an install at another registry or scope', () => {
    const offenders: string[] = [];
    for (const f of tracked.filter((p) => /(^|\/)(\.npmrc|bunfig\.toml)$/.test(p))) {
      const lines = readFileSync(resolve(REPO_ROOT, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith(';'));
      for (const l of lines) {
        if (/^\s*@[^:]+:registry\s*=/.test(l)) offenders.push(`${f}: ${l.trim()}`);
        if (/^\s*registry\s*=/.test(l) && !/registry\.npmjs\.org/.test(l)) {
          offenders.push(`${f}: ${l.trim()}`);
        }
        if (/^\s*\[install\.scopes\]/.test(l) || /^\s*\[install\.registry\]/.test(l)) {
          offenders.push(`${f}: ${l.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no tracked lockfile carries a URL/tarball dependency without an integrity hash', () => {
    const offenders: string[] = [];
    for (const f of tracked.filter((p) => /(^|\/)(bun\.lock|package-lock\.json)$/.test(p))) {
      for (const e of parseLockfile(f, readFileSync(resolve(REPO_ROOT, f), 'utf8'))) {
        if (isHashlessUrlSource(e)) offenders.push(`${f}: ${e.name}@${e.version}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the hashless-URL rule flags a planted hashless tarball (non-vacuity of the rule)', () => {
    const planted = '{"packages":{"t":["t@https://example.com/t-1.0.0.tgz",{}]}}';
    const found = parseLockfile('bun.lock', planted, (t: string) => Bun.JSONC.parse(t) as any);
    expect(found.filter((e: any) => isHashlessUrlSource(e))).toHaveLength(1);
  });

  it('the scan sees the tree (non-vacuity)', () => {
    expect(tracked.filter((p) => /(^|\/)bun\.lock$/.test(p)).length).toBeGreaterThan(3);
  });
});

describe('.github/workflows/release-age.yml', () => {
  const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/release-age.yml'), 'utf8');
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const doc = parse(text) as { on: Record<string, unknown>; permissions: unknown };
  it('runs on every pull request and on pushes to the long-lived lines', () => {
    expect(Object.keys(doc.on)).toContain('pull_request');
    expect(Object.keys(doc.on)).toContain('push');
  });
  it('is read-only', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
  });
  it('runs the gate from a full-depth checkout and cannot be softened', () => {
    expect(code).toContain('node scripts/release-age-gate.mjs');
    expect(code).toMatch(/fetch-depth:\s*0/);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });
});
