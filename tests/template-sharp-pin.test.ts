import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  dependencyRange,
  KNOWN_TEMPLATE_MANIFESTS,
  REPO_ROOT,
  templateManifests,
} from './helpers/workspace-manifests';

/**
 * #949 (C-1b) — every template's `sharp` pin stays inside the range the
 * compile's injection filter is PROVEN against.
 *
 * The single-executable compile replaces sharp's addon loader with a
 * `process.dlopen` shim via an `onLoad` filter that matches sharp >=0.35's
 * `dist/sharp.(m|c)js` layout. sharp 0.34 ships `lib/sharp.js` instead, so with
 * an 0.34 resolution the shim silently never injects and the compiled binary
 * cannot load sharp — observed live as a boot crash-loop (S3-V, finding C-1b).
 *
 * Widening the filter to 0.34's layout was REJECTED rather than done: that
 * loader is CJS (`module.exports = <addon>`) and injecting the ESM shim there
 * changes the require-interop shape unmeasured. The no-silent-path fix is a pin
 * the filter is proven against, held on BOTH sides:
 *
 *   - every template that scaffolds sharp pins `^0.35.x` — floor AND ceiling.
 *     The ceiling is deliberate (review round M3): `^0.35` cannot resolve to
 *     0.36, so the proof covers everything the pin can install. **Bumping to a
 *     new minor is a deliberate act**: re-prove the filter against the new
 *     sharp's layout (does `dist/sharp.mjs` still exist, still
 *     `export default <addon>`?), then move the `PROVEN_MINOR` below in the
 *     same change.
 *   - the filter still matches the proven layout, extracted from the shipped
 *     compile script rather than restated, so narrowing it reds here too.
 *
 * Scanned over EVERY template manifest via the shared walk, not the one
 * template someone remembered: the first version of this guard read only the
 * app template, and a mutation putting `^0.34` in the ZONE template reddened
 * nothing (review round F1).
 */

/** The sharp minor the injection filter has been proven against. */
const PROVEN_MINOR = 35;

/** Template manifests that scaffold sharp at all. */
function sharpTemplates(): { path: string; range: string }[] {
  return templateManifests().flatMap(({ path, pkg }) => {
    const range = dependencyRange(pkg, 'sharp');
    return range ? [{ path, range }] : [];
  });
}

describe('#949 — template sharp pins stay inside the injection-proven range', () => {
  it('the scan sees the known scaffolders (an over-narrowed scan fails here)', () => {
    const found = templateManifests().map((m) => m.path);
    for (const known of KNOWN_TEMPLATE_MANIFESTS) {
      expect(found, `${known} was not discovered by the template scan`).toContain(known);
    }
  });

  it('every template that ships sharp is covered — none opted out silently', () => {
    // Both known scaffolds generate an app whose entry imports sharp, so both
    // must carry a pin this guard can hold. A template DROPPING sharp is a
    // deliberate change that lands here first.
    const covered = sharpTemplates().map((t) => t.path);
    for (const known of KNOWN_TEMPLATE_MANIFESTS) {
      expect(
        covered,
        `${known} no longer declares sharp — either its generated app stopped importing sharp (update this guard) or the pin was lost (restore it)`,
      ).toContain(known);
    }
  });

  it.each(sharpTemplates())('$path pins sharp inside the proven minor', ({ path, range }) => {
    const m = /^\^(\d+)\.(\d+)\.\d+$/.exec(range);
    expect(
      m,
      `${path} pins sharp as '${range}' — expected a caret range ^0.${PROVEN_MINOR}.x`,
    ).not.toBeNull();
    expect(Number(m?.[1]), `${path}: sharp major moved`).toBe(0);
    // Floor AND ceiling: `^0.x` cannot cross the minor, so this one equality
    // bounds the whole resolvable range to what the filter is proven against.
    expect(
      Number(m?.[2]),
      `${path} pins sharp minor ${m?.[2]}, but the injection filter is proven against 0.${PROVEN_MINOR} only — re-prove the filter (see this file's header) before moving PROVEN_MINOR`,
    ).toBe(PROVEN_MINOR);
  });

  it('the compile filter still matches the proven dist/ layout', () => {
    const compile = readFileSync(
      resolve(REPO_ROOT, 'packages/kn-next/src/adapters/vinext-compile.mjs'),
      'utf8',
    );
    const filters = [...compile.matchAll(/filter:\s*\/(.+?)\/\s*\}/g)]
      .map((m) => m[1])
      .filter((p) => p.includes('sharp'));
    expect(filters, 'exactly one sharp onLoad filter in vinext-compile').toHaveLength(1);
    const filter = new RegExp(filters[0]);

    // The layout every sharp 0.35 resolution presents:
    expect(filter.test('/x/node_modules/sharp/dist/sharp.mjs')).toBe(true);
    expect(filter.test('/x/node_modules/sharp/dist/sharp.cjs')).toBe(true);
    expect(filter.test('/x/node_modules/sharp/dist/sharp.js')).toBe(true);
    // Never a lookalike from another package's tree:
    expect(filter.test('/x/node_modules/not-sharp/dist/sharp.mjs')).toBe(false);
  });
});
