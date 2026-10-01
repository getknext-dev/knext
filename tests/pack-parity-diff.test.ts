import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  comparePackedTarballEntries,
  formatPackParityReport,
} from '../scripts/lib/pack-parity-diff.mjs';
import { readTarEntries } from '../scripts/lib/tar-entries.mjs';

/**
 * `scripts/lib/pack-parity-diff.mjs` (#1734, G3) — hermetic unit tests on
 * REAL fixture tarballs (built with the real `tar` binary, same pattern
 * `tests/ga-tarball-diff.test.ts` uses), never the network. This is the pure
 * comparator half of the nightly pack-parity check; the CLI driver
 * (`scripts/verify-rc-pack-parity.mjs`) does the network/pack/checkout side
 * and is deliberately NOT unit tested here.
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

/** Build a well-formed `package/`-rooted fixture tarball with the given files. */
function buildFixtureTarball(
  outDir: string,
  filename: string,
  files: Record<string, string>,
): string {
  const stageRoot = mkFixtureDir('pack-parity-stage-');
  const pkgRoot = join(stageRoot, 'package');
  mkdirSync(pkgRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(pkgRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const tgzPath = join(outDir, filename);
  execFileSync('tar', ['-czf', tgzPath, '-C', stageRoot, 'package'], { env: TAR_ENV });
  return tgzPath;
}

const BASE_FILES = {
  'package.json': JSON.stringify({ name: '@getknext/fixture', version: '1.0.0' }, null, 2),
  'index.js': "module.exports = 'fixture';\n",
  'README.md': '# fixture\n',
};

describe('comparePackedTarballEntries', () => {
  it('identical tarballs -> identical: true, no differences reported', () => {
    const dir = mkFixtureDir('pack-parity-identical-');
    const a = buildFixtureTarball(dir, 'a.tgz', BASE_FILES);
    const b = buildFixtureTarball(dir, 'b.tgz', BASE_FILES);

    const result = comparePackedTarballEntries(readTarEntries(a), readTarEntries(b));

    expect(result.identical).toBe(true);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual([]);
    expect(result.differingFiles).toEqual([]);
    expect(formatPackParityReport('@getknext/fixture', result, { aLabel: 'a', bLabel: 'b' })).toBe(
      null,
    );
  });

  it('one byte differs in one file -> identical: false, that file listed in differingFiles', () => {
    const dir = mkFixtureDir('pack-parity-byte-diff-');
    const a = buildFixtureTarball(dir, 'a.tgz', BASE_FILES);
    const b = buildFixtureTarball(dir, 'b.tgz', {
      ...BASE_FILES,
      'index.js': "module.exports = 'FIXTURE';\n", // one-byte-class content change
    });

    const result = comparePackedTarballEntries(readTarEntries(a), readTarEntries(b));

    expect(result.identical).toBe(false);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual([]);
    expect(result.differingFiles).toEqual(['package/index.js']);
    const report = formatPackParityReport('@getknext/fixture', result, {
      aLabel: 'a',
      bLabel: 'b',
    });
    expect(report).toContain('package/index.js');
    expect(report).toContain('content differs');
  });

  it('an extra file in A -> identical: false, reported under onlyInA', () => {
    const dir = mkFixtureDir('pack-parity-extra-');
    const a = buildFixtureTarball(dir, 'a.tgz', {
      ...BASE_FILES,
      'EXTRA.txt': 'only in a\n',
    });
    const b = buildFixtureTarball(dir, 'b.tgz', BASE_FILES);

    const result = comparePackedTarballEntries(readTarEntries(a), readTarEntries(b));

    expect(result.identical).toBe(false);
    expect(result.onlyInA).toEqual(['package/EXTRA.txt']);
    expect(result.onlyInB).toEqual([]);
    expect(result.differingFiles).toEqual([]);
    const report = formatPackParityReport('@getknext/fixture', result, {
      aLabel: 'bun pm pack',
      bLabel: 'npm registry',
    });
    expect(report).toContain('only in bun pm pack: package/EXTRA.txt');
  });

  it('a missing file in A (present only in B) -> identical: false, reported under onlyInB', () => {
    const dir = mkFixtureDir('pack-parity-missing-');
    const a = buildFixtureTarball(dir, 'a.tgz', BASE_FILES);
    const b = buildFixtureTarball(dir, 'b.tgz', {
      ...BASE_FILES,
      'EXTRA.txt': 'only in b\n',
    });

    const result = comparePackedTarballEntries(readTarEntries(a), readTarEntries(b));

    expect(result.identical).toBe(false);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual(['package/EXTRA.txt']);
    expect(result.differingFiles).toEqual([]);
    const report = formatPackParityReport('@getknext/fixture', result, {
      aLabel: 'bun pm pack',
      bLabel: 'npm registry',
    });
    expect(report).toContain('only in npm registry: package/EXTRA.txt');
  });

  it('ignores mtime/mode-only metadata differences (never read by readTarEntries in the first place)', () => {
    // Build the SAME content with a deliberate delay between the two tars so
    // mtimes differ, and chmod one file differently before packing. Neither
    // should surface as a difference: `readTarEntries` does not even expose
    // mtime, and `comparePackedTarballEntries` deliberately does not compare
    // mode (see the module header for why).
    const dir = mkFixtureDir('pack-parity-metadata-');
    const stageA = mkFixtureDir('pack-parity-metadata-stage-a-');
    const pkgA = join(stageA, 'package');
    mkdirSync(pkgA, { recursive: true });
    writeFileSync(join(pkgA, 'index.js'), BASE_FILES['index.js']);
    execFileSync('chmod', ['755', join(pkgA, 'index.js')]);
    const a = join(dir, 'a.tgz');
    execFileSync('tar', ['-czf', a, '-C', stageA, 'package'], { env: TAR_ENV });

    const stageB = mkFixtureDir('pack-parity-metadata-stage-b-');
    const pkgB = join(stageB, 'package');
    mkdirSync(pkgB, { recursive: true });
    writeFileSync(join(pkgB, 'index.js'), BASE_FILES['index.js']);
    execFileSync('chmod', ['644', join(pkgB, 'index.js')]);
    const b = join(dir, 'b.tgz');
    execFileSync('tar', ['-czf', b, '-C', stageB, 'package'], { env: TAR_ENV });

    const result = comparePackedTarballEntries(readTarEntries(a), readTarEntries(b));
    expect(result.identical).toBe(true);
  });
});
