/**
 * The landing page's footer version pill must be DERIVED from
 * `packages/kn-next/package.json#version`, never a hardcoded string — a
 * hand-typed pill is exactly how "v0.1 · alpha" survived past three
 * publishes. Two things are checked: the pill-building logic itself, and
 * that the landing page source actually imports the derived value instead
 * of writing its own literal.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prereleaseTag, stageLabel, versionPillText } from './lib/version-label';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/kn-next/package.json'), 'utf-8')) as {
    version: string;
  }
).version;
const HOME_PAGE_SOURCE = readFileSync(resolve(import.meta.dirname, 'app/(home)/page.tsx'), 'utf-8');

describe('version-label — stage derivation', () => {
  it('has no prerelease tag, and no stage label, for a stable version', () => {
    expect(prereleaseTag('1.0.0')).toBeNull();
    expect(stageLabel('1.0.0')).toBeNull();
    expect(versionPillText('1.0.0')).toBe('v1.0.0');
  });

  it('labels an `-rc.N` prerelease as "release candidate"', () => {
    expect(prereleaseTag('1.0.0-rc.2')).toBe('rc');
    expect(stageLabel('1.0.0-rc.2')).toBe('release candidate');
    expect(versionPillText('1.0.0-rc.2')).toBe('v1.0.0-rc.2 · release candidate');
  });

  it('labels a `-beta.N` prerelease as "beta" and `-alpha.N` as "alpha"', () => {
    expect(versionPillText('2.0.0-beta.1')).toBe('v2.0.0-beta.1 · beta');
    expect(versionPillText('0.9.0-alpha.3')).toBe('v0.9.0-alpha.3 · alpha');
  });

  it('never claims "stable" for a prerelease version', () => {
    expect(versionPillText('1.0.0-rc.2')).not.toMatch(/stable/i);
  });
});

describe('version-label — tracks the real published version', () => {
  it("packages/kn-next/package.json's real version, run through the same derivation, is internally consistent", () => {
    // Whatever the real version is today (rc, beta, or stable), the derived
    // pill for it must never lie: an rc must say "release candidate", never
    // "stable", and the version number embedded in the pill must be the
    // real one — not a stale literal.
    const pill = versionPillText(PKG_VERSION);
    expect(pill).toContain(PKG_VERSION);
    const tag = prereleaseTag(PKG_VERSION);
    if (tag === 'rc') {
      expect(pill).toContain('release candidate');
      expect(pill).not.toMatch(/stable/i);
    } else if (tag === null) {
      expect(pill).toBe(`v${PKG_VERSION}`);
    }
  });
});

describe('landing page — footer pill is derived, not hardcoded', () => {
  it('imports the derived pill text from lib/version-label, not a bare literal', () => {
    expect(HOME_PAGE_SOURCE).toMatch(/from ['"]\.\.\/\.\.\/lib\/version-label['"]/);
    expect(HOME_PAGE_SOURCE).toMatch(/currentPillText/);
  });

  it('never hardcodes a stale version/stage pill literal in the page source', () => {
    // These are exactly the literals a hand-typed pill has used in the past.
    // A future regression that pastes a literal back in (instead of using
    // the derived `currentPillText`) must fail here.
    expect(HOME_PAGE_SOURCE).not.toMatch(/v0\.1\s*·\s*alpha/i);
    expect(HOME_PAGE_SOURCE).not.toMatch(/>\s*v\d+\.\d+(\.\d+)?\s*·\s*(alpha|beta|stable)\s*</i);
  });
});
