/**
 * The pre-existing HIGH advisories the OSV gate reported (--full) that were FIXED by a
 * bump rather than allowlisted (#2542). Each row is a version line and the first
 * patched release on it. The lockfile must resolve nothing below it, so a relock that
 * drifts back, or an override that is dropped, goes red here instead of waiting for the
 * nightly --full scan.
 *
 * What is NOT here is deliberate: braces (no patched release exists) and the frozen
 * fixtures are allowlisted with a reason in security/osv-allowlist.json, and
 * tests/osv-gate.test.ts keeps that list from rotting.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

type V = readonly [number, number, number];
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Every `["name@x.y.z", ...` resolution in a bun.lock, as x.y.z tuples. */
function resolved(lock: string, name: string): V[] {
  const esc = name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  return [...lock.matchAll(new RegExp(`\\["${esc}@(\\d+)\\.(\\d+)\\.(\\d+)"`, 'g'))].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const,
  );
}

interface Floor {
  pkg: string;
  /** Only resolutions with this major.minor prefix are judged (a line), or all if absent. */
  line?: readonly [number, number?];
  floor: V;
  advisories: string;
}

const ROOT_FLOORS: Floor[] = [
  {
    pkg: 'brace-expansion',
    line: [1],
    floor: [1, 1, 20],
    advisories:
      'GHSA-3jxr-9vmj-r5cp, -6j4f-fj2g-mc7p, -mh99-v99m-4gvg, -qhr7-859c-m2p7, -rgw5-rvv9-x895',
  },
  {
    pkg: 'brace-expansion',
    line: [2],
    floor: [2, 1, 6],
    advisories:
      'GHSA-3jxr-9vmj-r5cp, -6j4f-fj2g-mc7p, -mh99-v99m-4gvg, -qhr7-859c-m2p7, -rgw5-rvv9-x895',
  },
  {
    pkg: 'minimatch',
    line: [3],
    floor: [3, 1, 4],
    advisories: 'GHSA-23c5-xmqv-rm74',
  },
  {
    pkg: 'minimatch',
    line: [8],
    floor: [8, 0, 6],
    advisories: 'GHSA-23c5-xmqv-rm74, GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj',
  },
  {
    pkg: 'handlebars',
    floor: [4, 7, 10],
    advisories: 'seven HIGH/CRITICAL (GHSA-2w6w-674q-4c4q ...)',
  },
  { pkg: 'launch-editor', floor: [2, 14, 2], advisories: 'GHSA-587h-7wmj-h5pm' },
  { pkg: 'vite', floor: [8, 3, 3], advisories: 'GHSA-587h-7wmj-h5pm' },
  { pkg: 'shell-quote', floor: [1, 11, 0], advisories: 'GHSA-pqg4-j6r4-53mv' },
  { pkg: 'tmp', floor: [0, 2, 6], advisories: 'GHSA-ph9p-34f9-6g65' },
  { pkg: 'fflate', line: [0, 7], floor: [0, 7, 5], advisories: 'GHSA-px8p-9vwx-vf98' },
  { pkg: 'ws', line: [8], floor: [8, 21, 0], advisories: 'GHSA-96hv-2xvq-fx4p' },
  { pkg: 'uuid', line: [13], floor: [13, 0, 1], advisories: 'GHSA-w5hq-g745-h8pq' },
  {
    pkg: 'happy-dom',
    floor: [20, 8, 9],
    advisories: 'GHSA-6q6h-j7hj-3r64, GHSA-w4gp-fjgq-3q4g',
  },
];

const onLine = (v: V, line?: Floor['line']) =>
  !line || (v[0] === line[0] && (line[1] === undefined || v[1] === line[1]));

describe('OSV triage: bun.lock resolves nothing below the patched release (#2542)', () => {
  const lock = read('bun.lock');
  for (const { pkg, line, floor, advisories } of ROOT_FLOORS) {
    const label = `${pkg}${line ? ` ${line.join('.')}.x` : ''} >= ${floor.join('.')}`;
    it(`${label} (${advisories})`, () => {
      const subject = resolved(lock, pkg).filter((v) => onLine(v, line));
      expect(
        subject.length,
        `bun.lock has no ${label} resolution: the guard has no subject`,
      ).toBeGreaterThan(0);
      const bad = subject.filter((v) => cmp(v, floor) < 0).map((v) => `${pkg}@${v.join('.')}`);
      expect(
        bad,
        `raise the package.json override floor (or the direct dep) for ${pkg} and relock`,
      ).toEqual([]);
    });
  }

  it('declares an override (or a direct bump) for every override-fixed package', () => {
    const manifest = JSON.parse(read('package.json')) as {
      overrides: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const key of [
      'brace-expansion@1',
      'brace-expansion@2',
      'minimatch@3',
      'minimatch@8',
      'handlebars',
      'shell-quote',
      'tmp',
      'fflate@0.7',
      'ws@8',
      'uuid@13',
      'launch-editor',
    ]) {
      expect(manifest.overrides[key], `package.json overrides lacks \`${key}\``).toMatch(/^>=\d/);
    }
    expect(manifest.devDependencies['happy-dom']).toBe('^20.12.0');
  });
});

describe('OSV triage: examples/bun-exec resolves image-size >= 2.0.3 (#2542)', () => {
  it('GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr are fixed by an override over the vinext exact pin', () => {
    const subject = resolved(read('examples/bun-exec/bun.lock'), 'image-size');
    expect(subject.length).toBeGreaterThan(0);
    expect(subject.filter((v) => cmp(v, [2, 0, 3]) < 0)).toEqual([]);
    const pkg = JSON.parse(read('examples/bun-exec/package.json')) as {
      overrides: Record<string, string>;
    };
    expect(pkg.overrides['image-size']).toBe('^2.0.3');
  });

  it('vite >= 8.3.3 (GHSA-587h-7wmj-h5pm)', () => {
    const subject = resolved(read('examples/bun-exec/bun.lock'), 'vite');
    expect(subject.length).toBeGreaterThan(0);
    expect(subject.filter((v) => cmp(v, [8, 3, 3]) < 0)).toEqual([]);
  });
});

describe('OSV triage: the scale-zero-pg gateway module is on patched x/net, x/sys, x/text and spdystream (#2542)', () => {
  const mod = read('packages/scale-zero-pg/gateway/go.mod');
  const ver = (name: string): V => {
    const m = mod.match(new RegExp(`${name.replace(/[./]/g, '\\$&')} v(\\d+)\\.(\\d+)\\.(\\d+)`));
    if (!m) throw new Error(`go.mod does not require ${name}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  };
  for (const [name, floor, ids] of [
    ['github.com/moby/spdystream', [0, 5, 1], 'GO-2026-4958, GHSA-pc3f-x583-g7j2'],
    ['golang.org/x/net', [0, 60, 0], 'GO-2026-4440 .. GO-2026-6617'],
    ['golang.org/x/sys', [0, 44, 0], 'GO-2026-5024'],
    ['golang.org/x/text', [0, 41, 0], 'GO-2026-5970, GO-2026-6629'],
  ] as const) {
    it(`${name} >= ${floor.join('.')} (${ids})`, () => {
      expect(cmp(ver(name), floor)).toBeGreaterThanOrEqual(0);
    });
  }
});
