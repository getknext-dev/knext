import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  dependencyRange,
  KNOWN_TEMPLATE_MANIFESTS,
  REPO_ROOT,
  readManifest,
  templateManifests,
  workspaceManifests,
} from './helpers/workspace-manifests';

/**
 * #1402 — every scaffolder's `typescript` pin tracks the workspace's TS 7
 * pin, the same lockstep discipline `template-next-pin.test.ts` (#643) and
 * `template-sharp-pin.test.ts` (#949) already hold for `next` and `sharp`.
 *
 * The workspace moved to `typescript@^7.0.2` for `tsc` typechecking (the
 * spike in `.claude/research/ts7-migration-plan.md`: TS7's default export
 * drops the classic compiler API, but `tsc` itself typechecks the repo — and
 * a scaffolded app's own `next build` — cleanly and ~5-7x faster). A
 * scaffolder left behind on `^5` would hand new users a slower, unverified
 * toolchain the moment the workspace itself moved past it — exactly the
 * "we bumped the workspace and forgot the template" bug class #643 exists
 * to catch, just for a different dependency.
 *
 * Derives the expected version from the workspace rather than hardcoding it,
 * for the same reason #643 gives: a hardcoded expectation turns the next
 * bump into a two-place edit, and editing a guard to get green is the
 * failure mode `release-action-pins.test.ts`'s header already names.
 *
 * `package.json.vinext.hbs` (the `--builder vinext` content override, #1342)
 * is checked separately: `templateManifests()`'s scan matches only
 * `package.json`/`package.json.hbs` by construction (shared with the next-
 * and sharp-pin guards), so a `.vinext.hbs` pin is invisible to it. Rather
 * than widen that shared scan (and risk the sharp/next guards picking up a
 * manifest their own scope notes deliberately exclude), this file reads it
 * directly with the same `readManifest` used everywhere else.
 */

const VINEXT_TEMPLATE = 'packages/kn-next/templates/app/package.json.vinext.hbs';

/** The single `typescript` major.minor.patch the workspace is pinned to. */
function workspaceTypescriptVersion(): string {
  const pinned = workspaceManifests().flatMap(({ path, pkg }) => {
    const range = dependencyRange(pkg, 'typescript');
    return range ? [{ path, range }] : [];
  });
  const versions = new Set(pinned.map((p) => p.range));
  if (versions.size !== 1) {
    const byManifest = pinned.map(({ path, range }) => `\n   * ${path}: ${range}`).join('');
    throw new Error(
      `the workspace does not agree on ONE typescript range:${byManifest || ' (no manifest declares typescript)'}`,
    );
  }
  return [...versions][0];
}

describe('#1402 — template `typescript` pins track the workspace', () => {
  it('derives ONE typescript range from the workspace (no hardcoded expectation)', () => {
    expect(workspaceTypescriptVersion()).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it.each(templateManifests())('$path declares a typescript pin at all', ({ pkg }) => {
    // A template manifest with no `typescript` sails past the pin check
    // below by having nothing to compare — green-by-absence.
    expect(dependencyRange(pkg, 'typescript')).toBeDefined();
  });

  it.each(templateManifests())('$path pins the workspace typescript range', ({ path, pkg }) => {
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${path} declares no typescript dependency`).toBeDefined();
    expect(range, `${path} scaffolds a typescript range the TS7 spike never exercised`).toBe(
      workspaceTypescriptVersion(),
    );
  });

  it(`${VINEXT_TEMPLATE} pins the workspace typescript range too (out of the shared scan's scope)`, () => {
    expect(KNOWN_TEMPLATE_MANIFESTS).not.toContain(VINEXT_TEMPLATE);
    const { pkg } = readManifest(resolve(REPO_ROOT, VINEXT_TEMPLATE));
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${VINEXT_TEMPLATE} declares no typescript dependency`).toBeDefined();
    expect(range).toBe(workspaceTypescriptVersion());
  });
});
