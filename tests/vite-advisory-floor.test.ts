/**
 * GHSA-587h-7wmj-h5pm floor (#2542).
 *
 * vite bundles launch-editor-middleware, whose fs.existsSync() existence check
 * can be bypassed on Windows. Fixed in vite 8.2.4 / 8.3.3 and launch-editor
 * 2.14.2. A HIGH advisory in the lockfile reds the SBOM + Trivy JS-closure scan,
 * the docs dry-run and the vinext pre-compile closure scan on every PR.
 *
 * Scope: the lockfiles that ship into the scanned closures (root + examples).
 * The frozen fixture lockfiles under packages/kn-next/src/__tests__/fixtures/
 * are deliberately pinned (the pin is the thing under test) and are NOT covered.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type V = readonly [number, number, number];
const parse = (v: string): V => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`unparseable version ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const atLeast = (a: V, b: V) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return true;
};

/** Fixed lines: 8.2.4+ (8.2.x) and 8.3.3+. NOT 8.3.0-8.3.2, which are vulnerable. */
const isFixedVite = (v: V) =>
  v[0] > 8 ||
  (v[0] === 8 && (v[1] > 3 || atLeast(v, [8, 3, 3]) || (v[1] === 2 && atLeast(v, [8, 2, 4]))));

/** Every resolved `"<name>@x.y.z"` ident in a bun.lock (hoisted + nested). */
const resolved = (lock: string, name: string): string[] => {
  const re = new RegExp(`"${name}@(\\d+\\.\\d+\\.\\d+)"`, 'g');
  return [...lock.matchAll(re)].map((m) => m[1] as string);
};

const LOCKS = ['bun.lock', 'examples/bun-exec/bun.lock'];

describe('GHSA-587h-7wmj-h5pm floor', () => {
  for (const rel of LOCKS) {
    const lock = readFileSync(resolve(repoRoot, rel), 'utf8');
    it(`${rel}: vite resolves a fixed release (8.2.x >= 8.2.4, or >= 8.3.3)`, () => {
      const found = resolved(lock, 'vite');
      expect(found.length, `${rel} no longer resolves vite — update this guard`).toBeGreaterThan(0);
      for (const v of found) {
        expect(
          isFixedVite(parse(v)),
          `${rel} resolves vite@${v}, not a fixed release for GHSA-587h-7wmj-h5pm (fixed: 8.2.4+ on 8.2.x, 8.3.3+ on 8.3+; 8.3.0-8.3.2 are vulnerable)`,
        ).toBe(true);
      }
    });
  }

  it('bun.lock: launch-editor is resolved and >= 2.14.2', () => {
    const lock = readFileSync(resolve(repoRoot, 'bun.lock'), 'utf8');
    const found = resolved(lock, 'launch-editor');
    expect(found.length, 'launch-editor no longer resolved — update this guard').toBeGreaterThan(0);
    for (const v of found) {
      expect(
        atLeast(parse(v), [2, 14, 2]),
        `bun.lock resolves launch-editor@${v}, below the 2.14.2 fix for GHSA-587h-7wmj-h5pm`,
      ).toBe(true);
    }
  });
});
