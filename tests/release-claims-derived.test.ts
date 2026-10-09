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
    it(`${label} names every publishable package`, () => {
      const text = plain(path);
      const missing = packages.filter((p) => !text.includes(p));
      expect(missing).toEqual([]);
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
