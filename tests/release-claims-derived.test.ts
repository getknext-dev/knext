import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DERIVED-CLAIM GUARD for the release policy docs.
 *
 * `docs/RELEASE_POLICY.md`, `SECURITY.md` and `apps/docs/content/docs/versioning.mdx` each
 * restate which packages are published and how long 1.x is supported. Three hand-copied
 * claims drift. So the package list is DERIVED here from the manifests (every non-private
 * `@getknext/*` package under `packages/`) and each doc must name every one of them,
 * scanning rather than enumerating, so a later publishable `@getknext/grpc` fails all three
 * docs until each is updated. The 1.x support window is parsed out of each doc and compared.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DOCS: Record<string, string> = {
  'docs/RELEASE_POLICY.md': resolve(REPO_ROOT, 'docs/RELEASE_POLICY.md'),
  'SECURITY.md': resolve(REPO_ROOT, 'SECURITY.md'),
  'apps/docs/content/docs/versioning.mdx': resolve(
    REPO_ROOT,
    'apps/docs/content/docs/versioning.mdx',
  ),
};

function publishablePackages(): string[] {
  const names: string[] = [];
  const root = resolve(REPO_ROOT, 'packages');
  for (const entry of readdirSync(root)) {
    const manifestPath = resolve(root, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      private?: boolean;
    };
    if (m.private || !m.name?.startsWith('@getknext/')) continue;
    names.push(m.name);
  }
  return names.sort();
}

/** Strip markdown emphasis/code ticks so wording is compared, not formatting. */
function plain(path: string): string {
  return readFileSync(path, 'utf8').replace(/[*`]/g, '').replace(/\s+/g, ' ');
}

/**
 * The package-list section of a doc, delimited by a `published-packages:start` / `:end`
 * marker (an HTML comment in .md, a JSX comment in .mdx). A missing, duplicated or reversed anchor
 * THROWS, so the test fails rather than skipping. Returns the sorted, de-duplicated
 * `@getknext/*` names inside the section, so a missing OR extra entry is a diff.
 */
function listedPackages(label: string, path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const find = (kind: 'start' | 'end'): number[] => {
    const re = new RegExp(`(?:<!--|\\{/\\*)\\s*published-packages:${kind}\\s*(?:-->|\\*/\\})`, 'g');
    return [...text.matchAll(re)].map((m) => m.index as number);
  };
  const starts = find('start');
  const ends = find('end');
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(
      `${label}: need exactly one published-packages:start before one :end anchor (found ${starts.length}/${ends.length})`,
    );
  }
  const section = text.slice(starts[0], ends[0]);
  return [...new Set(section.match(/@getknext\/[a-z0-9-]+/g) ?? [])].sort();
}

const WINDOW = /security fixes only,? for (\w+) months?/i;

describe('release claims are derived from the manifests', () => {
  const packages = publishablePackages();

  it('scan finds the publishable set (denominator is not vacuous)', () => {
    expect(packages.length).toBeGreaterThanOrEqual(3);
    for (const p of ['@getknext/core', '@getknext/db', '@getknext/lib']) {
      expect(packages).toContain(p);
    }
  });

  it('the changeset fixed group covers every derived package except the independently versioned one', () => {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, '.changeset/config.json'), 'utf8')) as {
      fixed: string[][];
    };
    const fixed = new Set(cfg.fixed.flat());
    // @getknext/grpc is versioned independently (ADR-0020 amendment); the rest ship in lockstep.
    for (const p of packages.filter((n) => n !== '@getknext/grpc')) {
      expect(fixed.has(p)).toBe(true);
    }
  });

  for (const [label, path] of Object.entries(DOCS)) {
    it(`${label} package-list section lists exactly the publishable packages`, () => {
      const listed = listedPackages(label, path);
      expect(listed).toEqual(packages);
    });
  }

  it('all three docs state the same 1.x support window and dist-tag', () => {
    const windows = Object.entries(DOCS).map(([label, path]) => {
      const text = plain(path);
      const m = WINDOW.exec(text);
      expect(m, `${label} must state the 1.x security-only window`).not.toBeNull();
      expect(text, `${label} must name the latest-1 dist-tag`).toContain('latest-1');
      return (m as RegExpExecArray)[1].toLowerCase();
    });
    expect(new Set(windows).size).toBe(1);
  });
});
