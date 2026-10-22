import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  consumerVisibleManifestChanged,
  decide,
  derivePackageRoots,
} from '../scripts/check-changeset-required.mjs';

/**
 * GUARD: every dependency manifest knext ships or builds from has a Dependabot
 * channel, grouped, with a release-age cooldown that matches the install-time
 * quarantine in bunfig.toml.
 *
 * Before this guard `.github/dependabot.yml` covered GitHub Actions and the
 * operator's Go module only. The bun workspace (`bun.lock`), the Rust crates and
 * the Rust and Go function templates had no bump channel at all, so a vulnerable
 * transitive version stayed until someone happened to notice.
 *
 * THE COVERAGE SET IS DERIVED, NOT LISTED. The lockfiles are read from
 * `git ls-files`, so a Rust crate or Go module added next month fails this test
 * until it either gets an entry or is named in EXEMPT with a reason. An exempt
 * path that no longer exists also fails, so the list cannot go stale quietly.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

type Entry = {
  'package-ecosystem': string;
  directory?: string;
  directories?: string[];
  schedule?: { interval?: string };
  groups?: Record<
    string,
    { patterns?: string[]; 'dependency-type'?: string; 'update-types'?: string[] }
  >;
  cooldown?: { 'default-days'?: number };
  labels?: string[];
  'open-pull-requests-limit'?: number;
};

const config = parse(readFileSync(resolve(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
  updates: Entry[];
};

const dirsOf = (e: Entry): string[] => [
  ...(e.directories ?? []),
  ...(e.directory ? [e.directory] : []),
];

const MANIFEST: Record<string, { lock: string; manifest: string }> = {
  bun: { lock: 'bun.lock', manifest: 'package.json' },
  cargo: { lock: 'Cargo.lock', manifest: 'Cargo.toml' },
  gomod: { lock: 'go.sum', manifest: 'go.mod' },
};

/**
 * Lockfile directories deliberately NOT bumped, each with the reason. These are
 * measurement spikes and a test fixture, never shipped and never built into a
 * published artifact.
 */
const EXEMPT: Record<string, string> = {
  'spikes/zone-functions-coldstart/fn-rust': 'cold-start measurement spike, not shipped',
  'spikes/zone-functions-coldstart/fn-go': 'cold-start measurement spike, not shipped',
  'packages/ffi/fixtures/ffi-zone/rust': 'test fixture pinned to a fixed toolchain, not shipped',
  'packages/kn-next/src/__tests__/fixtures/standalone-drain-app':
    'frozen test fixture app, deliberately pinned, not shipped',
  'packages/kn-next/src/__tests__/fixtures/standalone-pages-app':
    'frozen test fixture app, deliberately pinned, not shipped',
  'packages/kn-next/src/__tests__/fixtures/vinext-bun-og-app':
    'frozen test fixture app, deliberately pinned, not shipped',
  'packages/kn-next/src/__tests__/fixtures/vinext-image-loaderfile-app':
    'frozen test fixture app, deliberately pinned, not shipped',
  'packages/kn-next/src/__tests__/fixtures/vinext-node-app':
    'frozen test fixture app, deliberately pinned, not shipped',
  'packages/kn-next/src/__tests__/fixtures/vinext-styled-jsx-app':
    'frozen test fixture app, deliberately pinned, not shipped',
};

