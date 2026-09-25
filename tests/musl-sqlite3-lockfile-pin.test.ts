import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1426 — a committed, `npm ci`-compatible lockfile pin for
 * `sqlite3@5.0.2` under `scripts/musl-native-lockfiles/`, generated via
 * `scripts/generate-musl-native-lockfile.sh sqlite3 5.0.2 --force` per the
 * issue and the script's own header. sqlite3 is the ORIGINAL motivating
 * case for `scripts/e2e-native-rebuild-musl.sh` (the ROUND 2/ROUND 7 notes
 * in that script's header) but, unlike the two `@img/sharp*` packages
 * #1257 pinned, had no committed lockfile — any fixture exercising its
 * musl rebuild still fell back to the non-reproducible fresh-install path.
 *
 * Wiring checked here (per the issue's own checklist):
 *   - `CREDENTIAL_CELLS`'s `MUSL_NATIVE_LOCKFILE_FILES`
 *     (scripts/compat-window-audit.mjs) — the per-cell frozen file list the
 *     compat-window fingerprint hashes; a new pinned lockfile must be
 *     declared there or the fingerprint's execution-scan test fails loud on
 *     an undeclared `${SCRIPT_DIR}/...` reference.
 *   - `scripts/e2e-deploy.sh`'s `docker run` mounts — each committed
 *     lockfile FILE is mounted individually (not the whole directory), the
 *     same pattern the sharp/libvips pair already uses.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const LOCKFILE_DIR = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles/sqlite3-5.0.2');
const PKG_JSON_REL = 'scripts/musl-native-lockfiles/sqlite3-5.0.2/package.json';
const LOCK_JSON_REL = 'scripts/musl-native-lockfiles/sqlite3-5.0.2/package-lock.json';

describe('scripts/musl-native-lockfiles/sqlite3-5.0.2 is a real, exact-version committed pin (#1426)', () => {
  it('both package.json and package-lock.json exist', () => {
    expect(existsSync(resolve(LOCKFILE_DIR, 'package.json'))).toBe(true);
    expect(existsSync(resolve(LOCKFILE_DIR, 'package-lock.json'))).toBe(true);
  });

  it('package.json declares an EXACT sqlite3 dependency spec — no caret/range (the #1415 fix this pin must honour)', () => {
    const pkg = JSON.parse(readFileSync(resolve(LOCKFILE_DIR, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.sqlite3).toBe('5.0.2');
  });

  it("package-lock.json's resolved sqlite3 version is exactly 5.0.2 — no drift to a newer release", () => {
    const lock = JSON.parse(readFileSync(resolve(LOCKFILE_DIR, 'package-lock.json'), 'utf8'));
    const resolved = lock.packages?.['node_modules/sqlite3']?.version;
    expect(resolved).toBe('5.0.2');
  });

  it('is a real npm-ci-compatible lockfile (lockfileVersion present, real integrity hash on the sqlite3 entry)', () => {
    const lock = JSON.parse(readFileSync(resolve(LOCKFILE_DIR, 'package-lock.json'), 'utf8'));
    expect(typeof lock.lockfileVersion).toBe('number');
    const entry = lock.packages?.['node_modules/sqlite3'];
    expect(typeof entry?.resolved).toBe('string');
    expect(entry.resolved).toContain('sqlite3');
    expect(typeof entry?.integrity).toBe('string');
    expect(entry.integrity.startsWith('sha512-')).toBe(true);
  });
});

describe('the sqlite3 lockfile pin is wired into CREDENTIAL_CELLS.extraFiles (#1426)', () => {
  it('scripts/compat-window-audit.mjs declares both sqlite3-5.0.2 files in MUSL_NATIVE_LOCKFILE_FILES', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs'), 'utf8');
    expect(source).toContain(PKG_JSON_REL);
    expect(source).toContain(LOCK_JSON_REL);
  });
});

describe('the sqlite3 lockfile pin is mounted by scripts/e2e-deploy.sh (#1426)', () => {
  it('the docker run block mounts both sqlite3-5.0.2 files individually, same pattern as the sharp/libvips pair', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/e2e-deploy.sh'), 'utf8');
    expect(source).toMatch(
      /musl-native-lockfiles\/sqlite3-5\.0\.2\/package\.json:\/musl-native-lockfiles\/sqlite3-5\.0\.2\/package\.json:ro/,
    );
    expect(source).toMatch(
      /musl-native-lockfiles\/sqlite3-5\.0\.2\/package-lock\.json:\/musl-native-lockfiles\/sqlite3-5\.0\.2\/package-lock\.json:ro/,
    );
  });
});

describe('.gitignore does not swallow the new committed lockfile (#1426, the #1415 incident this guards against)', () => {
  it('git actually tracks scripts/musl-native-lockfiles/sqlite3-5.0.2/package-lock.json once added', () => {
    // A real `.gitignore` check, not a text scan of the ignore file itself
    // (the exact incident from #1415: a blanket `package-lock.json` rule
    // silently swallowed a new pin until a negation was added for that one
    // directory) — `git check-ignore` is the authoritative answer.
    const { execFileSync } = require('node:child_process');
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', LOCK_JSON_REL], { cwd: REPO_ROOT, stdio: 'pipe' });
      ignored = true; // exit 0 means it WOULD be ignored
    } catch {
      ignored = false; // non-zero exit means it is NOT ignored
    }
    expect(ignored).toBe(false);
  });
});
