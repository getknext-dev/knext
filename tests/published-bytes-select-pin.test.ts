import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PIN_FILE, PIN_FILE_V13 } from '../scripts/lib/published-bytes-freeze-check.mjs';
import { selectPinFromGit } from '../scripts/published-bytes-select-pin.mjs';

/**
 * `scripts/published-bytes-select-pin.mjs` (#2098) — the git-reading half of
 * "guard the line whose bytes are credentialed". The pure choice is covered
 * in `published-bytes-freeze-check.test.ts` (`selectPinFile`); this file proves
 * the wiring against REAL git objects: the base commit's `@getknext/core`
 * version, the pin files at the base commit, and the `origin/main` fallback
 * for the v1.3 pin, which lives on `main` only (it is read from main by its
 * own credential workflow).
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/published-bytes-select-pin.mjs');
const registry: string[] = [];

afterEach(() => {
  for (const dir of registry.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function write(root: string, rel: string, body: unknown) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
}

const V10_PIN = { rcTag: 'v1.0.0-rc.6' };
const V13_PIN = { line: 'v1.3', rcTag: 'v1.3.0-rc.10' };

function repoWith(files: Record<string, unknown>): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'pb-select-pin-'));
  registry.push(root);
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}

const CORE = (version: string) => ({ name: '@getknext/core', version });

describe('selectPinFromGit (#2098)', () => {
  it('main on 1.3: falls back to the primary (v1.0) pin, so the check skips on the line mismatch', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.3.0'),
      [PIN_FILE]: V10_PIN,
      [PIN_FILE_V13]: V13_PIN,
    });
    const r = selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'main' });
    expect(r.pinFile).toBe(PIN_FILE);
    expect(r.baseVersion).toBe('1.3.0');
    expect(r.basePin).toEqual(V10_PIN);
  });

  it('integration/v1.3: selects the v1.3 pin, reading it from main when the base commit lacks the file', () => {
    // The integration branch carries a STALE v1.0 pin and no v1.3 pin at all.
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.3.0'),
      [PIN_FILE]: { rcTag: 'v1.0.0-rc.5' },
    });
    // `main` (the fallback source) carries the v1.3 pin.
    git(root, 'checkout', '-q', '-b', 'mainline');
    write(root, PIN_FILE_V13, V13_PIN);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main has the v1.3 pin');
    const r = selectPinFromGit({
      repoRoot: root,
      baseSha: sha,
      baseRef: 'integration/v1.3',
      mainRef: 'mainline',
    });
    expect(r.pinFile).toBe(PIN_FILE_V13);
    expect(r.baseVersion).toBe('1.3.0');
    expect(r.basePin).toEqual(V13_PIN);
  });

  it('a base on the v1.0 line selects the primary pin', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.0.3'),
      [PIN_FILE]: V10_PIN,
    });
    const r = selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'release/1.x' });
    expect(r.pinFile).toBe(PIN_FILE);
    expect(r.basePin).toEqual(V10_PIN);
  });

  it('no pin file at the base commit: unfrozen (rcTag null), as before', () => {
    const { root, sha } = repoWith({ 'packages/kn-next/package.json': CORE('1.3.0') });
    const r = selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'main' });
    expect(r.pinFile).toBe(PIN_FILE);
    expect(r.basePin).toEqual({ rcTag: null });
  });

  it('an unreadable core version yields baseVersion undefined (the check then fails closed)', () => {
    const { root, sha } = repoWith({ [PIN_FILE]: V10_PIN });
    const r = selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'main' });
    expect(r.baseVersion).toBeUndefined();
    expect(r.pinFile).toBe(PIN_FILE);
  });

  it('a corrupt base pin on a matching line FAILS (exit 2), never reads as "no window"', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.0.3'),
      [PIN_FILE]: '{not json',
    });
    expect(() =>
      selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'release/1.x' }),
    ).toThrow(/not valid JSON/);
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--base-sha', sha, '--base-ref', 'release/1.x'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('PIN_FILE_SELECTED');
  });

  it('an unreadable v1.3 pin on integration/v1.3 FAILS rather than falling back to the v1.0 pin', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.3.0'),
      [PIN_FILE]: V10_PIN,
      [PIN_FILE_V13]: V13_PIN,
    });
    // Destroy the v1.3 pin's loose object: it is listed in the tree but unreadable.
    const blob = git(root, 'rev-parse', `${sha}:${PIN_FILE_V13}`);
    rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    expect(() =>
      selectPinFromGit({ repoRoot: root, baseSha: sha, baseRef: 'integration/v1.3' }),
    ).toThrow(/cannot read/);
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--base-sha', sha, '--base-ref', 'integration/v1.3'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
  });

  it('a corrupt v1.3 pin read from main FAILS too', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.3.0'),
      [PIN_FILE]: V10_PIN,
    });
    git(root, 'checkout', '-q', '-b', 'mainline');
    write(root, PIN_FILE_V13, '{broken');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'corrupt v1.3 pin on main');
    expect(() =>
      selectPinFromGit({
        repoRoot: root,
        baseSha: sha,
        baseRef: 'integration/v1.3',
        mainRef: 'mainline',
      }),
    ).toThrow(/not valid JSON/);
  });

  it('CLI: prints KEY=value lines and writes the base pin file', () => {
    const { root, sha } = repoWith({
      'packages/kn-next/package.json': CORE('1.3.0'),
      [PIN_FILE]: V10_PIN,
    });
    const out = join(root, 'base-pin.json');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--base-sha', sha, '--base-ref', 'main', '--base-pin-out', out],
      { cwd: root, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`PIN_FILE_SELECTED=${PIN_FILE}`);
    expect(r.stdout).toContain('BASE_VERSION=1.3.0');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(V10_PIN);
  });

  it('CLI: missing --base-sha exits 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
