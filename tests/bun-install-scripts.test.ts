import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD: which dependencies may run an install lifecycle script is a reviewed,
 * pinned list.
 *
 * `bun install` runs a dependency's preinstall/install/postinstall only when the
 * package is in the ROOT `package.json` `trustedDependencies`, or on Bun's
 * built-in default-trusted list (`bun pm default-trusted`). The default list is
 * additive: measured on bun 1.4.2, an explicit list does NOT turn it off (esbuild's
 * postinstall still ran under `trustedDependencies: ["something-else"]`). So
 * "scripts only run for an explicit list" is false as a statement about bun, and
 * the honest guard pins both paths:
 *
 *   1. the root `trustedDependencies` equals `security/bun-install-scripts.json`
 *      `allow` exactly (explicit, so the decision does not depend on bun's list
 *      keeping a name), and
 *   2. every package that appears in `bun.lock` AND on bun's default list is in
 *      `allow` (a new dependency that can run a script cannot arrive unreviewed),
 *   3. every `allow` entry is still in the lockfile (the list cannot go stale), and
 *      carries a justification and a date.
 *
 * Also: no workspace member declares its own `trustedDependencies` (bun reads only
 * the root's, so a member's list is a no-op that reads as protection), and nothing
 * in CI or a Dockerfile edits the list at build time (`bun pm trust`, `--trust`).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

type Allow = { name: string; justification: string; added: string };
const allowFile = JSON.parse(read('security/bun-install-scripts.json')) as { allow: Allow[] };
const ALLOW = allowFile.allow;

function lockNames(): Set<string> {
  const lock = Bun.JSONC.parse(read('bun.lock')) as { packages: Record<string, string[]> };
  const names = new Set<string>();
  for (const entry of Object.values(lock.packages)) {
    const id = entry[0];
    names.add(id.slice(0, id.lastIndexOf('@')));
  }
  return names;
}

function defaultTrusted(): Set<string> {
  const out = spawnSync(process.execPath, ['pm', 'default-trusted'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(out.status, 'bun pm default-trusted exits 0').toBe(0);
  return new Set(
    out.stdout
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter((l) => l && !l.startsWith('Default')),
  );
}

describe('the allowlist file', () => {
  it('is non-empty and well-formed', () => {
    expect(ALLOW.length).toBeGreaterThan(0);
    for (const e of ALLOW) {
      expect(e.name, 'name').toBeTruthy();
      expect(e.justification?.length ?? 0, `${e.name} justification`).toBeGreaterThan(40);
      expect(e.added, `${e.name} added`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(ALLOW.map((e) => e.name)).size, 'no duplicate names').toBe(ALLOW.length);
  });
});

describe('root trustedDependencies is the reviewed list', () => {
  const rootPkg = JSON.parse(read('package.json')) as { trustedDependencies?: string[] };
  it('equals the allowlist exactly', () => {
    expect([...(rootPkg.trustedDependencies ?? [])].sort()).toEqual(
      ALLOW.map((e) => e.name).sort(),
    );
  });
  it('is mirrored in the lockfile bun resolves against', () => {
    const lock = Bun.JSONC.parse(read('bun.lock')) as { trustedDependencies?: string[] };
    expect([...(lock.trustedDependencies ?? [])].sort()).toEqual(ALLOW.map((e) => e.name).sort());
  });
});

describe('a dependency that can run an install script is a reviewed name', () => {
  it('the scan sees the lockfile and bun default list (non-vacuity)', () => {
    expect(lockNames().size).toBeGreaterThan(500);
    expect(defaultTrusted().size).toBeGreaterThan(100);
    expect(defaultTrusted().has('esbuild')).toBe(true);
  });

  it('every lockfile package on bun’s default-trusted list is in the allowlist', () => {
    const trusted = defaultTrusted();
    const allowed = new Set(ALLOW.map((e) => e.name));
    const unreviewed = [...lockNames()].filter((n) => trusted.has(n) && !allowed.has(n)).sort();
    expect(
      unreviewed,
      'these packages may run an install script under bun’s default list; read the script, then add them to security/bun-install-scripts.json AND root trustedDependencies',
    ).toEqual([]);
  });

  it('every allowlisted package is still in the lockfile (no stale entries)', () => {
    const names = lockNames();
    expect(ALLOW.map((e) => e.name).filter((n) => !names.has(n))).toEqual([]);
  });
});

describe('nothing else grants or edits trust', () => {
  it('no workspace member declares trustedDependencies (bun reads only the root)', () => {
    const offenders: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const entry of readdirSync(resolve(REPO_ROOT, group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const manifest = JSON.parse(read(`${group}/${entry.name}/package.json`)) as {
            trustedDependencies?: unknown;
          };
          if (manifest.trustedDependencies !== undefined) offenders.push(`${group}/${entry.name}`);
        } catch {
          // not a package directory
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no workflow, action or Dockerfile edits trust at build time (`bun pm trust`, `--trust`)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ya?ml|sh)$/.test(entry.name) || entry.name.startsWith('Dockerfile'))
          files.push(full);
      }
    };
    walk(resolve(REPO_ROOT, '.github'));
    for (const p of ['apps/file-manager/Dockerfile', 'apps/docs/Dockerfile']) {
      files.push(resolve(REPO_ROOT, p));
    }
    expect(files.length).toBeGreaterThan(40);
    const offenders: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      if (
        /\bbun\s+pm\s+trust\b/.test(code) ||
        /\bbun\s+(?:install|add|i)\b[^\n]*\s--trust\b/.test(code)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