function trackedDirs(file: string): string[] {
  const out = execFileSync('git', ['ls-files', '--', `**/${file}`, file], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return [
    ...new Set(
      out
        .split('\n')
        .filter(Boolean)
        .map((p) => dirname(p)),
    ),
  ].sort();
}

describe('dependabot.yml: ecosystems', () => {
  const byEco = (eco: string) => config.updates.filter((u) => u['package-ecosystem'] === eco);

  it('keeps the github-actions entry', () => {
    expect(byEco('github-actions')).toHaveLength(1);
  });

  for (const eco of ['bun', 'cargo', 'gomod'] as const) {
    it(`has a ${eco} entry`, () => {
      expect(byEco(eco).length).toBeGreaterThan(0);
    });
  }

  it('does not use the npm ecosystem for the bun workspace (it would not update bun.lock)', () => {
    expect(byEco('npm')).toHaveLength(0);
  });

  it('every declared directory exists and holds that ecosystem manifest and lockfile', () => {
    for (const eco of ['bun', 'cargo', 'gomod'] as const) {
      for (const entry of byEco(eco)) {
        for (const dir of dirsOf(entry)) {
          const abs = resolve(REPO_ROOT, `.${dir}`);
          expect(existsSync(resolve(abs, MANIFEST[eco].manifest)), `${eco} ${dir} manifest`).toBe(
            true,
          );
          expect(existsSync(resolve(abs, MANIFEST[eco].lock)), `${eco} ${dir} lockfile`).toBe(true);
        }
      }
    }
  });

  for (const eco of ['bun', 'cargo', 'gomod'] as const) {
    it(`every tracked ${MANIFEST[eco].lock} is covered by a ${eco} entry or exempt`, () => {
      const covered = new Set(
        byEco(eco)
          .flatMap(dirsOf)
          .map((d) => (d === '/' ? '.' : d.replace(/^\//, ''))),
      );
      const locks = trackedDirs(MANIFEST[eco].lock);
      expect(locks.length, `found ${MANIFEST[eco].lock} files`).toBeGreaterThan(0);
      const uncovered = locks.filter((d) => !covered.has(d) && !(d in EXEMPT));
      expect(uncovered, `${MANIFEST[eco].lock} dirs with no ${eco} entry`).toEqual([]);
    });
  }

  it('every exempt directory still exists (the exemption list cannot go stale)', () => {
    for (const dir of Object.keys(EXEMPT)) {
      expect(existsSync(resolve(REPO_ROOT, dir)), dir).toBe(true);
    }
  });

  it('covers the Rust crates and both function templates', () => {
    const cargo = byEco('cargo').flatMap(dirsOf);
    expect(cargo).toContain('/crates');
    expect(cargo).toContain('/templates/rust');
    expect(byEco('gomod').flatMap(dirsOf)).toContain('/templates/go');
    expect(byEco('gomod').flatMap(dirsOf)).toContain('/packages/kn-next-operator');
  });
});

describe('dependabot.yml: docker base images', () => {
  const docker = config.updates.filter((u) => u['package-ecosystem'] === 'docker');

  it('covers every directory whose Dockerfile pins golang by digest', () => {
    const dirs = docker.flatMap(dirsOf);
    for (const d of [
      '/packages/scale-zero-pg/gateway',
      '/packages/kn-next-operator',
      '/templates/go',
    ]) {
      expect(dirs, 'docker directories').toContain(d);
      expect(existsSync(resolve(REPO_ROOT, `.${d}`, 'Dockerfile')), `${d}/Dockerfile`).toBe(true);
    }
  });
});

describe('dependabot.yml: grouping, cadence and cooldown', () => {
  const ecosystems = config.updates.filter((u) => u['package-ecosystem'] !== 'github-actions');

  it('every non-actions entry is weekly and grouped', () => {
    for (const entry of ecosystems) {
      const label = `${entry['package-ecosystem']} ${dirsOf(entry).join(',')}`;
      expect(entry.schedule?.interval, label).toBe('weekly');
      expect(Object.keys(entry.groups ?? {}).length, `${label} has groups`).toBeGreaterThan(0);
    }
  });

  it('every ecosystem entry carries a cooldown equal to the bunfig quarantine', () => {
    const bunfig = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8');
    const seconds = Number(bunfig.match(/^\s*minimumReleaseAge\s*=\s*(\d+)/m)?.[1]);
    expect(Number.isFinite(seconds), 'bunfig.toml sets install.minimumReleaseAge').toBe(true);
    const days = seconds / 86400;
    for (const entry of ecosystems) {
      expect(
        entry.cooldown?.['default-days'],
        `${entry['package-ecosystem']} ${dirsOf(entry).join(',')} cooldown`,
      ).toBe(days);
    }
  });

  it('the bun entry splits runtime dependencies from tooling, so only the first needs a changeset', () => {
    const bun = config.updates.find((u) => u['package-ecosystem'] === 'bun');
    const groups = Object.values(bun?.groups ?? {});
    const types = groups.map((g) => g['dependency-type']).sort();
    expect(types).toEqual(['development', 'production']);
    for (const g of groups) expect(g.patterns).toContain('*');
  });

  it('every ecosystem entry labels its PRs `dependencies`', () => {
    for (const entry of ecosystems) {
      expect(entry.labels, `${entry['package-ecosystem']} ${dirsOf(entry).join(',')}`).toContain(
        'dependencies',
      );
    }
  });
});

describe('a dependency bump PR against the "Changeset required" check', () => {
  const ROOTS = derivePackageRoots(
    { fixed: [['@getknext/core']] },
    { 'packages/kn-next': { name: '@getknext/core', files: ['dist'] } },
  );
  const before = {
    dependencies: { zod: '^4.0.0' },
    devDependencies: { vitest: '^4.0.0' },
  };
  const bump = (key: 'dependencies' | 'devDependencies') => ({
    ...before,
    [key]: {
      ...(before[key] as Record<string, string>),
      [key === 'dependencies' ? 'zod' : 'vitest']: '^4.1.0',
    },
  });

  it('a devDependencies bump in a published package does not need a changeset', () => {
    expect(consumerVisibleManifestChanged(before, bump('devDependencies'))).toBe(false);
  });

  it('a dependencies bump in a published package does, and the opt-out label is accepted', () => {
    expect(consumerVisibleManifestChanged(before, bump('dependencies'))).toBe(true);
    const manifestChanged = { '@getknext/core': true };
    const base = {
      changedPaths: ['packages/kn-next/package.json', 'bun.lock'],
      roots: ROOTS,
      manifestChanged,
      changesetCandidates: [],
    };
    expect(decide({ ...base, labels: [] }).ok).toBe(false);
    expect(decide({ ...base, labels: ['dependencies'] }).ok).toBe(false);
    expect(decide({ ...base, labels: ['no-changeset'] }).ok).toBe(true);
  });
});
