import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../scripts/dependabot-published-bytes-pause.mjs';

/**
 * `scripts/dependabot-published-bytes-pause.mjs` (#1663) — the auto-close
 * decision for a Dependabot PR that would touch a published package's
 * dependency manifest while a credential window is open. Reuses
 * `decidePublishedBytesScope` verbatim (tested exhaustively in
 * `tests/published-bytes-freeze-check.test.ts`); these tests cover the
 * thin wrapper: reading the pin, writing `$GITHUB_OUTPUT`, and the exact
 * `shouldClose` mapping.
 *
 * Round 2 (PR #1680 review): `decide()` now takes `basePin`/`headPin`/
 * `mergeBasePin` instead of reading a single ambient pin file from
 * `repoRoot` — mirrors the same fix in
 * `scripts/published-bytes-freeze-check.mjs`.
 */

const registry: string[] = [];

function pin(rcTag: string | null, overrideMarker?: unknown) {
  return { rcTag, ...(overrideMarker ? { publishedBytesBumpMarker: overrideMarker } : {}) };
}

function buildFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dependabot-pause-fixture-'));
  registry.push(root);
  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));
  for (const [dir, name] of [
    ['packages/kn-next', '@getknext/core'],
    ['packages/lib', '@getknext/lib'],
    ['packages/db', '@getknext/db'],
  ] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0-rc.1', private: false }),
    );
  }
  return root;
}

afterEach(() => {
  for (const dir of registry.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('decide — a Dependabot bump to a published package manifest during an open window', () => {
  it('CLOSES a bump to a publishable package.json (e.g. a hypothetical future npm-ecosystem PR)', () => {
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['packages/kn-next/package.json'],
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(true);
  });

  it('CLOSES a bump to the root bun.lock (pins devDependency versions used by every build)', () => {
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['bun.lock'],
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(true);
  });

  it('LEAVES OPEN a github-actions bump touching only .github/workflows/*.yml (no window impact)', () => {
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['.github/workflows/ci.yml'],
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(false);
  });

  it('LEAVES OPEN any bump when no credential window is open at base (rcTag null)', () => {
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['packages/kn-next/package.json'],
      basePin: pin(null),
      headPin: pin(null),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(false);
  });

  it('LEAVES OPEN when a valid publishedBytesBumpMarker override introduced by this PR is present', () => {
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['packages/kn-next/package.json'],
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1', {
        date: '2026-09-25',
        expires: '2026-10-02',
        reason: 'intentional rc.2',
      }),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(false);
  });

  it('CLOSES when the marker is INHERITED from the merge base rather than introduced by this PR', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };
    const root = buildFixtureRoot();
    const r = decide({
      repoRoot: root,
      changedFiles: ['packages/kn-next/package.json'],
      basePin: pin('v1.0.0-rc.1', marker),
      headPin: pin('v1.0.0-rc.1', marker),
      mergeBasePin: pin('v1.0.0-rc.1', marker),
      now: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.shouldClose).toBe(true);
  });

  it('writes should_close and reason to $GITHUB_OUTPUT', () => {
    const root = buildFixtureRoot();
    const outputPath = join(root, 'gh-output.txt');
    decide({
      repoRoot: root,
      changedFiles: ['packages/kn-next/package.json'],
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      now: new Date('2026-09-30T00:00:00Z'),
      githubOutputPath: outputPath,
    });
    const out = readFileSync(outputPath, 'utf8');
    expect(out).toContain('should_close=true');
    expect(out).toMatch(/^reason=/m);
  });

  it('throws when changedFiles is not provided (never silently defaults to an empty diff)', () => {
    const root = buildFixtureRoot();
    expect(() =>
      decide({
        repoRoot: root,
        basePin: pin(null),
        headPin: pin(null),
      } as unknown as Parameters<typeof decide>[0]),
    ).toThrow(/changedFiles/);
  });

  it('throws when basePin is not provided', () => {
    const root = buildFixtureRoot();
    expect(() =>
      decide({
        repoRoot: root,
        changedFiles: [],
        headPin: pin(null),
      } as unknown as Parameters<typeof decide>[0]),
    ).toThrow(/basePin/);
  });

  it('throws when headPin is not provided', () => {
    const root = buildFixtureRoot();
    expect(() =>
      decide({
        repoRoot: root,
        changedFiles: [],
        basePin: pin(null),
      } as unknown as Parameters<typeof decide>[0]),
    ).toThrow(/headPin/);
  });
});
