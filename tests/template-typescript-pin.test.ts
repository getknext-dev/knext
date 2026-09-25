import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  dependencyRange,
  KNOWN_TEMPLATE_MANIFESTS,
  REPO_ROOT,
  readManifest,
  templateManifests,
} from './helpers/workspace-manifests';

/**
 * #1402 — every scaffolder's `typescript` pin tracks the TS7 range verified
 * for scaffolded apps, the same lockstep discipline `template-next-pin.test.ts`
 * (#643) and `template-sharp-pin.test.ts` (#949) already hold for `next` and
 * `sharp` — just against a DIFFERENT source of truth than those two.
 *
 * This is deliberately NOT "derive from the workspace's own `typescript`
 * pin" the way next/sharp are, and that took a real regression to learn
 * (`.claude/research/ts7-migration-plan.md`'s corrected finding): the
 * monorepo's OWN `typescript` devDependency must stay a classic-API-capable
 * version (`^5.9.3`) because `tsup`'s DTS bundling (`rollup-plugin-dts`)
 * `require`s the plain `typescript` package directly and needs `ts.sys` — which TS7's
 * default export does not expose. Bumping the workspace's plain
 * `typescript` to `^7` broke `packages/{kn-next,lib}`'s `tsup` DTS build
 * outright (`TypeError: Cannot read properties of undefined (reading
 * 'useCaseSensitiveFileNames')`), caught only by a REAL `bun install` +
 * `turbo build` after a prior verification was contaminated by a stale,
 * manually-placed `node_modules/typescript` directory left over from
 * ad hoc testing.
 *
 * A SCAFFOLDED app has no such constraint — it never runs `tsup`, `next
 * build` does its own typechecking and was independently verified clean and
 * fast under TS7 — so the template pin tracks the fast `typescript-tsc7`
 * alias (`npm:typescript@^7.0.2` in the root manifest, added purely to run
 * the ROOT `typecheck` script's `tsc` binary quickly) rather than the
 * workspace's own `typescript` field. Deriving from that alias, rather than
 * hardcoding `^7.0.2` here, keeps a future TS7 bump a one-place edit.
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

/** The `^X.Y.Z` range embedded in the root manifest's `typescript-tsc7`
 * alias (`npm:typescript@^X.Y.Z`) — the TS7 range verified for scaffolded
 * apps, independent of the workspace's own (classic-API) `typescript` pin. */
function verifiedScaffoldTypescriptRange(): string {
  const { pkg } = readManifest(resolve(REPO_ROOT, 'package.json'));
  const alias = dependencyRange(pkg, 'typescript-tsc7');
  const m = /^npm:typescript@(\^\d+\.\d+\.\d+)$/.exec(alias ?? '');
  if (!m) {
    throw new Error(
      `root package.json's "typescript-tsc7" alias is missing or not a plain "npm:typescript@^X.Y.Z" range: ${alias}`,
    );
  }
  return m[1];
}

describe('#1402 — template `typescript` pins track the verified-TS7 range', () => {
  it('the root manifest declares a well-formed typescript-tsc7 alias (no hardcoded expectation)', () => {
    expect(verifiedScaffoldTypescriptRange()).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it.each(templateManifests())('$path declares a typescript pin at all', ({ pkg }) => {
    // A template manifest with no `typescript` sails past the pin check
    // below by having nothing to compare — green-by-absence.
    expect(dependencyRange(pkg, 'typescript')).toBeDefined();
  });

  it.each(templateManifests())('$path pins the verified-TS7 range', ({ path, pkg }) => {
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${path} declares no typescript dependency`).toBeDefined();
    expect(range, `${path} scaffolds a typescript range the TS7 spike never exercised`).toBe(
      verifiedScaffoldTypescriptRange(),
    );
  });

  it(`${VINEXT_TEMPLATE} pins the verified-TS7 range too (out of the shared scan's scope)`, () => {
    expect(KNOWN_TEMPLATE_MANIFESTS).not.toContain(VINEXT_TEMPLATE);
    const { pkg } = readManifest(resolve(REPO_ROOT, VINEXT_TEMPLATE));
    const range = dependencyRange(pkg, 'typescript');
    expect(range, `${VINEXT_TEMPLATE} declares no typescript dependency`).toBeDefined();
    expect(range).toBe(verifiedScaffoldTypescriptRange());
  });
});
