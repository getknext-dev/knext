import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertEntrySafe,
  compareTarEntries,
  countVersionOccurrences,
  diffFileBytes,
  diffPackageJson,
  substituteVersion,
  validateVersionPair,
} from '../scripts/lib/ga-tarball-diff.mjs';
import { readTarEntries } from '../scripts/lib/tar-entries.mjs';

/**
 * `scripts/ga-tarball-diff.mjs` (#1306) — the GA-vs-rc tarball diff check.
 *
 * ROUND 1 fixed six review-reproduced bypasses (jev scores in the review):
 *
 *   1. (0.87) The old CLI extracted to disk and `readdirSync`-walked the
 *      result, which cannot see a symlink, a file's mode, or an entry OUTSIDE
 *      the extracted `package/` root. `compareTarEntries` diffs type, mode,
 *      and symlink/hardlink target for EVERY entry, and `assertEntrySafe`
 *      rejects an unsafe entry outright.
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
 *      a CLI-level lockstep-mismatch test).
 *
 * ROUND 2 found the round-1 hand-written tar reader (`tar-inventory.mjs`)
 * itself PARSER-DIFFERENTIAL from `node-tar` — the library `npm`/`pacote`
 * actually extract with. Rather than patch the hand parser (the exact
 * successive-round regression class three earlier rounds already lived
 * through), it is DELETED; `scripts/lib/tar-entries.mjs` now reads every
 * entry with `node-tar` itself, in list-only mode (never touching disk).
 * The "adversarial fixtures" describe block below builds each attack raw,
 * byte-for-byte (mirroring the review's own crafted-tarball approach — this
 * is the one place that is correct, not `tar -czf` over a staged directory,
 * because a legitimate tar tool cannot produce these malformed headers):
 *
 *   1. (0.87) a bad-checksum entry immediately followed by a checksum-VALID
 *      duplicate of the same path used to be resolved by "last entry wins"
 *      (`new Map(entries.map(e => [e.name, e]))`), silently hiding whichever
 *      copy came first. `readTarEntries` now REJECTS any second occurrence
 *      of a path outright — proven against both a legitimately-checksummed
 *      duplicate (node-tar itself raises nothing for that case) and the
 *      bad-checksum-duplicate shape review round 2's attack A used.
 *   2. (0.86) an empty-`name` ustar header carrying its real path only in
 *      `prefix`, retargeted via `type=2`/`linkpath` into a symlink — the old
 *      hand parser's `if (rawName === '') continue` skipped it entirely
 *      (silent, not even a diff). `node-tar` does not special-case this away
 *      either (see `tar-entries.mjs`'s header comment); `assertEntrySafe`
 *      catches it because the resulting path/linkpath fail the same
 *      outside-`package/`/absolute-target checks every other entry does.
 *   3. the PAX `path`/`linkpath` OVERRIDE mechanism itself (not just the
 *      empty-name/prefix shape) was never exercised by round 1's tests —
 *      deleting the old parser's pax-record handling would have stayed
 *      green. Dedicated tests below build a real PAX extended header
 *      (self-referential-length record, exactly as the tar format requires)
 *      that retargets a `path` and, separately, a `linkpath`, outside
 *      `package/`.
 *   4. the `--rc-ref/--ga-ref` "smoke test" from round 1 never actually
 *      packed anything (the orphan-commit fixture has no `packages/`
 *      directories, so `packRef` skips straight past the `bun pm pack`
 *      call) — its title claimed more than the test did. Renamed to name
 *      what it verifies: the `git worktree add`/`remove` lifecycle.
 *
 * A truncation/NaN-size case is also covered (`size-field truncation`
 * describe block) — see that block's comment for why it is a
 * "must never silently pass", not a "must be fixed", case: `node-tar`'s own
 * header parser silently normalises an unparseable `size` field to `0`
 * under some conditions, so OUR view is, by construction, identical to what
 * a real `npm install` would produce; under others (observed directly, not
 * assumed — this repo's runtime for the CLI is Node, but the test suite
 * itself runs on Bun) the very same malformed header makes node-tar throw
 * instead. Both outcomes fail closed; the test accepts either.
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

    const entries = readTarEntries(tgz);
    const file = entries.find((e) => e.name === 'package/a.txt');
    const link = entries.find((e) => e.name === 'package/evil-link');
    expect(file?.type).toBe('file');
    expect((file?.mode ?? 0) & 0o777).toBe(0o644);
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

    const entries = readTarEntries(tgz);
    expect(entries.some((e) => e.name === 'evil/dist/index.js')).toBe(true);
  });
});

// --- adversarial fixtures: parser-differential attacks (review round 2) ----
//
// Built RAW, byte-for-byte — a legitimate `tar` tool cannot produce a
// bad-checksum header, an empty-name-with-prefix header, or a hand-crafted
// PAX record, so these cannot be built with `tar -czf` the way the rest of
// this file's fixtures are. This mirrors the review's own crafted-tarball
// approach precisely because that is the only way to reach these code paths.

/** A raw 512-byte ustar header + its (zero-padded) data, matching the wire format exactly. */
function rawTarHeader(
  name: string,
  data: Buffer,
  opts: {
    type?: string;
    badCksum?: boolean;
    prefix?: string;
    mode?: number;
    link?: string;
    sizeBytes?: Buffer;
  } = {},
): Buffer {
  const { type = '0', badCksum = false, prefix = '', mode = 0o644, link = '', sizeBytes } = opts;
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (sizeBytes) sizeBytes.copy(h, 124);
  else h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  if (badCksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(pad);
  return Buffer.concat([h, pad]);
}

/** A self-referential-length PAX record ("<len> key=value\n"), per the tar spec. */
function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let n = suffix.length + 1;
  while (`${n}${suffix}`.length !== n) n += 1;
  return `${n}${suffix}`;
}

