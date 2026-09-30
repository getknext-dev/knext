import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end test for the ratchet-floor guard's CLI ENTRYPOINT (review round
 * 2, #1253) — `tests/ratchet-floor-guard.test.ts` exercises the pure library
 * functions in-process; this exercises the actual `node scripts/check-
 * ratchet-floors.mjs` child process against a REAL, throwaway git repo, the
 * same way `tests/mutation-residue-scan.test.ts` proves its scanner.
 *
 * `scripts/check-ratchet-floors.mjs` derives its own repo root from
 * `import.meta.url` (never `process.cwd()`), so the fixture copies the real
 * guard SCRIPT + its library into the temp repo at the same relative path
 * (`scripts/check-ratchet-floors.mjs`, `scripts/lib/ratchet-floors.mjs`) and
 * spawns it FROM THERE — this is genuinely running "the CLI", not a copy
 * hand-edited to be testable.
 *
 * `RATCHET_FLOOR_BASE_REF` is the guard's own documented override for a repo
 * with no `origin` remote (its own file header names this exact case).
 */

const REPO_ROOT = resolve(__dirname, '..');
const GUARD_SCRIPT = resolve(REPO_ROOT, 'scripts/check-ratchet-floors.mjs');
const GUARD_LIB = resolve(REPO_ROOT, 'scripts/lib/ratchet-floors.mjs');

const tempRepos: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-floor-guard-e2e-'));
  tempRepos.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(GUARD_SCRIPT, join(dir, 'scripts', 'check-ratchet-floors.mjs'));
  cpSync(GUARD_LIB, join(dir, 'scripts', 'lib', 'ratchet-floors.mjs'));
  return dir;
}

function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--no-gpg-sign', '-qm', message], { cwd: dir, stdio: 'pipe' });
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function writeFloorFile(dir: string, value: number): void {
  writeFileSync(join(dir, 'floors.mjs'), `// @ratchet-floor\nexport const MIN_THING = ${value};\n`);
}

function runGuard(dir: string, baseRef: string) {
  const res = spawnSync('node', ['scripts/check-ratchet-floors.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RATCHET_FLOOR_BASE_REF: baseRef },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

afterAll(() => {
  for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/check-ratchet-floors.mjs — CLI entrypoint, real git repo (review round 2)', () => {
  it('exits 0 when the floor is unchanged between base and head', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    const base = commitAll(dir, 'base');
    writeFileSync(join(dir, 'README.md'), 'unrelated change\n');
    commitAll(dir, 'unrelated head change');

    const { status, stdout } = runGuard(dir, base);
    expect(status).toBe(0);
    expect(stdout).toMatch(/none lowered/);
  });

  it('exits 0 when the floor is RAISED between base and head', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    const base = commitAll(dir, 'base');
    writeFloorFile(dir, 200);
    commitAll(dir, 'raise the floor');

    const { status } = runGuard(dir, base);
    expect(status).toBe(0);
  });

  it('exits NON-ZERO when the floor is LOWERED between base and head', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    const base = commitAll(dir, 'base');
    writeFloorFile(dir, 99);
    commitAll(dir, 'lower the floor');

    const { status, stderr } = runGuard(dir, base);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/FLOOR\(S\) LOWERED/);
    expect(stderr).toMatch(/100 -> 99/);
  });

  it('exits NON-ZERO when the floor is REMOVED entirely at head (deleting the marker is not a bypass)', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    const base = commitAll(dir, 'base');
    writeFileSync(join(dir, 'floors.mjs'), '// the floor is gone\n');
    commitAll(dir, 'remove the floor');

    const { status, stderr } = runGuard(dir, base);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/FLOOR\(S\) LOWERED/);
    expect(stderr).toMatch(/100 -> REMOVED/);
  });

  it('exits 0 when a lowering is covered by a PR-introduced allowlist entry', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    const base = commitAll(dir, 'base');
    writeFloorFile(dir, 99);
    writeFileSync(
      join(dir, 'ratchet-lowering-allowlist.json'),
      JSON.stringify([
        {
          file: 'floors.mjs',
          path: 'MIN_THING',
          reason: 'deliberate, reviewed',
          date: '2026-09-30',
        },
      ]),
    );
    commitAll(dir, 'lower the floor, with an allowlist entry');

    const { status, stdout } = runGuard(dir, base);
    expect(status).toBe(0);
    expect(stdout).toMatch(/none lowered/);
  });

  it('does NOT accept an allowlist entry that was already present at base (inherited, not introduced)', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    writeFileSync(
      join(dir, 'ratchet-lowering-allowlist.json'),
      JSON.stringify([
        { file: 'floors.mjs', path: 'MIN_THING', reason: 'old', date: '2026-01-01' },
      ]),
    );
    const base = commitAll(dir, 'base, with a pre-existing allowlist entry');
    writeFloorFile(dir, 99);
    commitAll(dir, 'lower the floor, riding the inherited entry');

    const { status, stderr } = runGuard(dir, base);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/100 -> 99/);
  });

  it('FAILS CLOSED (never silently passes) when no origin/main and no override are available', () => {
    const dir = makeRepo();
    writeFloorFile(dir, 100);
    commitAll(dir, 'base');

    const res = spawnSync('node', ['scripts/check-ratchet-floors.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, RATCHET_FLOOR_BASE_REF: '' },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/FAILED CLOSED/);
  });
});
