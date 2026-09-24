import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareTrees, diffFileBytes, diffPackageJson } from '../scripts/lib/ga-tarball-diff.mjs';

/**
 * `scripts/ga-tarball-diff.mjs` (#1306) — the GA-vs-rc tarball diff check.
 *
 * The v1.0 compatibility credential is measured against the `rc.N` tarballs.
 * If the tarball that actually ships under the GA tag differs from its rc
 * counterpart in anything beyond version fields, the credential does not
 * cover what ships. This suite covers the pure comparison logic
 * (`scripts/lib/ga-tarball-diff.mjs`) directly, and the CLI end-to-end
 * against small fixture tarballs built with `tar` — real npm-pack-shaped
 * tarballs, not the actual monorepo (too slow/heavy for a unit test), so the
 * CLI's extraction/packing/orchestration path is exercised without a bun
 * build.
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

// --- diffPackageJson ---------------------------------------------------

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

  it('allows a @getknext/* sibling dependency range to move with the bump', () => {
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

  it('fails when a non-sibling dependency range drifts', () => {
    const rc = { name: 'x', version: '1.0.0-rc.3', dependencies: { pino: '^9.6.0' } };
    const ga = { name: 'x', version: '1.0.0', dependencies: { pino: '^9.7.0' } };
    const violations = diffPackageJson(rc, ga, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('pino');
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
});

// --- diffFileBytes -------------------------------------------------------

describe('diffFileBytes', () => {
  it('is clean on byte-identical files', () => {
    const buf = Buffer.from('hello world');
    expect(diffFileBytes(buf, buf, '1.0.0-rc.3', '1.0.0')).toEqual({ ok: true, embedded: false });
  });

  it('accepts an exact single-site rc->GA version substitution', () => {
    const rc = Buffer.from('// built by knext 1.0.0-rc.3\nconsole.log("hi");\n');
    const ga = Buffer.from('// built by knext 1.0.0\nconsole.log("hi");\n');
    expect(diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0')).toEqual({ ok: true, embedded: true });
  });

  it('rejects content that differs beyond the version substitution', () => {
    const rc = Buffer.from('// built by knext 1.0.0-rc.3\nconsole.log("hi");\n');
    const ga = Buffer.from('// built by knext 1.0.0\nconsole.log("bye");\n');
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('differs beyond');
  });

  it('rejects a partial substitution (some sites left un-substituted)', () => {
    const rc = Buffer.from('v1.0.0-rc.3 and again v1.0.0-rc.3');
    const ga = Buffer.from('v1.0.0 and again v1.0.0-rc.3');
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
  });

  it('rejects binary content that differs', () => {
    const rc = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const ga = Buffer.from([0x00, 0x01, 0xff, 0xfd]);
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('binary');
  });

  it('rejects a byte difference when the rc side never contained the rc version string', () => {
    const rc = Buffer.from('no version here');
    const ga = Buffer.from('no version there');
    const result = diffFileBytes(rc, ga, '1.0.0-rc.3', '1.0.0');
    expect(result.ok).toBe(false);
  });
});

// --- compareTrees ----------------------------------------------------------

describe('compareTrees', () => {
  const rcRoot = () => mkFixtureDir('ga-diff-rc-tree-');
  const gaRoot = () => mkFixtureDir('ga-diff-ga-tree-');
  const ctx = {
    rcVersion: '1.0.0-rc.3',
    gaVersion: '1.0.0',
    siblingNames: new Set(['@getknext/core', '@getknext/lib']),
    readFile: (p: string) => readFileSync(p),
  };

  it('is clean when the only deltas are licensed version fields', () => {
    const rc = rcRoot();
    const ga = gaRoot();
    writeFileSync(
      join(rc, 'package.json'),
      JSON.stringify({ name: '@getknext/core', version: '1.0.0-rc.3' }),
    );
    writeFileSync(
      join(ga, 'package.json'),
      JSON.stringify({ name: '@getknext/core', version: '1.0.0' }),
    );
    writeFileSync(join(rc, 'index.js'), 'console.log(1);');
    writeFileSync(join(ga, 'index.js'), 'console.log(1);');

    const rcFiles = new Map([
      ['package.json', join(rc, 'package.json')],
      ['index.js', join(rc, 'index.js')],
    ]);
    const gaFiles = new Map([
      ['package.json', join(ga, 'package.json')],
      ['index.js', join(ga, 'index.js')],
    ]);

    const result = compareTrees(rcFiles, gaFiles, ctx);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails closed on a missing file', () => {
    const rc = rcRoot();
    const ga = gaRoot();
    writeFileSync(join(rc, 'a.js'), 'x');
    writeFileSync(join(rc, 'b.js'), 'x');
    writeFileSync(join(ga, 'a.js'), 'x');

    const rcFiles = new Map([
      ['a.js', join(rc, 'a.js')],
      ['b.js', join(rc, 'b.js')],
    ]);
    const gaFiles = new Map([['a.js', join(ga, 'a.js')]]);

    const result = compareTrees(rcFiles, gaFiles, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('b.js'))).toBe(true);
  });

  it('fails closed on an extra file', () => {
    const rc = rcRoot();
    const ga = gaRoot();
    writeFileSync(join(rc, 'a.js'), 'x');
    writeFileSync(join(ga, 'a.js'), 'x');
    writeFileSync(join(ga, 'extra.js'), 'x');

    const rcFiles = new Map([['a.js', join(rc, 'a.js')]]);
    const gaFiles = new Map([
      ['a.js', join(ga, 'a.js')],
      ['extra.js', join(ga, 'extra.js')],
    ]);

    const result = compareTrees(rcFiles, gaFiles, ctx);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('extra.js'))).toBe(true);
  });

  it('reports the embedded-version site it normalised, by scanning rather than enumerating', () => {
    const rc = rcRoot();
    const ga = gaRoot();
    mkdirSync(join(rc, 'dist'), { recursive: true });
    mkdirSync(join(ga, 'dist'), { recursive: true });
    writeFileSync(join(rc, 'dist', 'banner.js'), '// v1.0.0-rc.3\nexport const x = 1;\n');
    writeFileSync(join(ga, 'dist', 'banner.js'), '// v1.0.0\nexport const x = 1;\n');

    const rcFiles = new Map([['dist/banner.js', join(rc, 'dist', 'banner.js')]]);
    const gaFiles = new Map([['dist/banner.js', join(ga, 'dist', 'banner.js')]]);

    const result = compareTrees(rcFiles, gaFiles, ctx);
    expect(result.ok).toBe(true);
    expect(result.embeddedVersionSites).toEqual(['dist/banner.js']);
  });
});

// --- CLI end-to-end against fixture tarballs --------------------------------

/** Build a minimal npm-pack-shaped tarball: a `package/` root containing `files`. */
function buildFixtureTarball(dir: string, name: string, files: Record<string, string>): string {
  const stageRoot = join(dir, 'stage');
  const pkgRoot = join(stageRoot, 'package');
  mkdirSync(pkgRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(pkgRoot, relPath);
    mkdirSync(abs.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(abs, content);
  }
  const tgzPath = join(dir, `${name.replace('/', '-')}.tgz`);
  execFileSync('tar', ['-czf', tgzPath, '-C', stageRoot, 'package']);
  return tgzPath;
}

function runCli(args: string[]): { code: number; output: string } {
  const scriptPath = join(import.meta.dir, '..', 'scripts', 'ga-tarball-diff.mjs');
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout}\n${result.stderr}` };
}

describe('ga-tarball-diff CLI (fixture tarballs)', () => {
  it('exits 0 when the only deltas across the published set are version fields', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-');

    for (const [name, dir] of [
      ['@getknext/lib', rcDir],
      ['@getknext/db', rcDir],
      ['@getknext/core', rcDir],
    ] as const) {
      buildFixtureTarball(dir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0-rc.3' }),
        'index.js': 'module.exports = {};\n',
      });
    }
    for (const [name, dir] of [
      ['@getknext/lib', gaDir],
      ['@getknext/db', gaDir],
      ['@getknext/core', gaDir],
    ] as const) {
      buildFixtureTarball(dir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0' }),
        'index.js': 'module.exports = {};\n',
      });
    }

    const { code, output } = runCli(['--rc-dir', rcDir, '--ga-dir', gaDir]);
    expect(code).toBe(0);
    expect(output).toContain('PASS');
  });

  it('exits 1 and prints a precise diff when a GA tarball carries an unexplained delta', () => {
    const rcDir = mkFixtureDir('ga-diff-cli-rc-bad-');
    const gaDir = mkFixtureDir('ga-diff-cli-ga-bad-');

    for (const [name, dir] of [
      ['@getknext/lib', rcDir],
      ['@getknext/db', rcDir],
      ['@getknext/core', rcDir],
    ] as const) {
      buildFixtureTarball(dir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0-rc.3' }),
        'index.js': 'module.exports = {};\n',
      });
    }
    buildFixtureTarball(gaDir, '@getknext/lib', {
      'package.json': JSON.stringify({ name: '@getknext/lib', version: '1.0.0' }),
      // deliberately different from the rc twin — not just a version substitution
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
    for (const name of ['@getknext/lib', '@getknext/db', '@getknext/core'] as const) {
      buildFixtureTarball(rcDir, name, {
        'package.json': JSON.stringify({ name, version: '1.0.0-rc.3' }),
      });
    }
    // GA set is missing @getknext/db entirely.
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
});
