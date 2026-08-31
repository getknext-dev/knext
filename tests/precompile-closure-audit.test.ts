import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANCHOR_PACKAGES,
  evaluateFindings,
  FAILING_SEVERITIES,
  installedPackages,
  MIN_INSTALLED_PACKAGES,
  MIN_NPM_COMPONENTS,
  npmComponents,
  readAllowlist,
  verifyClosureCoverage,
} from '../scripts/lib/precompile-closure.mjs';

/**
 * ADR-0042 Consequence 6 / #764 — the pre-compile closure gate's logic.
 *
 * The vinext build target compiles its whole JS dependency graph into ONE
 * bun binary. An image scan of that binary sees Alpine packages and nothing
 * else, which is the "vacuously green" reasoning ADR-0042 used to reject
 * `FROM scratch`. The only scannable surface left is the closure that feeds
 * `vite build` — the resolved node_modules tree — so the gate scans that.
 *
 * The whole gate therefore rests on one claim: THE SCAN ACTUALLY SAW THE
 * CLOSURE. A scan of nothing exits 0. These tests are about making "nothing"
 * red, and they are not hypothetical: measured on this repo's own example,
 *
 *   - `syft scan dir:node_modules` with default catalogers yields **0** npm
 *     components (the package.json cataloger is not on by default for a
 *     directory source) — a perfectly green SBOM of an empty package set;
 *   - `trivy fs` over the example finds `bun.lock` and catalogues **60** npm
 *     packages, where the same installed tree holds **210** packages by
 *     `installedPackages()` and yields **409** npm components under syft — and
 *     it misses a HIGH the installed tree carries (nanoid 3.3.17).
 *
 * Both failure modes are silent. Both are caught below.
 */

const tmpDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-closure-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A minimal CycloneDX doc with the given npm packages. */
function sbomOf(pkgs: Array<[string, string]>) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    metadata: { component: { type: 'file', name: 'node_modules' } },
    components: pkgs.map(([name, version]) => ({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
    })),
  };
}

/** Enough components to clear the floor, plus every anchor. */
function healthySbom() {
  const filler: Array<[string, string]> = Array.from(
    { length: MIN_NPM_COMPONENTS + 10 },
    (_, i) => [`filler-${i}`, '1.0.0'],
  );
  return sbomOf([...ANCHOR_PACKAGES.map((n) => [n, '1.0.0'] as [string, string]), ...filler]);
}

function installedSet(names: string[]): Set<string> {
  return new Set(names);
}

/** A `Set` big enough to clear the installed floor, containing `names`. */
function healthyInstalled(names: string[] = []): Set<string> {
  const out = new Set(names);
  for (let i = 0; i < MIN_INSTALLED_PACKAGES + 10; i++) out.add(`filler-${i}`);
  return out;
}

describe('npmComponents reads only the npm half of an SBOM', () => {
  it('counts npm components and ignores non-npm ones', () => {
    const sbom = sbomOf([['vite', '8.0.0']]);
    sbom.components.push({
      type: 'library',
      name: 'actions/checkout',
      version: 'v4',
      purl: 'pkg:github/actions/checkout@v4',
    });
    const npm = npmComponents(sbom);
    expect(npm.map((c: { name: string }) => c.name)).toEqual(['vite']);
  });

  it('a GitHub-Actions-only SBOM has ZERO npm components (the measured syft default)', () => {
    // This is the real shape of `syft scan dir:node_modules` without
    // `+javascript-package-cataloger`: 18 components, none of them npm.
    const sbom = sbomOf([]);
    sbom.components.push({
      type: 'library',
      name: 'actions/setup-node',
      version: 'v1',
      purl: 'pkg:github/actions/setup-node@v1',
    });
    expect(npmComponents(sbom)).toHaveLength(0);
  });
});

