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
      // Collect the shell command lines inside this step's `run:` block. Exclude
      // YAML metadata keys (`name:`, `id:`, `working-directory:`, `env:` keys,
      // `uses:`) and comments — a step `name:` can legitimately contain the word
      // "pnpm" (e.g. "Resolve next.js pnpm store path") without being a command.
      const cmdLines = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /(^|\s)pnpm(\s|$)/.test(l) && !l.startsWith('#'))
        .filter((l) => !/^-?\s*(name|id|uses|working-directory|env|with|run):/.test(l));

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

// ── Lean + cached harness-install guards (#147 — the cold-install decider) ─────
// #157 removed BOTH the pnpm-store actions/cache AND the (correctly-removed)
// source build. A COLD, uncached full-monorepo `corepack pnpm install` of
// next.js then ran for the first time and exceeded the 180-min runner ceiling,
// cancelling at exactly the timeout — so the deploy-tests shards still never ran.
//
// Two complementary fixes, both guarded here:
//   1. RE-ADD the pnpm-store actions/cache (keyed on NEXTJS_REF + the next.js
//      lockfile) so a repeat run skips re-downloading every dependency. The
//      turbo BUILD cache stays gone (the prebuilt-next guards above enforce that).
//   2. SLIM the cold install itself: the deploy-harness only imports ROOT
//      devDependencies (run-tests.js: @actions/core/@vercel/kv/async-sema/glob/
//      yargs; create-next-install: execa/fs-extra; the test/lib helpers:
//      cheerio/express/get-port/strip-ansi/playwright). It needs NONE of the
//      monorepo's workspace packages (packages/*, apps/*, bench/*, turbopack/*)
//      installed at this stage — create-next-install builds each fixture's temp
//      app SEPARATELY and (in prebuilt mode, NEXT_TEST_PKG_PATHS) installs `next`
//      from the tarball, skipping linkPackages. So a `--filter` to the root
//      project plus --frozen-lockfile --prefer-offline cuts the dep graph
//      dramatically while keeping run-tests.js fully resolvable.

