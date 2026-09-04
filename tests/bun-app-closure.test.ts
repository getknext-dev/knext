import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { filterSbomToClosure, resolveAppClosure } from '../scripts/lib/bun-app-closure.mjs';

/**
 * C1 / #785 — the production image's JS closure must be SCANNABLE.
 *
 * `scripts/lib/precompile-closure.mjs` walks an installed `node_modules` tree
 * directly. That works for `examples/bun-exec`, which is its own install root.
 * It does NOT work for `apps/file-manager` — the app the supply-chain lane
 * actually builds and pushes — because the workspace install uses bun's
 * ISOLATED store: `apps/file-manager/node_modules/<dep>` is a symlink into
 * `node_modules/.bun/<name>@<ver>+<hash>/node_modules/<name>`, and a dependency
 * of that package is a SIBLING there rather than a child of it.
 *
 * MEASURED on this repo's real tree before this module existed:
 *   - `installedPackages('apps/file-manager/node_modules')` → 56 packages, which
 *     is below the gate's floor of 100 and is NOT the transitive closure;
 *   - `syft scan dir:apps/file-manager/node_modules` → 0 npm components (syft
 *     does not follow symlinks that escape the scan root);
 *   - `syft scan dir:node_modules` (the workspace root) → 2064 npm components,
 *     but that is the WHOLE workspace, including every other package's dev
 *     tooling: 90 HIGH/CRITICAL findings, dominated by Go binaries vendored in
 *     dev CLIs and by test-only packages that are never compiled into the app
 *     binary. Gating the publish lane on those would mean ~40 allowlist entries
 *     for code that does not ship.
 *
 * Hence this module: resolve the app's OWN transitive closure by following
 * DECLARED dependency edges through the isolated store, then project the
 * workspace-wide syft SBOM onto exactly that set. Nothing here re-derives what
 * is installed from a lockfile — every package.json read is read off disk, so
 * the "the tree is what the compiler swallows, not the lockfile" property that
 * ADR-0042 C6 rests on is preserved.
 */

/** A minimal bun-isolated-store fixture: app + store, symlinks and all. */
function makeFixture(): { root: string; appDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'knext-closure-'));
  const store = join(root, 'node_modules', '.bun');

  const pkg = (dir: string, body: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(body));
  };

  // store: a@1 (deps b), b@1, d@1 (dev-only), orphan@1 (reachable from nothing)
  const storePkg = (name: string, version: string) =>
    join(store, `${name}@${version}`, 'node_modules', name);
  pkg(storePkg('a', '1.0.0'), { name: 'a', version: '1.0.0', dependencies: { b: '^1' } });
  pkg(storePkg('b', '1.0.0'), { name: 'b', version: '1.0.0' });
  pkg(storePkg('d', '1.0.0'), { name: 'd', version: '1.0.0' });
  pkg(storePkg('orphan', '9.9.9'), { name: 'orphan', version: '9.9.9' });
  // a scoped package, reached transitively from b — the layout that needs the
  // two-level "which directory is my node_modules" walk.
  pkg(join(store, '@scope+s@2.0.0', 'node_modules', '@scope', 's'), {
    name: '@scope/s',
    version: '2.0.0',
  });

  const link = (from: string, to: string) => {
    mkdirSync(join(from, '..'), { recursive: true });
    symlinkSync(relative(join(from, '..'), to), from);
  };

  // b's dependency edge on @scope/s, expressed the way bun expresses it.
  writeFileSync(
    join(storePkg('b', '1.0.0'), 'package.json'),
    JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { '@scope/s': '^2' } }),
  );
  link(
    join(store, 'b@1.0.0', 'node_modules', '@scope', 's'),
    join(store, '@scope+s@2.0.0', 'node_modules', '@scope', 's'),
  );
  link(join(store, 'a@1.0.0', 'node_modules', 'b'), storePkg('b', '1.0.0'));

  const appDir = join(root, 'apps', 'demo');
  pkg(appDir, {
    name: 'demo',
    version: '0.0.0',
    dependencies: { a: '^1' },
    devDependencies: { d: '^1' },
  });
  link(join(appDir, 'node_modules', 'a'), storePkg('a', '1.0.0'));
  link(join(appDir, 'node_modules', 'd'), storePkg('d', '1.0.0'));

  return { root, appDir };
}