/** A PAX extended-header entry (typeflag 'x') that overrides fields on the NEXT header. */
function rawPaxHeader(records: Record<string, string>): Buffer {
  const body = Object.entries(records)
    .map(([k, v]) => paxRecord(k, v))
    .join('');
  return rawTarHeader('PaxHeader/entry', Buffer.from(body, 'utf8'), { type: 'x' });
}

function writeRawTarGz(dir: string, filename: string, parts: Buffer[]): string {
  const tgzPath = join(dir, filename);
  writeFileSync(tgzPath, gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
  return tgzPath;
}

describe('readTarEntries: adversarial fixtures (review round 2)', () => {
  it('rejects a legitimately-checksummed DUPLICATE path rather than silently keeping the last one', () => {
    const dir = mkFixtureDir('ga-diff-dup-valid-');
    const evil = Buffer.from('steal()\n');
    const clean = Buffer.from('safe()\n');
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawTarHeader('package/dist/index.js', evil),
      rawTarHeader('package/dist/index.js', clean),
    ]);
    expect(() => readTarEntries(tgz)).toThrow(/duplicate/);
  });

  it('rejects (review attack A shape) a bad-checksum entry followed by a checksum-valid duplicate', () => {
    const dir = mkFixtureDir('ga-diff-dup-badcksum-');
    const evil = Buffer.from('steal()\n');
    const clean = Buffer.from('safe()\n');
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawTarHeader('package/dist/index.js', evil),
      rawTarHeader('package/dist/index.js', clean, { badCksum: true }),
    ]);
    // Fails closed either way: node-tar's own `strict` throws on the bad
    // checksum before our duplicate check even runs. The assertion is on
    // the OUTCOME (throws), not on which of the two guards catches it.
    expect(() => readTarEntries(tgz)).toThrow();
  });

  it('rejects (review attack B shape) an empty-name header with a ustar prefix retargeted to a symlink', () => {
    const dir = mkFixtureDir('ga-diff-empty-name-prefix-');
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawTarHeader('package/dist/index.js', Buffer.from('safe()\n')),
      // name='' + prefix='package/dist/index.js' + type=symlink + link=/etc/passwd
      rawTarHeader('', Buffer.alloc(0), {
        prefix: 'package/dist/index.js',
        type: '2',
        link: '/etc/passwd',
      }),
    ]);
    const entries = readTarEntries(tgz);
    // node-tar's list() does not itself reject this — assertEntrySafe must.
    const evil = entries.find((e) => e.type === 'symlink');
    expect(evil).toBeTruthy();
    expect(() => assertEntrySafe(evil as never)).toThrow(/absolute/);
  });

  it('rejects a PAX `path` override that escapes package/', () => {
    const dir = mkFixtureDir('ga-diff-pax-path-');
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawPaxHeader({ path: '../../etc/evil-payload' }),
      rawTarHeader('package/dist/index.js', Buffer.from('payload\n')),
    ]);
    const entries = readTarEntries(tgz);
    const overridden = entries.find((e) => e.name.includes('evil-payload'));
    expect(overridden?.name).toBe('../../etc/evil-payload');
    expect(() => assertEntrySafe(overridden as never)).toThrow(/traversal|outside/);
  });

  it('rejects a PAX `linkpath` override that escapes package/', () => {
    const dir = mkFixtureDir('ga-diff-pax-linkpath-');
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawPaxHeader({ linkpath: '../../etc/passwd' }),
      rawTarHeader('package/dist/link.js', Buffer.alloc(0), { type: '2', link: 'unused' }),
    ]);
    const entries = readTarEntries(tgz);
    const link = entries.find((e) => e.type === 'symlink');
    expect(link?.linkname).toBe('../../etc/passwd');
    expect(() => assertEntrySafe(link as never)).toThrow(/escapes/);
  });
});