describe('compat-suite lean+cached harness install (test-e2e-deploy.yml, #147)', () => {
  it('re-adds the pnpm-store actions/cache keyed on NEXTJS_REF + the next.js lockfile', () => {
    const block = buildNextJobBlock();
    // An actions/cache step must exist in build-next.
    expect(
      /uses:\s*actions\/cache@/.test(block),
      'build-next must re-add an actions/cache step for the next.js pnpm store',
    ).toBe(true);
    // Its key must be parameterized on NEXTJS_REF (so a ref bump invalidates it)
    // AND the next.js pnpm lockfile (so a dep change invalidates it). This is the
    // non-tautological assertion: both inputs must appear in the SAME cache key.
    const keyLine = block
      .split('\n')
      .find((l) => /^\s*key:\s*/.test(l) && /pnpm/.test(l) && /NEXTJS_REF/.test(l));
    expect(keyLine, 'the pnpm-store cache key must be keyed on env.NEXTJS_REF').toBeTruthy();
    expect(
      /hashFiles\(\s*['"]next\.js\/pnpm-lock\.yaml['"]\s*\)/.test(keyLine ?? ''),
      'the pnpm-store cache key must include hashFiles of next.js/pnpm-lock.yaml',
    ).toBe(true);
  });

  it('resolves the pnpm store path (the resolver the cache step needs)', () => {
    const block = buildNextJobBlock();
    expect(
      /corepack\s+pnpm\s+store\s+path/.test(block),
      'build-next must resolve `corepack pnpm store path` so actions/cache can target the store',
    ).toBe(true);
  });

  it('caches the pnpm STORE, not the turbo build output (build cache stays gone)', () => {
    const block = buildNextJobBlock();
    // The cache must target the resolved store path, never the turbo build dirs
    // that the (removed) source build needed. Guard against a build-cache regression.
    expect(
      /node_modules\/\.cache\/turbo/.test(block),
      'build-next must NOT cache the turbo build output (the source build is gone)',
    ).toBe(false);
    expect(
      /packages\/\*\*\/dist/.test(block),
      'build-next must NOT cache next.js packages dist (the source build is gone)',
    ).toBe(false);
  });

  it('runs a SLIM frozen + prefer-offline harness install (not a full cold resolve)', () => {
    const block = buildNextJobBlock();
    // The harness install must use --frozen-lockfile (no full re-resolution) and
    // --prefer-offline (reuse the restored store) so the cold install converges.
    const installLine = block
      .split('\n')
      .find((l) => /corepack\s+pnpm\s+install\b/.test(l) && !l.trim().startsWith('#'));
    expect(installLine, 'expected a corepack pnpm install command line').toBeTruthy();
    expect(
      /--frozen-lockfile\b/.test(installLine ?? ''),
      'the harness install must pass --frozen-lockfile (avoid a full cold re-resolve)',
    ).toBe(true);
    expect(
      /--prefer-offline\b/.test(installLine ?? ''),
      'the harness install must pass --prefer-offline (reuse the restored store)',
    ).toBe(true);
  });

  it('filters the harness install to the root project (skips the monorepo workspace graph)', () => {
    const block = buildNextJobBlock();
    const installLine = block
      .split('\n')
      .find((l) => /corepack\s+pnpm\s+install\b/.test(l) && !l.trim().startsWith('#'));
    // run-tests.js + create-next-install only import ROOT devDependencies; none
    // of the workspace packages are needed at this stage. A --filter to the root
    // project cuts the dep graph dramatically without breaking the harness.
    expect(
      /--filter\b/.test(installLine ?? ''),
      'the harness install must --filter to the root project to skip workspace deps',
    ).toBe(true);
  });

  it('skips the SWC native postinstall (prebuilt next supplies @next/swc per-fixture)', () => {
    const block = buildNextJobBlock();
    // next.js root postinstall (install-native.mjs) does a `pnpm add next@<ver>`
    // to fetch all 8 SWC platform binaries — pure waste in prebuilt mode, where
    // @next/swc arrives from the tarball during each fixture install. The script
    // early-returns on NEXT_SKIP_NATIVE_POSTINSTALL.
    expect(
      /NEXT_SKIP_NATIVE_POSTINSTALL/.test(block),
      'build-next should set NEXT_SKIP_NATIVE_POSTINSTALL to skip the wasteful SWC native postinstall',
    ).toBe(true);
  });
});

// ── Network-resilient harness install guards (#147 — the resilience lever) ─────
// The slimmed+cached install (above) STILL ran the full 180-min job timeout and
// was CANCELLED (not errored) across 3 dispatches — identical 180:00 even after
// the root-only slim. That signature = pnpm HANGING on stuck network requests
// (this CI env shows repeated Docker Hub / npm-registry timeouts), NOT a fast
// network failure. KEY INSIGHT: pnpm's content-addressable store + the restored
// actions/cache PERSIST across re-invocations within the same job, so a RETRY
// LOOP with a PER-ATTEMPT TIMEOUT makes incremental progress — each attempt
// resumes from what the prior attempt downloaded — until one attempt completes.
//
// Two complementary fixes, both guarded here:
//   1. Wrap the next.js install in a bash retry loop with a per-attempt
//      `timeout` (e.g. up to 4 × 40m = 160m, safely under the 180-min ceiling).
//      Succeed on the first exit-0 attempt; fail only if all attempts exhaust.
//   2. Add pnpm network hardening so stuck requests fail-fast-and-retry instead
//      of hanging: fetch-retries, fetch-retry-min/maxtimeout, fetch-timeout, and
//      a LOWER network-concurrency. These must apply to the next.js install.

describe('compat-suite network-resilient harness install (test-e2e-deploy.yml, #147)', () => {
  /** The single build-next step block whose run: body installs the harness. */
  function harnessInstallStep(): string {
    return nextJsStepBlocks().find((b) => /corepack\s+pnpm\s+install\b/.test(b)) ?? '';
  }

  it('wraps the harness install in a retry loop with a per-attempt timeout', () => {
    const step = harnessInstallStep();
    expect(step, 'expected a next.js step that runs corepack pnpm install').not.toBe('');
    // A per-attempt `timeout <N>m corepack pnpm install ...` must guard each try
    // so a hung attempt is killed and retried rather than running to the job
    // timeout. The bare value 180 (the job ceiling) is NOT a valid per-attempt
    // timeout — assert a per-attempt timeout that is comfortably below it.
    const timeoutInstall = step.match(/timeout\s+(\d+)m\s+corepack\s+pnpm\s+install\b/);
    expect(
      timeoutInstall,
      'the harness install must be wrapped in `timeout <N>m corepack pnpm install` (per-attempt timeout)',
    ).not.toBeNull();
    const perAttemptMin = Number((timeoutInstall as RegExpMatchArray)[1]);
    expect(
      perAttemptMin,
      'the per-attempt timeout must be well under the 180-min job ceiling',
    ).toBeLessThanOrEqual(60);

    // There must be a loop construct that retries the attempt a bounded number
    // of times (for/while over an attempt counter), so failed/timed-out attempts
    // are re-run rather than failing the step on the first hang.
    expect(
      /\b(for|while)\b/.test(step),
      'the harness install must use a retry loop (for/while) so a hung attempt is retried',
    ).toBe(true);

    // The loop must be bounded by a max attempt count, and total budget
    // (attempts × per-attempt-timeout) must stay under the 180-min job ceiling.
    const attemptsMatch = step.match(/(?:attempts?|max[_-]?attempts?|tries|ATTEMPTS)\s*=\s*(\d+)/i);
    expect(
      attemptsMatch,
      'the retry loop must declare a bounded attempt count (e.g. attempts=4)',
    ).not.toBeNull();
    const attempts = Number((attemptsMatch as RegExpMatchArray)[1]);
    expect(attempts, 'must allow more than one attempt').toBeGreaterThan(1);
    expect(
      attempts * perAttemptMin,
      `attempts (${attempts}) × per-attempt timeout (${perAttemptMin}m) must stay under the 180-min job ceiling`,
    ).toBeLessThan(180);
  });

  it('succeeds as soon as one install attempt exits 0 (does not always exhaust)', () => {
    const step = harnessInstallStep();
    // The loop must break/exit-success on a zero exit (e.g. `&& break`, `break`,
    // or an explicit success flag) — not blindly run all attempts every time.
    expect(
      /\bbreak\b/.test(step),
      'the retry loop must break out on the first successful (exit-0) attempt',
    ).toBe(true);
  });

  it('applies pnpm network hardening to the next.js install (retries + timeouts + lower concurrency)', () => {
    const step = harnessInstallStep();
    // These must apply to the next.js install. We accept either NPM_CONFIG_* env
    // vars on the step or a pnpm config written into the next.js dir. Assert the
    // concrete hardening knobs, not just their presence somewhere generic.
    const text = step;
    expect(
      /(NPM_CONFIG_FETCH_RETRIES|fetch-retries)/i.test(text),
      'the install must set fetch-retries (more registry retries before giving up)',
    ).toBe(true);
    expect(
      /(NPM_CONFIG_FETCH_RETRY_MINTIMEOUT|fetch-retry-mintimeout)/i.test(text),
      'the install must set fetch-retry-mintimeout',
    ).toBe(true);
    expect(
      /(NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT|fetch-retry-maxtimeout)/i.test(text),
      'the install must set fetch-retry-maxtimeout',
    ).toBe(true);
    expect(
      /(NPM_CONFIG_FETCH_TIMEOUT|fetch-timeout)/i.test(text),
      'the install must set fetch-timeout so a single stuck request fails fast',
    ).toBe(true);
    // Lower network-concurrency to avoid overwhelming the flaky network.
    const concMatch = text.match(
      /(?:NPM_CONFIG_NETWORK_CONCURRENCY|network-concurrency)\s*[:=]\s*['"]?(\d+)/i,
    );
    expect(
      concMatch,
      'the install must lower network-concurrency to avoid overwhelming the flaky network',
    ).not.toBeNull();
    expect(
      Number((concMatch as RegExpMatchArray)[1]),
      'network-concurrency should be lowered (below pnpm default of 16)',
    ).toBeLessThan(16);
  });
});

// ── Playwright browser-download guards (#147 — THE root cause) ──────────────────
// Definitive diagnosis (run 28310661064 install-step log): `corepack pnpm install`
// RESOLVES all 3345 packages in ~3 SECONDS ("resolved 3345, reused 3337,
// downloaded 0, added 0, done") — the pnpm install is NOT the bottleneck. Each
// retry attempt then HANGS for 40 minutes in the `playwright-chromium` package's
// POSTINSTALL, i.e. downloading the Chromium browser binary from Playwright's CDN,
// which times out (the same network throttling failing Docker Hub pulls all
// session), gets killed by the per-attempt timeout, and fails all 4 attempts
// (`playwright-chromium install: Failed` / `ELIFECYCLE`). Every prior
// "infra-bound / 180-min" conclusion was actually THIS browser download hanging.
//
// FIX: set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 on the Prepare install step so the
// `playwright-chromium` postinstall does NOT fetch the browser — the install then
// finishes in seconds (resolution only). The browser binary is only needed when a
// test actually drives `next-webdriver`, so any chromium install belongs in the
// SHARD job (where it is used), retry+timeout-wrapped and actions/cache-d — NOT in
// the Prepare job's blocking install.

describe('compat-suite Playwright browser-download fix (test-e2e-deploy.yml, #147)', () => {
  /** The single build-next step block whose run: body installs the harness. */
  function harnessInstallStep(): string {
    return nextJsStepBlocks().find((b) => /corepack\s+pnpm\s+install\b/.test(b)) ?? '';
  }

  it('sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD on the Prepare harness install', () => {
    const step = harnessInstallStep();
    expect(step, 'expected a next.js step that runs corepack pnpm install').not.toBe('');
    // The hang is playwright-chromium's postinstall downloading the browser. The
    // env var must be present in the install step's env so pnpm skips that fetch.
    const m = step.match(/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD\s*:\s*['"]?([^'"\s#]+)/);
    expect(
      m,
      'the harness install step must set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD so the chromium download (the real hang) is skipped',
    ).not.toBeNull();
    // A truthy value ("1" / "true") — not "0"/"false".
    const value = (m as RegExpMatchArray)[1];
    expect(
      ['1', 'true'],
      `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD must be truthy, got "${value}"`,
    ).toContain(value);
  });

  it('any Prepare-job browser install is BOUNDED, cache-gated and non-fatal (never the old blocking hang)', () => {
    // HISTORY: the original hang was playwright-chromium's postinstall download
    // running UNBOUNDED inside the blocking `corepack pnpm install` — this test
    // used to forbid ANY `playwright install` in build-next. #147 A3-3 fix
    // round 1 (triage of run 28558576615) deliberately re-adds ONE explicit
    // install here to WARM the actions/cache so the 16 shards exact-hit instead
    // of racing 16 concurrent CDN downloads (9/16 shards burned 4×10-min
    // timeouts and ran with NO chromium). The invariant that must never regress
    // is the SHAPE, not the absence: bounded per-attempt timeout, retry loop,
    // gated on a cache miss, and NON-FATAL (a throttled CDN must not kill the
    // run's preparation).
    const block = buildNextJobBlock();
    if (!/playwright\s+install\b/.test(block)) return; // absent is also fine
    expect(
      /timeout\s+\d+m[\s\S]*playwright\s+install\b/.test(block),
      'the Prepare chromium warm-install must be wrapped in a per-attempt `timeout <N>m`',
    ).toBe(true);
    expect(
      /\b(for|while)\b/.test(block),
      'the Prepare chromium warm-install must use a retry loop (for/while)',
    ).toBe(true);
    expect(
      /if:\s*steps\.[\w-]+\.outputs\.cache-hit\s*!=\s*'true'/.test(block),
      'the Prepare chromium warm-install must be gated on a cache miss',
    ).toBe(true);
    expect(
      /::warning::/.test(block),
      'the Prepare chromium warm-install must be NON-FATAL (warn, never fail the prep)',
    ).toBe(true);
  });

  it('the shard chromium install stays retry+timeout-wrapped and cached', () => {
    const shardBlock = deployTestsJobBlock();
    const shardInstallsBrowser = /playwright\s+install\b/.test(shardBlock);

    if (shardInstallsBrowser) {
      // If the shard installs chromium, it must be bounded: a per-attempt timeout,
      // a retry loop, and an actions/cache keyed on the playwright version so the
      // CDN download is not repeated every run and a hang is bounded + retried.
      expect(
        /timeout\s+\d+m[\s\S]*playwright\s+install\b/.test(shardBlock),
        'the shard chromium install must be wrapped in a per-attempt `timeout <N>m`',
      ).toBe(true);
      expect(
        /\b(for|while)\b/.test(shardBlock),
        'the shard chromium install must use a retry loop (for/while)',
      ).toBe(true);
      expect(
        /uses:\s*actions\/cache@/.test(shardBlock),
        'the shard chromium install must be cached via actions/cache (keyed on the playwright version)',
      ).toBe(true);
    }
  });
});

// ── Workspace-handoff: tar transport (symlinks + exec bits), no installed
// node_modules (#147 — OOM, then the v16.2.0 haste-collision abort) ───────────
// Round 8 (run 28314500989): uploading the raw trees OOM'd actions/upload-artifact
// (it globs + hashes every file); fix was excluding `**/node_modules` and having
// each shard re-run the slim cached install.
//
// Round 11 (run 28556241980, REPRODUCED LOCALLY): the zip-based artifact
// MATERIALIZES SYMLINKS into real file copies. next.js's test corpus contains
// symlinks under jest's crawl roots (e.g. 4× `test/e2e/app-dir/next-condition/
// fixtures/*/sym-linked-packages -> ../../packages`); materialized, the same
// fixture package.json (`my-cjs-package`) exists twice → jest-haste-map
// `Haste module naming collision` → and v16.2.0's jest.config.js NEWLY sets
// `haste: { throwOnModuleCollision: true }` (16.0.3 only warned) → jest throws
// `Error: Duplicated files or mocks` ~1s into the crawl → `--listTests` lists 0.
// The blanket `!**/node_modules` exclude ALSO silently dropped test-FIXTURE
// node_modules (part of the corpus, e.g. next-condition's linked packages) —
// a latent run-time corruption.
//
// FIX: hand off ONE TARBALL. tar preserves symlinks + exec bits (zip artifact
// does neither), a single file cannot OOM the upload hasher, and the excludes
// become ANCHORED (only the INSTALLED ./next.js/node_modules + knext's installed
// node_modules) so fixture node_modules ride along. The shard unpacks and
// asserts the collision-critical symlink SURVIVED transport (tripwire).

describe('compat-suite workspace handoff is a symlink-preserving tarball (test-e2e-deploy.yml, #147)', () => {
  function buildNextSteps(): string[] {
    const lines = buildNextJobBlock().split('\n');
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
    return blocks;
  }

  /** The build-next step that tars the workspace. */
  function packWorkspaceStep(): string {
    return buildNextSteps().find((b) => /tar\s+c[a-z]*f[^\n]*compat-workspace\.tgz/.test(b)) ?? '';
  }

  /** The build-next `Upload workspace` step block (the upload-artifact step). */
  function uploadWorkspaceStep(): string {
    return (
      buildNextSteps().find(
        (b) => /uses:\s*actions\/upload-artifact@/.test(b) && /compat-workspace/.test(b),
      ) ?? ''
    );
  }

  it('packs the workspace as a tarball (symlinks + exec bits survive; zip materializes symlinks)', () => {
    const step = packWorkspaceStep();
    expect(
      step,
      'expected a build-next step that tars the workspace to compat-workspace.tgz',
    ).not.toBe('');
    // It must carry the three trees the shards need.
    expect(/\.\/knext\b/.test(step), 'the tarball must include the knext tree').toBe(true);
    expect(/\.\/next\.js\b/.test(step), 'the tarball must include the next.js source tree').toBe(
      true,
    );
    expect(
      /\.\/next-prebuilt\b/.test(step),
      'the tarball must include next-prebuilt (the prebuilt next.tgz)',
    ).toBe(true);
  });

  it('excludes only the INSTALLED node_modules (anchored), never the test-fixture ones', () => {
    const step = packWorkspaceStep();
    // The OOM cause was the INSTALLED trees (3345 packages). But next.js's test
    // corpus contains fixture node_modules that must ride along — a blanket
    // `**/node_modules` exclude silently corrupts fixtures. Excludes must be
    // ANCHORED to the installed locations.
    expect(
      /--exclude=['"]?\.\/next\.js\/node_modules['"]?/.test(step),
      'must exclude the INSTALLED ./next.js/node_modules (anchored, top-level only)',
    ).toBe(true);
    expect(
      /--exclude=['"]?\.\/knext\/node_modules['"]?/.test(step),
      'must exclude the installed ./knext/node_modules',
    ).toBe(true);
    expect(
      /--exclude=['"]?\*\*\/node_modules['"]?/.test(step) ||
        /--exclude=['"]?node_modules['"]?(\s|$)/m.test(step),
      'must NOT blanket-exclude every node_modules (test fixtures carry node_modules that are part of the corpus)',
    ).toBe(false);
  });

  it('uploads ONLY the single tarball (no raw-tree globs; the OOM is structurally impossible)', () => {
    const step = uploadWorkspaceStep();
    expect(step, 'expected a build-next upload-artifact step for compat-workspace').not.toBe('');
    expect(
      /compat-workspace\.tgz/.test(step),
      'the artifact payload must be the single compat-workspace.tgz',
    ).toBe(true);
    // No raw-tree glob lines: hashing hundreds of thousands of files is what
    // OOM'd the upload; a `!`-exclude line implies raw-tree globbing is back.
    expect(
      /^\s*!.*node_modules/m.test(step),
      'no `!`-exclude glob lines — the payload is one tarball, not raw trees',
    ).toBe(false);
  });

  it('the shard unpacks the tarball and tripwires on the collision-critical symlink', () => {
    const lines = deployTestsJobBlock().split('\n');
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
    const unpack = blocks.find((b) => /tar\s+x[a-z]*f[^\n]*compat-workspace\.tgz/.test(b)) ?? '';
    expect(unpack, 'expected a shard step that unpacks compat-workspace.tgz').not.toBe('');
    // The tripwire: if the transport ever materializes symlinks again, fail HERE
    // with the cause named — not 20 steps later as a cryptic 0-test jest abort.
    expect(
      /next\.js\/test\/e2e\/app-dir\/next-condition\/fixtures\/[\w/-]*sym-linked-packages/.test(
        unpack,
      ),
      'the unpack step must name a concrete known fixture symlink to probe',
    ).toBe(true);
    expect(
      /\[\s+!?\s*-L\s+["']?\$\{?SYMLINK_PROBE\}?["']?\s+\]|test\s+-L\s+/.test(unpack),
      'the unpack step must assert the probe is still a SYMLINK (-L) after transport',
    ).toBe(true);
    expect(
      /::error::[^\n]*symlink/i.test(unpack) && /\bexit\s+1\b/.test(unpack),
      'a materialized symlink must fail the shard loudly (::error:: + exit 1)',
    ).toBe(true);
    // Ordering: unpack right after download, before any step that uses the trees.
    const block = deployTestsJobBlock();
    const downloadIdx = block.search(/uses:\s*actions\/download-artifact@/);
    const unpackIdx = block.indexOf(unpack.trimStart().split('\n')[0]);
    expect(downloadIdx, 'expected the download-artifact step').toBeGreaterThanOrEqual(0);
    expect(unpackIdx, 'expected to locate the unpack step').toBeGreaterThanOrEqual(0);
    expect(downloadIdx < unpackIdx, 'unpack must come AFTER the artifact download').toBe(true);
    const reinstallIdx = block.search(/-\s+name:[^\n]*Re-install next\.js harness deps/);
    expect(reinstallIdx, 'expected the re-install step').toBeGreaterThanOrEqual(0);
    expect(unpackIdx < reinstallIdx, 'unpack must come BEFORE the next.js re-install').toBe(true);
  });

  it('the shard restores the pnpm store cache with the SAME key the Prepare job warms', () => {
    const buildBlock = buildNextJobBlock();
    const shardBlock = deployTestsJobBlock();
    // The Prepare job warms a pnpm-store actions/cache. The shard must restore the
    // SAME store (same key) so its re-install is an offline cache HIT (seconds).
    const buildKey = buildBlock
      .split('\n')
      .find((l) => /^\s*key:\s*/.test(l) && /pnpm/.test(l) && /NEXTJS_REF/.test(l));
    const shardKey = shardBlock
      .split('\n')
      .find((l) => /^\s*key:\s*/.test(l) && /pnpm/.test(l) && /NEXTJS_REF/.test(l));
    expect(buildKey, 'the Prepare job must declare a pnpm-store cache key').toBeTruthy();
    expect(
      shardKey,
      'the shard must restore the pnpm-store cache (same key the Prepare job warms)',
    ).toBeTruthy();
    expect(
      (shardKey ?? '').trim(),
      'the shard pnpm-store cache key must be IDENTICAL to the Prepare job key',
    ).toBe((buildKey ?? '').trim());
    // And it must be the next.js store (lockfile-hashed), not some other cache.
    expect(
      /hashFiles\(\s*['"]next\.js\/pnpm-lock\.yaml['"]\s*\)/.test(shardKey ?? ''),
      'the shard pnpm-store cache key must hashFiles next.js/pnpm-lock.yaml',
    ).toBe(true);
  });

  it('the shard re-runs the SAME slim frozen install (node_modules rebuilt locally + fast)', () => {
    const shardBlock = deployTestsJobBlock();
    // Because the artifact ships no node_modules, the shard must re-install in
    // next.js — the SAME slim, cache-hit install the Prepare job ran.
    const installLine = shardBlock
      .split('\n')
      .find((l) => /corepack\s+pnpm\s+install\b/.test(l) && !l.trim().startsWith('#'));
    expect(
      installLine,
      'the shard must re-run `corepack pnpm install` to rebuild next.js node_modules (excluded from the artifact)',
    ).toBeTruthy();
    expect(
      /--frozen-lockfile\b/.test(installLine ?? ''),
      'the shard re-install must pass --frozen-lockfile',
    ).toBe(true);
    expect(
      /--prefer-offline\b/.test(installLine ?? ''),
      'the shard re-install must pass --prefer-offline (offline cache hit)',
    ).toBe(true);
    expect(
      /--filter\b/.test(installLine ?? ''),
      'the shard re-install must --filter to the root project (skip the workspace graph)',
    ).toBe(true);
  });

  it('the shard re-install skips the Playwright browser download (the #160 hang)', () => {
    const shardBlock = deployTestsJobBlock();
    // The shard re-install must keep PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set so its
    // playwright-chromium postinstall does NOT re-trigger the 40-min CDN hang —
    // chromium is installed by the dedicated (cached, non-fatal) shard step.
    const lines = shardBlock.split('\n');
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
    const reinstallStep =
      blocks.find((b) => /corepack\s+pnpm\s+install\b/.test(b) && !/^\s*#/.test(b.trim())) ?? '';
    expect(reinstallStep, 'expected a shard step that re-runs corepack pnpm install').not.toBe('');
    const m = reinstallStep.match(/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD\s*:\s*['"]?([^'"\s#]+)/);
    expect(
      m,
      'the shard re-install step must set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD so it does not re-trigger the browser-download hang',
    ).not.toBeNull();
    expect(['1', 'true']).toContain((m as RegExpMatchArray)[1]);
  });
});

// ── Shard chromium-install must be NON-FATAL (#147 step 1 — the milestone fix) ──
// THE milestone is "the 4 shards EXECUTE, not necessarily pass" (#147 step 1).
// The shard chromium install hits the SAME throttled Playwright CDN this whole PR
// diagnoses, so it can fail all retry attempts. If the install step then hard
// `exit 1`s on exhaustion, the WHOLE shard job ABORTS at that step — and the
// ~678/743 tests that DON'T need a browser never run. That defeats the milestone.
//
// The actual test-run step two steps later uses `|| true` precisely so a partial
// scaffold still runs; the chromium install must mirror that resilience. On
// exhaustion it must WARN and CONTINUE (exit 0) so the shard always proceeds to
// run-tests.js — only the ~65 browser-driving tests then fail when chromium is
// genuinely absent.

describe('compat-suite shard chromium install is non-fatal (test-e2e-deploy.yml, #147)', () => {
  /** The shard step block whose run: body installs the chromium browser. */
  function shardChromiumStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks.find((b) => /playwright\s+install\b/.test(b)) ?? '';
  }

  it('the shard chromium install exists and is retry+timeout wrapped (precondition)', () => {
    const step = shardChromiumStep();
    expect(step, 'expected a shard step that runs playwright install').not.toBe('');
    expect(
      /timeout\s+\d+m[\s\S]*playwright\s+install\b/.test(step),
      'the shard chromium install must be wrapped in a per-attempt timeout',
    ).toBe(true);
  });

  it('does NOT hard `exit 1` when all chromium-install attempts are exhausted', () => {
    const step = shardChromiumStep();
    expect(step, 'expected a shard step that runs playwright install').not.toBe('');
    // The CDN failing all attempts must NOT abort the shard. A literal `exit 1`
    // anywhere in this step body would make a failed install fatal, skipping the
    // ~678 non-browser tests. Forbid it — the step must warn-and-continue.
    expect(
      /\bexit\s+1\b/.test(step),
      'the shard chromium install must be NON-FATAL: no `exit 1` on exhaustion — warn and continue so the non-browser tests still run',
    ).toBe(false);
  });

  it('emits a CI warning when chromium is unavailable (so the failure is visible, not silent)', () => {
    const step = shardChromiumStep();
    // Non-fatal must not mean silent: surface the exhaustion as a GitHub warning
    // annotation so the partial run is explained in the job summary.
    expect(
      /::warning::/.test(step),
      'the shard chromium install must `echo "::warning::..."` on exhaustion so the partial run is visible',
    ).toBe(true);
  });
});

// ── A3-3: the shard must actually RUN real deploy tests (#147) ──────────────────
// Run 28314927507 SUCCEEDED with `passed:0 failed:0 excluded:4` — i.e. the CI
// infra worked end-to-end but the harness selected + ran ZERO tests. Root cause
// (proven against vercel/next.js@v16.0.3 source) was TWO-fold:
//
//   1. SELECTION: the knext manifest declared `version: 1`. next.js's
//      test/get-test-filter.js understands only the legacy (no-version) format
//      and `version === 2`; any other number THROWS `Unknown manifest version`.
//      run-tests.js calls getTestFilter() at MODULE LOAD (top-level), so the throw
//      killed the whole run before a single test was discovered — `|| true`
//      swallowed the non-zero exit and the summary parsed an empty log → 0/0.
//      FIX: the manifest is now v2 with string-glob include/exclude (guarded by
//      tests/deploy-manifest.test.ts).
//
//   2. LOADING: even once selected, jest cannot LOAD a deploy test module without
//      the workspace `packages/next` BUILT — every test/e2e/**/*.test.ts imports
//      e2e-utils / next-test-utils, which import `next/dist/*` + `next/constants`
//      at module scope, and jest.config.js does `require('next/jest')`. In the
//      prebuilt model `packages/next/dist` is absent (no source build). FIX: a
//      shard step unpacks the PUBLISHED next tarball (which IS the built package)
//      into next.js/packages/next so those module-scope imports resolve — no Rust,
//      no source TS build.
//
// These guards lock in BOTH halves so a regression cannot silently return to 0/0.

describe('compat-suite runs REAL deploy tests (test-e2e-deploy.yml, #147 A3-3)', () => {
  it('points NEXT_EXTERNAL_TESTS_FILTERS at the knext v2 manifest', () => {
    const block = deployTestsJobBlock();
    expect(
      /NEXT_EXTERNAL_TESTS_FILTERS\s*:[^\n]*deploy-tests-manifest\.knext\.json/.test(block),
      'the run step must filter via the knext deploy manifest',
    ).toBe(true);
  });

  it('hydrates the workspace next/dist from the prebuilt tarball BEFORE running tests', () => {
    // Without a built packages/next, jest cannot load any deploy test module
    // (e2e-utils/next-test-utils import next/dist/* at module scope; jest.config.js
    // requires next/jest). The shard must unpack the prebuilt next.tgz into
    // next.js/packages/next so those imports resolve.
    const block = deployTestsJobBlock();
    // It must reference the prebuilt tarball and the workspace packages/next dir,
    // and untar into packages/next.
    expect(
      /next-prebuilt\/next\.tgz/.test(block),
      'the shard must source the prebuilt next.tgz to hydrate workspace next/dist',
    ).toBe(true);
    expect(
      /tar\s+x[a-z]*f[^\n]*next-prebuilt\/next\.tgz/.test(block),
      'the shard must untar the prebuilt next.tgz',
    ).toBe(true);
    expect(
      /packages\/next\/dist/.test(block),
      'the hydrate step must populate packages/next/dist (the absent built artifact)',
    ).toBe(true);
  });

  /** The shard step block that hydrates workspace next/dist from the prebuilt tarball. */
  function nextDistHydrateStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks.find((b) => /-\s+name:[^\n]*Hydrate workspace next\/dist/.test(b)) ?? '';
  }

  it('the next/dist hydrate is hygienic: fresh extract dir + destination dist removed first', () => {
    // Run 28553944684 (v16.2.0, all 16 shards): after `cp -R SRC/dist PKG/dist`
    // the sanity check hit ENOENT on packages/next/dist/trace/index.js even though
    // the published next@16.2.0 tarball (byte-identical to a local `npm pack`)
    // DOES contain it. This step was the only hydrate that neither extracted into
    // a fresh dir nor removed a pre-existing destination — `cp -R src/dist
    // dst/dist` silently NESTS to dst/dist/dist when dst/dist already exists, and
    // a shared ${RUNNER_TEMP}/package can be polluted by any earlier tool. Both
    // hazards are eliminated unconditionally (the @next/env hydrate already
    // rm -rf's its target first).
    const step = nextDistHydrateStep();
    expect(step, 'expected the next/dist hydrate step').not.toBe('');
    expect(
      /mktemp -d/.test(step),
      'the hydrate must extract the tarball into a FRESH mktemp dir (never a shared temp path)',
    ).toBe(true);
    expect(
      /rm\s+-rf\s+"\$\{PKG_DIR\}\/dist"/.test(step),
      'the hydrate must remove any pre-existing packages/next/dist before cp -R (cp nests into an existing dir)',
    ).toBe(true);
  });

  it('the next/dist hydrate asserts the tarball payload BEFORE copying (loud layout-change failure)', () => {
    // If a future published next ever reshuffles its dist layout, the failure must
    // name the tarball at the copy source — not surface later as a jest load crash.
    const step = nextDistHydrateStep();
    expect(
      /\$\{SRC\}\/\$\{probe\}/.test(step),
      'the hydrate must probe the extracted tarball payload before cp',
    ).toBe(true);
    expect(
      /::error::[^\n]*tarball/.test(step),
      'a payload miss must emit a ::error:: naming the tarball',
    ).toBe(true);
  });

  it('the next/dist hydrate sanity check RESOLVES the real harness specifiers (ref-agnostic)', () => {
    // The old sanity hardcoded file paths ("dist/trace/index.js", …) — a
    // ref-specific assumption. The harness actually imports MODULE SPECIFIERS
    // (next/jest via jest.config.js, next/constants + next/dist/trace via
    // e2e-utils, next/dist/server/next via next-test-utils — verified at the
    // v16.2.0 tag), and next.js's root depends on `next: workspace:*`, so
    // `require.resolve(spec, {paths:[repo root]})` exercises the EXACT resolution
    // jest performs at run time — a future ref bump fails on the true specifier,
    // not a stale path list.
    const step = nextDistHydrateStep();
    expect(
      /require\.resolve\(\s*s\s*,\s*\{\s*paths:\s*\[process\.cwd\(\)\]\s*\}\s*\)/.test(step),
      'the sanity check must require.resolve the harness import specifiers from the next.js root',
    ).toBe(true);
    for (const spec of [
      'next/jest',
      'next/constants',
      'next/dist/trace',
      'next/dist/server/next',
    ]) {
      expect(step.includes(`"${spec}"`), `sanity must cover the harness specifier ${spec}`).toBe(
        true,
      );
    }
  });

  it('the hydrate step runs BEFORE the run-tests step (ordering)', () => {
    const block = deployTestsJobBlock();
    const hydrateIdx = block.search(/-\s+name:[^\n]*[Hh]ydrate[^\n]*next/);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(hydrateIdx, 'expected a hydrate step in the shard job').toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step in the shard job').toBeGreaterThanOrEqual(0);
    expect(
      hydrateIdx < runIdx,
      'the next/dist hydrate step must come BEFORE run-tests.js (jest loads modules at run time)',
    ).toBe(true);
  });

  it('still runs run-tests.js with the prebuilt per-fixture install (NEXT_TEST_PKG_PATHS intact)', () => {
    // The hydrate step is for the HARNESS code (jest module loads); each FIXTURE
    // app still installs `next` from the same tarball via NEXT_TEST_PKG_PATHS. Both
    // use the identical prebuilt artifact, so they stay version-consistent. Guard
    // that #157–#161's prebuilt path is untouched.
    const block = deployTestsJobBlock();
    expect(/NEXT_TEST_PKG_PATHS\s*:/.test(block), 'NEXT_TEST_PKG_PATHS must remain set').toBe(true);
    expect(
      /node\s+run-tests\.js\s+--type\s+e2e/.test(block),
      'the shard must still invoke run-tests.js --type e2e',
    ).toBe(true);
  });
});

// ── A3-3: hydrate the @next/* harness LOAD closure (#147) ──────────────────────
// Run 28316667494: with the v2 manifest + the prebuilt next/dist hydrate (#162),
// the harness SELECTED real deploy test files — but every selected test crashed at
// MODULE LOAD with:
//   Error: Cannot find module '.../packages/next/node_modules/@next/env/dist/index.js'.
//   Please verify that the package.json has a valid "main" entry
// → summary stayed `{passed:0,failed:0,excluded:N}`: real selection, but the test
// modules died before jest could tally them (a load-crash is neither pass nor fail).
//
// ROOT CAUSE: hydrating `packages/next/dist` (#162) was NOT the full closure. The
// harness imports `next/dist/trace` + `next/dist/server/next` at MODULE SCOPE
// (test/lib/e2e-utils, next-test-utils) and jest.config.js requires `next/jest`
// (→ `next/dist/build/jest/jest`). All of those transitively `require('@next/env')`
// at module scope. `@next/env` is a SEPARATE workspace package (source dir
// `packages/next-env`, published to npm as `@next/env@<ref>`) whose `dist/` is ALSO
// unbuilt in the prebuilt model — so the workspace symlink
// `packages/next/node_modules/@next/env` points at a dist-less dir.
//
// EVIDENCE (vercel/next.js@v16.0.3, verified against the published tarballs):
//   • The ONLY non-swc `@next/*` package the prebuilt `next/dist` `require`s at
//     module scope is `@next/env` (grep of the published next@16.0.3 dist). The
//     other runtime `@next/*` (font, polyfill-module, polyfill-nomodule,
//     react-refresh-utils) are referenced as build-time ASSET paths, never
//     module-scope-required on the harness load path, and `@next/telemetry`
//     appears only as a JSDoc `@type` annotation in create-next-install.js.
//   • `packages/next-env/package.json` → name `@next/env`, main `dist/index.js`,
//     files `["dist"]`; the checked-out source dir has `index.ts` but NO `dist/`.
//   • The published `@next/env@16.0.3` tarball is exactly `package/dist/index.js`
//     (+ `index.d.ts`) — copying its `dist/` into `packages/next-env/dist/`
//     populates the symlink target with no source/Rust build.
//
// FIX (honest + cheap, no source build, mirrors the #162 next/dist hydrate): a
// shard step `npm pack`s each needed `@next/*` package at the pinned version and
// copies its `dist/` into the matching workspace source dir, BEFORE run-tests.js.
// Kept as a LIST so the next missing package (if CI surfaces one) is one entry.
//
// These guards lock in the load-closure hydrate so a regression cannot silently
// return to the 0/0 load-crash state.

describe('compat-suite hydrates the @next/* harness load closure (test-e2e-deploy.yml, #147 A3-3)', () => {
  /** The shard step block that hydrates the @next/* workspace packages. */
  function nextEnvHydrateStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    // The load-closure hydrate step is the one whose `npm pack` targets the listed
    // @next/* packages (a `${pkg}` loop). The next/dist hydrate step also mentions
    // @next/env (in its prose), so disambiguate on the loop's `npm pack "${pkg}`.
    return blocks.find((b) => /npm\s+pack\s+["']?\$\{?pkg/.test(b)) ?? '';
  }

  it('hydrates @next/env (the confirmed module-load closure) from its published npm tarball', () => {
    const step = nextEnvHydrateStep();
    expect(
      step,
      'expected a shard step that hydrates @next/env from its published npm tarball',
    ).not.toBe('');
    // The closure must include @next/env — the ONLY non-swc @next/* the prebuilt
    // next/dist requires at module scope. It is declared in the hydrate list as a
    // `@next/env:<source-dir>` entry and packed at version by the loop's `npm pack`.
    expect(
      /@next\/env:/.test(step),
      'the hydrate list must include @next/env (the confirmed module-load closure)',
    ).toBe(true);
    // It must `npm pack` the listed packages at the pinned version — the cheap,
    // build-free acquisition (the same model as the prebuilt next tarball).
    expect(
      /npm\s+pack\s+["']?\$\{?pkg/.test(step),
      'the hydrate step must npm pack each listed @next/* package at the pinned version',
    ).toBe(true);
  });

  it('pins the @next/* hydrate to the same ref as next (NEXTJS_REF, no leading v)', () => {
    const step = nextEnvHydrateStep();
    // The hydrated @next/* dist must match the next version under test. The
    // workflow derives the npm version from NEXTJS_REF (the git tag) by stripping
    // the leading `v` (`${NEXTJS_REF#v}`) — the same derivation build-next uses for
    // `npm pack next@`. Guard that the hydrate is version-pinned, not floating.
    expect(
      /NEXTJS_REF#v/.test(step),
      'the @next/* hydrate must derive the npm version from NEXTJS_REF (strip leading v), matching next',
    ).toBe(true);
  });

  it('copies the published dist into the workspace next-env source dir', () => {
    const step = nextEnvHydrateStep();
    // `@next/env`'s source dir is packages/next-env (published as @next/env). The
    // unbuilt source dir has no dist/; the hydrate must copy the published dist/
    // into packages/next-env/dist so the workspace symlink target resolves.
    expect(
      /packages\/next-env\/dist/.test(step),
      'the hydrate must populate packages/next-env/dist (the @next/env source dir, the symlink target)',
    ).toBe(true);
  });

  it('uses a LIST so adding the next @next/* package is one entry (not hardcoded single)', () => {
    const step = nextEnvHydrateStep();
    // Keep the hydrate extensible: a bash loop over a package list, so surfacing
    // the next missing @next/* package is one line, not a copy-pasted step.
    expect(
      /\bfor\b/.test(step),
      'the @next/* hydrate must loop over a package list so adding the next one is one entry',
    ).toBe(true);
  });

  it('runs the @next/* hydrate BEFORE run-tests.js (jest loads modules at run time)', () => {
    const block = deployTestsJobBlock();
    const envHydrateIdx = block.search(/-\s+name:[^\n]*@next\/[^\n]*/i);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(
      envHydrateIdx,
      'expected an @next/* hydrate step in the shard job',
    ).toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step in the shard job').toBeGreaterThanOrEqual(0);
    expect(
      envHydrateIdx < runIdx,
      'the @next/* load-closure hydrate must come BEFORE run-tests.js',
    ).toBe(true);
  });

  it('runs the @next/* hydrate AFTER the next/dist hydrate (both before the run)', () => {
    // The #162 next/dist hydrate and this @next/* hydrate are complementary: the
    // workspace next/dist must exist for the @next/env symlink target to matter,
    // and both must precede run-tests.js. Assert the @next/* step is ordered after
    // the next/dist hydrate so the two hydrates compose predictably.
    const block = deployTestsJobBlock();
    const nextDistIdx = block.search(/-\s+name:[^\n]*[Hh]ydrate[^\n]*next\/dist/);
    const envHydrateIdx = block.search(/-\s+name:[^\n]*@next\/[^\n]*/i);
    expect(nextDistIdx, 'expected the next/dist hydrate step').toBeGreaterThanOrEqual(0);
    expect(envHydrateIdx, 'expected the @next/* hydrate step').toBeGreaterThanOrEqual(0);
    expect(
      nextDistIdx < envHydrateIdx,
      'the @next/* hydrate must come AFTER the next/dist hydrate (#162) and before the run',
    ).toBe(true);
  });
});

// ── A3-3: hydrate the prebuilt @next/swc NATIVE binary (#147) ──────────────────
// Run 28317087611: with the @next/* load closure hydrated (#163), the harness
// SELECTED + LOADED real deploy test files — but every selected test then crashed
// at SETUP with `⨯ Failed to load SWC binary for linux/x64`, caused by
// `Error: Failed to get registry from "pnpm"` → `Command failed: pnpm config get
// registry` → `Failed to switch pnpm to v9.6.0 ... pnpm CLI is missing`.
// run-tests.js then aborted each shard on its first test (`exiting with code 1`),
// so only ONE test ran per shard and all reported `failed with code: 1` → summary
// stayed 0/0 (the under-count this PR also fixes in e2e-summary.mjs).
//
// ROOT CAUSE (a HARNESS-ENV failure, NOT a missing module / NOT a real adapter
// failure): the workspace + fixture `next build` need `@next/swc` (the native Rust
// binary), but the prebuilt model sets NEXT_SKIP_NATIVE_POSTINSTALL=1 so no
// `@next/swc-<platform>` is installed. next then tries its WASM fallback, which
// resolves the registry via `pnpm config get registry`; that spawn dies because
// next.js pins pnpm@9.6.0 via corepack and the 9.6.0 binary is absent in the jest
// child env. SWC never loads → `next build` fails before any assertion runs.
//
// FIX (honest + cheap, mirrors the @next/env + next/dist hydrates, NO Rust/source
// build): `npm pack` the PUBLISHED `@next/swc-<platformArchABI>` at the pinned
// version, unpack its `next-swc.<triple>.node` into a stable dir, and point next at
// it via NEXT_TEST_NATIVE_DIR — the harness's first-class "use a local built
// @next/swc" hook. That env is inherited by both the workspace-next build AND the
// fixture `next build` the deploy script runs, so neither hits the WASM/registry
// path. These guards lock the fix in so a regression cannot silently return to the
// "Failed to load SWC binary" crash.

describe('compat-suite hydrates the prebuilt @next/swc native binary (test-e2e-deploy.yml, #147 A3-3)', () => {
  /** The shard step block that hydrates the @next/swc native binary. */
  function swcHydrateStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    // Disambiguate from the @next/env load-closure hydrate (which also npm packs
    // a `${pkg}` list): the swc step uniquely packs a `@next/swc-<triple>` package.
    return (
      blocks.find(
        (b) => /@next\/swc-[a-z0-9-]+/.test(b) && /npm\s+pack\s+["']?\$\{pkg\}@/.test(b),
      ) ?? ''
    );
  }

  it('hydrates @next/swc-<platform> from its published npm tarball (no Rust build)', () => {
    const step = swcHydrateStep();
    expect(
      step,
      'expected a shard step that hydrates the @next/swc native binary from its published tarball',
    ).not.toBe('');
    // The fix must npm pack the published @next/swc package — the build-free
    // acquisition, the same model as the prebuilt next tarball + @next/env hydrate.
    expect(
      /@next\/swc-linux-x64-gnu/.test(step),
      'the hydrate must include @next/swc-linux-x64-gnu (the ubuntu-latest runner triple)',
    ).toBe(true);
    expect(
      /npm\s+pack\s+["']?\$\{pkg\}@/.test(step),
      'the hydrate step must npm pack the listed @next/swc package at the pinned version',
    ).toBe(true);
    // It must extract the native .node binary (not a dist/ — swc ships a .node).
    expect(
      /next-swc\.[a-z0-9-]+\.node/.test(step),
      'the hydrate must extract the next-swc.<triple>.node native binary',
    ).toBe(true);
  });

  it('pins the @next/swc hydrate to the same ref as next (NEXTJS_REF, no leading v)', () => {
    const step = swcHydrateStep();
    expect(
      /NEXTJS_REF#v/.test(step),
      'the @next/swc hydrate must derive the npm version from NEXTJS_REF (strip leading v), matching next',
    ).toBe(true);
  });

  it('uses a LIST so adding another platform triple is one entry', () => {
    const step = swcHydrateStep();
    expect(
      /\bfor\b/.test(step),
      'the @next/swc hydrate must loop over a triple list so adding a platform is one entry',
    ).toBe(true);
  });

  it('points next at the hydrated binary via NEXT_TEST_NATIVE_DIR on the run step', () => {
    const block = deployTestsJobBlock();
    // The harness checks NEXT_TEST_NATIVE_DIR FIRST when loading SWC; the run-tests
    // step must export it so both workspace + fixture builds skip the WASM/registry
    // path. It must reference the step output (the hydrated native dir), not a
    // hardcoded path.
    expect(
      /NEXT_TEST_NATIVE_DIR\s*:/.test(block),
      'the run step must set NEXT_TEST_NATIVE_DIR so next loads the hydrated @next/swc native binary',
    ).toBe(true);
    expect(
      /NEXT_TEST_NATIVE_DIR\s*:[^\n]*steps\.swc\.outputs/.test(block),
      'NEXT_TEST_NATIVE_DIR must reference the swc-hydrate step output (the native dir), not a hardcoded path',
    ).toBe(true);
  });

  it('runs the @next/swc hydrate BEFORE run-tests.js (next loads SWC at build time)', () => {
    const block = deployTestsJobBlock();
    const swcIdx = block.search(/-\s+name:[^\n]*@next\/swc[^\n]*/i);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(swcIdx, 'expected an @next/swc hydrate step in the shard job').toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step in the shard job').toBeGreaterThanOrEqual(0);
    expect(swcIdx < runIdx, 'the @next/swc native hydrate must come BEFORE run-tests.js').toBe(
      true,
    );
  });
});

// ── A3-3: the workflow must NOT override next.js's jest.config.js (#147, GROUND
// TRUTH from run 28318485456) ────────────────────────────────────────────────────
//
// The PRIOR theory — that jest found 0 tests because next.js's `rootDir: 'test'`
// made the harness's repo-root-relative positional (`test/e2e/<…>/index.test.ts`)
// miss — was DISPROVEN. A shard step that overwrote jest.config.js with
// `rootDir: '.'` SHIPPED and STILL produced `No tests found … - 0 matches` on every
// shard. So rootDir was never the variable.
//
// GROUND TRUTH (vercel/next.js @ v16.0.3 source + jest@29.7.0 reproduction):
//   • run-tests.js:301-304 globs with `cwd: __dirname` (next.js repo root) → each
//     `test.file` is repo-root-relative `test/e2e/<…>`.
//   • run-tests.js:520 passes it as a jest POSITIONAL; :600 spawns jest with no
//     `cwd`, no `--config` → jest auto-discovers next.js/jest.config.js.
//   • jest@29.7.0 matches the positional as a case-insensitive RegExp against the
//     ABSOLUTE path (SearchSource.js + testPathPatternToRegExp). A faithful repro
//     (real next/jest, the real 404-page-router fixture, full packages/next/src haste
//     collisions, CI=1) shows BOTH the UPSTREAM `rootDir: 'test'` config AND the
//     override `rootDir: '.'` config FIND and run the test — `--listTests` lists it.
//     Neither rootDir is the lever; the override was unnecessary AND unproven.
//
// CORRECTION: stop overwriting upstream's jest.config.js. next.js itself runs exactly
// these deploy tests with the upstream config (its `test-deploy-*` scripts). The
// workflow keeps a fast "harness intact" check (the deploy test FILES + module-scope
// import dirs must be present; a missing checkout is the only remaining honest
// explanation for 0 tests) but MUST NOT rewrite next.js/jest.config.js.
// FORBIDDEN (would be a false-green): --passWithNoTests or anything that turns
// "no tests found" into a 0-exit. The success signal is real `[e2e-deploy]` markers
// + `next build` in the log, not a suppressed abort or a config rewrite.
describe('compat-suite does NOT override next.js jest.config.js (test-e2e-deploy.yml, #147 A3-3 ground truth)', () => {
  /** The shard step that verifies the harness is intact (without rewriting config). */
  function harnessStep(): string {
    const block = deployTestsJobBlock();
    const lines = block.split('\n');
    const blocks: string[] = [];
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
    };
    for (const line of lines) {
      if (/^\s*-\s+name:/.test(line)) flush();
      cur.push(line);
    }
    flush();
    return blocks.find((b) => /-\s+name:[^\n]*jest harness is intact/i.test(b)) ?? '';
  }

  it('has a shard step that verifies the next.js jest harness is intact', () => {
    const step = harnessStep();
    expect(step, 'expected a "jest harness is intact" verification step').not.toBe('');
  });

  it('does NOT overwrite next.js/jest.config.js (no `cat > jest.config.js` heredoc)', () => {
    // The smoking gun of the reverted override was a heredoc redirect into the
    // upstream config. It must be gone from the whole workflow.
    expect(
      /cat\s*>\s*jest\.config\.js/.test(workflowText()),
      'the workflow must not rewrite next.js/jest.config.js (upstream rootDir stands)',
    ).toBe(false);
  });

  it('does NOT force jest rootDir to the repo root anywhere in the workflow', () => {
    // No `rootDir: '.'` injection — the prior (disproven) override is fully reverted.
    expect(
      /rootDir\s*:\s*['"]\.['"]/.test(workflowText()),
      'the workflow must not pin jest rootDir to the repo root',
    ).toBe(false);
  });

  it('verifies the selected deploy test FILES are actually present (checkout sanity)', () => {
    const step = harnessStep();
    // A missing fixture checkout is the one remaining honest cause of "0 tests";
    // the step proves the e2e test tree + a representative test file exist.
    expect(/test\s+-d\s+test\/e2e/.test(step), 'must assert test/e2e exists').toBe(true);
    expect(
      /test\s+-f\s+test\/e2e\/[\w./-]+\.test\.ts/.test(step),
      'must assert a representative deploy test file exists',
    ).toBe(true);
  });

  it('NEVER uses --passWithNoTests (that would convert a phantom abort to a false-green)', () => {
    expect(
      /--passWithNoTests/.test(workflowText()),
      'the harness must not suppress "no tests found" into a pass',
    ).toBe(false);
  });

  it('runs the harness-intact check BEFORE run-tests.js', () => {
    const block = deployTestsJobBlock();
    const checkIdx = block.search(/-\s+name:[^\n]*jest harness is intact/i);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(checkIdx, 'expected a harness-intact step').toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step').toBeGreaterThanOrEqual(0);
    expect(checkIdx < runIdx, 'the harness-intact check must come BEFORE run-tests.js').toBe(true);
  });
});

// ── A3-3: jest DISCOVERY fix — SWC at config-load time + the upstream /.next/
// regex bug (#147, PROVEN by debug run 28551192374) ─────────────────────────────
//
// Three-layer root cause of "Pattern: … - 0 matches" on every shard, proven on
// the throwaway branch agent/compat-a33-jest-debug:
//   1. Run 28548871586: next/jest loads the @next/swc native binding AT JEST
//      CONFIG-RESOLUTION TIME. NEXT_TEST_NATIVE_DIR was set only on the run step
//      (#164), so any other jest invocation in the job died at config load
//      ("Failed to load SWC binary for linux/x64" — and the earlier unbounded
//      --showConfig hang was next trying to DOWNLOAD the binary into its own
//      fallback dir over the throttled network). FIX: plant the hydrated .node
//      into next's unconditional fallback probe path AND export
//      NEXT_TEST_NATIVE_DIR via $GITHUB_ENV so every later step inherits it.
//   2. Run 28549511217→28551192374: next/jest ITSELF injects
//      testPathIgnorePatterns ['/node_modules/', '/.next/'] with the dot
//      UNESCAPED (upstream vercel/next.js bug, packages/next/src/build/jest/
//      jest.ts:156 at v16.0.3). The entries are REGEXES, so '/.next/' matches
//      the '/knext/' segment of the runner workspace path
//      (/home/runner/work/knext/knext/...) and EVERY file is excluded purely
//      because the repo is named knext. FIX: patch the resolved next/jest dist
//      to the escaped '/\.next/' form (see
//      docs/compat/upstream-nextjs-jest-ignore-bug.md).
//   3. jest caches its crawl under /tmp/jest_* keyed on config contents — a
//      pre-patch crawl could silently resurrect the 0-matches state. FIX: clear
//      it right before run-tests.js.
// With all three in place the debug run showed: smoke `Tests: 1 passed` under
// the auto config, `--listTests` count=1707, and the real 404-page-router
// deploy test discovered + executing. These guards lock the production steps in.

describe('compat-suite jest discovery fix (test-e2e-deploy.yml, #147 A3-3)', () => {
  /** Splits a job block into `- name:`-delimited step blocks. */
  function stepBlocks(job: string): string[] {
    const lines = job.split('\n');
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
    return blocks;
  }

  /** The shard step that hydrates the @next/swc native binary (id: swc). */
  function swcStep(): string {
    return (
      stepBlocks(deployTestsJobBlock()).find(
        (b) => /@next\/swc-[a-z0-9-]+/.test(b) && /npm\s+pack\s+["']?\$\{pkg\}@/.test(b),
      ) ?? ''
    );
  }

  /** The shard step that patches next/jest's unescaped /.next/ ignore pattern. */
  function patchStep(): string {
    return (
      stepBlocks(deployTestsJobBlock()).find((b) =>
        /-\s+name:[^\n]*Patch next\/jest[^\n]*\.next/i.test(b),
      ) ?? ''
    );
  }

  it("plants the hydrated SWC binary into next's own fallback probe path", () => {
    const step = swcStep();
    expect(step, 'expected the @next/swc hydrate step').not.toBe('');
    // next/jest loads SWC at jest-config-load time in contexts that may lack
    // NEXT_TEST_NATIVE_DIR; next probes packages/next/next-swc-fallback/
    // unconditionally, so the binary must ALSO live there.
    expect(
      /next-swc-fallback\/@next\/swc-linux-x64-gnu/.test(step),
      "the swc step must target next's fallback probe path (packages/next/next-swc-fallback/@next/swc-linux-x64-gnu)",
    ).toBe(true);
    // The mkdir may target the literal path or a variable assigned to it above
    // (the assignment is covered by the fallback-path assertion).
    expect(
      /mkdir\s+-p\s+[^\n]*(next-swc-fallback|FALLBACK_DIR)/.test(step),
      'the swc step must mkdir -p the fallback dir before copying',
    ).toBe(true);
    expect(
      /cp\s+[^\n]*next-swc\.linux-x64-gnu\.node[^\n]*/.test(step),
      'the swc step must copy the hydrated .node binary into the fallback path',
    ).toBe(true);
    // Fail loud if the hydrated source binary is missing — a silent skip would
    // reintroduce the config-load crash.
    expect(
      /\bexit\s+1\b/.test(step),
      'the swc step must fail loud (exit 1) when the source .node is missing',
    ).toBe(true);
  });

  it('exports NEXT_TEST_NATIVE_DIR to $GITHUB_ENV so EVERY later step inherits it', () => {
    const step = swcStep();
    // Job-level env cannot reference step outputs, so the swc step must export
    // the native dir via $GITHUB_ENV — jest can be invoked (config load
    // included) by any later step, not just the run-tests step.
    expect(
      /echo\s+"NEXT_TEST_NATIVE_DIR=[^"]*"\s*>>\s*"?\$GITHUB_ENV"?/.test(step),
      'the swc step must `echo "NEXT_TEST_NATIVE_DIR=..." >> "$GITHUB_ENV"`',
    ).toBe(true);
    // The run step's explicit env reference stays intact (harmless + explicit).
    const block = deployTestsJobBlock();
    expect(
      /NEXT_TEST_NATIVE_DIR\s*:[^\n]*steps\.swc\.outputs/.test(block),
      'the run step must keep its explicit NEXT_TEST_NATIVE_DIR env reference',
    ).toBe(true);
  });

  it('has the next/jest /.next/ patch step, ordered before run-tests.js', () => {
    const step = patchStep();
    expect(
      step,
      'expected a "Patch next/jest unescaped /.next/ ignore pattern" step in the shard job',
    ).not.toBe('');
    const block = deployTestsJobBlock();
    const patchIdx = block.search(/-\s+name:[^\n]*Patch next\/jest/i);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(runIdx, 'expected the run-tests step').toBeGreaterThanOrEqual(0);
    expect(
      patchIdx < runIdx,
      'the next/jest patch must run BEFORE run-tests.js (jest resolves its config at run time)',
    ).toBe(true);
    // And after the next/dist hydrate — the patch targets the HYDRATED dist file.
    // Existence-assert BEFORE the index comparison: search() returns -1 for a
    // missing step, and -1 < patchIdx is vacuously true — a deleted hydrate step
    // would otherwise slip through this ordering guard unnoticed.
    const hydrateIdx = block.search(/-\s+name:[^\n]*[Hh]ydrate[^\n]*next\/dist/);
    expect(hydrateIdx, 'expected the next/dist hydrate step to exist').toBeGreaterThanOrEqual(0);
    expect(
      hydrateIdx < patchIdx,
      'the next/jest patch must run AFTER the next/dist hydrate (it patches the hydrated dist)',
    ).toBe(true);
  });

  it('the patch replaces the unescaped /.next/ literal with the ESCAPED form', () => {
    const step = patchStep();
    // The replacement must produce the escaped regex source '/\.next/' — i.e. a
    // backslash-escaped dot in the written file text. In the workflow YAML that
    // replacement string carries literal backslashes before `.next`.
    expect(
      /\\\\+\.next\//.test(step),
      'the patch must write the ESCAPED form (backslash before .next) into next/jest dist',
    ).toBe(true);
    // It must target the resolved next/jest dist chain, not a hardcoded absolute path.
    expect(
      /require\.resolve\(['"]next\/jest['"]/.test(step),
      'the patch must resolve next/jest from the next.js workspace (require.resolve)',
    ).toBe(true);
    expect(
      /dist\/build\/jest\/jest\.js/.test(step),
      'the patch must reach packages/next/dist/build/jest/jest.js (where the unescaped literal lives)',
    ).toBe(true);
  });

  it('the patch fails loud ONLY when the dist file is missing; NOOP is tolerated', () => {
    const step = patchStep();
    // A missing dist file means the next/dist hydrate regressed — fail the step.
    expect(
      /process\.exit\(1\)/.test(step),
      'the patch step must exit 1 when the next/jest dist file cannot be found',
    ).toBe(true);
    // But an already-escaped upstream (no unescaped literal) is FINE: print and
    // continue, never exit non-zero for a NOOP.
    expect(/NOOP/.test(step), 'the patch step must print NOOP when upstream is already fixed').toBe(
      true,
    );
    expect(
      /APPLIED/.test(step),
      'the patch step must print APPLIED (with the file) when it patches',
    ).toBe(true);
  });

  it('clears the jest haste cache (/tmp/jest_*) right before run-tests.js', () => {
    const block = deployTestsJobBlock();
    const clearIdx = block.search(/rm\s+-rf\s+\/tmp\/jest_\*/);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(
      clearIdx,
      'the shard must `rm -rf /tmp/jest_*` (stale pre-patch crawl cache would resurrect 0-matches)',
    ).toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step').toBeGreaterThanOrEqual(0);
    expect(clearIdx < runIdx, 'the jest cache clear must come BEFORE run-tests.js').toBe(true);
    // And after the patch step — clearing before the patch would be pointless.
    // Existence-assert first: search() returns -1 when the step is missing and
    // -1 < clearIdx would pass vacuously.
    const patchIdx = block.search(/-\s+name:[^\n]*Patch next\/jest/i);
    expect(patchIdx, 'expected the next/jest patch step to exist').toBeGreaterThanOrEqual(0);
    expect(patchIdx < clearIdx, 'the cache clear must come AFTER the next/jest patch').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #147 A3-3 triage of run 28552585087 (the first run where shards EXECUTED real
// tests). Findings this block locks in:
//
//  (1) HARNESS-VERSION FLOOR. Every one of the 8 failures across all 4 shards was
//      the SAME harness-environment error: `vercel link` → "No existing
//      credentials found. Please run `vercel login`". At v16.0.3,
//      test/lib/next-modes/next-deploy.ts is HARDCODED to the Vercel CLI — the
//      custom deploy-script contract (NEXT_TEST_DEPLOY_SCRIPT_PATH /
//      NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH / NEXT_TEST_CLEANUP_SCRIPT_PATH) the
//      knext workflow relies on DOES NOT EXIST at that ref. It landed upstream in
//      vercel/next.js#89206 (b19e6d44, 2026-01-29; cleanup hook in #90696) and
//      first shipped in the v16.2.0 stable tag. So with the ref at v16.0.3 the
//      knext adapter is NEVER invoked: the 5 "passes" were vacuous
//      skipDeployment placeholders and the 8 failures were Vercel-credential
//      noise. The pinned ref must stay ≥ v16.2.0 or the suite tests nothing.
//
//  (2) FULL-SHARD EXECUTION. run-tests.js@v16.0.3 ABORTS the whole shard on the
//      first post-retry failure (`cleanUpAndExit(1)`) unless
//      NEXT_TEST_CONTINUE_ON_ERROR === 'true' — that is why each shard reported
//      results for only ~2 of its ~179 selected tests. v16.2.0 continues past
//      failures by default (hadFailures flag, exit at the end), but the env pin
//      stays as an explicit statement of intent + a guard against a ref
//      downgrade: the exclusion ledger is only meaningful over ALL selected
//      tests.
//
//  (3) DISCOVERY TRIPWIRE. Three separate discovery-layer regressions each
//      produced a silent 0-test "green" in earlier rounds (v1 manifest throw,
//      unbuilt workspace-package closure, the unescaped /.next/ ignore regex).
//      A cheap post-patch `jest --listTests` gate now fails the shard LOUDLY
//      before run-tests.js whenever discovery collapses to 0 again.
// ─────────────────────────────────────────────────────────────────────────────
describe('compat-suite full-shard execution + harness-version floor (test-e2e-deploy.yml, #147 A3-3 triage)', () => {
  function deployTestsSteps(): string[] {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks;
  }

  it('pins the default next.js ref at or above the v16.2.0 deploy-script-contract floor', () => {
    const text = workflowText();
    // Both the dispatch-input default and the env fallback must carry the floor.
    // v16.0.x harnesses hardcode the Vercel CLI (run 28552585087: every failure
    // was "No existing credentials found") — the custom deploy-script hooks the
    // run step sets are simply unread there. Only the two FUNCTIONAL pins are
    // checked (dispatch `default:` + the NEXTJS_REF `||` fallback) — comments may
    // legitimately reference older refs as historical run records.
    const functionalPins = [
      text.match(/default:\s*'(v16\.\d+\.\d+)'/),
      text.match(
        /NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'(v16\.\d+\.\d+)'\s*\}\}/,
      ),
    ];
    const refs = functionalPins.filter((m) => m !== null).map((m) => (m as RegExpMatchArray)[1]);
    expect(refs.length, 'expected BOTH functional v16.x ref pins in the workflow').toBe(2);
    for (const ref of refs) {
      const [, minor] = ref.slice(1).split('.').map(Number);
      expect(
        minor >= 2,
        `pinned ref ${ref} is below the v16.2.0 floor — next-deploy.ts has no ` +
          'NEXT_TEST_DEPLOY_SCRIPT_PATH support before v16.2.0 (vercel/next.js#89206), ' +
          'so the knext adapter would never be invoked',
      ).toBe(true);
    }
    expect(
      /default:\s*'v16\.\d+\.\d+'/.test(text),
      'dispatch input must default a pinned ref',
    ).toBe(true);
    expect(
      /NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'v16\.\d+\.\d+'\s*\}\}/.test(
        text,
      ),
      'NEXTJS_REF env must fall back to the same pinned ref family',
    ).toBe(true);
  });

  it('sets NEXT_TEST_CONTINUE_ON_ERROR on the run step (full-shard execution, no first-failure abort)', () => {
    const runStep = deployTestsSteps().find((b) => /name:[^\n]*Run official deploy tests/.test(b));
    expect(runStep, 'expected the run-tests step').toBeTruthy();
    expect(
      /NEXT_TEST_CONTINUE_ON_ERROR:\s*['"]true['"]/.test(runStep ?? ''),
      'the run step must set NEXT_TEST_CONTINUE_ON_ERROR: "true" — without it a ' +
        'v16.0.x run-tests.js aborts the shard on the FIRST failure and the ledger ' +
        'only ever sees ~2 of ~179 selected tests (run 28552585087)',
    ).toBe(true);
  });

  it('shards the deploy tests 16 ways (full-shard runtime budget)', () => {
    const block = deployTestsJobBlock();
    // The matrix value is a YAML flow sequence that may wrap across lines —
    // capture from `shard: [` to the matching `]`.
    const shardMatch = block.match(/^\s*shard:\s*\n?\s*\[[\s\S]*?\]/m);
    expect(shardMatch, 'expected a matrix shard: [...] flow sequence').not.toBeNull();
    const entries = (shardMatch as RegExpMatchArray)[0].match(/'\d+\/\d+'/g) ?? [];
    // ~715 selected tests total. With full-shard execution each shard must finish
    // its slice inside the 60-min job timeout; at 4 shards a real-deploy slice
    // (~179 files × fixture `next build` + boot, concurrency 2) cannot. 16 mirrors
    // the reference harness's own shard count (~45 files/shard).
    expect(entries.length, 'expected a 16-way shard matrix').toBe(16);
    for (const [i, entry] of entries.entries()) {
      expect(entry).toBe(`'${i + 1}/16'`);
    }
  });

  it('has a loud-fail jest --listTests gate between the discovery patches and run-tests.js', () => {
    const steps = deployTestsSteps();
    // Select by the step NAME line — a pre-existing comment elsewhere in the job
    // also mentions `--listTests`, and comments attach to the PREVIOUS step block.
    const gate = steps.find((b) => /-\s+name:[^\n]*--listTests/.test(b)) ?? '';
    expect(gate, 'expected a jest --listTests discovery gate step in the shard job').not.toBe('');
    // Loud-fail: a 0-match discovery must abort the shard (exit 1), never proceed
    // into a vacuous 0-test run-tests.js invocation.
    expect(/\bexit\s+1\b/.test(gate), 'the listTests gate must exit 1 on 0 matches').toBe(true);
    expect(
      /::error::/.test(gate),
      'the listTests gate must emit a ::error:: annotation so the regression is visible',
    ).toBe(true);
    // It must probe a KNOWN-SELECTED deploy test file, not an arbitrary pattern.
    expect(
      /test\/e2e\/[\w./-]+\.test\.ts/.test(gate),
      'the gate must list a concrete known-present deploy test file',
    ).toBe(true);
    // Run 28556241980: the gate FIRED correctly, but its `2>/dev/null` swallowed
    // jest's stderr — the log said "matched 0" without the WHY, costing a blind CI
    // cycle. The gate must CAPTURE jest's stderr (+ exit code) and print both on
    // failure, so the very next failing run carries its own diagnosis.
    expect(
      /2>\s*\/dev\/null/.test(gate),
      'the gate must NOT discard jest stderr to /dev/null — capture and print it on failure',
    ).toBe(false);
    expect(
      /2>\s*"?\$\{?GATE_ERR\}?"?/.test(gate),
      'the gate must capture jest stderr to a file (GATE_ERR) for the failure dump',
    ).toBe(true);
    expect(
      /head\s+-n?\s*\d+\s+"?\$\{?GATE_ERR\}?"?/.test(gate),
      'on failure the gate must print the captured jest stderr into the log',
    ).toBe(true);
    expect(
      /JEST_EXIT/.test(gate),
      'the gate must record and report the jest exit code (distinguishes crash vs empty list)',
    ).toBe(true);
    // Ordering: after the /.next/ patch + haste-cache clear, before run-tests.js.
    const block = deployTestsJobBlock();
    const patchIdx = block.search(/-\s+name:[^\n]*Patch next\/jest/i);
    const clearIdx = block.search(/rm\s+-rf\s+\/tmp\/jest_\*/);
    const gateIdx = block.indexOf(gate.trimStart().split('\n')[0]);
    const runIdx = block.search(/-\s+name:[^\n]*Run official deploy tests/);
    expect(patchIdx, 'expected the next/jest patch step').toBeGreaterThanOrEqual(0);
    expect(clearIdx, 'expected the haste-cache clear step').toBeGreaterThanOrEqual(0);
    expect(gateIdx, 'expected to locate the gate step in the job block').toBeGreaterThanOrEqual(0);
    expect(runIdx, 'expected the run-tests step').toBeGreaterThanOrEqual(0);
    expect(patchIdx < gateIdx, 'the gate must run AFTER the next/jest patch').toBe(true);
    expect(clearIdx < gateIdx, 'the gate must run AFTER the haste-cache clear').toBe(true);
    expect(gateIdx < runIdx, 'the gate must run BEFORE run-tests.js').toBe(true);
  });

  it('does NOT patch or fork run-tests.js source (the ref bump is the fix, not a source patch)', () => {
    // The v16.0.3 Vercel-CLI hardcoding could also have been "fixed" by rewriting
    // next-deploy.ts / run-tests.js in place — a fork we would then own forever.
    // The honest fix is the ref bump; keep the workflow free of harness-source
    // rewrites (the ONE sanctioned dist patch is the /.next/ escape, guarded above).
    const text = workflowText();
    expect(
      /(?:cat|tee)\s*>+\s*(?:\.\/)?run-tests\.js/.test(text),
      'must not overwrite run-tests.js',
    ).toBe(false);
    expect(
      /(?:cat|tee)\s*>+\s*[^\n]*next-deploy\.ts/.test(text),
      'must not overwrite next-deploy.ts',
    ).toBe(false);
  });
});

// ── A3-3 FINAL MILE (#147): the Turbopack test lane + @next/playwright closure ──
// Run 28590478386 (main, 779 passed / 9 failed) triage:
//
//   • SIX of the nine (app-dir/app/index, css-chunking, esm-externals,
//     next-config/index, edge-can-use-wasm-files, segment-cache/prefetch-inlining)
//     share ONE cause: the harness's bundler-lane flag IS_TURBOPACK_TEST was
//     never set. Next 16 builds fixtures with Turbopack (default), but the jest
//     process's `isTurbopack` (test/lib/turbo.ts shouldUseTurbopack()) reads
//     process.env.IS_TURBOPACK_TEST — so webpack-only assertions/snapshots ran
//     against Turbopack output. It ALSO fixes the two "Call retries were
//     exceeded" build aborts: packages/next/src/lib/bundler.ts parseBundlerArgs
//     treats IS_TURBOPACK_TEST as an EXPLICIT bundler choice (TURBOPACK='1',
//     not 'auto'), which disables turbopack-warning.ts's hard process.exit(1)
//     on fixtures that carry a `webpack` config. PROVENANCE: upstream's own
//     adapter deploy lane sets it (vercel/next.js@v16.2.0
//     .github/workflows/test_e2e_deploy_release.yml, test-deploy-adapter job:
//     `IS_TURBOPACK_TEST=1 … node run-tests.js`), and run-tests.js spawns jest
//     with {...process.env}, so a job-env var reaches the tests AND (via
//     next-deploy.ts scriptEnv {...process.env}) the knext deploy script's
//     fixture `next build`.
//
//   • instant-navigation-testing-api fails with
//     `Cannot find module '@next/playwright'` — the same dist-less-workspace
//     class as @next/env (triage bucket B9): packages/next-playwright ships no
//     dist/ in the prebuilt model. The fix is ONE entry in the existing
//     @next/* load-closure hydrate list (published @next/playwright@<ref> has
//     main dist/index.js and requires only ./step at module scope).

describe('compat-suite Turbopack lane flag (test-e2e-deploy.yml, #147 A3-3 final mile)', () => {
  /** The shard step block that runs run-tests.js. */
  function runTestsStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks.find((b) => /-\s+name:[^\n]*Run official deploy tests/.test(b)) ?? '';
  }

  it('sets IS_TURBOPACK_TEST=1 on the run step (mirrors upstream test-deploy-adapter)', () => {
    const step = runTestsStep();
    expect(step, 'expected the Run official deploy tests step').not.toBe('');
    const m = step.match(/IS_TURBOPACK_TEST\s*:\s*['"]?([^'"\s#]+)/);
    expect(
      m,
      'the run step env must set IS_TURBOPACK_TEST — without it the jest harness applies webpack-lane assertions to Turbopack builds (6 of the final 9 failures) and next build hard-exits on webpack-config fixtures (TURBOPACK=auto)',
    ).not.toBeNull();
    expect((m as RegExpMatchArray)[1], 'IS_TURBOPACK_TEST must be truthy').toBe('1');
  });

  it('does not ALSO set the webpack lane (the two flags are mutually exclusive upstream)', () => {
    const step = runTestsStep();
    // bundler.ts exits(1) on "Multiple bundler flags set"; upstream lanes set
    // exactly one of IS_TURBOPACK_TEST / IS_WEBPACK_TEST.
    expect(
      /IS_WEBPACK_TEST\s*:/.test(step),
      'the run step must not set IS_WEBPACK_TEST alongside IS_TURBOPACK_TEST',
    ).toBe(false);
  });

  it('sets NEXT_ENABLE_ADAPTER=1 on the run step (adapter-lane expectations, not just adapter runtime)', () => {
    // Code-gate advisory on the first all-green run (28599745695): upstream's
    // test-deploy-adapter lane sets NEXT_ENABLE_ADAPTER=1 in the SAME afterBuild
    // env line the other three mirrors came from (test_e2e_deploy_release.yml
    // :209-218). In-scope e2e files read it as `isAdapterTest` and switch to
    // ADAPTER expectations (not-found-with-pages-i18n, sub-shell-generation,
    // partial-fallback-*). Without it, those tests pass under NON-adapter
    // expectations — green for possibly the wrong reason. Credential integrity
    // requires the adapter lane's expectations, not just its runtime.
    const step = runTestsStep();
    expect(step, 'expected the Run official deploy tests step').not.toBe('');
    const m = step.match(/NEXT_ENABLE_ADAPTER\s*:\s*['"]?([^'"\s#]+)/);
    expect(
      m,
      'the run step env must set NEXT_ENABLE_ADAPTER — upstream test-deploy-adapter sets it and isAdapterTest branches read it',
    ).not.toBeNull();
    expect((m as RegExpMatchArray)[1], 'NEXT_ENABLE_ADAPTER must be truthy').toBe('1');
  });
});

describe('compat-suite hydrates @next/playwright (test-e2e-deploy.yml, #147 A3-3 final mile)', () => {
  /** The shard step block that hydrates the @next/* workspace packages. */
  function closureHydrateStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks.find((b) => /npm\s+pack\s+["']?\$\{?pkg/.test(b)) ?? '';
  }

  it('the @next/* load-closure list includes @next/playwright -> packages/next-playwright', () => {
    const step = closureHydrateStep();
    expect(step, 'expected the @next/* load-closure hydrate step').not.toBe('');
    // instant-navigation-testing-api imports `@next/playwright` at module scope;
    // the workspace source dir is packages/next-playwright (main: dist/index.js,
    // published at the same version as next).
    expect(
      /@next\/playwright:packages\/next-playwright/.test(step),
      'the hydrate list must include "@next/playwright:packages/next-playwright" (B9: instant-navigation-testing-api fails module load without its dist)',
    ).toBe(true);
  });

  it('sanity-checks that @next/playwright resolves after the hydrate', () => {
    const step = closureHydrateStep();
    // The step's node sanity block must fail loud in CI if the hydrated package
    // still cannot be resolved (e.g. the workspace symlink is missing after the
    // filtered install) — never let it resurface as a per-test module-load crash.
    expect(
      /next-playwright\/dist\/index\.js/.test(step),
      'the hydrate sanity check must assert packages/next-playwright/dist/index.js exists',
    ).toBe(true);
  });
});

// ── A3-3 round 4 (#147): deploy-lane ENV FIDELITY with upstream test-deploy-adapter ──
// Run 28597872225 (786/2) triage prompted a full settings audit of upstream's own
// adapter deploy lane (vercel/next.js@v16.2.0 test_e2e_deploy_release.yml,
// test-deploy-adapter job) against ours:
//   • per-case timeout: IDENTICAL — 60s HARDCODED (test/lib/e2e-utils/index.ts
//     `individualTestTimeout = 60 * 1000`, applied via a Proxy-wrapped it/test;
//     NEXT_E2E_TEST_TIMEOUT does NOT raise it).
//   • concurrency: IDENTICAL — upstream passes `-c 2` explicitly; run-tests.js
//     DEFAULT_CONCURRENCY is 2. We make ours explicit so the fidelity is
//     declared, not incidental.
//   • runners (ubuntu-latest) + retries (3 attempts): IDENTICAL.
//   • NEXT_E2E_TEST_TIMEOUT=240000: upstream sets it; we did NOT. It raises the
//     SETUP timeout (jest.setTimeout — createNext/deploy/build hooks; Linux
//     default 120s) — a real fidelity gap for slow fixture deploys under shard
//     load, though NOT the per-case 60s class. Mirror it.
// Conclusion recorded here so nobody "fixes" the 60s-timeout flake class by
// diverging from the mirrored lane (e.g. -c 1 or a raised per-case timeout):
// upstream runs this class at the SAME settings and handles the residual wobble
// by ledger (its own deploy manifest's flakey/failed suites) — as do we.

describe('compat-suite deploy-lane env fidelity (test-e2e-deploy.yml, #147 A3-3 round 4)', () => {
  function runTestsStep(): string {
    const lines = deployTestsJobBlock().split('\n');
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
    return blocks.find((b) => /-\s+name:[^\n]*Run official deploy tests/.test(b)) ?? '';
  }

  it('mirrors upstream NEXT_E2E_TEST_TIMEOUT=240000 (setup-timeout fidelity)', () => {
    const step = runTestsStep();
    expect(step, 'expected the Run official deploy tests step').not.toBe('');
    const m = step.match(/NEXT_E2E_TEST_TIMEOUT\s*:\s*['"]?(\d+)/);
    expect(
      m,
      'the run step must set NEXT_E2E_TEST_TIMEOUT — upstream test-deploy-adapter sets 240000 (raises the jest SETUP timeout for fixture deploy/build hooks)',
    ).not.toBeNull();
    expect((m as RegExpMatchArray)[1]).toBe('240000');
  });

  it('runs run-tests.js at the EXPLICIT upstream concurrency (-c 2), never -c 1 divergence', () => {
    const step = runTestsStep();
    // Upstream deploy lanes pass `-c 2` explicitly. An explicit flag also guards
    // against a silent run-tests.js default change on a future ref bump.
    expect(
      /run-tests\.js[^\n]*(?:-c|--concurrency)[ =]2\b/.test(step),
      'run-tests.js must be invoked with explicit -c 2 (upstream test-deploy-adapter parity)',
    ).toBe(true);
    expect(
      /run-tests\.js[^\n]*(?:-c|--concurrency)[ =]1\b/.test(step),
      'must NOT lower to -c 1 — that diverges from the mirrored upstream lane',
    ).toBe(false);
  });
});

describe('compat-suite red-nightly alert issue (test-e2e-deploy.yml, #147 A3-3 graduation)', () => {
  // The graduated compat-matrix ✅ decays SILENTLY if the nightly goes red and
  // nobody notices — the credential's stability record depends on red nightlies
  // being loud. This guard asserts the workflow carries an alert job that, on a
  // failed SCHEDULED run, creates-or-updates a pinned "Compat nightly RED"
  // issue with the run link (idempotent — never one-issue-per-night spam).
  // Policy (docs/compat-matrix.md Maintenance): red nightly → alert issue →
  // flip the row back citing the red run (the matrix guard permits ❌ freely).
  const src = readFileSync(WORKFLOW_PATH, 'utf8');

  /** The nightly-red-alert job block (from its job key to the next 2-space-indented job key). */
  function alertJob(): string {
    const m = src.match(/^ {2}nightly-red-alert:\n[\s\S]*?(?=^ {2}[a-z][\w-]*:|\n*$(?![\s\S]))/m);
    return m ? m[0] : '';
  }

  it('has a nightly-red-alert job', () => {
    expect(alertJob(), 'expected a `nightly-red-alert:` job in test-e2e-deploy.yml').not.toBe('');
  });

  it('is failure-gated AND scoped to the scheduled nightly (never a red dispatch experiment)', () => {
    const job = alertJob();
    expect(
      /if:[\s\S]*?always\(\)/.test(job),
      'the alert must run via always() + needs-result checks (an `if: success()`-style default would skip it exactly when needed)',
    ).toBe(true);
    expect(
      /if:[\s\S]*?github\.event_name\s*==\s*'schedule'/.test(job),
      'the alert must be scoped to the scheduled nightly — a red workflow_dispatch experiment must not page',
    ).toBe(true);
    expect(
      /needs\.build-next\.result\s*==\s*'failure'/.test(job),
      'must alert when the build-next (Prepare) job fails',
    ).toBe(true);
    expect(
      /needs\.deploy-tests\.result\s*==\s*'failure'/.test(job),
      'must alert when any deploy-tests shard fails',
    ).toBe(true);
  });

  it('depends on both build-next and deploy-tests (a Prepare failure must also page)', () => {
    const job = alertJob();
    const needs = job.match(/needs:\s*\[([^\]]*)\]/);
    expect(needs, 'the alert job must declare needs: [build-next, deploy-tests]').not.toBeNull();
    const list = (needs as RegExpMatchArray)[1];
    expect(list).toContain('build-next');
    expect(list).toContain('deploy-tests');
  });

  it('has issues: write permission (least-privilege, but enough to create/update the alert)', () => {
    expect(/permissions:\s*\n\s+issues:\s*write/.test(alertJob())).toBe(true);
  });

  it('creates-or-updates the "Compat nightly RED" issue idempotently, with the run link', () => {
    const job = alertJob();
    expect(job).toContain('Compat nightly RED');
    // Idempotency: look up the existing open issue first, comment on it if
    // found, create (and pin) only when absent — never one new issue per night.
    expect(/gh issue list\b/.test(job), 'must look up the existing open alert issue').toBe(true);
    expect(/gh issue comment\b/.test(job), 'must UPDATE the existing issue (no spam)').toBe(true);
    expect(/gh issue create\b/.test(job), 'must create the issue when none is open').toBe(true);
    expect(
      /github\.run_id/.test(job),
      'the alert must carry the red run link (github.run_id)',
    ).toBe(true);
  });

  it('states the flip-back policy in the alert body (matrix row ❌ with the red run cited)', () => {
    expect(/flip/i.test(alertJob()), 'the alert body must state the row flip-back policy').toBe(
      true,
    );
  });
});

describe('compat-suite fail-on-red gate — revocation teeth (test-e2e-deploy.yml, #182 code gate)', () => {
  // Run 28552585087 carried 8 REAL test failures yet concluded SUCCESS: the run
  // step swallows run-tests.js's exit (`|| true`, markers are parsed from
  // runner.log) and nothing ever failed on `failed > 0` — so the nightly could
  // NEVER go red on TEST failures, the alert job (gated on job failure) could
  // never fire for them, and the "red nightly flips the row back" wording was
  // unenforced. This guard asserts the teeth: a step AFTER summarize/upload
  // reads the shard's own summary JSON and fails the JOB on failed>0 or
  // notRun>0. Summarize + upload stay `if: always()` so artifacts always emit
  // BEFORE the job flips red.
  const src = readFileSync(WORKFLOW_PATH, 'utf8');

  function stepIndex(nameRe: RegExp): number {
    return src.search(nameRe);
  }

  it('has a fail-on-red step in the deploy-tests job', () => {
    expect(
      /-\s+name:[^\n]*Fail shard on red results/.test(src),
      'expected a "Fail shard on red results" step — without it a red shard concludes SUCCESS (run 28552585087)',
    ).toBe(true);
  });

  it('orders the gate AFTER summarize and upload (artifacts must emit before the job flips red)', () => {
    const summarize = stepIndex(/-\s+name:[^\n]*Summarize shard result/);
    const upload = stepIndex(/-\s+name:[^\n]*Upload summary artifact/);
    const gate = stepIndex(/-\s+name:[^\n]*Fail shard on red results/);
    expect(summarize, 'Summarize step must exist').toBeGreaterThan(-1);
    expect(upload, 'Upload step must exist').toBeGreaterThan(-1);
    expect(gate, 'fail-on-red step must exist').toBeGreaterThan(-1);
    expect(gate, 'gate must come AFTER Summarize').toBeGreaterThan(summarize);
    expect(gate, 'gate must come AFTER Upload — the ledger artifact always lands').toBeGreaterThan(
      upload,
    );
  });

  it('summarize and upload remain if: always() (a red gate must never starve the ledger)', () => {
    for (const nameRe of [
      /-\s+name:[^\n]*Summarize shard result[\s\S]*?(?=\n\s*-\s+name:|\n*$)/,
      /-\s+name:[^\n]*Upload summary artifact[\s\S]*?(?=\n\s*-\s+name:|\n*$)/,
    ]) {
      const block = src.match(nameRe)?.[0] ?? '';
      expect(block, `step block for ${nameRe} must exist`).not.toBe('');
      expect(/if:\s*always\(\)/.test(block), `step must keep if: always(): ${nameRe}`).toBe(true);
    }
  });

  it('the gate fails on failed>0 OR notRun>0 from the summary JSON, and on a MISSING summary', () => {
    const gate =
      src.match(
        /-\s+name:[^\n]*Fail shard on red results[\s\S]*?(?=\n\s*-\s+name:|\n {2}[a-z])/,
      )?.[0] ?? '';
    expect(gate).not.toBe('');
    expect(/if:\s*always\(\)/.test(gate), 'gate must run even after an earlier step failed').toBe(
      true,
    );
    expect(/compat-suite-summary/.test(gate), 'gate must read the shard summary JSON').toBe(true);
    expect(/\bfailed\b/.test(gate), 'gate must check the failed count').toBe(true);
    expect(/\bnotRun\b/.test(gate), 'gate must check the notRun (phantom) count').toBe(true);
    expect(/exit 1|process\.exit\(1\)/.test(gate), 'gate must fail the job on red').toBe(true);
    expect(
      /missing|! -f|-f\s+"?\$\{?SUMMARY/.test(gate),
      'a missing summary is NOT green — the gate must fail on it',
    ).toBe(true);
  });

  it('the gate ALSO fails on a truncated summary (#171 follow-up: partial results are never green)', () => {
    // A shard killed mid-run (step timeout, runner eviction) emits a summary
    // with fewer results than the run-tests.js selection count. summarize()
    // marks that `truncated: true` (with `expectedTotal`); the gate must treat
    // it as red — otherwise a 20-of-45 partial green sails through.
    const gate =
      src.match(
        /-\s+name:[^\n]*Fail shard on red results[\s\S]*?(?=\n\s*-\s+name:|\n {2}[a-z])/,
      )?.[0] ?? '';
    expect(gate).not.toBe('');
    expect(
      /\btruncated\b/.test(gate),
      'gate must check the truncated flag — a shard killed mid-run is NOT green',
    ).toBe(true);
    expect(
      /expectedTotal/.test(gate),
      'gate must surface expectedTotal so the red message names how many results are missing',
    ).toBe(true);
  });

  it('the run step comment no longer claims "matrix row stays ❌ regardless" (stale pre-graduation contract)', () => {
    expect(
      src.includes('stays ❌ regardless'),
      'stale comment: post-graduation the JOB honestly fails on red results — update the || true rationale',
    ).toBe(false);
    // the || true itself STAYS (markers are parsed from runner.log); the new
    // contract must be stated next to it.
    expect(/\|\| true\b/.test(src)).toBe(true);
  });
});

// ── #147 item 4: the Bun runtime axis — a SEPARATE, cheaper lane ───────────────
// The Node nightly (16 shards) is the CREDENTIAL lane; doubling it every night
// for Bun would be pure cost with no extra credibility. The Bun axis is instead
// a separate lane inside the SAME workflow (no copy-paste second workflow):
//   • a `runtime` workflow_dispatch input (choice node|bun, default node), and
//   • a WEEKLY (Sunday) schedule that runs the bun lane,
// both funneled through ONE workflow-level `KNEXT_RUNTIME` env that the shard
// run step plumbs into scripts/e2e-deploy.sh (which already boots the standalone
// server.js with `bun` when KNEXT_RUNTIME=bun). HONESTY: the compat-matrix Node
// ✅ (run 28602886003) is a NODE claim — the Bun row stays ❌ until a green Bun
// run exists (tests/compat-matrix.test.ts holds that row to the same evidence
// contract), and a red BUN weekly must alert under its OWN lane-named issue,
// never implying the Node credential went red.

describe('compat-suite Bun runtime axis (test-e2e-deploy.yml, #147 item 4)', () => {
  const src = workflowText();

  /** The `workflow_dispatch:` inputs block (up to the sibling `schedule:` key). */
  function dispatchBlock(): string {
    const m = src.match(/workflow_dispatch:[\s\S]*?(?=\n\s{2}schedule:)/);
    return m ? m[0] : '';
  }

  /** The `runtime:` input sub-block inside workflow_dispatch.inputs. */
  function runtimeInputBlock(): string {
    const block = dispatchBlock();
    const m = block.match(/^(\s+)runtime:\s*\n([\s\S]*?)(?=^\1\w|\n*$(?![\s\S]))/m);
    return m ? m[0] : '';
  }

  /** All cron strings declared under `schedule:`. */
  function crons(): string[] {
    return [...src.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  it('declares a `runtime` workflow_dispatch input', () => {
    expect(
      runtimeInputBlock(),
      'workflow_dispatch must declare a `runtime` input (the on-demand bun lane)',
    ).not.toBe('');
  });

  it('the runtime input is a choice of node|bun and DEFAULTS to node (nightly stays the Node credential lane)', () => {
    const input = runtimeInputBlock();
    expect(
      /type:\s*choice/.test(input),
      'the runtime input must be type: choice (free-text would allow a typo lane)',
    ).toBe(true);
    expect(/default:\s*'?node'?/.test(input), 'the runtime input must default to node').toBe(true);
    expect(/^\s*-\s*'?node'?\s*$/m.test(input), 'options must include node').toBe(true);
    expect(/^\s*-\s*'?bun'?\s*$/m.test(input), 'options must include bun').toBe(true);
  });

  it('keeps the nightly cron AND adds exactly one weekly (Sunday) cron for the bun lane', () => {
    const all = crons();
    expect(all, 'the nightly Node cron must stay untouched (the credential lane)').toContain(
      '17 3 * * *',
    );
    const weekly = all.filter((c) => c !== '17 3 * * *');
    expect(weekly.length, 'exactly ONE extra schedule: the weekly bun lane').toBe(1);
    expect(
      /^\S+\s+\S+\s+\*\s+\*\s+(0|7|SUN|sun)$/.test(weekly[0]),
      `the extra cron must be WEEKLY on Sunday (day-of-week field), got "${weekly[0]}"`,
    ).toBe(true);
  });

  it('derives KNEXT_RUNTIME at the workflow level: dispatch input > weekly cron → bun > default node', () => {
    const envLine = src.split('\n').find((l) => /^\s*KNEXT_RUNTIME:\s*\$\{\{/.test(l));
    expect(envLine, 'a workflow-level KNEXT_RUNTIME env expression must exist').toBeTruthy();
    expect(
      /inputs\.runtime/.test(envLine ?? ''),
      'the lane must honor the workflow_dispatch runtime input',
    ).toBe(true);
    expect(
      /github\.event\.schedule/.test(envLine ?? ''),
      'the lane must branch on github.event.schedule (which cron fired)',
    ).toBe(true);
    // The cron string the expression compares against must be EXACTLY the weekly
    // cron declared under schedule: — a drifted string silently runs the weekly
    // lane on Node forever.
    const weekly = crons().filter((c) => c !== '17 3 * * *')[0] ?? '';
    expect(
      (envLine ?? '').includes(`'${weekly}'`),
      `the KNEXT_RUNTIME expression must compare github.event.schedule to the weekly cron ('${weekly}')`,
    ).toBe(true);
    expect(/'bun'/.test(envLine ?? ''), 'the weekly branch must yield bun').toBe(true);
    expect(/'node'/.test(envLine ?? ''), 'the fallback must be node').toBe(true);
  });

  it('plumbs the lane into the shard run step (KNEXT_RUNTIME is no longer hardcoded to node)', () => {
    const block = deployTestsJobBlock();
    const line = block.split('\n').find((l) => /^\s*KNEXT_RUNTIME:/.test(l));
    expect(line, 'the run step must still set KNEXT_RUNTIME explicitly').toBeTruthy();
    expect(
      /KNEXT_RUNTIME:\s*\$\{\{\s*env\.KNEXT_RUNTIME\s*\}\}/.test(line ?? ''),
      `the run step must plumb the workflow-level lane (env.KNEXT_RUNTIME), got: "${(line ?? '').trim()}"`,
    ).toBe(true);
    expect(
      /KNEXT_RUNTIME:\s*'?node'?\s*(#.*)?$/.test(line ?? ''),
      'KNEXT_RUNTIME must NOT be hardcoded to node — that silently disables the bun lane',
    ).toBe(false);
  });

  it('sets up Bun ONLY on the bun lane, via a SHA-pinned oven-sh/setup-bun', () => {
    const shard = deployTestsJobBlock();
    // Split the shard job into step blocks and find the setup-bun one.
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of shard.split('\n')) {
      if (/^\s*-\s+name:/.test(line)) {
        if (current.length) blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) blocks.push(current.join('\n'));
    const bunStep = blocks.find((b) => /oven-sh\/setup-bun/.test(b)) ?? '';
    expect(bunStep, 'the deploy-tests job must have an oven-sh/setup-bun step').not.toBe('');
    expect(
      /uses:\s*oven-sh\/setup-bun@[0-9a-f]{40}\b/.test(bunStep),
      'oven-sh/setup-bun must be pinned to a full commit SHA (supply-chain rule: pin third-party actions)',
    ).toBe(true);
    expect(
      /if:\s*env\.KNEXT_RUNTIME\s*==\s*'bun'/.test(bunStep),
      'the bun setup must be GATED on the bun lane (the Node nightly must not pay for it)',
    ).toBe(true);
  });

  it('passes --runtime to the summary so every artifact is lane-attributable', () => {
    const summarizeStep =
      deployTestsJobBlock()
        .split('\n- name:')
        .find((b) => /e2e-summary\.mjs/.test(b)) ?? '';
    expect(summarizeStep, 'expected the Summarize shard result step').not.toBe('');
    expect(
      /--runtime\s+"?\$\{?KNEXT_RUNTIME\}?"?/.test(summarizeStep),
      'the summarize invocation must pass --runtime "${KNEXT_RUNTIME}" (artifacts must say which lane produced them)',
    ).toBe(true);
  });

  // ── #188: the bun-version dispatch knob — prove the remainder is Bun-version-gated ──
  // Campaign state (#188/PR #189): the bun lane is at 784/788 on Bun 1.3.14 and the
  // 3 remaining red files (the edge-sandbox fetch gap + the not-found invariant pair)
  // are documented Bun ≤1.3.x runtime gaps, believed fixed in Bun 1.4.0-canary (the
  // same release that fixes the keep-alive class the guard works around). A
  // `bun-version` dispatch input lets us RUN the lane on canary and prove (or
  // disprove) that attribution with real artifacts — including exercising the
  // keep-alive guard's ≥1.4 self-disable path in real CI. HONESTY: canary is
  // dispatch-only experimentation; the WEEKLY schedule stays on `latest` (the
  // steady-state lane), enforced by the `|| 'latest'` fallback (github.event.inputs
  // is empty on schedule events).

  /** The `bun-version:` input sub-block inside workflow_dispatch.inputs. */
  function bunVersionInputBlock(): string {
    const block = dispatchBlock();
    const m = block.match(/^(\s+)bun-version:\s*\n([\s\S]*?)(?=^\1[\w-]|\n*$(?![\s\S]))/m);
    return m ? m[0] : '';
  }

  /** The oven-sh/setup-bun step block inside the deploy-tests job. */
  function setupBunStep(): string {
    const shard = deployTestsJobBlock();
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of shard.split('\n')) {
      if (/^\s*-\s+name:/.test(line)) {
        if (current.length) blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) blocks.push(current.join('\n'));
    return blocks.find((b) => /oven-sh\/setup-bun/.test(b)) ?? '';
  }

  it('declares a `bun-version` workflow_dispatch input (string, default latest)', () => {
    const input = bunVersionInputBlock();
    expect(
      input,
      'workflow_dispatch must declare a `bun-version` input (the canary-proof knob, #188)',
    ).not.toBe('');
    expect(
      /default:\s*'?latest'?/.test(input),
      'the bun-version input must default to latest (a plain dispatch stays the steady-state lane)',
    ).toBe(true);
    // Free string, NOT a choice: the whole point is dispatching arbitrary specs
    // (canary, a pinned 1.4.0-canary.N, a future stable) without a workflow edit.
    expect(
      /type:\s*choice/.test(input),
      'the bun-version input must be a free string (canary / pinned specs), not a choice',
    ).toBe(false);
  });

  it('plumbs the bun-version input into setup-bun with a PINNED stable fallback (#187 follow-up: the weekly lane must not float)', () => {
    // #187 review follow-up: the schedule fallback used to be `latest`, which
    // FLOATS — a red weekly after a new Bun release could be a brand-new-Bun
    // regression misattributed to knext (the whole lane exists to attribute
    // red files to Bun versions). The fallback (what the WEEKLY schedule runs,
    // since github.event.inputs is empty on schedule events) must be a pinned
    // stable semver; the dispatch input stays a free string so canary/pinned
    // experiments need no workflow edit.
    const bunStep = setupBunStep();
    expect(bunStep, 'expected the oven-sh/setup-bun step').not.toBe('');
    const line = bunStep.split('\n').find((l) => /^\s*bun-version:/.test(l)) ?? '';
    expect(line, 'setup-bun must set with.bun-version').not.toBe('');
    const m = line.match(
      /bun-version:\s*\$\{\{\s*github\.event\.inputs\.bun-version\s*\|\|\s*'([^']+)'\s*\}\}/,
    );
    expect(
      m,
      `setup-bun must plumb the dispatch input with a quoted fallback, got: "${line.trim()}"`,
    ).not.toBeNull();
    const fallback = (m as RegExpMatchArray)[1];
    expect(
      /^\d+\.\d+\.\d+$/.test(fallback),
      `the weekly-lane fallback must be a PINNED stable semver (never 'latest'/'canary' — those float), got: "${fallback}"`,
    ).toBe(true);
  });

  it('documents the bun pin provenance + deliberate-bump policy next to the setup-bun step', () => {
    const bunStep = setupBunStep();
    expect(bunStep, 'expected the oven-sh/setup-bun step').not.toBe('');
    // The pin must carry its provenance (why this version) and a tracked-bump
    // note (bumping is deliberate, with a re-baseline) — an unexplained pin
    // rots into "why is this old?" and gets bumped blindly.
    expect(
      /pin/i.test(bunStep),
      'the setup-bun step comment must explain the pin (provenance)',
    ).toBe(true);
    expect(
      /bump/i.test(bunStep),
      'the setup-bun step comment must state the deliberate-bump policy',
    ).toBe(true);
  });

  it('the lane decision (KNEXT_RUNTIME) is independent of bun-version (version never flips the lane)', () => {
    const envLine = src.split('\n').find((l) => /^\s*KNEXT_RUNTIME:\s*\$\{\{/.test(l)) ?? '';
    expect(envLine, 'the workflow-level KNEXT_RUNTIME expression must exist').not.toBe('');
    expect(
      /bun-version/.test(envLine),
      'KNEXT_RUNTIME must not reference bun-version — the version knob must never select the lane',
    ).toBe(false);
  });

  it('records the ACTUAL bun version in the shard summary (--runtime-version, bun lane only)', () => {
    const summarizeStep =
      deployTestsJobBlock()
        .split('\n- name:')
        .find((b) => /e2e-summary\.mjs/.test(b)) ?? '';
    expect(summarizeStep, 'expected the Summarize shard result step').not.toBe('');
    // The version must be OBSERVED (`bun --version` from the toolchain setup-bun
    // actually installed), never the requested input spec — `canary` is not an
    // attributable version. Gated on the bun lane so node artifacts are unchanged.
    expect(
      /bun --version/.test(summarizeStep),
      'the summarize step must capture the observed `bun --version` (canary evidence must be attributable)',
    ).toBe(true);
    expect(
      /if\s+\[\s+"\$\{?KNEXT_RUNTIME\}?"\s+=\s+"bun"\s+\]/.test(summarizeStep),
      'the bun --version capture must be gated on the bun lane (node runs unaffected)',
    ).toBe(true);
    expect(
      /--runtime-version\s+"?\$\{?RUNTIME_VERSION\}?"?/.test(summarizeStep),
      'the summarize invocation must pass --runtime-version "${RUNTIME_VERSION}"',
    ).toBe(true);
  });

  it('the red alert NAMES the lane: a red bun weekly gets its own title and never implies the Node credential is red', () => {
    const alertMatch = src.match(
      /^ {2}nightly-red-alert:\n[\s\S]*?(?=^ {2}[a-z][\w-]*:|\n*$(?![\s\S]))/m,
    );
    const job = alertMatch ? alertMatch[0] : '';
    expect(job, 'expected the nightly-red-alert job').not.toBe('');
    // Lane-aware: the alert must branch on the runtime lane.
    expect(
      /KNEXT_RUNTIME/.test(job),
      'the alert must read KNEXT_RUNTIME to distinguish lanes',
    ).toBe(true);
    // The Node credential title is unchanged (idempotency key for the Node lane).
    expect(job).toContain('Compat nightly RED');
    // The bun lane gets a DISTINCT title that names bun — a red bun weekly must
    // never comment on (or be mistaken for) the Node credential issue.
    const titles = [...job.matchAll(/title=(['"])(.*?)\1/g)].map((m) => m[2]);
    const bunTitle = titles.find((t) => /bun/i.test(t));
    expect(
      bunTitle,
      'the alert must assign a bun-lane title (e.g. "Compat weekly RED (bun lane)")',
    ).toBeTruthy();
    expect(bunTitle).not.toBe('Compat nightly RED');
    // And the body must say the Node credential is NOT implicated.
    expect(
      /does NOT imply[^\n]*Node/i.test(job) || /Node credential[^\n]*not/i.test(job),
      'the bun-lane alert body must state it does NOT imply the Node credential lane is red',
    ).toBe(true);
  });
});

// ── #187 review follow-up: the alert-dedup lookup must page past 30 issues ────
// The idempotency of the red-alert job hinges on `gh issue list` FINDING the
// already-open alert issue. gh's default --limit is 30: with >30 open issues in
// the repo, the pinned alert can fall off the first page, the lookup returns
// empty, and every red night files a NEW issue — the exact spam the dedup
// exists to prevent. Both lane titles ('Compat nightly RED' and 'Compat weekly
// RED (bun lane)') go through the SAME parameterized lookup, so hardening that
// one invocation covers both lanes (#187 item 6).

describe('compat-suite red-alert dedup lookup limits (test-e2e-deploy.yml, #187 follow-up)', () => {
  const src = workflowText();

  function alertJob(): string {
    const m = src.match(/^ {2}nightly-red-alert:\n[\s\S]*?(?=^ {2}[a-z][\w-]*:|\n*$(?![\s\S]))/m);
    return m ? m[0] : '';
  }

  /**
   * Logical `gh issue list` invocations in the alert job, with backslash line
   * continuations joined (the lookup is wrapped across lines in the YAML).
   */
  function ghIssueListInvocations(): string[] {
    const joined = alertJob().replace(/\\\n\s*/g, ' ');
    return joined.split('\n').filter((l) => /gh issue list\b/.test(l));
  }

  it('every gh issue list lookup pins an explicit --state open (never an implicit default)', () => {
    const lookups = ghIssueListInvocations();
    expect(lookups.length, 'expected at least one gh issue list lookup').toBeGreaterThan(0);
    for (const cmd of lookups) {
      expect(
        /--state\s+open\b/.test(cmd),
        `the alert lookup must pass --state open explicitly, got: "${cmd.trim()}"`,
      ).toBe(true);
    }
  });

  it('every gh issue list lookup raises --limit to at least 100 (default 30 misses the alert and spams)', () => {
    for (const cmd of ghIssueListInvocations()) {
      const m = cmd.match(/--limit\s+(\d+)\b/);
      expect(
        m,
        `the alert lookup must pass an explicit --limit (gh defaults to 30), got: "${cmd.trim()}"`,
      ).not.toBeNull();
      expect(
        Number((m as RegExpMatchArray)[1]),
        'the lookup limit must cover a busy repo (>=100 open issues before dedup can miss)',
      ).toBeGreaterThanOrEqual(100);
    }
  });

  it('the lookup is parameterized on the lane title, so BOTH lane titles get the hardened lookup (#187 item 6)', () => {
    const lookups = ghIssueListInvocations();
    // The job selects on the shell `title` variable (set per lane above the
    // lookup) — one hardened invocation serving both 'Compat nightly RED' and
    // 'Compat weekly RED (bun lane)'. A second, unparameterized lookup would
    // dodge the limit fix for one lane.
    expect(
      lookups.some((cmd) => /\$\{?title\}?/.test(cmd) || /\$\{title\}/.test(alertJob())),
      'the gh issue list lookup must select on the per-lane ${title} variable',
    ).toBe(true);
  });
});
