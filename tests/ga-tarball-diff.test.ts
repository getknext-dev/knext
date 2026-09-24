import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertEntrySafe,
  compareTarEntries,
  countVersionOccurrences,
  diffFileBytes,
  diffPackageJson,
  substituteVersion,
  validateVersionPair,
} from '../scripts/lib/ga-tarball-diff.mjs';
import { readTarEntries } from '../scripts/lib/tar-inventory.mjs';

/**
 * `scripts/ga-tarball-diff.mjs` (#1306) — the GA-vs-rc tarball diff check.
 *
 * This round fixes six review-reproduced bypasses (jev scores in the review):
 *
 *   1. (0.87) The old CLI extracted to disk and `readdirSync`-walked the
 *      result, which cannot see a symlink, a file's mode, or an entry OUTSIDE
 *      the extracted `package/` root. `scripts/lib/tar-inventory.mjs` reads
 *      the tar stream directly instead; `compareTarEntries` diffs type, mode,
 *      and symlink/hardlink target for EVERY entry, and `assertEntrySafe`
 *      rejects an unsafe entry outright (see the `compareTarEntries` and
 *      `assertEntrySafe` describe blocks, plus the CLI attack-replay test).
 *   2. (0.87) A `@getknext/*` sibling dependency range used to be skipped on
 *      ANY change. It must now equal the rc range with the version
 *      substituted — nothing else (`diffDependencyField` tests).
 *   3. The `siblingNames.has(name)` gate on that leniency was decorative
 *      (removing it kept every existing test green). A dedicated test below
 *      constructs a `@getknext/*`-named dependency NOT in `siblingNames`
 *      whose range differs by exactly the substitution pattern — it must
 *      still fail, which only holds if that membership check is load-bearing.
 *   4. (0.67) The naive `split(rcVersion).join(gaVersion)` matched
 *      `1.0.0-rc.1` as a substring of `1.0.0-rc.10`. `countVersionOccurrences`/
 *      `substituteVersion` are boundary-aware (no adjacent `[0-9A-Za-z.-]` on
 *      either side).
 *   5. (0.45) `package.json` comparison used to ignore key order. Order now
 *      matters everywhere except the `version` value and a sibling range's
 *      value (`diffPackageJson` key-order tests, including `exports`).
 *   6. Version well-formedness + lockstep (`validateVersionPair` tests, plus
 *      a CLI-level lockstep-mismatch test) and a `--rc-ref/--ga-ref` smoke
 *      test that exercises the real `git worktree add`/`remove` lifecycle
 *      without a full `bun install`+build (too slow for a unit suite — see
 *      that test's own comment for why this is the honest scope).
 */

const registry: string[] = [];
function mkFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of registry.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

/** tar (via the real `tar -czf`, gzip-compress whatever is staged) every top-level entry of `stageRoot`. */
function packStage(stageRoot: string, outDir: string, filename: string): string {
  const tgzPath = join(outDir, filename);
  const topEntries = readdirSync(stageRoot);
  execFileSync('tar', ['-czf', tgzPath, '-C', stageRoot, ...topEntries], { env: TAR_ENV });
  return tgzPath;
}

