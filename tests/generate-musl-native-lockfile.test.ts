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
      // techdebt-4 round-2 finding: this used to pass the REAL, resolvable
      // version `0.34.5` here despite the comment claiming "bogus" — a real
      // version DOES hit the network (a full registry resolution), which
      // this test's scope never needed: it only proves --force bypasses the
      // existing-DIRECTORY guard, not that a real resolution occurs. Using
      // an actually bogus, never-published version keeps that assertion
      // true while making the comment match the code, and matches the
      // (real) `must-not-exist` registry lookup pattern used by the sibling
      // test above rather than resolving a real package's transitive tree.
      const bogusVersion = '0.0.0-does-not-exist-techdebt4';
      const targetDir = join(
        dir,
        'musl-native-lockfiles',
        `img-sharp-linuxmusl-x64-${bogusVersion}`,
      );
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'package.json'), '{}');
      writeFileSync(join(targetDir, 'package-lock.json'), '{}');
      const r = run(script, ['@img/sharp-linuxmusl-x64', bogusVersion, '--force']);
      expect(r.stderr).not.toMatch(/already exists.*--force/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exact-version pin, real network (round-2 finding — the caret-range bug, #1415)', () => {
  /**
   * `@img/sharp-libvips-linuxmusl-x64` published 1.3.3 (newer than the
   * 1.2.4 this repo's corpus pins) AFTER the corpus lockfile was first
   * generated. Live-reproduced against the real registry while writing
   * this test: a `"^1.2.4"` dependency spec resolves to `1.3.3` today, not
   * `1.2.4` — proving the caret-range bug is real and current, not just
   * theoretical. The fix pins the EXACT version string (no `^`) and
   * verifies the resolved lockfile version matches before writing anything.
   */
  it('writes an exact version spec into the generated package.json, never a caret range', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.4', '--force']);
      expect(r.status).toBe(0);
      const targetDir = join(dir, 'musl-native-lockfiles', 'img-sharp-libvips-linuxmusl-x64-1.2.4');
      const pkgJson = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'));
      expect(pkgJson.dependencies['@img/sharp-libvips-linuxmusl-x64']).toBe('1.2.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the resolved lockfile version equals the exact requested version (no drift to a newer release)', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.4', '--force']);
      expect(r.status).toBe(0);
      const targetDir = join(dir, 'musl-native-lockfiles', 'img-sharp-libvips-linuxmusl-x64-1.2.4');
      const lock = JSON.parse(readFileSync(join(targetDir, 'package-lock.json'), 'utf8'));
      const resolved = lock.packages['node_modules/@img/sharp-libvips-linuxmusl-x64'].version;
      expect(resolved).toBe('1.2.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a caret-range VERSION argument outright, before any network call (no drift possible from a caller-supplied range)', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '^1.2.4']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
  });

  it('rejects a tilde-range VERSION argument outright', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '~1.2.4']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
  });

  it('rejects a wildcard/dist-tag VERSION argument outright (e.g. "latest")', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', 'latest']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
  });

  it('rejects an embedded x-range VERSION argument that still starts with a digit (e.g. "1.2.x") — the digit-prefix check alone would let this through to the network', () => {
    const { dir, script } = makeIsolatedCopy();
    try {
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.x']);
      expect(r.status).not.toBe(0);
      // Load-bearing distinction from the mismatch-guard tests above: this
      // must be refused by the UPFRONT validation, before any network call
      // — proven by asserting the "resolving ... against the real npm
      // registry" line never prints. Without this check, "1.2.x" starts
      // with a digit and passes the digit-prefix pattern, reaching the
      // network — the mismatch guard would still catch the drift
      // afterwards, but only after spending a real registry round-trip on
      // a request that was never going to be exact.
      expect(r.stderr).toMatch(/not an exact version/);
      expect(r.stderr).not.toMatch(/resolving @img/);
      const targetDir = join(dir, 'musl-native-lockfiles', 'img-sharp-libvips-linuxmusl-x64-1.2.x');
      expect(existsSync(targetDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Round-3 review finding (techdebt-4): the `*'x'*` substring check
   * rejects the LETTER x/X anywhere in the version string, contradicting
   * this file's own header comment ("Reject anything that is not a bare
   * dotted-numeric version WITH AN OPTIONAL PRERELEASE/BUILD SUFFIX") — a
   * real, legitimate prerelease tag containing the letter x as part of a
   * WORD (e.g. `next`, `hex`, `experimental`) is not an x-RANGE wildcard
   * and must not be rejected. The x-range check must only fire when
   * `x`/`X` is a whole DOT-DELIMITED SEGMENT (npm's actual `1.2.x` syntax),
   * never a substring inside an unrelated word.
   */
  it('does NOT reject a legitimate prerelease tag that merely CONTAINS the letter x as part of a word (e.g. "1.0.0-next.1") — jev 0.68 finding', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.0.0-next.1']);
    // Must pass the upfront validation stage — proven by reaching the real
    // network call (a different, later failure than the validation
    // rejection), not by asserting overall success (this prerelease
    // version does not actually exist on the registry, so the network
    // call itself fails — that failure is fine and expected; what must
    // NOT happen is the validation-stage rejection).
    expect(r.stderr).not.toMatch(/not an exact version/);
    expect(r.stderr).toMatch(/resolving @img/);
  });

  it('still rejects a REAL x-range even with prerelease-shaped digits around it (e.g. "1.2.x")', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.x']);
    expect(r.stderr).toMatch(/not an exact version/);
    expect(r.stderr).not.toMatch(/resolving @img/);
  });

  it('still rejects a bare "x" or "X" version', () => {
    for (const v of ['x', 'X']) {
      const { script } = makeIsolatedCopy();
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', v]);
      expect(r.stderr).toMatch(/not an exact version/);
    }
  });

  /**
   * jev 0.94 follow-up finding: the previous
   * `[0-9]*.[0-9]*.[0-9]* | [0-9]*.[0-9]* | [0-9]*` case-glob accepted a
   * BARE or PARTIAL version outright — "1" and "1.2" each matched their own
   * alternative exactly, reaching the real network with something that was
   * never a real pinned MAJOR.MINOR.PATCH. Proven the same way the other
   * validation-stage rejections above are: no network call is ever reached
   * (`resolving @img` never printed).
   */
  it('rejects a bare MAJOR version with no MINOR/PATCH at all (e.g. "1") — jev 0.94 finding', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
    expect(r.stderr).not.toMatch(/resolving @img/);
  });

  it('rejects a partial MAJOR.MINOR version with no PATCH (e.g. "1.2") — jev 0.94 finding', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
    expect(r.stderr).not.toMatch(/resolving @img/);
  });

  /**
   * jev 0.94 follow-up finding: the x-range whole-segment check only ever
   * stripped a "-" (prerelease) suffix before looking for a literal ".x."
   * segment — a BUILD-metadata suffix ("+build") glued directly onto the
   * wildcard segment left VERSION_CORE as "1.2.x+build" (no "-" to strip),
   * which contains no ".x." substring (it's ".x+", not ".x."), so both the
   * old digit-prefix case-glob (looose enough to match it anyway) and the
   * old x-range check let it through untouched.
   */
  it('rejects an x-range segment with a BUILD-metadata suffix glued onto it (e.g. "1.2.x+build") — jev 0.94 finding', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.x+build']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an exact version/);
    expect(r.stderr).not.toMatch(/resolving @img/);
  });

  it('still accepts a real version with BOTH a prerelease and a build-metadata suffix (e.g. "1.2.4-rc.1+build.5")', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.4-rc.1+build.5']);
    expect(r.stderr).not.toMatch(/not an exact version/);
    expect(r.stderr).toMatch(/resolving @img/);
  });

  /**
   * jev 0.49 finding: the ".x."/".X." whole-segment check wraps the FULL
   * VERSION argument in dots, so an x-range segment with a prerelease
   * suffix glued directly onto it (e.g. "1.2.x-foo") wraps to ".1.2.x-foo."
   * — which contains no ".x." substring, so it slipped through. npm itself
   * still reads "1.2.x-foo" as an x-range (the wildcard segment), not a
   * literal prerelease tag on a "x" patch version, so this must be rejected
   * the same as a bare "1.2.x". The check must consider only the VERSION
   * CORE — everything before the first "-" — when looking for a whole
   * x/X/* segment, never the full string with a prerelease suffix attached.
   */
  it('rejects an x-range segment with a prerelease suffix glued onto it (e.g. "1.2.x-foo") — jev 0.49 finding', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.x-foo']);
    expect(r.stderr).toMatch(/not an exact version/);
    expect(r.stderr).not.toMatch(/resolving @img/);
  });

  it('rejects a bare "x"/"X" version with a prerelease suffix glued onto it (e.g. "x-foo")', () => {
    for (const v of ['x-foo', 'X-foo']) {
      const { script } = makeIsolatedCopy();
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', v]);
      expect(r.stderr).toMatch(/not an exact version/);
      expect(r.stderr).not.toMatch(/resolving @img/);
    }
  });

  it('still does NOT reject a legitimate prerelease SUFFIX that is literally "x" (e.g. "1.2.3-x") — the wildcard check only applies to the version CORE, never the suffix', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '1.2.3-x']);
    expect(r.stderr).not.toMatch(/not an exact version/);
    expect(r.stderr).toMatch(/resolving @img/);
  });

  /**
   * Round-6 review nit: the all-digit segment check still accepted a
   * leading-zero segment ("01.2.3" — not valid semver, and not the string
   * npm would record, so the pin dir's name would never match), an EMPTY
   * suffix ("1.2.3+", "1.2.3-"), and a trailing dot ("1.2.3." — POSIX
   * field splitting drops the empty last field, so it still counted 3).
   */
  it('rejects a leading-zero segment, an empty or malformed suffix, and a trailing dot', () => {
    for (const v of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3+',
      '1.2.3-',
      '1.2.3-+b',
      '1.2.3-a..b',
      '1.2.3-a.',
      '1.2.3+b+c',
      '1.2.3-a+',
      '1.2.3-a_b',
      '1.2.3.',
    ]) {
      const { script } = makeIsolatedCopy();
      const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', v]);
      expect({ v, status: r.status === 0 }).toEqual({ v, status: false });
      expect({ v, stderr: /not an exact version/.test(r.stderr) }).toEqual({ v, stderr: true });
      expect(r.stderr).not.toMatch(/resolving @img/);
    }
  });

  it('still accepts a zero segment and a hyphenated prerelease (e.g. "0.10.0-rc-1.0+sha.0a1")', () => {
    const { script } = makeIsolatedCopy();
    const r = run(script, ['@img/sharp-libvips-linuxmusl-x64', '0.10.0-rc-1.0+sha.0a1']);
    expect(r.stderr).not.toMatch(/not an exact version/);
    expect(r.stderr).toMatch(/resolving @img/);
  });
});
