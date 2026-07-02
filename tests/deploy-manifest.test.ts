import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Self-contained glob matcher (no `minimatch` runtime dep — it is not hoisted to
 * the repo's top-level node_modules). Supports the subset the manifest uses:
 * `**` (any path incl. `/`), `*` (any non-`/`), and brace alternation `{a,b}`
 * (incl. the empty alternative in `{,x}`). This mirrors how next.js's
 * get-test-filter.js minimatches the same globs against discovered test files —
 * if these assertions pass, the real harness keeps/drops the same files.
 */
function globMatch(file: string, pattern: string): boolean {
  // Expand brace alternations into a set of concrete patterns first.
  const expanded = expandBraces(pattern);
  return expanded.some((p) => new RegExp(`^${globToRegex(p)}$`).test(file));
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  // Find the matching close brace for this (non-nested) group.
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const pre = pattern.slice(0, open);
  const post = pattern.slice(close + 1);
  const alts = pattern.slice(open + 1, close).split(',');
  return alts.flatMap((alt) => expandBraces(`${pre}${alt}${post}`));
}

function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` collapses to zero-or-more path segments (minimatch: `a/**/b`
        // matches `a/b`); a trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/**
 * Contract test for test/deploy-tests-manifest.knext.json (#89, ADR-0007 A3-2/A3-3, #147).
 *
 * TWO jobs, both load-bearing:
 *
 *  1. HARNESS COMPATIBILITY (the A3-3 fix). vercel/next.js's run-tests.js consumes
 *     this file via NEXT_EXTERNAL_TESTS_FILTERS → test/get-test-filter.js, which
 *     ONLY understands `version === 2` (rule-based include/exclude with string
 *     globs) or the legacy no-version full-list format. The previous `version: 1`
 *     + object-shaped exclude list THREW `Unknown manifest version: 1` at module
 *     load, so run-tests.js died before discovering a single test — every shard
 *     reported passed:0 failed:0 (run 28314927507). These tests lock the manifest
 *     to the shape the harness actually accepts AND to a non-empty include set
 *     (an empty include selects ZERO tests under v2 semantics).
 *
 *  2. HONEST LEDGER (CLAUDE.md §10, .claude/rules/architecture.md). The honesty
 *     rule forbids a silent skip: every knext-SPECIFIC exclusion must carry a
 *     non-empty rationale tied to a known-unsupported category. Because the
 *     harness's `rules.exclude` is a flat string-glob array (it cannot hold our
 *     rationale objects), the ledger lives in a sidecar `$knextExclusions` array
 *     (ignored by the harness) and every ledger glob must also appear in
 *     `rules.exclude` so the ledger and the live filter never drift.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');

interface KnextExclusion {
  test: string;
  rationale: string;
  category: string;
}
interface Manifest {
  version: number;
  // v2 `suites` is an object map of file → {failed, flakey}; empty by default.
  suites: Record<string, { failed?: string[]; flakey?: string[] }>;
  rules: {
    include: string[];
    exclude: string[];
  };
  $knextExclusions: KnextExclusion[];
}

/**
 * Categories a knext exclusion may legitimately reference. These mirror the
 * compat-matrix rows that are architecturally or upstream-gated (CLAUDE.md §8
 * "buckets"): things knext does NOT support today, by design or because the
 * feature is not adapter-standardizable yet.
 */
const KNOWN_UNSUPPORTED_CATEGORIES = new Set([
  'edge-runtime',
  'edge-middleware',
  'ppr',
  'cache-components',
  'image-optimization',
]);

const manifest: Manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : ({} as Manifest);

describe('test/deploy-tests-manifest.knext.json — harness-compatible v2 selection (#147)', () => {
  it('the manifest file exists', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it('declares version 2 (the ONLY rule-based version get-test-filter.js accepts)', () => {
    // version:1 (or any number that is not 2, and is not absent) makes
    // get-test-filter.js throw `Unknown manifest version`, killing run-tests.js
    // at module load — the exact bug that made every shard run 0 tests.
    expect(manifest.version).toBe(2);
  });

  it('shape matches the v2 filter: suites object + rules.{include,exclude} string arrays', () => {
    // v2 reads `test.file in manifest.suites` (suites must be an OBJECT) and
    // minimatches against rules.include / rules.exclude (arrays of STRING globs).
    expect(
      manifest.suites !== null &&
        typeof manifest.suites === 'object' &&
        !Array.isArray(manifest.suites),
      'suites must be an object map (v2), not an array',
    ).toBe(true);
    expect(Array.isArray(manifest.rules.include)).toBe(true);
    expect(Array.isArray(manifest.rules.exclude)).toBe(true);
    for (const pat of [...manifest.rules.include, ...manifest.rules.exclude]) {
      expect(typeof pat, `rules glob must be a string, got ${JSON.stringify(pat)}`).toBe('string');
    }
  });

  it('include is NON-EMPTY (an empty include selects ZERO tests under v2)', () => {
    // Under v2, a test is dropped unless it matches an include pattern. The old
    // `include: []` is therefore an automatic 0-test run — the include MUST name
    // the deploy-eligible base set (the e2e/production globs).
    expect(manifest.rules.include.length).toBeGreaterThan(0);
    // The deploy-eligible e2e base set must be present.
    expect(
      manifest.rules.include.some((p) => p.startsWith('test/e2e/')),
      'include must select the deploy-eligible test/e2e/** base set',
    ).toBe(true);
  });

  it('a representative deploy-eligible test is SELECTED (passed+failed > 0 is possible)', () => {
    // Prove the filter actually keeps a normal e2e deploy test — if this fails,
    // run-tests.js would again select 0 tests. navigation is a plain HTTP/render
    // app-dir test with no architectural exclusion.
    const file = 'test/e2e/app-dir/navigation/navigation.test.ts';
    const included = manifest.rules.include.some((p) => globMatch(file, p));
    const excluded = manifest.rules.exclude.some((p) => globMatch(file, p));
    expect(included && !excluded, `${file} must be selected by the manifest`).toBe(true);
  });

  it('knext architectural exclusions ARE filtered out by the live rules', () => {
    // The 4 architectural categories must be dropped by rules.exclude.
    const archSamples = [
      'test/e2e/middleware-general/index.test.ts',
      'test/e2e/cache-components/cache-components.test.ts',
      'test/e2e/app-dir/ppr-full/ppr-full.test.ts',
      'test/e2e/app-dir/edge-runtime-module-errors/index.test.ts',
    ];
    for (const file of archSamples) {
      expect(
        manifest.rules.exclude.some((p) => globMatch(file, p)),
        `${file} must be excluded by rules.exclude`,
      ).toBe(true);
    }
  });
});

describe('test/deploy-tests-manifest.knext.json — upstream-known-failing suites mirror (#147 A3-3)', () => {
  // The #162 review flagged that knext ran per-CASE test cases upstream ITSELF
  // skips in deploy mode: next.js's own test/deploy-tests-manifest.json carries a
  // `suites` map (file → {failed, flakey} case-name lists) that get-test-filter.js
  // applies via jest -t skips. Our manifest replaces upstream's (the harness loads
  // exactly ONE file), so if we don't mirror `suites` we run upstream-known-failing
  // cases and book their failures as knext failures — noise, not signal. Mirroring
  // upstream's OWN skips verbatim is honest: next.js itself does not run them
  // against ANY deploy target at the pinned ref.
  it('suites is a non-empty mirror (upstream skips per-case deploy-known-failures)', () => {
    expect(Object.keys(manifest.suites).length).toBeGreaterThan(0);
  });

  it('every suites entry is well-formed: {failed?/flakey?} arrays of case-name strings', () => {
    for (const [file, entry] of Object.entries(manifest.suites)) {
      expect(
        file.startsWith('test/') && /\.test\.(t|j)sx?$/.test(file),
        `suites key must be a test file path, got "${file}"`,
      ).toBe(true);
      const lists = [entry.failed, entry.flakey].filter((l) => l !== undefined);
      expect(lists.length, `suites["${file}"] must carry failed and/or flakey`).toBeGreaterThan(0);
      for (const list of lists) {
        expect(Array.isArray(list)).toBe(true);
        for (const name of list as string[]) {
          expect(typeof name === 'string' && name.trim().length > 0).toBe(true);
        }
      }
    }
  });

  it('mirrors representative upstream v16.2.0 suites entries verbatim', () => {
    // Two stable representatives from vercel/next.js@v16.2.0
    // test/deploy-tests-manifest.json — if upstream's ref bumps, re-mirror and
    // update these (the manifest $comment records the provenance ref).
    expect(
      manifest.suites['test/e2e/app-dir/app-client-cache/client-cache.defaults.test.ts'],
    ).toBeTruthy();
    expect(manifest.suites['test/e2e/app-dir/actions/app-action.test.ts']).toBeTruthy();
  });

  it('records the upstream provenance (ref + "upstream-known-failing") in the manifest text', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    expect(
      /upstream-known-failing/i.test(raw),
      'the manifest must state the suites entries are upstream-known-failing (not knext debt)',
    ).toBe(true);
    expect(/v16\.2\.0/.test(raw), 'the manifest must record the upstream ref mirrored').toBe(true);
  });
});

describe('test/deploy-tests-manifest.knext.json — honest exclusion ledger (#89)', () => {
  it('has a $knextExclusions ledger that is neither empty nor all-excluding', () => {
    expect(Array.isArray(manifest.$knextExclusions)).toBe(true);
    // Not empty: would falsely imply knext supports every deploy feature.
    expect(manifest.$knextExclusions.length).toBeGreaterThan(0);
    // Not absurdly large: a giant exclude list = faking green by skipping everything.
    expect(manifest.$knextExclusions.length).toBeLessThan(50);
  });

  it('EVERY ledger entry has a non-empty rationale (no silent skips)', () => {
    for (const entry of manifest.$knextExclusions) {
      expect(typeof entry.test, `ledger entry missing "test": ${JSON.stringify(entry)}`).toBe(
        'string',
      );
      expect(entry.test.trim().length, `empty test name: ${JSON.stringify(entry)}`).toBeGreaterThan(
        0,
      );
      expect(
        typeof entry.rationale === 'string' && entry.rationale.trim().length > 0,
        `ledger entry "${entry.test}" has no rationale`,
      ).toBe(true);
    }
  });

  it('every ledger entry references a known-unsupported category', () => {
    for (const entry of manifest.$knextExclusions) {
      expect(
        KNOWN_UNSUPPORTED_CATEGORIES.has(entry.category),
        `ledger "${entry.test}" cites unknown category "${entry.category}" — ` +
          `only ${[...KNOWN_UNSUPPORTED_CATEGORIES].join(', ')} are honest exclusions`,
      ).toBe(true);
    }
  });

  it('every ledger glob also appears in rules.exclude (ledger & live filter cannot drift)', () => {
    // The honest ledger documents WHY; rules.exclude is what the harness ACTS on.
    // If a category is in the ledger it must be enforced, and vice-versa: no
    // architectural exclusion may be silently dropped from the live filter.
    const liveExcludes = new Set(manifest.rules.exclude);
    for (const entry of manifest.$knextExclusions) {
      expect(
        liveExcludes.has(entry.test),
        `ledger glob "${entry.test}" is not in rules.exclude — the ledger and the live filter have drifted`,
      ).toBe(true);
    }
  });
});

// ── knext-observed flaky quarantines (#147 A3-3 final mile) ─────────────────────
// Run 28593534713 (agent/compat-a33-final-mile, 785 passed / 3 failed): the last
// 3 failing files are ONE mechanism — 60s jest timeouts awaiting RUNTIME-PREFETCH
// responses via createRouterAct. Evidence gathered before quarantining:
//
//   • CROSS-RUN WOBBLE (not deterministic knext debt):
//     - search-params: hung 3/3 attempts in 28593534713; failed 2 attempts then
//       RECOVERED on retry in 28590478386.
//     - prefetch-layout-sharing: hung 3/3 in 28593534713; PASSED in 28590478386;
//       failed in 28578203671.
//     - refresh: PASSED in both prior runs; in 28593534713 a DIFFERENT case hung
//       each attempt (att1+att3: Server Action refresh; att2: re-navigation).
//   • SERVING LAYER EXONERATED by local repro (documented in the manifest
//     ledger): the exact rewritten full-prefetch request the hanging
//     search-params case waits on returns 200 in ~76ms from the knext standalone
//     server WITH the expected 'rewrittenSearchParam' content, stream complete,
//     headers intact — the deployment answers correctly; the hang is in the
//     client/CDP prefetch scheduling under CI load.
//   • UPSTREAM PROVENANCE: upstream's own deploy manifest quarantines the
//     runtime-prefetch family wholesale (~34 `flakey` cases in
//     segment-cache/prefetch-runtime.test.ts) and this very search-params file
//     carries an in-file deploy-mode FIXME + `if (!isNextDeploy)` skip
//     ("search params seem to be dropped from the resume render when deployed").
//
// These are FLAKEY quarantines of the OBSERVED cases only — never whole files,
// never pre-emptive — and each must carry its evidence in a $knextQuarantines
// ledger entry so the skip can be re-tested and removed on a ref bump.

interface KnextQuarantine {
  test: string;
  cases: string[];
  mechanism: string;
  evidence: string;
  provenance: string;
}

// Round 3 (run 28596005486, 787 passed / 1 failed): three more family members
// crossed the quarantine bar. The bar is deliberately: at least ONE FINAL
// (post-retry, 3/3) file failure across the full-run record — single-attempt
// wobbles that in-run retry tolerance absorbs (metadata, basic,
// cached-navigations, prefetching, dynamic-on-hover…) are NOT quarantined.
//   • stale-time: FINAL failure in 28596005486 (att1 'reuses dynamic data…'
//     hung, att2 BOTH cases hung, att3 'expires runtime prefetches…' hung while
//     'reuses…' passed in 1077ms); wobbled (recovered) in 28590478386.
//   • per-page-dynamic-stale-time: FINAL failure in 28578203671 (alternating
//     cases across attempts); wobbled (recovered) in 28590478386 + 28596005486.
//   • vary-params: FINAL failure in 28578203671; wobbled (recovered) in
//     28590478386 + 28596005486. All observed hangs share the family signature:
//     60s jest timeout, runtime-prefetch flows, zero assertion diffs.
const OBSERVED_FLAKY_QUARANTINES: Record<string, { cases: string[]; observedRuns: string[] }> = {
  'test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts': {
    cases: [
      'segment cache (search params) stores prefetched data by its rewritten search params, not the original ones',
    ],
    observedRuns: ['28593534713', '28590478386'],
  },
  'test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts': {
    cases: [
      'layout sharing in non-static prefetches segment-level prefetch config uses a runtime prefetch for sub-pages of runtime-prefetchable layouts if requested',
    ],
    observedRuns: ['28593534713', '28578203671'],
  },
  'test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts': {
    cases: [
      'segment cache (refresh) Server Action refresh() refreshes dynamic data only, not cached',
      'segment cache (refresh) re-navigation to a fully static page does not overwrite dynamic slots with default content',
    ],
    observedRuns: ['28593534713'],
  },
  'test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts': {
    cases: [
      'segment cache (staleness) expires runtime prefetches when their stale time has elapsed',
      'segment cache (staleness) reuses dynamic data up to the staleTimes.dynamic threshold',
    ],
    observedRuns: ['28596005486', '28590478386'],
  },
  'test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts': {
    cases: [
      'segment cache (per-page dynamic stale time) reuses dynamic data within the per-page stale time window',
      'segment cache (per-page dynamic stale time) back/forward navigation always reuses BFCache regardless of stale time',
      'segment cache (per-page dynamic stale time) per-page value overrides global staleTimes.dynamic regardless of direction',
    ],
    observedRuns: ['28578203671', '28596005486'],
  },
  'test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts': {
    cases: [
      'segment cache - vary params does not share cached segment when all params accessed statically (runtime prefetch)',
      'segment cache - vary params renders cached loading state instantly with runtime prefetching',
      'segment cache - vary params does not reuse prefetched segment when page accesses searchParams',
      'segment cache - vary params shares cached segment across all params when none accessed statically (runtime prefetch)',
    ],
    observedRuns: ['28578203671', '28596005486', '28590478386'],
  },
  // Round 4 (run 28597872225, 786/2). Settings audit first (see the workflow
  // fidelity guards in tests/compat-suite-workflow.test.ts): upstream's
  // test-deploy-adapter lane runs the SAME per-case 60s timeout (hardcoded
  // individualTestTimeout in e2e-utils, NOT raised by NEXT_E2E_TEST_TIMEOUT),
  // the same -c 2 concurrency, the same ubuntu-latest runners and the same 3
  // attempts — the class is inherently wobbly in deploy mode even at full env
  // parity, and upstream itself handles it by ledger (prefetch-runtime flakey
  // + app-client-cache failed entries). So: ledger, don't diverge.
  //   • client-cache.parallel-routes: pure family signature — alternating 60s
  //     hangs (att1+att3 're-use the cache…', att2 'should prefetch the full
  //     page'); passed ALL FOUR prior full runs. Upstream marks the SAME case
  //     texts failed in this family's defaults/experimental siblings.
  //   • prefetching: MIXED mechanism, honestly split: the uri-encoded case is
  //     an ASSERTION diff (un-retried immediate hasElementByCssSelector check
  //     right after .click() — the substantive %20-reuse assertions PASS);
  //     the two loading-state cases are family 60s hangs. All wobble across
  //     identical-code runs (28596005486 fully passed).
  'test/e2e/app-dir/app-client-cache/client-cache.parallel-routes.test.ts': {
    cases: [
      'app dir client cache with parallel routes prefetch={true} should prefetch the full page',
      'app dir client cache with parallel routes prefetch={true} should re-use the cache for the full page, only for 5 mins',
    ],
    observedRuns: ['28597872225'],
  },
  'test/e2e/app-dir/app-prefetch/prefetching.test.ts': {
    cases: [
      'app dir - prefetching should not unintentionally modify the requested prefetch by escaping the uri encoded query params',
      'app dir - prefetching should show layout eagerly when prefetched with loading one level down',
      'app dir - prefetching should immediately render the loading state for a dynamic segment when fetched from higher up in the tree',
    ],
    observedRuns: ['28597872225', '28593534713', '28590478386'],
  },
  // Round 6 (adapter-lane confirmation run 28601386408, 787/1): the lone
  // failure classified per the fork discipline — NOT an adapter finding:
  // optimistic-routing does NOT read NEXT_ENABLE_ADAPTER (verified: the only
  // isAdapterTest readers at v16.2.0 are not-found-with-pages-i18n,
  // sub-shell-generation{,-middleware}, partial-fallback-*, deployment-id —
  // all of which passed on first attempt this run). Pure family signature: a
  // DIFFERENT case hung 60s each attempt (att1 'rewrite detection…', att2
  // 'static route with catch-all sibling…', att3 'nested dynamic routes…'),
  // each passing in the other attempts in <1.5s, zero assertion diffs;
  // corroborated by a recovered 2-case in-run wobble in 28593534713.
  'test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts': {
    cases: [
      'optimistic-routing rewrite detection: detects dynamic rewrite when URL does not match route structure',
      'optimistic-routing static route with catch-all sibling: does not match sub-route against catch-all',
      'optimistic-routing nested dynamic routes: predicts through multiple dynamic segments',
      'optimistic-routing optional catch-all: predicts from index to path with segments',
    ],
    observedRuns: ['28601386408', '28593534713'],
  },
};

describe('test/deploy-tests-manifest.knext.json — knext-observed flaky quarantines (#147 A3-3 final mile)', () => {
  const quarantines: KnextQuarantine[] =
    (manifest as unknown as { $knextQuarantines?: KnextQuarantine[] }).$knextQuarantines ?? [];

  it('quarantines EXACTLY the observed hanging cases as flakey (per-case, never whole files)', () => {
    for (const [file, { cases }] of Object.entries(OBSERVED_FLAKY_QUARANTINES)) {
      const entry = manifest.suites[file];
      expect(entry, `suites must carry a flakey entry for ${file}`).toBeTruthy();
      expect(entry.flakey ?? [], `flakey list for ${file}`).toEqual(cases);
      // Quarantine ≠ known-failing: these wobble across runs, so they must be
      // flakey, not failed.
      expect(entry.failed ?? []).toEqual([]);
    }
  });

  it('each quarantined file has a $knextQuarantines ledger entry with evidence + mechanism + provenance', () => {
    for (const [file, { cases, observedRuns }] of Object.entries(OBSERVED_FLAKY_QUARANTINES)) {
      const ledger = quarantines.find((q) => q.test === file);
      expect(ledger, `no $knextQuarantines ledger entry for ${file}`).toBeTruthy();
      expect(ledger?.cases).toEqual(cases);
      // Evidence must cite EVERY run in which the hang was observed — the
      // cross-run record is the licence to quarantine, so it must be auditable
      // from the ledger alone.
      for (const runId of observedRuns) {
        expect(
          new RegExp(runId).test(ledger?.evidence ?? ''),
          `${file}: evidence must cite observing run ${runId}`,
        ).toBe(true);
      }
      expect(
        (ledger?.mechanism ?? '').length,
        `${file}: mechanism must be documented`,
      ).toBeGreaterThan(0);
      // Provenance: upstream itself quarantines the runtime-prefetch family.
      expect(
        /prefetch-runtime/.test(ledger?.provenance ?? ''),
        `${file}: provenance must reference upstream's own runtime-prefetch flakey quarantine`,
      ).toBe(true);
    }
  });

  it('quarantined cases never leak into failed lists or rules.exclude (no silent file drops)', () => {
    for (const file of Object.keys(OBSERVED_FLAKY_QUARANTINES)) {
      expect(
        manifest.rules.exclude.includes(file),
        `${file} must NOT be excluded wholesale — only its observed cases are quarantined`,
      ).toBe(false);
    }
  });

  it('every $knextQuarantines ledger entry maps to a live suites flakey entry (no drift)', () => {
    for (const ledger of quarantines) {
      const entry = manifest.suites[ledger.test];
      expect(entry?.flakey, `ledger ${ledger.test} has no live suites.flakey`).toBeTruthy();
      for (const c of ledger.cases) {
        expect(
          entry?.flakey?.includes(c),
          `ledger case "${c}" is not enforced in suites["${ledger.test}"].flakey`,
        ).toBe(true);
      }
    }
  });

  // Code-gate minor on the first all-green run (28599745695): the completeness
  // checks above only cover files hardcoded in OBSERVED_FLAKY_QUARANTINES — a
  // future flakey addition that skips BOTH lists would sail through unledgered.
  // This guard is GENERIC: every suites entry is either part of the upstream
  // v16.2.0 mirror (the verbatim block re-mirrored on ref bumps) or MUST carry
  // a $knextQuarantines record covering exactly its flakey cases.
  const UPSTREAM_MIRROR_SUITES = new Set([
    'test/e2e/app-dir/app-client-cache/client-cache.defaults.test.ts',
    'test/e2e/app-dir/app-client-cache/client-cache.experimental.test.ts',
    'test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts',
    'test/e2e/app-dir/actions/app-action.test.ts',
    'test/e2e/app-dir/actions/app-action-node-middleware.test.ts',
    'test/e2e/app-dir/app-static/app-static.test.ts',
    'test/e2e/app-dir/metadata/metadata.test.ts',
    'test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts',
    'test/e2e/middleware-rewrites/test/index.test.ts',
  ]);

  it('ANY suites entry outside the upstream mirror MUST have a complete $knextQuarantines record (generic, no hardcoded allowlist)', () => {
    for (const [file, entry] of Object.entries(manifest.suites)) {
      if (UPSTREAM_MIRROR_SUITES.has(file)) continue;
      // A knext-observed entry must be flakey-only (quarantine != known-failing)...
      expect(
        entry.failed ?? [],
        `knext-observed suites["${file}"] must not carry a failed list — quarantines are flakey-only`,
      ).toEqual([]);
      expect(
        (entry.flakey ?? []).length,
        `suites["${file}"] is neither an upstream mirror entry nor a flakey quarantine`,
      ).toBeGreaterThan(0);
      // ...and every one of its cases must be ledgered with evidence.
      const ledger = quarantines.find((q) => q.test === file);
      expect(
        ledger,
        `suites["${file}"] has flakey cases but NO $knextQuarantines ledger record — unledgered quarantines are forbidden`,
      ).toBeTruthy();
      expect(
        [...(ledger?.cases ?? [])].sort(),
        `$knextQuarantines record for "${file}" must cover exactly its live flakey cases`,
      ).toEqual([...(entry.flakey ?? [])].sort());
      for (const key of ['mechanism', 'evidence', 'provenance'] as const) {
        expect(
          typeof ledger?.[key] === 'string' && (ledger?.[key] ?? '').trim().length > 0,
          `$knextQuarantines record for "${file}" is missing a non-empty "${key}"`,
        ).toBe(true);
      }
    }
  });

  it('the upstream-mirror set in this guard matches the mirrored suites (re-mirror both on a ref bump)', () => {
    // If a ref bump re-mirrors upstream suites, this set must be updated in the
    // same change — otherwise the generic guard above would misclassify a new
    // upstream mirror entry as an unledgered knext quarantine (fail-loud is the
    // point, but the fix must be obvious).
    for (const file of UPSTREAM_MIRROR_SUITES) {
      expect(
        manifest.suites[file],
        `guard's UPSTREAM_MIRROR_SUITES lists "${file}" but the manifest has no such suites entry`,
      ).toBeTruthy();
    }
  });
});
