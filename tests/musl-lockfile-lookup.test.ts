import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * scripts/lib/musl-lockfile-lookup.sh (#1257 round 7) — pure, side-effect-free
 * lookup helpers pulled out of scripts/e2e-native-rebuild-musl.sh specifically
 * so they are testable WITHOUT docker/apk (that script's own suite,
 * tests/e2e-native-rebuild-musl.docker-e2e.test.ts, needs a real container).
 * Every case here runs the REAL shell functions via a tiny POSIX `sh`
 * harness, not a re-derivation of their logic in TypeScript — a text-scan
 * or a hand-copied reimplementation would prove nothing about what the
 * actual script does.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const LIB_SH = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');

function run(script: string, env: Record<string, string> = {}): string {
  return execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trimEnd();
}

const SOURCE = `. "${LIB_SH}"`;

describe('lockfile_key: sanitizes an npm spec into the on-disk lookup key', () => {
  it('strips a leading scope "@" and turns "/" into "-"', () => {
    expect(run(`${SOURCE}; lockfile_key '@img/sharp-linuxmusl-x64'`)).toBe(
      'img-sharp-linuxmusl-x64',
    );
  });

  it('leaves an unscoped name unchanged', () => {
    expect(run(`${SOURCE}; lockfile_key 'sqlite3'`)).toBe('sqlite3');
  });

  it('handles a deeper-scoped name (more than one "/") by replacing every slash', () => {
    expect(run(`${SOURCE}; lockfile_key '@scope/sub/name'`)).toBe('scope-sub-name');
  });
});

describe('pinned_lockfile_dir_for: finds a committed lockfile only when BOTH files are present', () => {
  it('returns the real committed dir for the pinned sharp-linuxmusl-x64@0.34.5 lockfile (#1257)', () => {
    const out = run(`${SOURCE}; pinned_lockfile_dir_for '@img/sharp-linuxmusl-x64' '0.34.5'`, {
      LOCKFILES_DIR: resolve(REPO_ROOT, 'scripts/musl-native-lockfiles'),
    });
    expect(out).toBe(
      resolve(REPO_ROOT, 'scripts/musl-native-lockfiles/img-sharp-linuxmusl-x64-0.34.5'),
    );
  });

  it('returns the real committed dir for the pinned sharp-libvips-linuxmusl-x64@1.2.4 lockfile (#1257)', () => {
    const out = run(
      `${SOURCE}; pinned_lockfile_dir_for '@img/sharp-libvips-linuxmusl-x64' '1.2.4'`,
      { LOCKFILES_DIR: resolve(REPO_ROOT, 'scripts/musl-native-lockfiles') },
    );
    expect(out).toBe(
      resolve(REPO_ROOT, 'scripts/musl-native-lockfiles/img-sharp-libvips-linuxmusl-x64-1.2.4'),
    );
  });

  it('is empty for a name@version this repo has no committed lockfile for (the fallback trigger)', () => {
    const out = run(`${SOURCE}; pinned_lockfile_dir_for '@img/sharp-linuxmusl-x64' '9.9.9'`, {
      LOCKFILES_DIR: resolve(REPO_ROOT, 'scripts/musl-native-lockfiles'),
    });
    expect(out).toBe('');
  });

  it('is empty when LOCKFILES_DIR is unset — the back-compat call shape never errors, just always misses', () => {
    const out = execFileSync(
      'sh',
      ['-c', `${SOURCE}; pinned_lockfile_dir_for '@img/sharp-linuxmusl-x64' '0.34.5'`],
      { encoding: 'utf8' },
    ).trimEnd();
    expect(out).toBe('');
  });

  it('is empty when a directory exists but is MISSING package-lock.json (a partial/corrupt pin must not be trusted)', () => {
    // Node's own mkdtempSync, not a bare `$TMPDIR` reference inside the `sh
    // -c` script — `$TMPDIR` is unset on the GitHub runner, so `mkdir -p
    // "$TMPDIR/partial-pin/..."` expanded to `mkdir -p "/partial-pin/..."`
    // and failed against the filesystem root, not a real scratch dir. This
    // test file is new on this branch (#1257), not present on main, so this
    // is fixed as part of making #1257 itself green, not a pre-existing
    // main regression.
    const scratch = mkdtempSync(join(tmpdir(), 'musl-partial-pin-'));
    try {
      const out = run(
        `${SOURCE}; mkdir -p "\${SCRATCH_DIR}/partial-pin/img-fake-pkg-1.0.0" && touch "\${SCRATCH_DIR}/partial-pin/img-fake-pkg-1.0.0/package.json" && LOCKFILES_DIR="\${SCRATCH_DIR}/partial-pin" pinned_lockfile_dir_for '@img/fake-pkg' '1.0.0'`,
        { SCRATCH_DIR: scratch },
      );
      expect(out).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
