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
 * #1402 — every scaffolder's `typescript` pin tracks the workspace's
 * `typescript` pin, the same lockstep discipline `template-next-pin.test.ts`
 * (#643) and `template-sharp-pin.test.ts` (#949) already hold for `next` and
 * `sharp`.
 *
 * **The default scaffold stays on TS 5.9.x, not TS7 (2026-09-25 decision,
 * founder-flaggable).** TS7 is real and verified for scaffolded apps in
 * isolation — a real scaffold builds and tests clean on both builders, and
 * `next build`'s own TS7 typecheck is real — but a user's STANDARD toolchain
 * around the app breaks on it: `typescript-eslint` does not support TS7
 * (peer range `<6.1.0`, so `eslint-config-next` fails outright), and TS7
 * ships no `tsserver.js`, so editor "workspace TypeScript" and the `next`
 * tsconfig plugin both stop working. See the docs site's TS7 page for the
 * documented opt-in path and what breaks. This guard exists precisely so a
 * later change can't silently re-bump the scaffold default without also
 * updating that doc.
 *
 * The monorepo's OWN `typescript` devDependency also stays `^5.9.3`
 * (classic-API-capable, required by `tsup`'s DTS bundling — see
 * `.claude/research/ts7-migration-plan.md`'s correction), so — unlike the
 * separate `typescript-tsc7` alias this repo carries purely to run the root
 * `typecheck` script's `tsc` binary fast — workspace and template are back
 * in the SAME lockstep relationship next/sharp already use: derive from the
 * workspace, don't hardcode.
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

/** The single `typescript` range the workspace is pinned to. */
function workspaceTypescriptRange(): string {
  const pinned = workspaceManifests().flatMap(({ path, pkg }) => {
    const range = dependencyRange(pkg, 'typescript');
    return range ? [{ path, range }] : [];
  });
  const ranges = new Set(pinned.map((p) => p.range));
  if (ranges.size !== 1) {
    const byManifest = pinned.map(({ path, range }) => `\n   * ${path}: ${range}`).join('');
    throw new Error(
      `the workspace does not agree on ONE typescript range:${byManifest || ' (no manifest declares typescript)'}`,
    );
  }
  return [...ranges][0];
}

describe('#1402 — template `typescript` pins track the workspace (TS7 stays opt-in)', () => {
  it('derives ONE typescript range from the workspace (no hardcoded expectation)', () => {
    expect(workspaceTypescriptRange()).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it('the workspace default is NOT TS7 — eslint/editor breakage, TS7 is opt-in only', () => {
    // Both halves: a caret-anything-else can slip past a "not ^7" check as
    // easily as ^7 itself, so pin to the exact decided default rather than
    // merely excluding one bad answer.
    expect(workspaceTypescriptRange()).toBe('^5.9.3');
  });

  it.each(templateManifests())('$path declares a typescript pin at all', ({ pkg }) => {
    // A template manifest with no `typescript` sails past the pin check
    // below by having nothing to compare — green-by-absence.
    expect(dependencyRange(pkg, 'typescript')).toBeDefined();
  });

  it.each(templateManifests())('$path pins the workspace typescript range', ({ path, pkg }) => {
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${path} declares no typescript dependency`).toBeDefined();
    expect(range, `${path} scaffolds a typescript range the workspace never exercised`).toBe(
      workspaceTypescriptRange(),
    );
  });

  it(`${VINEXT_TEMPLATE} pins the workspace typescript range too (out of the shared scan's scope)`, () => {
    expect(KNOWN_TEMPLATE_MANIFESTS).not.toContain(VINEXT_TEMPLATE);
    const { pkg } = readManifest(resolve(REPO_ROOT, VINEXT_TEMPLATE));
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${VINEXT_TEMPLATE} declares no typescript dependency`).toBeDefined();
    expect(range).toBe(workspaceTypescriptRange());
  });
});