describe('resolveAppClosure walks bun’s isolated store by DECLARED edges', () => {
  it('reaches transitive deps that live as store SIBLINGS, not as children', () => {
    const { appDir } = makeFixture();
    const { packages } = resolveAppClosure(appDir);
    // `b` is a dependency of `a`. In the isolated store it is NOT under
    // `.../a/node_modules/b` — it is a sibling of `a` inside `a@1.0.0/node_modules`.
    // A walker that only recurses into `<pkg>/node_modules` never sees it.
    expect([...packages.keys()].sort()).toEqual([
      '@scope/s@2.0.0',
      'a@1.0.0',
      'b@1.0.0',
      'd@1.0.0',
    ]);
  });

  it('excludes store packages nothing in the app depends on', () => {
    const { appDir } = makeFixture();
    const { packages } = resolveAppClosure(appDir);
    // The whole point: the workspace store holds every other package's dev
    // tooling. Scanning it wholesale is what produced 90 HIGH/CRITICAL findings
    // for code that is never compiled into the binary.
    expect([...packages.keys()]).not.toContain('orphan@9.9.9');
  });

  it('can exclude the app’s devDependencies', () => {
    const { appDir } = makeFixture();
    const { packages } = resolveAppClosure(appDir, { includeDev: false });
    expect([...packages.keys()].sort()).toEqual(['@scope/s@2.0.0', 'a@1.0.0', 'b@1.0.0']);
  });

  it('reports an unresolvable declared dependency instead of silently dropping it', () => {
    const { appDir } = makeFixture();
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { a: '^1', ghost: '^1' } }),
    );
    const { packages, unresolved } = resolveAppClosure(appDir);
    expect(unresolved.join(','), 'a declared dep that is not installed must be REPORTED').toContain(
      'ghost',
    );
    expect([...packages.keys()]).toContain('a@1.0.0');
  });

  it('throws on a missing app directory rather than returning an empty closure', () => {
    // An empty closure scans clean. A gate that answers "clean" when it was
    // pointed at nothing is the exact vacuity ADR-0042 C6 exists to prevent.
    expect(() => resolveAppClosure('/definitely/not/here')).toThrow();
  });
});

describe('filterSbomToClosure projects the workspace SBOM onto the app closure', () => {
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [
      { name: 'a', version: '1.0.0', purl: 'pkg:npm/a@1.0.0' },
      { name: 'b', version: '1.0.0', purl: 'pkg:npm/b@1.0.0' },
      { name: 'vitest', version: '4.0.18', purl: 'pkg:npm/vitest@4.0.18' },
      { name: 'stdlib', version: 'go1.20.7', purl: 'pkg:golang/std@go1.20.7' },
    ],
  };

  it('keeps only components the app closure actually contains', () => {
    const { sbom: out } = filterSbomToClosure(sbom, new Set(['a@1.0.0', 'b@1.0.0']));
    expect(out.components.map((c: { name: string }) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('drops non-npm components — the binary embeds JS, not vendored Go CLIs', () => {
    const { sbom: out } = filterSbomToClosure(sbom, new Set(['a@1.0.0', 'stdlib@go1.20.7']));
    expect(out.components.map((c: { name: string }) => c.name)).toEqual(['a']);
  });

  it('reports closure members the SBOM never catalogued (the coverage signal)', () => {
    const { missing } = filterSbomToClosure(sbom, new Set(['a@1.0.0', 'never-catalogued@3.0.0']));
    expect(missing).toEqual(['never-catalogued@3.0.0']);
  });

  it('preserves the CycloneDX envelope so grype still reads the document', () => {
    const { sbom: out } = filterSbomToClosure(sbom, new Set(['a@1.0.0']));
    expect(out.bomFormat).toBe('CycloneDX');
    expect(out.specVersion).toBe('1.6');
  });
});
