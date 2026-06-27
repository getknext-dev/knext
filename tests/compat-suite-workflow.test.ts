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

/** The raw workflow text. */
function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * Returns the body (the `run:` block and surrounding lines) of every workflow
 * step whose `working-directory:` is `next.js`. Used to assert that next.js's
 * own pnpm — not the globally action-setup-pinned knext pnpm — drives the
 * next.js install/build/playwright steps (engine clash: next.js v16.0.3 wants
 * pnpm 9.6.0, knext wants 10.4.1; a single global pnpm cannot serve both).
 *
 * We split the YAML into step blocks at each `- name:` boundary and keep the
 * blocks that declare `working-directory: next.js`.
 */
function nextJsStepBlocks(): string[] {
  const lines = workflowText().split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks.filter((b) => /working-directory:\s*next\.js\b/.test(b));
}

describe('compat-suite workflow pnpm pin (test-e2e-deploy.yml)', () => {
  it('has at least one pnpm/action-setup step (sanity)', () => {
    expect(pnpmSetupVersions().length).toBeGreaterThan(0);
  });

  it('every pnpm/action-setup step pins an explicit version', () => {
    pnpmSetupVersions().forEach((version, idx) => {
      expect(version, `pnpm/action-setup step #${idx + 1} must set with.version`).not.toBeNull();
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

  // ── Engine-clash regression guard (the #137 follow-up) ──────────────────────
  // build-next pins action-setup pnpm to 10.4.1 for the knext @knext/lib/core
  // builds, but next.js v16.0.3 declares `packageManager: pnpm@9.6.0`. A single
  // global pnpm cannot satisfy both: running `pnpm install` inside next.js under
  // 10.4.1 fails the engine check and every deploy-tests shard SKIPs. The fix is
  // to drive the next.js steps through corepack (per-project pnpm) rather than
  // the globally-pinned action-setup pnpm.

  it('enables corepack so next.js can use its own packageManager pnpm', () => {
    expect(
      /corepack\s+enable/.test(workflowText()),
      'workflow must `corepack enable` so next.js per-project pnpm is honored',
    ).toBe(true);
  });

  it('runs next.js install/build via corepack, not the bare (knext-pinned) pnpm', () => {
    const blocks = nextJsStepBlocks();
    expect(blocks.length, 'expected at least one next.js working-directory step').toBeGreaterThan(
      0,
    );

    for (const block of blocks) {
      // Collect the shell command lines inside this step's `run:` block.
      const cmdLines = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /(^|\s)pnpm(\s|$)/.test(l) && !l.startsWith('#'));

      for (const cmd of cmdLines) {
        // Any pnpm invocation in a next.js step must go through corepack so it
        // resolves next.js's pinned pnpm@9.6.0, never the knext 10.4.1 shim.
        expect(
          /corepack\s+pnpm(\s|$)/.test(cmd) || /corepack\s+enable/.test(cmd),
          `next.js step must invoke pnpm via corepack (got: "${cmd}")`,
        ).toBe(true);
      }
    }
  });

  it('does not reuse the knext pnpm pin for next.js by hardcoding 9.6.0', () => {
    // Honor next.js's pinned pnpm via corepack rather than hardcoding a second
    // version that would silently drift from upstream's packageManager field.
    const setups = pnpmSetupVersions();
    const expected = pinnedPnpmVersion();
    // Every action-setup step is the knext one; none should pin next.js's 9.6.0.
    expect(
      setups.every((v) => v === expected),
      'no pnpm/action-setup step should pin a second (next.js) pnpm version',
    ).toBe(true);
  });
});

// ── Build-perf regression guard (#147 step 1) ─────────────────────────────────
// As of the 2026-06-27 dispatch, `build-next` reached the real next.js build but
// hit the 60-minute job timeout while building next.js v16.0.3 from source and
// was cancelled, so the 4 deploy-tests shards never executed. The fix raises the
// build-next timeout to a realistic cold-build ceiling AND caches the pnpm store
// + next.js build output keyed on NEXTJS_REF so repeat runs are fast. These guards
// prevent that perf fix from silently regressing.

/**
 * Returns the body of the `build-next` job: every line from the `build-next:`
 * key up to (but not including) the next sibling job key (`deploy-tests:`).
 */
function buildNextJobBlock(): string {
  const lines = workflowText().split('\n');
  let start = -1;
  let jobIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s+)build-next:\s*$/);
    if (m) {
      start = i;
      jobIndent = m[1].length;
      break;
    }
  }
  expect(start, 'workflow must declare a build-next job').toBeGreaterThanOrEqual(0);
  const out: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    // A sibling job key (same indent, non-comment, ends with ':') ends the block.
    if (indent === jobIndent && /^\s+\S.*:\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

describe('compat-suite build-next perf guards (test-e2e-deploy.yml, #147)', () => {
  it('raises the build-next timeout to match the reference cold-build ceiling (180 min)', () => {
    const block = buildNextJobBlock();
    const m = block.match(/^\s*timeout-minutes:\s*(\d+)/m);
    expect(m, 'build-next must declare timeout-minutes').not.toBeNull();
    const minutes = Number((m as RegExpMatchArray)[1]);
    // Round 1 raised this to 120; the full-monorepo cold build still hit that
    // exact ceiling (run 28285404942 cancelled at +120). The reference deploy
    // harness (build_reusable.yml) affords 180 min; match it so the first cold
    // build of the now-narrower scope has real headroom to COMPLETE.
    expect(
      minutes,
      'build-next timeout must be >=180 min — a cold build was cancelled at the 120-min ceiling',
    ).toBeGreaterThanOrEqual(180);
  });

  // ── Build-scope guard (#147 step 1, round 2) ──────────────────────────────
  // The 120-min full-monorepo cold build (`corepack pnpm build` = `turbo run
  // build` over docs/examples/eslint-plugin-next/create-next-app/etc.) never
  // finished, so the deploy-tests shards never ran. The deploy tests only need
  // the `next` package and its workspace dependency closure built — they invoke
  // `next build` against fixture apps (see scripts/e2e-deploy.sh). The fix
  // scopes the build with a turbo filter `--filter=next...` (trailing `...`
  // includes next's workspace deps). This guard prevents a silent regression
  // back to the unscoped full-monorepo build.
  it('scopes the next.js build to `next` + its workspace deps (not the whole monorepo)', () => {
    const block = buildNextJobBlock();
    // The next.js build step must run turbo's build task scoped to the `next`
    // package dependency closure, via corepack (per-project pnpm — #137 guard).
    const hasScopedBuild =
      /corepack\s+pnpm\s+turbo\s+run\s+build\b[^\n]*--filter[=\s]+next\.\.\./.test(block);
    expect(
      hasScopedBuild,
      'build-next must build a TARGETED scope (`corepack pnpm turbo run build --filter=next...`), not the full monorepo',
    ).toBe(true);
    // And it must NOT fall back to the unscoped full-monorepo build, which is
    // what hit the 120-min timeout.
    expect(
      /corepack\s+pnpm\s+build\b/.test(block),
      'build-next must not run the unscoped `corepack pnpm build` (full-monorepo cold build that timed out)',
    ).toBe(false);
  });

  it('caches the pnpm store and the next.js build, keyed on NEXTJS_REF', () => {
    const block = buildNextJobBlock();
    // At least one actions/cache step in build-next.
    expect(
      /uses:\s*actions\/cache(?:@|\s|$)/.test(block),
      'build-next must use actions/cache to avoid redoing the cold build every run',
    ).toBe(true);
    // Every concrete cache key in build-next must include NEXTJS_REF so a ref
    // bump invalidates the cache (the build is only valid for one pinned ref).
    // We collect inline `key:` values plus the continuation lines under a
    // `restore-keys: |` block scalar (skipping the `|` line itself).
    const blockLines = block.split('\n');
    const keyValues: string[] = [];
    for (let i = 0; i < blockLines.length; i++) {
      const inline = blockLines[i].match(/^\s*key:\s*(\S.*)$/);
      if (inline) keyValues.push(inline[1].trim());
      if (/^\s*restore-keys:\s*\|\s*$/.test(blockLines[i])) {
        const baseIndent = blockLines[i].search(/\S/);
        for (let j = i + 1; j < blockLines.length; j++) {
          if (blockLines[j].trim() === '') continue;
          const indent = blockLines[j].search(/\S/);
          if (indent <= baseIndent) break;
          keyValues.push(blockLines[j].trim());
        }
      }
    }
    expect(keyValues.length, 'build-next cache step must declare a key').toBeGreaterThan(0);
    for (const value of keyValues) {
      expect(
        /NEXTJS_REF/.test(value),
        `cache key must include NEXTJS_REF so a ref bump invalidates it (got: "${value}")`,
      ).toBe(true);
    }
  });
});