/** Build a well-formed `package/`-rooted fixture tarball. */
function buildFixtureTarball(dir: string, name: string, files: Record<string, string>): string {
  const stageRoot = mkFixtureDir('ga-diff-stage-');
  const pkgRoot = join(stageRoot, 'package');
  mkdirSync(pkgRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(pkgRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return packStage(stageRoot, dir, `${name.replace('/', '-')}.tgz`);
}

function runCli(args: string[]): { code: number; output: string } {
  const scriptPath = join(import.meta.dir, '..', 'scripts', 'ga-tarball-diff.mjs');
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout}\n${result.stderr}` };
}

// --- validateVersionPair (review item 6) ------------------------------------

describe('validateVersionPair', () => {
  it('accepts a well-formed rc->GA pair', () => {
    expect(validateVersionPair('1.0.0-rc.3', '1.0.0')).toBeNull();
  });

  it('rejects a malformed rc version (no -rc.N suffix)', () => {
    expect(validateVersionPair('1.0.0', '1.0.0')).toContain('not well-formed');
  });

  it('rejects a malformed GA version', () => {
    expect(validateVersionPair('1.0.0-rc.3', '1.0.0-beta')).toContain('not well-formed');
  });

  it('rejects a GA version that does not match the rc version base', () => {
    expect(validateVersionPair('1.0.0-rc.3', '1.0.1')).toContain('does not match');
  });
});

// --- boundary-aware version substitution (review item 4) -------------------

describe('countVersionOccurrences / substituteVersion (boundary-aware)', () => {
  it('does not count a version as occurring inside a longer version-like string', () => {
    expect(countVersionOccurrences('1.0.0-rc.10', '1.0.0-rc.1')).toBe(0);
  });

  it('counts an exact, boundary-delimited occurrence', () => {
    expect(countVersionOccurrences('see 1.0.0-rc.1 here', '1.0.0-rc.1')).toBe(1);
  });

  it('counts multiple boundary-delimited occurrences', () => {
    expect(countVersionOccurrences('1.0.0-rc.1 and again 1.0.0-rc.1', '1.0.0-rc.1')).toBe(2);
  });

  it('substitutes every occurrence but leaves a longer look-alike untouched', () => {
    const text = '1.0.0-rc.1 built; see also 1.0.0-rc.10';
    expect(substituteVersion(text, '1.0.0-rc.1', '1.0.0')).toBe(
      '1.0.0 built; see also 1.0.0-rc.10',
    );
  });
});

describe('diffFileBytes (boundary-aware, review item 4)', () => {
  it('is clean on byte-identical files', () => {
    const buf = Buffer.from('hello world');
    expect(diffFileBytes(buf, buf, '1.0.0-rc.3', '1.0.0')).toEqual({ ok: true, embedded: false });
  });

  it('accepts a multi-site rc->GA version substitution (review item 6 header claim)', () => {
    const rc = Buffer.from('built 1.0.0-rc.3; also built 1.0.0-rc.3\nconsole.log("hi");\n');
    const ga = Buffer.from('built 1.0.0; also built 1.0.0\nconsole.log("hi");\n');
    expect(diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0')).toEqual({ ok: true, embedded: true });
  });

  it('rejects content that differs beyond the version substitution', () => {
    const rc = Buffer.from('// built by knext 1.0.0-rc.3\nconsole.log("hi");\n');
    const ga = Buffer.from('// built by knext 1.0.0\nconsole.log("bye");\n');
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
  });

  it('rejects a partial substitution (some sites left un-substituted)', () => {
    const rc = Buffer.from('v1.0.0-rc.3 and again v1.0.0-rc.3');
    const ga = Buffer.from('v1.0.0 and again v1.0.0-rc.3');
    expect(diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0').ok).toBe(false);
  });

  it('rejects binary content that differs', () => {
    const rc = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const ga = Buffer.from([0x00, 0x01, 0xff, 0xfd]);
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('binary');
  });

  it('BUG (fixed): a shorter rc version must not match as a prefix of a longer look-alike version', () => {
    // Naive `split('1.0.0-rc.1').join('1.0.0')` on "1.0.0-rc.10" produces
    // "1.0.00" — a corrupted string nobody's real build emits — and the old
    // code would have accepted it as a "clean substitution" if the GA side
    // happened to contain exactly that. Boundary-aware matching must instead
    // refuse to touch "1.0.0-rc.10" at all (it is a DIFFERENT version
    // string), so this must fail closed.
    const rc = Buffer.from('1.0.0-rc.10');
    const ga = Buffer.from('1.0.00');
    expect(diffFileBytes(rc, ga, '1.0.0-rc.1', '1.0.0').ok).toBe(false);
  });
});

// --- diffPackageJson / diffDependencyField (review items 2, 3, 5) ----------

describe('diffPackageJson', () => {
  const ctx = {
    rcVersion: '1.0.0-rc.3',
    gaVersion: '1.0.0',
    siblingNames: new Set(['@getknext/core', '@getknext/lib', '@getknext/db']),
  };

  it('allows only the version field to change', () => {
    const rc = { name: '@getknext/core', version: '1.0.0-rc.3', license: 'Apache-2.0' };
    const ga = { name: '@getknext/core', version: '1.0.0', license: 'Apache-2.0' };
    expect(diffPackageJson(rc, ga, ctx)).toEqual([]);
  });

  it('fails when a non-version field drifts', () => {
    const rc = { name: '@getknext/core', version: '1.0.0-rc.3', license: 'Apache-2.0' };
    const ga = { name: '@getknext/core', version: '1.0.0', license: 'MIT' };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('license');
  });

  it('fails when the version does not match the expected rc/GA pair', () => {
    const rc = { name: 'x', version: '1.0.0-rc.2', dependencies: {} };
    const ga = { name: 'x', version: '1.0.0', dependencies: {} };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('version');
  });

  it('fails on an extra or missing key', () => {
    const rc = { name: 'x', version: '1.0.0-rc.3' };
    const ga = { name: 'x', version: '1.0.0', extra: true };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('extra');
  });

  // --- item 5: order-sensitivity ---

  it('flags reordered top-level keys even when the key set is identical', () => {
    const rc = { name: 'x', version: '1.0.0-rc.3', license: 'Apache-2.0' };
    const ga = { version: '1.0.0', name: 'x', license: 'Apache-2.0' };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.some((v) => v.includes('key order differs'))).toBe(true);
  });

  it('flags reordered conditional exports (resolution order is behaviourally significant)', () => {
    const rc = {
      name: 'x',
      version: '1.0.0-rc.3',
      exports: { '.': { import: './a.mjs', require: './a.cjs' } },
    };
    const ga = {
      name: 'x',
      version: '1.0.0',
      exports: { '.': { require: './a.cjs', import: './a.mjs' } },
    };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.some((v) => v.includes('exports'))).toBe(true);
  });

  it('is clean when exports key order matches exactly', () => {
    const rc = {
      name: 'x',
      version: '1.0.0-rc.3',
      exports: { '.': { import: './a.mjs', require: './a.cjs' } },
    };
    const ga = {
      name: 'x',
      version: '1.0.0',
      exports: { '.': { import: './a.mjs', require: './a.cjs' } },
    };
    expect(diffPackageJson(rc, ga, ctx)).toEqual([]);
  });

  it('flags reordered dependency keys even when every range is otherwise fine', () => {
    const rc = { name: 'x', version: '1.0.0-rc.3', dependencies: { a: '1.0.0', b: '2.0.0' } };
    const ga = { name: 'x', version: '1.0.0', dependencies: { b: '2.0.0', a: '1.0.0' } };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.some((v) => v.includes('"dependencies"') && v.includes('key order'))).toBe(
      true,
    );
  });

  // --- item 2: sibling range must equal rc-range-with-substitution, not "any change" ---

  it('allows a @getknext/* sibling dependency range that is exactly the rc range with the version substituted', () => {
    const rc = {
      name: '@getknext/core',
      version: '1.0.0-rc.3',
      dependencies: { '@getknext/lib': '^1.0.0-rc.3' },
    };
    const ga = {
      name: '@getknext/core',
      version: '1.0.0',
      dependencies: { '@getknext/lib': '^1.0.0' },
    };
    expect(diffPackageJson(rc, ga, ctx)).toEqual([]);
  });

  it('fails a sibling range pointing at a git URL instead of the substituted version', () => {
    const rc = {
      name: '@getknext/core',
      version: '1.0.0-rc.3',
      dependencies: { '@getknext/lib': '^1.0.0-rc.3' },
    };
    const ga = {
      name: '@getknext/core',
      version: '1.0.0',
      dependencies: { '@getknext/lib': 'git+https://github.com/example/lib.git' },
    };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('@getknext/lib');
  });

  it('fails a sibling range pointing at an unrelated (non-substituted) version', () => {
    const rc = {
      name: '@getknext/core',
      version: '1.0.0-rc.3',
      dependencies: { '@getknext/lib': '^1.0.0-rc.3' },
    };
    const ga = {
      name: '@getknext/core',
      version: '1.0.0',
      dependencies: { '@getknext/lib': '^2.0.0' },
    };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
  });

  it('fails when a non-sibling dependency range drifts', () => {
    const rc = { name: 'x', version: '1.0.0-rc.3', dependencies: { pino: '^9.6.0' } };
    const ga = { name: 'x', version: '1.0.0', dependencies: { pino: '^9.7.0' } };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('pino');
  });

  // --- item 3: siblingNames.has(name) must be load-bearing, not decorative ---

  it('does NOT extend sibling leniency to a @getknext/*-named dependency outside the compared set', () => {
    // A dependency whose name starts with "@getknext/" but is NOT one of the
    // packages this run is actually comparing. Its range differs by exactly
    // the rc->GA substitution pattern — if `ctx.siblingNames.has(name)` were
    // dropped from the leniency gate (leaving only the `startsWith` check),
    // this would wrongly pass. It must fail.
    const scopedCtx = { ...ctx, siblingNames: new Set(['@getknext/core']) };
    const rc = {
      name: '@getknext/core',
      version: '1.0.0-rc.3',
      dependencies: { '@getknext/not-in-set': '^1.0.0-rc.3' },
    };
    const ga = {
      name: '@getknext/core',
      version: '1.0.0',
      dependencies: { '@getknext/not-in-set': '^1.0.0' },
    };
    const violations = diffPackageJson(rc, ga, scopedCtx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('@getknext/not-in-set');
  });
});

// --- assertEntrySafe / compareTarEntries (review item 1) -------------------

function mkEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'package/index.js',
    type: 'file',
    mode: 0o644,
    linkname: null,
    data: Buffer.from('x'),
    ...overrides,
  };
}

describe('assertEntrySafe', () => {
  it('accepts an entry safely rooted at package/', () => {
    expect(() => assertEntrySafe(mkEntry())).not.toThrow();
  });

  it('accepts the bare "package" root entry', () => {
    expect(() =>
      assertEntrySafe(mkEntry({ name: 'package', type: 'directory', data: null })),
    ).not.toThrow();
  });

  it('rejects an entry outside package/', () => {
    expect(() => assertEntrySafe(mkEntry({ name: 'evil/dist/index.js' }))).toThrow(/outside/);
  });

  it('rejects an absolute-path entry', () => {
    expect(() => assertEntrySafe(mkEntry({ name: '/etc/passwd' }))).toThrow(/absolute/);
  });

  it('rejects a path-traversal entry', () => {
    expect(() => assertEntrySafe(mkEntry({ name: 'package/../../etc/passwd' }))).toThrow(
      /traversal/,
    );
  });

  it('rejects a symlink whose target is an absolute path', () => {
    expect(() =>
      assertEntrySafe(
        mkEntry({ name: 'package/link', type: 'symlink', linkname: '/etc/passwd', data: null }),
      ),
    ).toThrow(/absolute/);
  });

  it('rejects a symlink target that escapes via ..', () => {
    expect(() =>
      assertEntrySafe(
        mkEntry({
          name: 'package/dist/link',
          type: 'symlink',
          linkname: '../../etc/passwd',
          data: null,
        }),
      ),
    ).toThrow(/escapes/);
  });

  it('accepts a symlink target that stays inside package/', () => {
    expect(() =>
      assertEntrySafe(
        mkEntry({ name: 'package/dist/link', type: 'symlink', linkname: 'index.js', data: null }),
      ),
    ).not.toThrow();
  });
});

describe('compareTarEntries', () => {
  const ctx = {
    rcVersion: '1.0.0-rc.3',
    gaVersion: '1.0.0',
    siblingNames: new Set(['@getknext/core']),
  };

  const pkgJson = (version: string) =>
    Buffer.from(JSON.stringify({ name: '@getknext/core', version }));

  it('is clean for identical entries plus a version-only package.json', () => {
    const rc = [
      mkEntry({ name: 'package', type: 'directory', mode: 0o755, data: null }),
      mkEntry({ name: 'package/package.json', data: pkgJson('1.0.0-rc.3') }),
      mkEntry({ name: 'package/index.js', data: Buffer.from('x') }),
    ];
    const ga = [
      mkEntry({ name: 'package', type: 'directory', mode: 0o755, data: null }),
      mkEntry({ name: 'package/package.json', data: pkgJson('1.0.0') }),
      mkEntry({ name: 'package/index.js', data: Buffer.from('x') }),
    ];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(true);
  });

  it('flags a mode change on an otherwise-identical file (644 -> 755)', () => {
    const rc = [mkEntry({ name: 'package/index.js', mode: 0o644, data: Buffer.from('x') })];
    const ga = [mkEntry({ name: 'package/index.js', mode: 0o755, data: Buffer.from('x') })];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('mode differs'))).toBe(true);
  });

  it('flags a type change (file -> symlink)', () => {
    const rc = [mkEntry({ name: 'package/x', type: 'file', data: Buffer.from('x') })];
    const ga = [mkEntry({ name: 'package/x', type: 'symlink', linkname: 'y', data: null })];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('type differs'))).toBe(true);
  });

  it('flags a symlink target change', () => {
    const rc = [mkEntry({ name: 'package/link', type: 'symlink', linkname: 'a.js', data: null })];
    const ga = [mkEntry({ name: 'package/link', type: 'symlink', linkname: 'b.js', data: null })];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('symlink target differs'))).toBe(true);
  });

  it('flags a hardlink target change', () => {
    const rc = [
      mkEntry({ name: 'package/h', type: 'hardlink', linkname: 'package/a', data: null }),
    ];
    const ga = [
      mkEntry({ name: 'package/h', type: 'hardlink', linkname: 'package/b', data: null }),
    ];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('hardlink target differs'))).toBe(true);
  });

  it('fails closed on a missing entry', () => {
    const rc = [mkEntry({ name: 'package/a.js' }), mkEntry({ name: 'package/b.js' })];
    const ga = [mkEntry({ name: 'package/a.js' })];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('package/b.js'))).toBe(true);
  });

  it('rejects (throws) rather than diffs an entry outside package/, even if both sides have it', () => {
    const rc = [mkEntry({ name: 'evil/x' })];
    const ga = [mkEntry({ name: 'evil/x' })];
    expect(() => compareTarEntries(rc, ga, ctx)).toThrow(/outside/);
  });

  it('reports the embedded-version site it normalised', () => {
    const rc = [
      mkEntry({ name: 'package/dist/banner.js', data: Buffer.from('// built 1.0.0-rc.3\nx();\n') }),
    ];
    const ga = [
      mkEntry({ name: 'package/dist/banner.js', data: Buffer.from('// built 1.0.0\nx();\n') }),
    ];
    const result = compareTarEntries(rc, ga, ctx);
    expect(result.ok).toBe(true);
    expect(result.embeddedVersionSites).toEqual(['package/dist/banner.js']);
  });
});

// --- tar-inventory: reads real tarballs correctly ---------------------------

describe('readTarEntries (real tar fixtures)', () => {
  it('records type, mode, and symlink target from a real tarball', () => {
    const dir = mkFixtureDir('ga-diff-tarinv-');
    const pkgRoot = join(dir, 'package');
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, 'a.txt'), 'hi');
    chmodSync(join(pkgRoot, 'a.txt'), 0o644);
    symlinkSync('/etc/passwd', join(pkgRoot, 'evil-link'));
    const tgz = packStage(dir, dir, 'x.tgz');

    const entries = readTarEntries(readFileSync(tgz));
    const file = entries.find((e) => e.name === 'package/a.txt');
    const link = entries.find((e) => e.name === 'package/evil-link');
    expect(file?.type).toBe('file');
    expect(file?.mode & 0o777).toBe(0o644);
    expect(link?.type).toBe('symlink');
    expect(link?.linkname).toBe('/etc/passwd');
  });

  it('records an entry rooted outside package/', () => {
    const dir = mkFixtureDir('ga-diff-tarinv-evil-');
    mkdirSync(join(dir, 'evil', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'evil', 'dist', 'index.js'), 'evil();');
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package', 'index.js'), 'ok();');
    const tgz = packStage(dir, dir, 'x.tgz');

    const entries = readTarEntries(readFileSync(tgz));
    expect(entries.some((e) => e.name === 'evil/dist/index.js')).toBe(true);
  });
});

// --- CLI end-to-end -----------------------------------------------------

function buildCleanTrio(dir: string, version: string) {
  for (const name of ['@getknext/lib', '@getknext/db', '@getknext/core'] as const) {
    buildFixtureTarball(dir, name, {
      'package.json': JSON.stringify({ name, version }),
      'index.js': 'module.exports = {};\n',
    });
  }
}

describe('ga-tarball-diff CLI (fixture tarballs)', () => {
  it('exits 0 when the only deltas across the published set are version fields', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-');
    buildCleanTrio(rcDir, '1.0.0-rc.3');
    buildCleanTrio(gaDir, '1.0.0');

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(0);
    expect(output).toContain('PASS');
  });

  it('exits 1 and prints a precise diff when a GA tarball carries an unexplained delta', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-bad-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-bad-');
    buildCleanTrio(rcDir, '1.0.0-rc.3');
    buildFixtureTarball(gaDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0' }),
      'index.js': 'module.exports = { changed: true };\n',
    });
    for (const name of ['@getknext/db', '@getknext/core'] as const) {
      buildFixtureTarball(gaDir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0' }),
        'index.js': 'module.exports = {};\n',
      });
    }

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('index.js');
  });

  it('fails closed when a published package is missing from one side', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-missing-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-missing-');
    buildCleanTrio(rcDir, '1.0.0-rc.3');
    for (const name of ['@getknext/lib', '@getknext/core'] as const) {
      buildFixtureTarball(gaDir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0' }),
      });
    }

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(1);
    expect(output).toContain('@getknext/db');
  });

  it('requires exactly one of --rc-dir/--ga-dir or --rc-ref/--ga-ref', () => {
    const { code, output } = runCli(['--rc-dir', '/tmp/does-not-matter']);
    expect(code).toBe(1);
    expect(output).toContain('ERROR');
  });

  it('fails closed on a non-lockstep version pair across packages', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-lockstep-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-lockstep-');
    buildFixtureTarball(rcDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0-rc.3' }),
    });
    buildFixtureTarball(gaDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0' }),
    });
    buildFixtureTarball(rcDir, '@getknext/db', {
      'package.json': JSON.stringify({ name: '@getknext/db', version: '1.0.0-rc.4' }),
    });
    buildFixtureTarball(gaDir, '@getknext/db', {
      'package.json': JSON.stringify({ name: '@getknext/db', version: '1.0.0' }),
    });
    buildFixtureTarball(rcDir, '@getknext/core', {
      'package.json': JSON.stringify({ name: '@getknext/core', version: '1.0.0-rc.3' }),
    });
    buildFixtureTarball(gaDir, '@getknext/core', {
      'package.json': JSON.stringify({ name: '@getknext/core', version: '1.0.0' }),
    });

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(1);
    expect(output).toContain('lockstep');
  });

  it('fails closed on a malformed rc version', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-malformed-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-malformed-');
    buildCleanTrio(rcDir, '1.0.0-rc.3');
    buildCleanTrio(gaDir, '1.0.0');
    // Overwrite core's rc tarball with a non-"-rc.N" version.
    rmSync(join(rcDir, '@getknext-core.tgz'), { force: true });
    buildFixtureTarball(rcDir, '@getknext/core', {
      'package.json': JSON.stringify({ name: '@getknext/core', version: '1.0.0' }),
    });

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(1);
    expect(output).toContain('not well-formed');
  });

  it('replays the reviewer-class attack: top-level evil/ entry + /etc/passwd symlink + mode change, all in one GA tarball', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-attack-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-attack-');
    buildFixtureTarball(rcDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0-rc.3' }),
    });
    buildFixtureTarball(gaDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0' }),
    });
    buildFixtureTarball(rcDir, '@getknext/db', {
      'package.json': JSON.stringify({ name: '@getknext/db', version: '1.0.0-rc.3' }),
    });
    buildFixtureTarball(gaDir, '@getknext/db', {
      'package.json': JSON.stringify({ name: '@getknext/db', version: '1.0.0' }),
    });

    // rc core: clean.
    const rcStage = mkFixtureDir('ga-diff-attack-rc-stage-');
    mkdirSync(join(rcStage, 'package', 'dist'), { recursive: true });
    writeFileSync(
      join(rcStage, 'package', 'package.json'),
      JSON.stringify({ name: '@getknext/core', version: '1.0.0-rc.3' }),
    );
    writeFileSync(join(rcStage, 'package', 'dist', 'index.js'), 'module.exports = {};\n');
    chmodSync(join(rcStage, 'package', 'dist', 'index.js'), 0o644);
    packStage(rcStage, rcDir, 'core.tgz');

    // ga core: same base, PLUS a top-level evil/ entry, a symlink to
    // /etc/passwd, and index.js's mode flipped 644 -> 755. Built fresh here,
    // not reused from any external fixture.
    const gaStage = mkFixtureDir('ga-diff-attack-ga-stage-');
    mkdirSync(join(gaStage, 'package', 'dist'), { recursive: true });
    writeFileSync(
      join(gaStage, 'package', 'package.json'),
      JSON.stringify({ name: '@getknext/core', version: '1.0.0' }),
    );
    writeFileSync(join(gaStage, 'package', 'dist', 'index.js'), 'module.exports = {};\n');
    chmodSync(join(gaStage, 'package', 'dist', 'index.js'), 0o755);
    symlinkSync('/etc/passwd', join(gaStage, 'package', 'dist', 'link.js'));
    mkdirSync(join(gaStage, 'evil', 'dist'), { recursive: true });
    writeFileSync(join(gaStage, 'evil', 'dist', 'index.js'), 'evil();\n');
    packStage(gaStage, gaDir, 'core.tgz');

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(1);
    expect(output).toContain('FAIL');
  });
});

// --- --rc-ref/--ga-ref smoke test -------------------------------------------

describe('ga-tarball-diff CLI (--rc-ref/--ga-ref)', () => {
  // A full ref-mode run needs `bun install --frozen-lockfile` + a real build
  // for lib/db/core, which is too slow for a unit suite (minutes, and shells
  // out to bun). What's tractable — and what review item 6 asks for at
  // minimum — is proving the real `git worktree add`/`remove` lifecycle
  // works and leaves nothing behind, using an ORPHAN commit (via
  // `git commit-tree` against the empty tree, never touching any branch or
  // the working tree) that has no packages/ directories at all: `packRef`
  // then skips straight to "no such package dir" for every package and
  // `run()` reports them all missing — a real git worktree add/remove, exit
  // 1, no leaked worktree — without a bun build in the loop.
  it('packs an empty-tree ref via a real git worktree, cleans it up, and reports every package missing', () => {
    const repoRoot = resolve(import.meta.dir, '..');
    const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // the well-known empty-tree hash
    const commitSha = execFileSync(
      'git',
      ['commit-tree', emptyTreeSha, '-m', 'ga-tarball-diff test fixture: empty tree'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();

    const before = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const { code, output } = runCli(['--rc-ref', commitSha, '--ga-ref', commitSha]);

    const after = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(code).toBe(1);
    expect(output).toContain('missing from rc set');
    expect(output).toContain('missing from GA set');
    expect(after).toBe(before); // no leaked worktree
  });

  it('requires exactly one of --rc-dir/--ga-dir or --rc-ref/--ga-ref (ref-mode arg parsing)', () => {
    const { code, output } = runCli(['--rc-ref', 'HEAD']);
    expect(code).toBe(1);
    expect(output).toContain('ERROR');
  });
});