// --- size-field truncation: must still fail closed, even though node-tar ---
// itself (not just our reader) normalises an unparseable size to 0 under
// plain Node — verified directly against `node -e` against the installed
// `node_modules/tar`. Under the Bun runtime these tests actually run on,
// the SAME malformed header instead makes node-tar throw
// (`TAR_ENTRY_INVALID: checksum failure`, from its own internal stream
// chunking) — an even stronger fail-closed outcome, observed directly rather
// than assumed. Both are acceptable and BOTH are asserted for: this is
// deliberately NOT a "readTarEntries must reject this" test, because
// `node_modules/tar/dist/commonjs/header.js`'s `nanUndef` silently turning a
// `size` field that fails `parseInt(..., 8)` into `undefined` (then `0` on
// `ReadEntry`) is not a differential — it is exactly what a real
// `npm install` would do with the same tarball, since it is the same
// library. What has to hold, on whichever runtime, is that the CONSEQUENCE
// — a file that should have had content silently becoming empty — never
// silently PASSES: either the read itself throws, or the empty result still
// surfaces as an ordinary content mismatch in the tree diff.
describe('size-field truncation (must fail closed at the diff level)', () => {
  it('a size field that decodes to NaN never silently passes: readTarEntries throws, or normalises to an empty (size 0) entry', () => {
    const dir = mkFixtureDir('ga-diff-size-nan-');
    const spaces = Buffer.alloc(12, 0x20); // an all-blank size field parses to NaN -> undefined -> 0
    const tgz = writeRawTarGz(dir, 'x.tgz', [
      rawTarHeader('package/dist/index.js', Buffer.from('export const x=1\n'), {
        sizeBytes: spaces,
      }),
    ]);
    try {
      const entries = readTarEntries(tgz);
      const entry = entries.find((e) => e.name === 'package/dist/index.js');
      expect(entry?.size).toBe(0);
      expect(entry?.data?.length).toBe(0);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('the truncated-to-empty GA copy never silently matches a non-empty rc copy: read throws, or the tree diff reports it', () => {
    const dir = mkFixtureDir('ga-diff-size-nan-diff-');
    const spaces = Buffer.alloc(12, 0x20);
    const rcTgz = writeRawTarGz(dir, 'rc.tgz', [
      rawTarHeader('package/dist/index.js', Buffer.from('export const x=1\n')),
    ]);
    const gaTgz = writeRawTarGz(dir, 'ga.tgz', [
      rawTarHeader('package/dist/index.js', Buffer.from('export const x=1\n'), {
        sizeBytes: spaces,
      }),
    ]);
    try {
      const rcEntries = readTarEntries(rcTgz);
      const gaEntries = readTarEntries(gaTgz);
      const ctx = { rcVersion: '1.0.0-rc.3', gaVersion: '1.0.0', siblingNames: new Set<string>() };
      const result = compareTarEntries(rcEntries, gaEntries, ctx);
      expect(result.ok).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
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

// --- --rc-ref/--ga-ref: git worktree lifecycle (NOT a packing smoke test) --

describe('ga-tarball-diff CLI (--rc-ref/--ga-ref)', () => {
  // A full ref-mode run needs `bun install --frozen-lockfile` + a real build
  // for lib/db/core, which is too slow for a unit suite (minutes, and shells
  // out to bun) — that path is NOT exercised here, and the earlier title on
  // this test ("packs an empty-tree ref…") overclaimed: the orphan-commit
  // fixture below has no `packages/` directories, so `packRef` skips
  // straight past every `bun pm pack` call — this test never packs anything.
  // What it DOES prove, honestly: the real `git worktree add`/`remove`
  // lifecycle works and leaves nothing behind, using an ORPHAN commit (via
  // `git commit-tree` against the empty tree, never touching any branch or
  // the working tree) that has no packages/ directories at all — `packRef`
  // reports every package missing, `run()` exits 1, and no worktree leaks.
  it('exercises the real git worktree add/remove lifecycle for an empty-tree ref (does not pack — see comment)', () => {
    const repoRoot = resolve(import.meta.dir, '..');
    const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // the well-known empty-tree hash
    // `git commit-tree` needs an author/committer identity, and a CI runner
    // has no reason to carry a global `user.name`/`user.email` (ours doesn't
    // — that is how this failed in CI while passing locally). Pass the
    // identity explicitly on this spawn rather than depending on ANY git
    // config, global or repo-local.
    const commitSha = execFileSync(
      'git',
      ['commit-tree', emptyTreeSha, '-m', 'ga-tarball-diff test fixture: empty tree'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'ga-tarball-diff-test',
          GIT_AUTHOR_EMAIL: 'ga-tarball-diff-test@example.invalid',
          GIT_COMMITTER_NAME: 'ga-tarball-diff-test',
          GIT_COMMITTER_EMAIL: 'ga-tarball-diff-test@example.invalid',
        },
      },
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
