/**
 * The landing page footer's version pill must always track the real published
 * version — never a hand-typed string that can drift the moment a release
 * ships. `packages/kn-next/package.json#version` is the single source of
 * truth (all three publishable `@getknext/*` packages release in lockstep,
 * see /docs/versioning), so this module derives the pill text from that file
 * at build time instead of letting the page hardcode one.
 */
import pkg from '../../../packages/kn-next/package.json';

const KNOWN_PRERELEASE_STAGES: Record<string, string> = {
  rc: 'release candidate',
  beta: 'beta',
  alpha: 'alpha',
};

/**
 * Extracts a semver prerelease identifier (e.g. `rc` from `1.0.0-rc.2`),
 * or `null` for a stable version with no prerelease segment.
 */
export function prereleaseTag(version: string): string | null {
  const match = version.match(/-([a-zA-Z]+)(?:[.\d]+)?$/);
  return match ? match[1].toLowerCase() : null;
}

/** A human-readable stage label for a prerelease tag, or `null` for stable. */
export function stageLabel(version: string): string | null {
  const tag = prereleaseTag(version);
  if (!tag) return null;
  return KNOWN_PRERELEASE_STAGES[tag] ?? tag;
}

/**
 * The full pill text: `v<version>` for a stable release, or
 * `v<version> · <stage>` for a prerelease (e.g. `v1.0.0-rc.2 · release candidate`).
 */
export function versionPillText(version: string): string {
  const stage = stageLabel(version);
  return stage ? `v${version} · ${stage}` : `v${version}`;
}

export const currentVersion: string = pkg.version;
export const currentPillText: string = versionPillText(currentVersion);
