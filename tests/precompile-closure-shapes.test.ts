import { describe, expect, it } from 'bun:test';
import {
  ANCHOR_PACKAGES,
  closureShape,
  verifyClosureCoverage,
} from '../scripts/lib/precompile-closure.mjs';

/**
 * #1525 — the closure gate's second shape: the Next standalone trace that the
 * self-contained standalone executable embeds. That tree holds next and react
 * but NO vinext/vite/nitro, so the vinext anchors would red a correct scan; and
 * it is a traced subset, so the vinext size floors do not apply. Shape-specific
 * anchors must still red a scan pointed at the wrong tree, and an empty trace
 * must still be red.
 */

function sbomOf(pkgs: Array<[string, string]>) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    components: pkgs.map(([name, version]) => ({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
    })),
  };
}

const filler = (n: number): Array<[string, string]> =>
  Array.from({ length: n }, (_, i) => [`filler-${i}`, '1.0.0']);
const pairs = (names: string[]): Array<[string, string]> =>
  names.map((n) => [n, '1.0.0'] as [string, string]);

describe('closure shapes: vinext and the standalone trace each carry their own anchors', () => {
  it('vinext stays the default shape with the unchanged anchors', () => {
    expect(closureShape('vinext').anchors).toEqual(ANCHOR_PACKAGES);
    expect(closureShape(undefined).anchors).toEqual(ANCHOR_PACKAGES);
  });

  it('an unknown shape throws instead of silently falling back', () => {
    expect(() => closureShape('nitro')).toThrow(/unknown closure shape/);
  });

  it('standalone anchors on next + react + react-dom and NOT on vinext/vite/nitro', () => {
    const { anchors } = closureShape('standalone');
    expect(anchors).toEqual(expect.arrayContaining(['next', 'react', 'react-dom']));
    for (const wrong of ['vinext', 'vite', 'nitro']) expect(anchors).not.toContain(wrong);
  });

  it('ACCEPTS a healthy standalone trace that has no vinext toolchain', () => {
    const s = closureShape('standalone');
    const result = verifyClosureCoverage({
      sbom: sbomOf([...pairs(s.anchors), ...filler(s.minComponents + 5)]),
      installed: new Set([...s.anchors, ...filler(s.minInstalled + 5).map(([n]) => n)]),
      ...s,
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('REJECTS a standalone SBOM that lacks next (it scanned the wrong tree)', () => {
    const s = closureShape('standalone');
    const result = verifyClosureCoverage({
      sbom: sbomOf([
        ...pairs(s.anchors.filter((n: string) => n !== 'next')),
        ...filler(s.minComponents + 5),
      ]),
      installed: new Set([...s.anchors, ...filler(s.minInstalled + 5).map(([n]) => n)]),
      ...s,
    });
    expect(result.ok).toBe(false);
    expect(result.missingAnchors).toEqual(['next']);
  });

  it('REJECTS an empty standalone trace (floors are far above zero)', () => {
    const s = closureShape('standalone');
    expect(s.minComponents).toBeGreaterThanOrEqual(10);
    expect(s.minInstalled).toBeGreaterThanOrEqual(10);
    const result = verifyClosureCoverage({ sbom: sbomOf([]), installed: new Set(), ...s });
    expect(result.ok).toBe(false);
  });

  it('problem text names the shape rather than always saying vinext', () => {
    const s = closureShape('standalone');
    const result = verifyClosureCoverage({
      sbom: sbomOf(filler(s.minComponents + 5)),
      installed: new Set(filler(s.minInstalled + 5).map(([n]) => n)),
      ...s,
    });
    const text = result.problems.join('\n');
    expect(text).toContain('standalone');
    expect(text).not.toContain('vinext pre-compile');
  });

  it('the default (vinext) problem text is unchanged', () => {
    const result = verifyClosureCoverage({ sbom: sbomOf([]), installed: new Set() });
    expect(result.problems.join('\n')).toContain('vinext pre-compile closure');
  });
});
