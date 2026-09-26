import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh — the `apk add` toolchain install
 * (#1257 → #1425). The image's `apk add --no-cache <pkg1> <pkg2> ...`
 * pinned every package by NAME only, so a re-run at a later date can
 * silently pick up a newer (or index-revoked/republished) build of the
 * same package.
 *
 * NOT an exact `name=version-rN` pin, and deliberately so (coordinator
 * course-correction, #1425 round 2): Alpine's package mirrors keep only the
 * LATEST build of each package per release branch — an exact pin is
 * guaranteed to fail the very next time Alpine ships a security bump to any
 * of these packages, a recurring CI red unrelated to any change in this
 * repo. jev scored an exact pin 0.05 ("no, not the best option") against
 * this constraint, and a minor-locked fuzzy constraint 0.57 ("yes") — the
 * best of the three options weighed (custom digest-pinned image: 0.37, no
 * pin + documented tradeoff: 0.23). Alpine's OWN `apk add pkg~X.Y` syntax
 * (a fuzzy/prefix version match — see `apk add --help`) pins to the X.Y
 * minor, rejecting a minor/major drift, while still accepting the routine
 * patch-level security bumps a `=` pin would reject. The base image itself
 * is ALREADY digest-pinned (`STANDALONE_BUN_IMAGE`), so this pins the
 * remaining live-mirror-resolved layer to the same Alpine release's own
 * minor branch, not to a moving target.
 *
 * This is a SCAN, not a hand-maintained list of package names — a new apk
 * package added later without a `~X.Y` constraint must fail this test, not
 * silently pass because nobody updated a checklist (workflow.md's "prefer
 * scanning to enumerating" rule, and this repo's own established pattern —
 * see tests/musl-rebuild-npm-run-as-builder.test.ts for the same shape
 * applied to `run_as_builder`).
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

interface ApkScan {
  tokens: string[];
  /** Lines the scanner cannot statically resolve — a guard must FAIL on these, never skip them. */
  unparseable: string[];
}

/**
 * Every `apk add` invocation's package tokens (flags excluded), extracted from
 * a script source. Fails CLOSED: a line continuation, a variable/command
 * substitution, or a chained command on an `apk add` line is reported in
 * `unparseable` rather than silently ignored.
 */
function scanApkAdd(source: string): ApkScan {
  const tokens: string[] = [];
  const unparseable: string[] = [];
  for (const line of source.split('\n')) {
    if (!/^\s*(?:\S+\s+&&\s+)?apk\s+add\b/.test(line)) continue;
    const body = line.trim().replace(/\s*>\s*\S+\s*$/, ''); // trailing >/dev/null
    if (/[\\$`;|&(]/.test(body.replace(/^\S+\s+&&\s+/, ''))) {
      unparseable.push(line.trim());
      continue;
    }
    const words = body
      .replace(/^\S+\s+&&\s+/, '')
      .split(/\s+/)
      .slice(2); // drop "apk" "add"
    for (const w of words) {
      if (w.startsWith('-')) continue; // a flag, e.g. --no-cache
      tokens.push(w);
    }
  }
  return { tokens, unparseable };
}

function apkAddPackageTokens(source: string): string[] {
  return scanApkAdd(source).tokens;
}

/** Every shell script under scripts/ (recursive) — a scan, so a new script that installs via apk is covered automatically. */
function shellScripts(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...shellScripts(full));
    else if (e.name.endsWith('.sh')) out.push(full);
  }
  return out;
}

/** A `pkg~X.Y` (or deeper, `pkg~X.Y.Z`) minor-locked fuzzy version constraint — Alpine's `~` prefix-match operator, never a full `=X.Y.Z-rN` exact pin (which this repo has deliberately chosen NOT to use — see the file header). */
const MINOR_LOCK_RE = /^[^=~]+~\d+(\.\d+)+$/;

describe('every apk package in scripts/e2e-native-rebuild-musl.sh carries a minor-locked constraint (#1425)', () => {
  it('finds at least one apk add invocation — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(apkAddPackageTokens(source).length).toBeGreaterThan(0);
  });

  it('every apk package token carries a `~X.Y` minor-lock constraint, not a bare name', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const tokens = apkAddPackageTokens(source);
    const unpinned = tokens.filter((t) => !MINOR_LOCK_RE.test(t));
    expect(unpinned).toEqual([]);
  });

  it('EVERY shell script under scripts/ that runs `apk add` is fully pinned and fully parseable', () => {
    const problems: string[] = [];
    let scanned = 0;
    for (const f of shellScripts(SCRIPTS_DIR)) {
      const { tokens, unparseable } = scanApkAdd(readFileSync(f, 'utf8'));
      scanned += tokens.length;
      for (const u of unparseable) problems.push(`${f}: unparseable apk add line: ${u}`);
      for (const t of tokens) if (!MINOR_LOCK_RE.test(t)) problems.push(`${f}: unpinned ${t}`);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('fails closed on constructs it cannot parse (continuation, variable, chained command)', () => {
    for (const bad of [
      'apk add --no-cache python3~3.12 \\',
      'apk add --no-cache $PKGS',
      'apk add --no-cache python3~3.12; apk add make',
      'apk add --no-cache "$(cat pkgs)"',
    ]) {
      expect(scanApkAdd(bad).unparseable).toHaveLength(1);
    }
  });

  it('rejects an EXACT `=version-rN` pin too — that is the guaranteed-future-break shape this deliberately avoids', () => {
    const exactPinnedLine = 'apk add --no-cache python3=3.12.3-r1 >/dev/null';
    const tokens = apkAddPackageTokens(exactPinnedLine);
    const unpinned = tokens.filter((t) => !MINOR_LOCK_RE.test(t));
    expect(unpinned).toEqual(['python3=3.12.3-r1']);
  });

  it('the scan correctly distinguishes a minor-locked token from a bare one (fixture proof)', () => {
    const lockedLine = 'apk add --no-cache python3~3.12 >/dev/null';
    const unlockedLine = 'apk add --no-cache python3 >/dev/null';
    expect(apkAddPackageTokens(lockedLine)).toEqual(['python3~3.12']);
    expect(apkAddPackageTokens(unlockedLine)).toEqual(['python3']);
    expect(MINOR_LOCK_RE.test('python3~3.12')).toBe(true);
    expect(MINOR_LOCK_RE.test('python3')).toBe(false);
  });

  it('a comment mentioning "apk add" in prose is not scanned as an invocation', () => {
    const prose = '# apk add costs a few seconds and the alpine repo carries a real toolchain';
    expect(apkAddPackageTokens(prose)).toEqual([]);
  });
});
