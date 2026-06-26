import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST for .github/workflows/test-e2e-deploy.yml (#89 / ADR-0007 A3-2).
 *
 * The official Next.js deploy-harness nightly used to FAIL at the `build-next`
 * job with "Error: No pnpm version is specified": `pnpm/action-setup@v4` had no
 * `version:` input, and because knext is checked out into a sub-path (`path:
 * knext`), the action could NOT resolve a repo-root `packageManager` field at
 * the workspace root. With pnpm unresolved the `build-next` job died and the
 * actual `deploy-tests` shards were SKIPPED — so the official compatibility
 * suite never ran a single test.
 *
 * This test mechanically prevents that regression: EVERY `pnpm/action-setup`
 * step in the compat-suite workflow must pin an explicit `version`, and that
 * version must match the repo's pinned pnpm (`packageManager` in package.json)
 * so the two never drift.
 *
 * Implementation note: this scans the workflow YAML as text rather than parsing
 * it with a YAML library, so the test adds no new runtime dependency (the repo
 * has no direct `yaml` dep) and stays trivially portable across CI runners.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const ROOT_PKG_PATH = resolve(REPO_ROOT, 'package.json');

/** The pnpm version the repo pins via `packageManager` (e.g. "10.4.1"). */
function pinnedPnpmVersion(): string {
  const pkg = JSON.parse(readFileSync(ROOT_PKG_PATH, 'utf8')) as {
    packageManager?: string;
  };
  const pm = pkg.packageManager ?? '';
  const match = pm.match(/^pnpm@(\d+\.\d+\.\d+)$/);
  expect(match, `package.json packageManager should pin pnpm, got "${pm}"`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

/**
 * The `version:` declared in each `pnpm/action-setup` step's block, in document
 * order. A `null` entry means that step pins no version. We locate each
 * `uses: pnpm/action-setup` line, then scan the lines that belong to the same
 * step block (more-indented than the `uses:` key, up to the next list item or a
 * dedent) for a `version:` key — skipping intervening comment lines.
 */
function pnpmSetupVersions(): Array<string | null> {
  const lines = readFileSync(WORKFLOW_PATH, 'utf8').split('\n');
  const versions: Array<string | null> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-?\s*uses:\s*pnpm\/action-setup(?:@|\s|$)/.test(lines[i])) continue;
    const usesIndent = lines[i].search(/\S/);
    let version: string | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      // A new list item ("- ...") at or below the `uses:` indent, or any dedent
      // below it, ends this step block.
      if (indent < usesIndent) break;
      if (indent === usesIndent && /^\s*-\s/.test(line)) break;
      const m = line.match(/^\s*version:\s*["']?([^"'\s#]+)["']?/);
      if (m) {
        version = m[1];
        break;
      }
    }
    versions.push(version);
  }
  return versions;
}

describe('compat-suite workflow pnpm pin (test-e2e-deploy.yml)', () => {
  it('has at least one pnpm/action-setup step (sanity)', () => {
    expect(pnpmSetupVersions().length).toBeGreaterThan(0);
  });

  it('every pnpm/action-setup step pins an explicit version', () => {
    pnpmSetupVersions().forEach((version, idx) => {
      expect(
        version,
        `pnpm/action-setup step #${idx + 1} must set with.version`,
      ).not.toBeNull();
      expect(String(version).trim().length, 'pnpm version must be non-empty').toBeGreaterThan(0);
    });
  });

  it('the pinned pnpm version matches the repo packageManager field', () => {
    const expected = pinnedPnpmVersion();
    pnpmSetupVersions().forEach((version, idx) => {
      expect(
        version,
        `pnpm version in step #${idx + 1} must match packageManager pnpm@${expected}`,
      ).toBe(expected);
    });
  });
});
