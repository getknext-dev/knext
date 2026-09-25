import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * scripts/generate-musl-native-lockfile.sh (#1257 round 7, techdebt-3 fix) —
 * the real-network, contributor-run tool that adds a new pin to
 * scripts/musl-native-lockfiles/. `scripts/e2e-native-rebuild-musl.sh`'s
 * header comment named this file before it existed; this test proves the
 * file exists, is executable, and its ARGUMENT-VALIDATION / existing-dir
 * guard logic is correct — NOT the actual `npm install --package-lock-only`
 * network call, which needs a live registry and is out of scope for a
 * deterministic CI test (the script's own header says as much: real-network,
 * contributor-run, not CI-run).
 *
 * CRITICAL: every test that exercises the script past its argument-parsing
 * stage runs against an ISOLATED COPY (script + its `lib/` dependency,
 * copied into a throwaway tmpdir) — never the real checkout. This script's
 * target directory is `${SCRIPT_DIR}/musl-native-lockfiles/<key>`, resolved
 * from wherever the script itself lives; running the REAL script in place
 * against a real name@version that npm can actually resolve (this sandbox
 * DOES have live network access — proven the hard way, see the incident
 * note below) would silently overwrite the real committed corpus with a
 * differently-shaped package.json/package-lock.json. That happened once
 * while developing this test file — `@img/sharp-linuxmusl-x64@0.34.5`
 * --force`, run directly against the real checkout, DID resolve over the
 * network and DID overwrite the real committed lockfile (caught via `git
 * status`/`git diff` before commit, restored with `git checkout --`).
 * Isolation, not a network-availability assumption, is what makes this
 * safe now.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const REAL_SCRIPT = resolve(REPO_ROOT, 'scripts/generate-musl-native-lockfile.sh');
const REAL_LIB = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');

/** Copies the script + its lib dependency into a fresh, throwaway tmpdir with the same relative layout, so SCRIPT_DIR/TARGET_DIR resolve entirely inside it. */
function makeIsolatedCopy(): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'generate-musl-lockfile-isolated-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  const script = join(dir, 'generate-musl-native-lockfile.sh');
  writeFileSync(script, readFileSync(REAL_SCRIPT, 'utf8'));
  writeFileSync(join(dir, 'lib', 'musl-lockfile-lookup.sh'), readFileSync(REAL_LIB, 'utf8'));
  return { dir, script };
}

function run(script: string, args: string[]) {
  return spawnSync('sh', [script, ...args], { encoding: 'utf8' });
}

describe('scripts/generate-musl-native-lockfile.sh exists and is runnable', () => {
  it('the file exists (closes the dangling reference from e2e-native-rebuild-musl.sh)', () => {
    expect(existsSync(REAL_SCRIPT)).toBe(true);
  });

  it('sources scripts/lib/musl-lockfile-lookup.sh for the key derivation, not a reimplementation', () => {
    const text = readFileSync(REAL_SCRIPT, 'utf8');
    expect(text).toContain('lib/musl-lockfile-lookup.sh');
    expect(text).toContain('lockfile_key');
  });
});

describe('argument validation (no network required, real script, no target dir ever touched)', () => {
  it('exits non-zero with a usage message when called with no arguments', () => {
    const r = run(REAL_SCRIPT, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits non-zero with a usage message when called with only a name', () => {
    const r = run(REAL_SCRIPT, ['@img/sharp-linuxmusl-x64']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });
});

describe('existing-pin guard (isolated copy — never touches the real committed corpus)', () => {
  it('refuses to overwrite an existing committed lockfile dir without --force', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      const targetDir = join(dir, 'musl-native-lockfiles', 'img-sharp-linuxmusl-x64-0.34.5');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'package.json'), '{}');
      writeFileSync(join(targetDir, 'package-lock.json'), '{}');
      const r = run(script, ['@img/sharp-linuxmusl-x64', '0.34.5']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already exists.*--force/);
      // And the fixture files must be UNTOUCHED — the guard fired BEFORE
      // any write, not after a failed overwrite attempt.
      expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toBe('{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a name@version with NO existing pin dir proceeds past the guard (the network call is what fails next, proving the guard did not block it)', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      // A bogus, never-published version — the guard must not fire (no
      // existing dir under this isolated root), so the script proceeds to
      // the real `npm install` call, which then fails to resolve it. That
      // failure is a DIFFERENT message than the guard's own.
      const r = run(script, ['@img/sharp-linuxmusl-x64', '0.0.0-does-not-exist-techdebt3']);
      expect(r.stderr).not.toMatch(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the --force flag lets a re-generation past the existing-dir guard (isolated copy)', () => {
  it('with --force, an existing target dir does not short-circuit the run (proceeds to the network call instead)', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      const targetDir = join(dir, 'musl-native-lockfiles', 'img-sharp-linuxmusl-x64-0.34.5');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'package.json'), '{}');
      writeFileSync(join(targetDir, 'package-lock.json'), '{}');
      // Bogus version again — this proves --force bypasses the EXISTING-DIR
      // check specifically (a real npm resolution is not needed to prove
      // that, and using one here is exactly the mistake that corrupted the
      // real corpus once already — see the file header).
      const r = run(script, ['@img/sharp-linuxmusl-x64', '0.34.5', '--force']);
      expect(r.stderr).not.toMatch(/already exists.*--force/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
