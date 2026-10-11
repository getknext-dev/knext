import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * GUARD: every intra-repo dependency in a publishable `package.json` is declared
 * with the `workspace:` protocol in the COMMITTED tree.
 *
 * Why: a literal range such as `"@getknext/lib": "^1.3.0"` resolves against the
 * REGISTRY, not the workspace. After a major bump the published package would then
 * depend on the previous major of its sibling. Release tooling (the pack step in
 * install-smoke, `rewrite-workspace-ranges`) rewrites `workspace:` to literals in
 * the working tree on purpose, so a `git commit -a` after one of those runs can
 * commit the rewrite. Nothing else caught that (a review did).
 *
 * Scanned, not enumerated: sibling names come from the workspace itself.
 */

const ROOT = resolve(import.meta.dir, '..');
const DEP_GROUPS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

type Manifest = {
  dir: string;
  name: string;
  private?: boolean;
  [group: string]: unknown;
};

function readManifests(root: string): Manifest[] {
  const out: Manifest[] = [];
  for (const base of ['apps', 'packages']) {
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      const file = join(baseDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof pkg.name === 'string') out.push({ ...pkg, dir: `${base}/${entry.name}` });
    }
  }
  return out;
}

/** Violations: `<dir> <group>.<dep> = <range>` for a sibling not on `workspace:`. */
export function literalSiblingRanges(manifests: Manifest[]): string[] {
  const siblings = new Set(manifests.map((m) => m.name));
  const bad: string[] = [];
  for (const m of manifests) {
    if (m.private === true) continue;
    for (const group of DEP_GROUPS) {
      const deps = (m[group] ?? {}) as Record<string, string>;
      for (const [dep, range] of Object.entries(deps)) {
        if (siblings.has(dep) && !String(range).startsWith('workspace:')) {
          bad.push(`${m.dir} ${group}.${dep} = ${range}`);
        }
      }
    }
  }
  return bad.sort();
}

describe('the matcher itself', () => {
  const fixture = (lib: string, core: string): Manifest[] => [
    { dir: 'packages/lib', name: '@getknext/lib' },
    { dir: 'packages/db', name: '@getknext/db', dependencies: { '@getknext/lib': lib } },
    { dir: 'packages/alias', name: 'kn-next', dependencies: { '@getknext/core': core } },
    { dir: 'packages/core', name: '@getknext/core', devDependencies: { '@getknext/lib': lib } },
  ];

  it('accepts workspace: ranges', () => {
    expect(literalSiblingRanges(fixture('workspace:^', 'workspace:^'))).toEqual([]);
  });

  it('flags a literal range on any sibling in any dependency group, including kn-next', () => {
    expect(literalSiblingRanges(fixture('^1.3.0', '^1.3.0'))).toEqual([
      'packages/alias dependencies.@getknext/core = ^1.3.0',
      'packages/core devDependencies.@getknext/lib = ^1.3.0',
      'packages/db dependencies.@getknext/lib = ^1.3.0',
    ]);
  });

  it('does not flag third-party dependencies or private apps', () => {
    const manifests: Manifest[] = [
      { dir: 'packages/lib', name: '@getknext/lib', dependencies: { pino: '^9.0.0' } },
      { dir: 'apps/x', name: 'x', private: true, dependencies: { '@getknext/lib': '^1.0.0' } },
    ];
    expect(literalSiblingRanges(manifests)).toEqual([]);
  });
});

describe('the committed tree', () => {
  it('declares every sibling dependency of a publishable package with workspace:', () => {
    const manifests = readManifests(ROOT);
    // Non-vacuity: the group this guards must actually be present.
    for (const name of ['@getknext/core', '@getknext/db', '@getknext/lib', 'kn-next']) {
      expect(
        manifests.map((m) => m.name),
        `${name} missing from the scan`,
      ).toContain(name);
    }
    expect(literalSiblingRanges(manifests)).toEqual([]);
  });
});
