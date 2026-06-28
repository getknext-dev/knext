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

  it('does NOT run a blocking explicit browser install in the Prepare job', () => {
    const block = buildNextJobBlock();
    // The redundant `corepack pnpm playwright install chromium ...` that ran in the
    // blocking Prepare install is exactly what hung; it must be gone from build-next.
    expect(
      /playwright\s+install\b/.test(block),
      'build-next (Prepare) must NOT run an explicit `playwright install` — that browser download is the hang',
    ).toBe(false);
  });

  it('if chromium is installed at all, it lives in the shard job, retry+timeout-wrapped and cached', () => {
    const buildBlock = buildNextJobBlock();
    const shardBlock = deployTestsJobBlock();
    const shardInstallsBrowser = /playwright\s+install\b/.test(shardBlock);
    // Prepare must never install the browser (asserted above); the only acceptable
    // place for a browser install is the shard job that actually drives it.
    expect(
      /playwright\s+install\b/.test(buildBlock),
      'the chromium install must not be in the Prepare job',
    ).toBe(false);

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

// ── Workspace-handoff: don't ship node_modules in the artifact (#147 — OOM) ────
// Run 28314500989: the Prepare install completed in 26 SECONDS (the Playwright
// browser-download hang from #160 is gone), but the `Upload workspace` step
// (actions/upload-artifact of knext + next.js + next-prebuilt) FAILED with
// `FATAL ERROR: ... JavaScript heap out of memory`. Cause: the uploaded next.js
// tree carries its full node_modules (3345 packages, hundreds of thousands of
// files); actions/upload-artifact globs + hashes every file and OOMs.
//
// FIX (Option A — don't ship node_modules): EXCLUDE `**/node_modules` from the
// uploaded artifact (upload only the source trees + the prebuilt next.tgz + the
// @knext/core adapter tarball). Each deploy-tests SHARD then RESTORES the same
// pnpm-store actions/cache the Prepare job warmed (same key) and RE-RUNS the
// SAME fast install in next.js — `corepack pnpm install --frozen-lockfile
// --prefer-offline --filter "{.}"` with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — a
// cache hit, so it finishes in seconds. The artifact stays source-only; each
// shard rebuilds node_modules locally + fast.

describe('compat-suite workspace handoff excludes node_modules (test-e2e-deploy.yml, #147)', () => {
  /** The build-next `Upload workspace` step block (the upload-artifact step). */
  function uploadWorkspaceStep(): string {
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
    return (
      blocks.find(
        (b) => /uses:\s*actions\/upload-artifact@/.test(b) && /compat-workspace/.test(b),
      ) ?? ''
    );
  }

  it('the upload-workspace artifact EXCLUDES node_modules (the OOM cause)', () => {
    const step = uploadWorkspaceStep();
    expect(step, 'expected a build-next upload-artifact step for compat-workspace').not.toBe('');
    // actions/upload-artifact excludes via a `!`-prefixed path line in the `path:`
    // glob block. Hundreds of thousands of node_modules files are what OOM the
    // upload — the artifact must explicitly exclude them.
    expect(
      /^\s*!.*node_modules/m.test(step),
      'the upload-workspace step must exclude node_modules (e.g. `!**/node_modules`) — shipping it OOMs actions/upload-artifact',
    ).toBe(true);
  });

  it('still uploads the source trees + the prebuilt next tarball + the adapter pack', () => {
    const step = uploadWorkspaceStep();
    // The handoff must still carry the knext + next.js source trees and the
    // next-prebuilt/next.tgz so the shard can resolve NEXT_TEST_PKG_PATHS and the
    // @knext/core adapter pack — only node_modules is dropped.
    expect(/(^|\s)knext(\s|$)/m.test(step), 'must still upload the knext tree').toBe(true);
    expect(/(^|\s)next\.js(\s|$)/m.test(step), 'must still upload the next.js source tree').toBe(
      true,
    );
    expect(
      /next-prebuilt/.test(step),
      'must still upload next-prebuilt (the prebuilt next.tgz the harness installs)',
    ).toBe(true);
  });

  it('belt-and-suspenders: the upload step raises the Node heap (NODE_OPTIONS)', () => {
    const step = uploadWorkspaceStep();
    // Even with node_modules excluded, the upload still hashes a large source
    // tree; bumping the old-space size guards against a borderline OOM.
    expect(
      /NODE_OPTIONS[\s\S]*max-old-space-size/.test(step),
      'the upload step should set NODE_OPTIONS=--max-old-space-size to harden against OOM',
    ).toBe(true);
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