describe('verifyClosureCoverage — a scan of nothing must be RED', () => {
  it('accepts a healthy closure', () => {
    const result = verifyClosureCoverage({
      sbom: healthySbom(),
      installed: healthyInstalled(ANCHOR_PACKAGES),
    });
    expect(result.problems, result.problems.join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('REJECTS an SBOM with no npm components at all', () => {
    const result = verifyClosureCoverage({
      sbom: sbomOf([]),
      installed: healthyInstalled(ANCHOR_PACKAGES),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/npm component/i);
  });

  it('REJECTS an SBOM below the component floor', () => {
    const few: Array<[string, string]> = ANCHOR_PACKAGES.map((n) => [n, '1.0.0']);
    const result = verifyClosureCoverage({
      sbom: sbomOf(few),
      installed: healthyInstalled(ANCHOR_PACKAGES),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(new RegExp(`${MIN_NPM_COMPONENTS}`));
  });

  it('REJECTS an EMPTY closure directory even though its coverage is trivially 100%', () => {
    // The nastiest shape: nothing installed, nothing in the SBOM, every ratio
    // perfect. Without an absolute floor on the INSTALLED side this passes.
    const result = verifyClosureCoverage({ sbom: sbomOf([]), installed: installedSet([]) });
    expect(result.ok).toBe(false);
    expect(result.coverage).toBe(1);
    expect(result.problems.join('\n')).toMatch(/installed/i);
  });

  it('REJECTS an SBOM missing a toolchain anchor (it scanned the wrong tree)', () => {
    const withoutVinext = ANCHOR_PACKAGES.filter((n) => n !== 'vinext');
    const filler: Array<[string, string]> = Array.from(
      { length: MIN_NPM_COMPONENTS + 10 },
      (_, i) => [`filler-${i}`, '1.0.0'],
    );
    const result = verifyClosureCoverage({
      sbom: sbomOf([...withoutVinext.map((n) => [n, '1.0.0'] as [string, string]), ...filler]),
      installed: healthyInstalled(ANCHOR_PACKAGES),
    });
    expect(result.ok).toBe(false);
    expect(result.missingAnchors).toContain('vinext');
  });

  it('REJECTS an SBOM that covers only a fraction of the installed tree (the lockfile shape)', () => {
    // The measured trivy-fs shape: 60 catalogued packages against a tree of
    // 210. Green today, and what it never looked at includes a HIGH.
    const installed = new Set<string>();
    for (let i = 0; i < 210; i++) installed.add(`pkg-${i}`);
    for (const a of ANCHOR_PACKAGES) installed.add(a);
    const covered: Array<[string, string]> = Array.from({ length: 60 }, (_, i) => [
      `pkg-${i}`,
      '1.0.0',
    ]);
    const result = verifyClosureCoverage({
      sbom: sbomOf([...ANCHOR_PACKAGES.map((n) => [n, '1.0.0'] as [string, string]), ...covered]),
      installed,
    });
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeLessThan(0.5);
    expect(result.problems.join('\n')).toMatch(/covers/i);
  });
});

describe('installedPackages walks the real node_modules tree', () => {
  it('finds plain and scoped packages, and ignores nested node_modules markers', () => {
    const root = scratch();
    const nm = join(root, 'node_modules');
    mkdirSync(join(nm, 'vite'), { recursive: true });
    writeFileSync(join(nm, 'vite', 'package.json'), JSON.stringify({ name: 'vite' }));
    mkdirSync(join(nm, '@vinext', 'core'), { recursive: true });
    writeFileSync(join(nm, '@vinext', 'core', 'package.json'), JSON.stringify({ name: 'core' }));
    // A transitively-nested copy still counts — it is in the tree the compiler reads.
    mkdirSync(join(nm, 'vite', 'node_modules', 'nanoid'), { recursive: true });
    writeFileSync(
      join(nm, 'vite', 'node_modules', 'nanoid', 'package.json'),
      JSON.stringify({ name: 'nanoid' }),
    );

    const found = installedPackages(nm);
    expect([...found].sort()).toEqual(['@vinext/core', 'nanoid', 'vite']);
  });

  it('returns an EMPTY set for a directory that does not exist (never invents coverage)', () => {
    expect(installedPackages(join(scratch(), 'nope')).size).toBe(0);
  });
});

describe('readAllowlist — dated + justified, mirroring the npm-audit gate', () => {
  const NOW = new Date('2026-08-19T00:00:00Z');

  it('activates a well-formed, unexpired entry', () => {
    const active = readAllowlist(
      {
        allow: [
          { id: 'GHSA-aaaa', justification: 'no fix available upstream', added: '2026-08-19' },
        ],
      },
      NOW,
    );
    expect(active.has('GHSA-aaaa')).toBe(true);
  });

  it('an EXPIRED entry stops suppressing', () => {
    const active = readAllowlist(
      {
        allow: [
          {
            id: 'GHSA-old',
            justification: 'x',
            added: '2026-01-01',
            expires: '2026-08-01',
          },
        ],
      },
      NOW,
    );
    expect(active.has('GHSA-old')).toBe(false);
  });

  it('THROWS on an entry with no justification — a bare id can never suppress', () => {
    expect(() => readAllowlist({ allow: [{ id: 'GHSA-bare' }] }, NOW)).toThrow(/justification/i);
  });

  it('THROWS on an entry with no added date', () => {
    expect(() => readAllowlist({ allow: [{ id: 'GHSA-x', justification: 'y' }] }, NOW)).toThrow(
      /added/i,
    );
  });

  it('THROWS on an UNKNOWN key — a typo’d `expires` is a never-expiring entry', () => {
    // The silent-weakening case: `expiress` is ignored, so this entry reads as
    // expiring in 2020 and in fact suppresses forever. An ignored key is a gate
    // that quietly changed meaning, which is the same failure the malformed-key
    // throws above exist to prevent.
    expect(() =>
      readAllowlist(
        {
          allow: [
            {
              id: 'GHSA-typo',
              justification: 'no fix upstream',
              added: '2026-01-01',
              expiress: '2020-01-01',
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/expiress/);
  });

  it('accepts the documented optional `note` key', () => {
    const active = readAllowlist(
      {
        allow: [
          {
            id: 'GHSA-noted',
            justification: 'no fix upstream',
            added: '2026-08-19',
            expires: '2026-11-19',
            note: 'tracked upstream at example/image-size#1',
          },
        ],
      },
      NOW,
    );
    expect(active.has('GHSA-noted')).toBe(true);
  });
});

describe('evaluateFindings — HIGH/CRITICAL block, allowlisted ids are reported not silenced', () => {
  const grype = (matches: Array<[string, string, string]>) => ({
    matches: matches.map(([pkg, id, severity]) => ({
      vulnerability: { id, severity },
      artifact: { name: pkg, version: '1.0.0', type: 'npm' },
    })),
  });

  it('blocks on HIGH and CRITICAL', () => {
    const out = evaluateFindings(
      grype([
        ['image-size', 'GHSA-5p2g-fcmc-qvqq', 'High'],
        ['left-pad', 'GHSA-crit', 'Critical'],
      ]),
      { allowlist: new Set() },
    );
    expect(out.blocking.map((f) => f.id).sort()).toEqual(['GHSA-5p2g-fcmc-qvqq', 'GHSA-crit']);
  });

  it('ignores severities below the threshold', () => {
    const out = evaluateFindings(
      grype([
        ['a', 'GHSA-med', 'Medium'],
        ['b', 'GHSA-low', 'Low'],
        ['c', 'GHSA-unknown', 'Unknown'],
      ]),
      { allowlist: new Set() },
    );
    expect(out.blocking).toEqual([]);
    expect([...FAILING_SEVERITIES]).toEqual(['critical', 'high']);
  });

  it('suppresses an allowlisted id but still REPORTS it', () => {
    const out = evaluateFindings(grype([['image-size', 'GHSA-5p2g-fcmc-qvqq', 'High']]), {
      allowlist: new Set(['GHSA-5p2g-fcmc-qvqq']),
    });
    expect(out.blocking).toEqual([]);
    expect(out.suppressed.map((f) => f.id)).toEqual(['GHSA-5p2g-fcmc-qvqq']);
  });

  it('THROWS when grype output has no `matches` key at all — a crashed scan is not a pass', () => {
    // A scanner that failed and printed something else must never read as
    // "zero findings". This is the same emptiness rule one layer down.
    expect(() => evaluateFindings({} as never, { allowlist: new Set() })).toThrow(/matches/i);
  });
});
