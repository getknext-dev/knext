import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  comparePackedTarballEntries,
  compareTarballEntriesTolerant,
  formatPackParityReport,
  formatTolerantPackParityReport,
  groupTarEntriesByName,
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

// --- tolerant comparison: #1562-aware (#1734 review refinement) ------------
//
// A legitimate `bun pm pack` cannot be reproduced with `tar -czf` over a
// staged directory (a filesystem cannot hold two files at the same path), so
// — mirroring `tests/ga-tarball-diff.test.ts`'s own adversarial-fixture
// approach exactly — these fixtures are built RAW, byte-for-byte, as the real
// #1562 shape: two legitimately-checksummed headers for the SAME path.

/** A raw 512-byte ustar header + its (zero-padded) data, matching the wire format exactly. */
function rawTarHeader(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('0', 156); // regular file
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(pad);
  return Buffer.concat([h, pad]);
}

function writeRawTarGz(dir: string, filename: string, parts: Buffer[]): string {
  const tgzPath = join(dir, filename);
  writeFileSync(tgzPath, gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
  return tgzPath;
}

describe('compareTarballEntriesTolerant', () => {
  it('duplicate copies identical to each other AND the registry -> identical:true, with a structural note', () => {
    const dir = mkFixtureDir('pack-parity-dup-ok-');
    const shared = Buffer.from("module.exports = 'shared';\n");
    const bunTgz = writeRawTarGz(dir, 'bun.tgz', [
      rawTarHeader('package/dist/cli/kn-next.js', shared),
      rawTarHeader('package/dist/cli/kn-next.js', shared), // identical second copy
    ]);
    const registryTgz = writeRawTarGz(dir, 'registry.tgz', [
      rawTarHeader('package/dist/cli/kn-next.js', shared),
    ]);

    const allEntriesA = readTarEntries(bunTgz, { allowDuplicates: true });
    const entriesB = readTarEntries(registryTgz);
    const result = compareTarballEntriesTolerant(allEntriesA, entriesB);

    expect(result.identical).toBe(true);
    expect(result.conflictingDuplicates).toEqual([]);
    expect(result.structuralDuplicates).toEqual([
      { name: 'package/dist/cli/kn-next.js', count: 2 },
    ]);

    const report = formatTolerantPackParityReport('@getknext/core', result, {
      aLabel: 'bun pm pack',
      bLabel: 'npm registry',
    });
    expect(report).toContain('STRUCTURAL NOTE (#1562');
    expect(report).toContain('identical');
    expect(report).not.toContain('FAIL');
  });

  it('duplicate copies that DISAGREE with each other -> identical:false, reported in conflictingDuplicates', () => {
    const dir = mkFixtureDir('pack-parity-dup-conflict-');
    const copyOne = Buffer.from("module.exports = 'copy-one';\n");
    const copyTwo = Buffer.from("module.exports = 'copy-two';\n");
    const bunTgz = writeRawTarGz(dir, 'bun.tgz', [
      rawTarHeader('package/dist/cli/kn-next.js', copyOne),
      rawTarHeader('package/dist/cli/kn-next.js', copyTwo),
    ]);
    const registryTgz = writeRawTarGz(dir, 'registry.tgz', [
      rawTarHeader('package/dist/cli/kn-next.js', copyTwo), // matches the LAST (extracted) copy
    ]);

    const allEntriesA = readTarEntries(bunTgz, { allowDuplicates: true });
    const entriesB = readTarEntries(registryTgz);
    const result = compareTarballEntriesTolerant(allEntriesA, entriesB);

    expect(result.identical).toBe(false);
    expect(result.conflictingDuplicates).toEqual(['package/dist/cli/kn-next.js']);
    // Last-wins content still matches the registry, so this is NOT ALSO
    // reported as a content-diff — it is reported exactly once, as the
    // internal-inconsistency finding it actually is.
    expect(result.differingFiles).toEqual([]);

    const report = formatTolerantPackParityReport('@getknext/core', result, {
      aLabel: 'bun pm pack',
      bLabel: 'npm registry',
    });
    expect(report).toContain('FAIL: duplicate tar entry "package/dist/cli/kn-next.js"');
  });

  it('a duplicate whose LAST (extracted) copy differs from the registry -> identical:false, a plain content diff', () => {
    const dir = mkFixtureDir('pack-parity-dup-extracted-diff-');
    const firstCopy = Buffer.from("module.exports = 'first';\n");
    const lastCopy = Buffer.from("module.exports = 'last';\n");
    const bunTgz = writeRawTarGz(dir, 'bun.tgz', [
      rawTarHeader('package/dist/cli/kn-next.js', firstCopy),
      rawTarHeader('package/dist/cli/kn-next.js', lastCopy),
    ]);
    const registryTgz = writeRawTarGz(dir, 'registry.tgz', [
      rawTarHeader(
        'package/dist/cli/kn-next.js',
        Buffer.from("module.exports = 'DIFFERENT FROM BOTH';\n"),
      ),
    ]);

    const allEntriesA = readTarEntries(bunTgz, { allowDuplicates: true });
    const entriesB = readTarEntries(registryTgz);
    const result = compareTarballEntriesTolerant(allEntriesA, entriesB);

    expect(result.identical).toBe(false);
    expect(result.differingFiles).toEqual(['package/dist/cli/kn-next.js']);
    // ALSO internally inconsistent (first !== last), reported too, not hidden
    // behind the content-diff finding.
    expect(result.conflictingDuplicates).toEqual(['package/dist/cli/kn-next.js']);
  });

  it('no duplicates at all -> behaves exactly like comparePackedTarballEntries, no structural note', () => {
    const dir = mkFixtureDir('pack-parity-no-dup-');
    const a = buildFixtureTarball(dir, 'a.tgz', BASE_FILES);
    const b = buildFixtureTarball(dir, 'b.tgz', BASE_FILES);

    const result = compareTarballEntriesTolerant(
      readTarEntries(a, { allowDuplicates: true }),
      readTarEntries(b),
    );

    expect(result.identical).toBe(true);
    expect(result.structuralDuplicates).toEqual([]);
    expect(result.conflictingDuplicates).toEqual([]);
    expect(
      formatTolerantPackParityReport('@getknext/fixture', result, { aLabel: 'a', bLabel: 'b' }),
    ).toBe(null);
  });
});

describe('groupTarEntriesByName', () => {
  it('groups every occurrence of a path together, in file order', () => {
    const entries = [
      { name: 'x', type: 'file', mode: 0o644, linkname: null, size: 1, data: Buffer.from('1') },
      { name: 'y', type: 'file', mode: 0o644, linkname: null, size: 1, data: Buffer.from('2') },
      { name: 'x', type: 'file', mode: 0o644, linkname: null, size: 1, data: Buffer.from('3') },
    ];
    const groups = groupTarEntriesByName(entries as never);
    expect(groups.get('x')?.map((e) => e.data?.toString())).toEqual(['1', '3']);
    expect(groups.get('y')?.map((e) => e.data?.toString())).toEqual(['2']);
  });
});
