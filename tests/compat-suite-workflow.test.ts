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

// ── Prebuilt-next guard (#147 step 1, round 4 — the prebuilt pivot) ────────────
// Rounds 1–3 tried to make `build-next` COMPILE next.js v16.0.3 from source within
// the job window (timeout 60→120→180, build scoping `--filter=next...`, a
// GHA-backed turbo remote cache). The source build proved NON-CONVERGENT: even
// the scoped build exceeded the 180-min runner ceiling across two cache-warming
// dispatches, so the 4 deploy-tests shards NEVER executed.
//
// PIVOT: stop compiling `next` from source. The published `next@16.0.3` npm tarball
// IS the built `packages/next` at the same version, so testing knext's adapter
// against it is functionally equivalent (arguably MORE correct for an adapter
// compat test). The reference deploy harness supports this first-class: when
// `NEXT_TEST_PKG_PATHS` is set (a JSON [[name, tarballPath]] map), `createNextInstall`
// SKIPS `linkPackages` (the source-pack step) and installs the provided tarball
// into each fixture app. `@next/swc` still arrives prebuilt via the tarball's
// optionalDependencies — no Rust build either.
//
// These guards lock in the prebuilt path and prevent a regression back to the
// non-convergent source build.

/**
 * Returns the body of the `build-next` job: every line from the `build-next:`
 * key up to (but not including) the next sibling job key (`deploy-tests:`).
 */
function buildNextJobBlock(): string {
  return jobBlock('build-next');
}

/** Returns the body of the `deploy-tests` job block. */
function deployTestsJobBlock(): string {
  return jobBlock('deploy-tests');
}

/** Returns the lines of a top-level job block by its key (e.g. `build-next`). */
function jobBlock(jobName: string): string {
  const lines = workflowText().split('\n');
  let start = -1;
  let jobIndent = -1;
  const keyRe = new RegExp(`^(\\s+)${jobName}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      start = i;
      jobIndent = m[1].length;
      break;
    }
  }
  expect(start, `workflow must declare a ${jobName} job`).toBeGreaterThanOrEqual(0);
  const out: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    // A sibling job key (same indent, non-comment, ends with ':') ends the block.
    if (indent === jobIndent && /^\s+\S.*:\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

describe('compat-suite prebuilt-next guards (test-e2e-deploy.yml, #147)', () => {
  it('acquires the PUBLISHED next (npm pack/install), not a source build', () => {
    const block = buildNextJobBlock();
    // build-next must fetch the published next tarball for the pinned ref. We
    // accept `npm pack next@<ref>` (the canonical acquisition). The ref is the
    // numeric version (NEXTJS_REF is a git tag like `v16.0.3`; the npm dist-tag
    // strips the leading `v`), so we match a published-next acquisition that
    // references the resolved version env.
    const hasPublishedAcquire =
      /npm\s+pack\s+["']?next@/.test(block) || /npm\s+(?:install|i)\s+["']?next@/.test(block);
    expect(
      hasPublishedAcquire,
      'build-next must acquire the PUBLISHED next (e.g. `npm pack next@$NEXT_NPM_VERSION`), not build it from source',
    ).toBe(true);
  });

  it('does NOT compile next.js from source (no turbo build of next)', () => {
    const block = buildNextJobBlock();
    // The non-convergent source build is gone: no `turbo run build` of next
    // (scoped or unscoped) and no full-monorepo `corepack pnpm build`.
    expect(
      /turbo\s+run\s+build\b/.test(block),
      'build-next must NOT run `turbo run build` — the source build is the non-convergent bottleneck',
    ).toBe(false);
    expect(
      /corepack\s+pnpm\s+build\b/.test(block),
      'build-next must NOT run the full-monorepo `corepack pnpm build`',
    ).toBe(false);
    expect(
      /--filter[=\s]+next\.\.\./.test(block),
      'build-next must NOT use the source-build `--filter=next...` scope',
    ).toBe(false);
  });

  it('does NOT wire the turbo remote-cache (only the source build needed it)', () => {
    const block = buildNextJobBlock();
    // The dtinth turbo remote-cache action existed solely to incrementally
    // persist the source build across runs. With no source build, it is dead
    // weight (and an extra supply-chain dependency) — drop it.
    expect(
      /setup-github-actions-caching-for-turbo/.test(block),
      'build-next should not wire a turbo remote cache once the source build is gone',
    ).toBe(false);
  });

  it('passes the prebuilt next tarball to the harness via NEXT_TEST_PKG_PATHS', () => {
    // The deploy-tests shard step must set NEXT_TEST_PKG_PATHS so the reference
    // harness (`createNextInstall`) installs the published `next` tarball into
    // each fixture app instead of packing it from source (`linkPackages`).
    const block = deployTestsJobBlock();
    expect(
      /NEXT_TEST_PKG_PATHS\s*:/.test(block),
      'deploy-tests must set NEXT_TEST_PKG_PATHS to the prebuilt next tarball so the harness skips the source pack',
    ).toBe(true);
  });

  it('still installs the harness deps via corepack pnpm (next.js per-project pnpm)', () => {
    // We still need next.js's own deps installed so `run-tests.js` + the source
    // `test/` harness run — and `@next/swc` arrives prebuilt during that install.
    // That install must still go through corepack (#137 engine-clash guard).
    const block = buildNextJobBlock();
    expect(
      /corepack\s+pnpm\s+install\b/.test(block),
      'build-next must still `corepack pnpm install` the next.js harness deps',
    ).toBe(true);
  });
});
