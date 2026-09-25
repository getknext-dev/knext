import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh — the `apk add` toolchain install
 * (#1257 → #1425). The image's `apk add --no-cache <pkg1> <pkg2> ...`
 * pinned every package by NAME only, so a re-run at a later date can
 * silently pick up a newer (or index-revoked/republished) build of the
 * same package — unlike every `npm install` in this same script, which
 * #1257 round 7 made reproducible via a committed lockfile. #1425 closes
 * that gap by pinning each apk package to an EXACT `name=version` spec
 * (Alpine's `apk add pkg=X.Y.Z-rN` syntax — apk itself fails the whole
 * install if the pinned version is not in the currently configured index,
 * so a stale/wrong pin fails LOUD, not silently).
 *
 * This is a SCAN, not a hand-maintained list of package names — a new apk
 * package added later without a `=version` pin must fail this test, not
 * silently pass because nobody updated a checklist (workflow.md's "prefer
 * scanning to enumerating" rule, and this repo's own established pattern —
 * see tests/musl-rebuild-npm-run-as-builder.test.ts for the same shape
 * applied to `run_as_builder`).
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

/** Every `apk add` invocation line's package tokens (flags like `--no-cache` excluded), extracted from a real script source. */
function apkAddPackageTokens(source: string): string[] {
  const lines = source.split('\n').filter((l) => /^\s*apk add\b/.test(l));
  const tokens: string[] = [];
  for (const line of lines) {
    // Strip a trailing `>/dev/null`-style redirect (not a package token) and
    // the leading `apk add` command word itself.
    const withoutRedirect = line.replace(/>\s*\S+\s*$/, '');
    const words = withoutRedirect.trim().split(/\s+/).slice(2); // drop "apk" "add"
    for (const w of words) {
      if (w.startsWith('-')) continue; // a flag, e.g. --no-cache
      tokens.push(w);
    }
  }
  return tokens;
}

describe('every apk package in scripts/e2e-native-rebuild-musl.sh is pinned to an exact version (#1425)', () => {
  it('finds at least one apk add invocation — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(apkAddPackageTokens(source).length).toBeGreaterThan(0);
  });

  it('every apk package token carries an exact `=version` pin, not a bare name', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const tokens = apkAddPackageTokens(source);
    const unpinned = tokens.filter((t) => !t.includes('='));
    expect(unpinned).toEqual([]);
  });

  it('the scan correctly distinguishes a pinned token from a bare one (fixture proof)', () => {
    const pinnedLine = 'apk add --no-cache python3=3.12.3-r1 >/dev/null';
    const unpinnedLine = 'apk add --no-cache python3 >/dev/null';
    expect(apkAddPackageTokens(pinnedLine)).toEqual(['python3=3.12.3-r1']);
    expect(apkAddPackageTokens(unpinnedLine)).toEqual(['python3']);
  });

  it('a comment mentioning "apk add" in prose is not scanned as an invocation', () => {
    const prose = '# apk add costs a few seconds and the alpine repo carries a real toolchain';
    expect(apkAddPackageTokens(prose)).toEqual([]);
  });
});
