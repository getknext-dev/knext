/**
 * The PR-time half of the install-smoke coverage guarantee.
 *
 * `scripts/install-smoke.mjs` proves at RUN time that every publishable package
 * packs, installs and runs on plain npm/Node. That is the expensive half — a full
 * pack + clean install per run — and it can only ever prove coverage is right
 * TODAY. It cannot catch the derivation being swapped for a hardcoded list that
 * happens to name every package publishable today and silently misses the next
 * one. That is the miss this file exists for, and it is the same failure the gate
 * itself was written to close, one level up.
 *
 * Same division of labour the action-pin and anonymous-install gates use: form at
 * PR time, value at run time.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { publishablePackages, readWorkspaceManifests } from '../scripts/publish-preflight.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(REPO_ROOT, 'scripts', 'install-smoke.mjs');

const source = () => readFileSync(SMOKE, 'utf8');
const changesetIgnore = () =>
  (
    JSON.parse(readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8')) as {
      ignore?: string[];
    }
  ).ignore ?? [];
/**
 * The publishable packages WITH their workspace directories.
 *
 * `publishablePackages` is a `.filter()`, so it passes `dir` through at runtime, but its
 * JSDoc param type omits it and TypeScript narrows the return accordingly. Re-joining
 * against the manifests keeps the shared helper's typing alone.
 */
const publishable = () => {
  const manifests = readWorkspaceManifests(REPO_ROOT);
  const names = new Set(publishablePackages(manifests, changesetIgnore()).map((p) => p.name));
  return manifests.filter((m) => names.has(m.name));
};

/** Every `join(repoRoot, 'packages', 'x')` the gate names, as leaf directory names. */
function packageDirsNamedInGate(src: string): string[] {
  return [...src.matchAll(/join\(\s*repoRoot,\s*'packages',\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
}

describe('install-smoke covers the publishable set', () => {
  it('derives the covered set from the publishable helper, not a hardcoded list', () => {
    // Without this, both directions of the run-time assertion can be satisfied by a
    // literal array — green today, blind to the fifth package.
    const src = source();
    expect(src).toMatch(/publishablePackages\(/);
    expect(src).toMatch(/readWorkspaceManifests\(/);
  });

  it('asserts BOTH directions at run time', () => {
    // A publishable package the gate does not pack, and a package the gate packs
    // that is not publishable. One without the other is half a guarantee.
    const src = source();
    expect(src).toMatch(/const uncovered = publishable\.filter\(/);
    expect(src).toMatch(/const unpublished = packed\.filter\(/);
  });

  it('names a package directory for every publishable package', () => {
    // The PR-time catch: adding a publishable package without adding it here fails
    // in review rather than after a four-minute pack-and-install cycle.
    const named = packageDirsNamedInGate(source());
    for (const pkg of publishable()) {
      const leaf = pkg.dir.split('/').pop();
      expect(
        named,
        `${pkg.name} (${pkg.dir}) is publishable but scripts/install-smoke.mjs never packs it — ` +
          'a consumer path nothing else proves',
      ).toContain(leaf);
    }
  });

  it('names no package directory that is not publishable', () => {
    const publishableLeaves = new Set(publishable().map((p) => p.dir.split('/').pop()));
    for (const leaf of packageDirsNamedInGate(source())) {
      expect(
        publishableLeaves,
        `scripts/install-smoke.mjs packs packages/${leaf}, which does not publish — ` +
          'the gate and the release set disagree',
      ).toContain(leaf);
    }
  });

  it('resolves the alias bin through the installed manifest, not a hardcoded filename', () => {
    // Renaming the shim and its `bin` mapping together is legitimate; a hardcoded
    // path would fail the release for it.
    expect(source()).toMatch(/\.bin\?\.\['kn-next'\]/);
  });
});
