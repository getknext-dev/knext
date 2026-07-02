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

const OBSERVED_FLAKY_QUARANTINES: Record<string, string[]> = {
  'test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts': [
    'segment cache (search params) stores prefetched data by its rewritten search params, not the original ones',
  ],
  'test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts': [
    'layout sharing in non-static prefetches segment-level prefetch config uses a runtime prefetch for sub-pages of runtime-prefetchable layouts if requested',
  ],
  'test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts': [
    'segment cache (refresh) Server Action refresh() refreshes dynamic data only, not cached',
    'segment cache (refresh) re-navigation to a fully static page does not overwrite dynamic slots with default content',
  ],
};

describe('test/deploy-tests-manifest.knext.json — knext-observed flaky quarantines (#147 A3-3 final mile)', () => {
  const quarantines: KnextQuarantine[] =
    (manifest as unknown as { $knextQuarantines?: KnextQuarantine[] }).$knextQuarantines ?? [];

  it('quarantines EXACTLY the observed hanging cases as flakey (per-case, never whole files)', () => {
    for (const [file, cases] of Object.entries(OBSERVED_FLAKY_QUARANTINES)) {
      const entry = manifest.suites[file];
      expect(entry, `suites must carry a flakey entry for ${file}`).toBeTruthy();
      expect(entry.flakey ?? [], `flakey list for ${file}`).toEqual(cases);
      // Quarantine ≠ known-failing: these wobble across runs, so they must be
      // flakey, not failed.
      expect(entry.failed ?? []).toEqual([]);
    }
  });

  it('each quarantined file has a $knextQuarantines ledger entry with evidence + mechanism + provenance', () => {
    for (const [file, cases] of Object.entries(OBSERVED_FLAKY_QUARANTINES)) {
      const ledger = quarantines.find((q) => q.test === file);
      expect(ledger, `no $knextQuarantines ledger entry for ${file}`).toBeTruthy();
      expect(ledger?.cases).toEqual(cases);
      // Evidence must cite the OBSERVED runs (cross-run wobble is the licence to
      // quarantine) — at least the run that hung and one where the file passed
      // or recovered.
      expect(
        /28593534713/.test(ledger?.evidence ?? ''),
        `${file}: evidence must cite the observing run 28593534713`,
      ).toBe(true);
      expect(
        /2859047838|2857820367/.test(ledger?.evidence ?? ''),
        `${file}: evidence must cite a prior run showing the case wobbles (pass/recover)`,
      ).toBe(true);
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
});
