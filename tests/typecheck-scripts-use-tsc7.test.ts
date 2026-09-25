import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { REPO_ROOT, readManifest, workspaceManifests } from './helpers/workspace-manifests';

/**
 * #1402 — every workspace `typecheck` script that invokes `tsc` invokes it
 * via the `typescript-tsc7` alias, not the plain `typescript` package.
 *
 * Nothing else pinned this down: with the root, `lib`, and `kn-next`
 * `typecheck` scripts hand-edited back to plain `tsc`, the full suite still
 * stayed green — plain `tsc` resolves fine (it's still a valid TypeScript
 * devDependency, just the slower 5.9.x binary), so no test failed loudly.
 * The only signal lost is speed, which nothing asserts. This guard makes
 * the binary choice itself the assertion, not a side effect of something
 * else failing.
 *
 * SCANS every workspace manifest's `scripts.typecheck` for the substring
 * `tsc` (a script invoking the TypeScript compiler at all) and requires
 * `typescript-tsc7` to appear alongside it — so a script that legitimately
 * never runs `tsc` (`packages/kn-next-alias`'s `node --check`, the CLI
 * bundle's own syntax check) is unaffected, but any script that DOES run
 * `tsc` must run the fast binary. A script with no `typecheck` field at all
 * is unaffected too — this guard is about which BINARY a typecheck runs,
 * not about mandating one exist (that's `ci-typecheck-contract.test.ts`'s
 * job).
 */

interface TypecheckScript {
  path: string;
  script: string;
}

/** Every workspace member's (+ root's) `scripts.typecheck`, if declared. */
function typecheckScripts(): TypecheckScript[] {
  const manifests = [readManifest(resolve(REPO_ROOT, 'package.json')), ...workspaceManifests()];
  return manifests.flatMap(({ path, pkg }) => {
    const scripts = pkg.scripts as Record<string, string> | undefined;
    const script = scripts?.typecheck;
    return script ? [{ path, script }] : [];
  });
}

describe('#1402 — every `tsc`-invoking typecheck script uses typescript-tsc7', () => {
  it('finds at least the known tsc7 consumers (an over-narrowed scan fails here)', () => {
    const found = typecheckScripts().map((t) => t.path);
    for (const known of [
      'package.json',
      'packages/lib/package.json',
      'packages/db/package.json',
      'packages/kn-next/package.json',
      'packages/ui/package.json',
      'apps/db-demo/package.json',
      'apps/file-manager/package.json',
    ]) {
      expect(found, `${known}'s typecheck script was not discovered`).toContain(known);
    }
  });

  it.each(typecheckScripts())('$path: a tsc-invoking typecheck script uses typescript-tsc7', ({
    path,
    script,
  }) => {
    if (!/\btsc\b/.test(script)) return; // doesn't invoke tsc at all — out of scope
    expect(
      script,
      `${path}'s typecheck script runs tsc but not via typescript-tsc7: "${script}"`,
    ).toContain('typescript-tsc7');
  });

  it('the detector distinguishes tsc-invoking scripts from non-tsc ones (self-test)', () => {
    expect(/\btsc\b/.test('node_modules/typescript-tsc7/bin/tsc --noEmit')).toBe(true);
    expect(/\btsc\b/.test('node --check bin/kn-next.js')).toBe(false);
  });
});
