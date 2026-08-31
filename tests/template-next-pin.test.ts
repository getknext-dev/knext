import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Manifest,
  nextRange,
  REPO_ROOT,
  readManifest,
  WORKSPACE_DIRS,
  workspaceGlobs,
  workspaceManifests,
} from './helpers/workspace-manifests';

/**
 * #643 — every SCAFFOLDER's `next` pin equals the workspace's.
 *
 * `turbo gen zone` scaffolded 16.2.10 for weeks after #579 moved the workspace
 * (and `apps/*`, and the compat runs over them) to 16.2.11: PR #579 bumped the
 * manifests it could see and no guard covered the template trees. The parity
 * guard added in #642 (`create-scaffold-parity.test.ts`) is not that guard by
 * construction — it compares the two template trees' SHAPE files and buckets
 * `package.json.hbs` as LAYOUT, i.e. "compared on nothing". So pins were
 * covered by neither.
 *
 * Two design choices worth stating, because both are ways this guard could have
 * been written and been useless:
 *
 *   - It **derives** the expected version from the workspace rather than
 *     hardcoding it. A hardcoded expectation makes the next `next` bump a
 *     two-place edit, and editing a guard to get green is the failure mode this
 *     repo has already paid for (see `release-action-pins.test.ts`).
 *
 *   - It derives from the **workspace manifests**, NOT from
 *     `next-version-floor.test.ts`'s `FLOOR`. That constant is a *lower bound*
 *     (a CVE floor, asserted with `>=`); a template pinned at the floor while
 *     the workspace has moved to a later minor is exactly the drift this guard
 *     exists to catch, and deriving from the floor would call it green. Nor is
 *     the compat workflow's `NEXTJS_REF` (`v16.2.0`) the source: it is a
 *     deliberately-frozen git tag inside the compat window (ADR-0039) and sits
 *     *below* the CVE floor, so templates must not follow it either.
 *
 * And it SCANS for template manifests instead of listing the two we know about
 * — "we added a scaffolder and forgot the pin" IS this bug, so a third template
 * tree is covered the moment it lands.
 *
 * The workspace half of the scan lives in `helpers/workspace-manifests.ts`,
 * shared with `next-version-floor.test.ts`. Two copies of one scan is the same
 * defect class as the two copies of one root rule that the other half of this
 * PR removes.
 */

/** Directories a template tree is never found under. */
const SKIP_DIRS = new Set([
  '.git',
  '.claude',
  '.next',
  '.turbo',
  'node_modules',
  'coverage',
  'dist',
  'graphify-out',
  'out',
]);

/** The scaffolders that MUST be covered, so an over-narrowed scan cannot pass. */
const KNOWN_TEMPLATE_MANIFESTS = [
  'packages/kn-next/templates/app/package.json.hbs',
  'turbo/generators/templates/zone/package.json.hbs',
];

/** The exact `X.Y.Z` a `1.2.3` / `^1.2.3` / `>=1.2.3` range is anchored on. */
function versionOf(range: string): string {
  const m = range.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`next range "${range}" has no X.Y.Z to compare`);
  return m[1];
}

/**
 * Every `package.json` / `package.json.hbs` living under a `templates/`
 * directory, found by walking the repo. Scanned, not enumerated.
 */
function templateManifests(): Manifest[] {
  const found: Manifest[] = [];
  const walk = (dir: string, inTemplates: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), inTemplates || entry.name === 'templates');
      } else if (
        inTemplates &&
        (entry.name === 'package.json' || entry.name === 'package.json.hbs')
      ) {
        found.push(readManifest(join(dir, entry.name)));
      }
    }
  };
  walk(REPO_ROOT, false);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The single `next` version the workspace is built and compat-run against. */
function workspaceNextVersion(): string {
  const pinned = workspaceManifests().flatMap(({ path, pkg }) => {
    const range = nextRange(pkg);
    return range ? [{ path, version: versionOf(range) }] : [];
  });
  const versions = new Set(pinned.map((p) => p.version));
  if (versions.size !== 1) {
    // Name the manifests, not just the versions: "16.2.10, 16.2.11" says there
    // is a disagreement without saying which file to edit.
    const byManifest = pinned.map(({ path, version }) => `\n   * ${path}: ${version}`).join('');
    throw new Error(
      `the workspace does not agree on ONE next version:${byManifest || ' (no manifest declares next)'}`,
    );
  }
  return [...versions][0];
}

describe('#643 — template `next` pins track the workspace', () => {
  it('scans the same workspace globs pnpm-workspace.yaml declares', () => {
    expect(workspaceGlobs()).toEqual(WORKSPACE_DIRS.map((d) => `${d}/*`).sort());
  });

  it('derives ONE next version from the workspace (no hardcoded expectation)', () => {
    expect(workspaceNextVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('finds every known scaffolder by scanning (an over-narrowed scan fails here)', () => {
    const found = templateManifests().map((m) => m.path);
    // Both halves: the sanctioned trees ARE present…
    for (const known of KNOWN_TEMPLATE_MANIFESTS) {
      expect(found, `${known} was not discovered by the template scan`).toContain(known);
    }
    // …and nothing else slipped in unchecked. A new scaffolder must be added
    // here deliberately — but it is already pin-checked by the case below,
    // which is generated from the scan, not from this list.
    expect(found.filter((p) => !KNOWN_TEMPLATE_MANIFESTS.includes(p))).toEqual([]);
  });

  it.each(templateManifests())('$path declares a next pin at all', ({ pkg }) => {
    // A template manifest with no `next` would sail past the pin check below
    // by having nothing to compare — green-by-absence.
    expect(nextRange(pkg)).toBeDefined();
  });

  it.each(templateManifests())('$path pins the workspace next version', ({ path, pkg }) => {
    const range = nextRange(pkg);
    expect(range, `${path} declares no next dependency`).toBeDefined();
    expect(
      versionOf(range as string),
      `${path} scaffolds a next version the compat suite never exercised`,
    ).toBe(workspaceNextVersion());
  });
});
