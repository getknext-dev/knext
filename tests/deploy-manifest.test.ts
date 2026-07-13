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

// ── knext-observed flaky quarantines (#147 A3-3 final mile, #214 family policy) ──
// The runtime-prefetch/navigation-timing family: 60s jest timeouts (upstream's
// HARDCODED per-case `individualTestTimeout` in test/lib/e2e-utils — NOT raised
// by NEXT_E2E_TEST_TIMEOUT, which only lifts the SETUP timeout) thrown from
// createRouterAct-driven navigation/prefetch waits, a DIFFERENT case per attempt,
// zero assertion diffs, while the sibling -c 2 slot deploys+tests other fixtures
// (CPU contention on the 4-core runner). Serving layer exonerated by local repro
// (the manifest ledger's search-params entry: the exact awaited prefetch answers
// 200 in ~76ms from the real knext deployment).
//
// ROOT CAUSE (the #214 investigation): vercel/next.js#95301 (merged 2026-07-02,
// AFTER the pinned v16.2.0) fixes a client segment-cache race — a locked
// navigation reused an in-flight runtime-prefetch entry without tracking it,
// drained without awaiting it, and read the unresolved shell, so the awaited
// content never surfaced and the test hit the bare 60s timeout. Upstream's own
// words: "The race only lost under CPU contention, which is why it reproduced
// in the prod flake-detection job on slow containers but almost never locally."
// That is EXACTLY the observed signature. Upstream additionally suite-skipped
// five family files outright ("too flaky") after v16.2.0: #92163 (refresh),
// #92198 (prefetch-layout-sharing), #92162 (per-page-dynamic-stale-time),
// #92199 (cached-navigations, all cases), #92195 (client-cache.parallel-routes).
// Four are still skipped at canary; cached-navigations' skips were REVERTED by
// #93798 (2026-05-13) — the file is fully live at canary, and the revert
// PREDATES the #95301 fix (2026-07-02), so its membership rests on #95301 plus
// knext's OWN final-post-retry evidence, with the skip-then-revert history
// cited honestly (guarded below via `upstreamSkipRevertPR`).
//
// POLICY (ADR-0007 graduation addendum §d, amending §c.1): per-case quarantine
// stopped converging — across runs 28578203671…28701712403 a DIFFERENT family
// member failed final-past-retries nearly every run (new sibling cases inside
// ledgered files, then a brand-new file). Files meeting the FAMILY BAR are
// quarantined at FILE level via a verbatim rules.exclude entry:
//   (i)  ≥1 knext FINAL post-retry failure with the family signature, AND
//   (ii) upstream provenance: the root-cause fix (vercel/next.js#95301) and,
//        where one exists, upstream's own suite-skip PR, AND
//   (iii) a $knextQuarantines ledger record with level:"file" carrying
//        mechanism/evidence/provenance + the nextjsRef stamp (the expiry gate
//        below forces re-audit on every ref bump — first candidate for removal
//        is the first NEXTJS_REF that contains the #95301 fix).
// Cases OUTSIDE the family stay per-case (never whole files) exactly as before.

interface KnextQuarantine {
  test: string;
  cases: string[];
  mechanism: string;
  evidence: string;
  provenance: string;
  /** The NEXTJS_REF the quarantine evidence was observed at (#181/#172 follow-up). */
  nextjsRef?: string;
  /** Set when the entry was re-tested (and re-confirmed) at a NEWER workflow ref. */
  reaudited?: string;
  /** #214: "file" = family-level quarantine (whole file in rules.exclude). Absent = per-case. */
  level?: 'case' | 'file';
}

/**
 * The runtime-prefetch/navigation-timing family (#214): every file here has at
 * least one FINAL (post-retry, 3/3) failure with the family signature across
 * the full-run record, and the shared root cause is upstream's client
 * segment-cache race (vercel/next.js#95301, fixed post-v16.2.0).
 * `upstreamSkipPR` marks files upstream ITSELF suite-skipped as "too flaky";
 * `upstreamSkipRevertPR` marks a later upstream REVERT of that skip (the file is
 * live again at canary) — the ledger must then cite BOTH, and may not claim the
 * file is still skipped.
 */
const FAMILY_FILE_QUARANTINES: Record<
  string,
  { observedRuns: string[]; upstreamSkipPR?: number; upstreamSkipRevertPR?: number }
> = {
  'test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts': {
    observedRuns: ['28593534713', '28590478386'],
  },
  'test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts': {
    observedRuns: ['28593534713', '28578203671'],
    upstreamSkipPR: 92198,
  },
  'test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts': {
    observedRuns: ['28593534713'],
    upstreamSkipPR: 92163,
  },
  'test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts': {
    observedRuns: ['28596005486', '28590478386'],
  },
  'test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts': {
    observedRuns: ['28578203671', '28596005486', '28607626868', '28700392845'],
    upstreamSkipPR: 92162,
  },
  'test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts': {
    observedRuns: ['28578203671', '28596005486', '28590478386', '28607626868'],
  },
  // Skip-then-REVERT history: #92199 (2026-04-15) it.skip'd all its cases as
  // flaky, #93798 (2026-05-13) reverted — live at canary. The revert PREDATES
  // the #95301 root-cause fix (2026-07-02) and our v16.2.0 pin predates both,
  // so the race is un-fixed in our lane; membership rests on #95301 + knext's
  // own final-post-retry evidence.
  'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts': {
    observedRuns: ['28618585946', '28612654960'],
    upstreamSkipPR: 92199,
    upstreamSkipRevertPR: 93798,
  },
  // #214: the newest member — final-past-retries in run 28701712403 (shard 3/16),
  // a DIFFERENT case hung 60s on each of the 3 attempts (test.ts:232, :280, :57)
  // while 9/11 cases passed per attempt.
  'test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts': {
    observedRuns: ['28701712403'],
  },
  'test/e2e/app-dir/app-client-cache/client-cache.parallel-routes.test.ts': {
    observedRuns: ['28597872225'],
    upstreamSkipPR: 92195,
  },
  'test/e2e/app-dir/app-prefetch/prefetching.test.ts': {
    observedRuns: ['28597872225', '28593534713', '28590478386'],
  },
  'test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts': {
    observedRuns: ['28601386408', '28593534713'],
  },
  'test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts': {
    observedRuns: ['28612654960', '28607626868'],
  },
};

// Per-case quarantines OUTSIDE the family keep the original §c.1 mechanics:
// exact observed cases only, never whole files.
//   • server-actions-redirect-middleware-rewrite: bun-lane wobble whose
//     mechanism overlaps the documented Bun edge-sandbox outbound-fetch gap
//     (PR #189) — NOT the runtime-prefetch family; stays per-case.
//   • edge-async-local-storage: same edge-sandbox outbound-fetch mechanism
//     class (the fixture's edge handlers await fetch(...) + response.text() —
//     the documented Bun ≤1.3.x errored-body-never-settles gap); bun-lane-only
//     final-post-retry failure in run 29276122186. LANE-SCOPING NOTE: the
//     manifest is lane-BLIND (both lanes load the same
//     NEXT_EXTERNAL_TESTS_FILTERS file), so the two cases are jest-deselected
//     on the NODE lane too, where they pass; the FILE still runs and reports
//     green on node and the 778 file-count total is unchanged (suites entries
//     are per-case deselections, not file exclusions) — the same accepted
//     cost as the server-actions precedent entry, documented in the ledger.
const PER_CASE_QUARANTINES: Record<string, { cases: string[]; observedRuns: string[] }> = {
  'test/e2e/app-dir/server-actions-redirect-middleware-rewrite/server-actions-redirect-middleware-rewrite.test.ts':
    {
      cases: [
        'app-dir - server-actions-redirect-middleware-rewrite.test should redirect correctly in edge runtime with middleware rewrite',
      ],
      observedRuns: ['28616072395', '28607626868'],
    },
  'test/e2e/edge-async-local-storage/index.test.ts': {
    cases: [
      'edge api can use async local storage cans use a single instance per request',
      'edge api can use async local storage cans use multiple instances per request',
    ],
    observedRuns: ['29276122186'],
  },
};

describe('deploy-tests-manifest — #214 family-level quarantine (ADR-0007 §d)', () => {
  const quarantines: KnextQuarantine[] =
    (manifest as unknown as { $knextQuarantines?: KnextQuarantine[] }).$knextQuarantines ?? [];

  it('every family file is excluded at FILE level via a verbatim rules.exclude entry', () => {
    for (const file of Object.keys(FAMILY_FILE_QUARANTINES)) {
      expect(
        manifest.rules.exclude.includes(file),
        `${file} is in the runtime-prefetch flake family and must be file-level excluded`,
      ).toBe(true);
    }
  });

  it('family files carry NO stale per-case suites entry (the file-level exclusion supersedes it)', () => {
    for (const file of Object.keys(FAMILY_FILE_QUARANTINES)) {
      expect(
        manifest.suites[file],
        `${file} is file-level quarantined — its old per-case suites entry must be removed (dead config)`,
      ).toBeUndefined();
    }
  });

  it('every family file has a level:"file" ledger record with mechanism + run-cited evidence', () => {
    for (const [file, { observedRuns }] of Object.entries(FAMILY_FILE_QUARANTINES)) {
      const ledger = quarantines.find((q) => q.test === file);
      expect(ledger, `no $knextQuarantines ledger entry for family file ${file}`).toBeTruthy();
      expect(ledger?.level, `${file}: family quarantine must declare level:"file"`).toBe('file');
      expect(
        (ledger?.mechanism ?? '').trim().length,
        `${file}: mechanism must be documented`,
      ).toBeGreaterThan(0);
      expect(
        (ledger?.cases ?? []).length,
        `${file}: the historically observed cases must be preserved in the ledger`,
      ).toBeGreaterThan(0);
      // The cross-run record is the licence — every observing run must be auditable
      // from the ledger alone.
      for (const runId of observedRuns) {
        expect(
          new RegExp(runId).test(ledger?.evidence ?? ''),
          `${file}: evidence must cite observing run ${runId}`,
        ).toBe(true);
      }
    }
  });

  it('family provenance cites the upstream ROOT-CAUSE fix (vercel/next.js#95301) — and the upstream suite-skip PR where one exists', () => {
    for (const [file, { upstreamSkipPR, upstreamSkipRevertPR }] of Object.entries(
      FAMILY_FILE_QUARANTINES,
    )) {
      const ledger = quarantines.find((q) => q.test === file);
      expect(
        /#95301/.test(ledger?.provenance ?? ''),
        `${file}: family provenance must cite the upstream root-cause fix vercel/next.js#95301 ` +
          '(the in-flight prefetch-entry reuse race under CPU contention, fixed post-v16.2.0)',
      ).toBe(true);
      if (upstreamSkipPR !== undefined) {
        expect(
          new RegExp(`#${upstreamSkipPR}`).test(ledger?.provenance ?? ''),
          `${file}: provenance must cite upstream's own suite-skip PR #${upstreamSkipPR}`,
        ).toBe(true);
      }
      if (upstreamSkipRevertPR !== undefined) {
        // Honesty on the citation surface (#215 gate): when upstream REVERTED
        // its skip, the ledger must cite the revert PR too, and must NOT claim
        // the file is still skipped upstream — that would be a false citation.
        expect(
          new RegExp(`#${upstreamSkipRevertPR}`).test(ledger?.provenance ?? ''),
          `${file}: upstream reverted its skip — provenance must cite the revert PR #${upstreamSkipRevertPR}`,
        ).toBe(true);
        expect(
          /still skipped at canary/i.test(ledger?.provenance ?? ''),
          `${file}: provenance claims the file is still skipped at canary, but upstream ` +
            `reverted the skip in #${upstreamSkipRevertPR} — correct the citation`,
        ).toBe(false);
      }
    }
  });

  it('the family stays BOUNDED (≤ 15 file-level entries) — a growing blanket skip is not a policy', () => {
    const fileLevel = quarantines.filter((q) => q.level === 'file');
    expect(fileLevel.length).toBeLessThanOrEqual(15);
    // And every level:"file" ledger entry must be one of the family files above —
    // promoting a NEW file requires updating BOTH this table (with its runs +
    // provenance) and the manifest, keeping the guard and the ledger in lockstep.
    for (const q of fileLevel) {
      expect(
        Object.keys(FAMILY_FILE_QUARANTINES).includes(q.test),
        `level:"file" ledger entry ${q.test} is not in the guard's family table — ` +
          'update FAMILY_FILE_QUARANTINES with its observed runs and provenance',
      ).toBe(true);
    }
  });

  it('rules.exclude taxonomy is CLOSED: upstream mirror ∪ architectural ledger ∪ family ledger (no silent file drops)', () => {
    // The old guard asserted quarantined files never appear in rules.exclude;
    // §d replaces it with a stronger closure property: EVERY exclude entry must
    // be attributable — mirrored verbatim from upstream's own manifest, ledgered
    // architectural ($knextExclusions), or a ledgered level:"file" family
    // quarantine. Anything else fails loudly.
    const architectural = new Set(manifest.$knextExclusions.map((e) => e.test));
    const family = new Set(quarantines.filter((q) => q.level === 'file').map((q) => q.test));
    for (const entry of manifest.rules.exclude) {
      const attributed =
        UPSTREAM_MIRROR_EXCLUDES.has(entry) || architectural.has(entry) || family.has(entry);
      expect(
        attributed,
        `rules.exclude entry "${entry}" is unattributed — it must be an upstream-mirror ` +
          'exclude, a $knextExclusions architectural glob, or a level:"file" family quarantine',
      ).toBe(true);
    }
  });
});

/** Upstream v16.2.0 test/deploy-tests-manifest.json rules.exclude, mirrored verbatim
 * (re-mirror on a NEXTJS_REF bump — these are upstream's own deploy excludes, not knext debt). */
const UPSTREAM_MIRROR_EXCLUDES = new Set([
  'test/e2e/cancel-request/stream-cancel.test.ts',
  'test/e2e/new-link-behavior/material-ui.test.ts',
  'test/e2e/react-dnd-compile/react-dnd-compile.test.ts',
  'test/e2e/skip-trailing-slash-redirect/index.test.ts',
  'test/e2e/app-dir/app-compilation/index.test.ts',
  'test/e2e/app-dir/rsc-webpack-loader/rsc-webpack-loader.test.ts',
  'test/e2e/swc-warnings/index.test.ts',
  'test/e2e/third-parties/index.test.ts',
  'test/e2e/app-dir/app-routes/app-custom-route-base-path.test.ts',
  'test/e2e/app-dir/mdx/mdx.test.ts',
  'test/e2e/app-dir/modularizeimports/modularizeimports.test.ts',
  'test/e2e/app-dir/third-parties/basic.test.ts',
  'test/e2e/app-dir/app-static/app-static-custom-handler.test.ts',
  'test/e2e/app-dir/options-request/options-request.test.ts',
  'test/e2e/app-dir/revalidate-dynamic/revalidate-dynamic.test.ts',
  'test/e2e/app-dir/syntax-highlighter-crash/syntax-highlighter-crash.test.ts',
  'test/e2e/new-link-behavior/stitches.test.ts',
  'test/e2e/next-image-forward-ref/index.test.ts',
  'test/e2e/react-compiler/react-compiler.test.ts',
  'test/e2e/app-dir/i18n-hybrid/i18n-hybrid.test.ts',
  'test/e2e/app-dir/metadata/metadata.test.ts',
  'test/e2e/app-dir/rsc-basic/rsc-basic.test.ts',
  'test/e2e/basepath/basepath.test.ts',
  'test/e2e/postcss-config-cjs/index.test.ts',
  'test/e2e/socket-io/index.test.ts',
  'test/e2e/middleware-matcher/index.test.ts',
  'test/e2e/next-script/index.test.ts',
  'test/production/standalone-mode/**/*',
]);

describe('deploy-tests-manifest — per-case quarantines outside the family (§c.1 mechanics unchanged)', () => {
  const quarantines: KnextQuarantine[] =
    (manifest as unknown as { $knextQuarantines?: KnextQuarantine[] }).$knextQuarantines ?? [];

  it('quarantines EXACTLY the observed hanging cases as flakey (per-case, never whole files)', () => {
    for (const [file, { cases }] of Object.entries(PER_CASE_QUARANTINES)) {
      const entry = manifest.suites[file];
      expect(entry, `suites must carry a flakey entry for ${file}`).toBeTruthy();
      expect(entry.flakey ?? [], `flakey list for ${file}`).toEqual(cases);
      // Quarantine ≠ known-failing: these wobble across runs, so they must be
      // flakey, not failed.
      expect(entry.failed ?? []).toEqual([]);
      // Per-case means per-case: the file itself must NOT be excluded wholesale.
      expect(
        manifest.rules.exclude.includes(file),
        `${file} is a per-case quarantine and must NOT be file-level excluded`,
      ).toBe(false);
    }
  });

  it('each per-case quarantined file has a ledger entry with evidence + mechanism + provenance', () => {
    for (const [file, { cases, observedRuns }] of Object.entries(PER_CASE_QUARANTINES)) {
      const ledger = quarantines.find((q) => q.test === file);
      expect(ledger, `no $knextQuarantines ledger entry for ${file}`).toBeTruthy();
      expect(ledger?.level ?? 'case', `${file} must not claim level:"file"`).not.toBe('file');
      expect(ledger?.cases).toEqual(cases);
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
      // Provenance: either upstream itself quarantines the family
      // (runtime-prefetch), or — #188 round 3 — the entry explicitly declares
      // the documented bun-lane mechanism class (the edge-sandbox
      // outbound-fetch gap, PR #189) instead of borrowing upstream cover.
      expect(
        /prefetch-runtime/.test(ledger?.provenance ?? '') ||
          /edge-sandbox outbound-fetch gap/.test(ledger?.provenance ?? ''),
        `${file}: provenance must reference upstream's runtime-prefetch quarantine or the documented bun edge-sandbox mechanism`,
      ).toBe(true);
    }
  });

  it('every PER-CASE ledger entry maps to a live suites flakey entry (no drift); file-level entries map to rules.exclude', () => {
    for (const ledger of quarantines) {
      if (ledger.level === 'file') {
        expect(
          manifest.rules.exclude.includes(ledger.test),
          `file-level ledger ${ledger.test} is not enforced in rules.exclude`,
        ).toBe(true);
        continue;
      }
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
  // checks above only cover files hardcoded in the tables — a future flakey
  // addition that skips BOTH lists would sail through unledgered. This guard is
  // GENERIC: every suites entry is either part of the upstream v16.2.0 mirror
  // (the verbatim block re-mirrored on ref bumps) or MUST carry a
  // $knextQuarantines record covering exactly its flakey cases.
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

// ─────────────────────────────────────────────────────────────────────────────
// #181 sys-design + #172 follow-up — quarantine REF-STAMP expiry gate.
// A quarantine's licence is its evidence, and that evidence was gathered at a
// specific harness ref. On a NEXTJS_REF bump the evidence goes stale: the
// upstream fixture/timings the wobble was observed against may have changed,
// so ADR-0007's graduation addendum requires re-testing every quarantined case
// at the new ref. That policy used to live only in prose — nothing FAILED when
// the workflow ref moved while the ledger stayed stamped at the old one. This
// gate mechanizes it: every $knextQuarantines entry carries the `nextjsRef` it
// was quarantined at, and a workflow default-ref bump FAILS this suite until
// each entry is either re-audited (`reaudited: <newref>`) or re-quarantined
// with fresh evidence.
// ─────────────────────────────────────────────────────────────────────────────

describe('$knextQuarantines ref stamps — re-audit on NEXTJS_REF bump (#181/#172 follow-up)', () => {
  const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
  const REF_SHAPE = /^v\d+\.\d+\.\d+$/;

  /** The workflow's DEFAULT pinned ref (what scheduled runs actually test). */
  function workflowDefaultRef(): string {
    const src = readFileSync(WORKFLOW_PATH, 'utf8');
    const m = src.match(
      /NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}/,
    );
    expect(m, 'workflow must derive NEXTJS_REF with a pinned quoted default').not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  const quarantines: KnextQuarantine[] =
    (manifest as unknown as { $knextQuarantines?: KnextQuarantine[] }).$knextQuarantines ?? [];

  it('has quarantine entries to stamp (sanity)', () => {
    expect(quarantines.length).toBeGreaterThan(0);
  });

  it('every quarantine entry is stamped with the NEXTJS_REF its evidence was observed at', () => {
    for (const q of quarantines) {
      expect(
        typeof q.nextjsRef === 'string' && REF_SHAPE.test(q.nextjsRef),
        `${q.test}: every $knextQuarantines entry must carry a well-formed nextjsRef stamp (vX.Y.Z), got "${String(
          q.nextjsRef,
        )}"`,
      ).toBe(true);
    }
  });

  it('FAILS on a workflow ref bump until each entry is re-audited at the new ref', () => {
    const ref = workflowDefaultRef();
    for (const q of quarantines) {
      const covered = q.nextjsRef === ref || q.reaudited === ref;
      expect(
        covered,
        `${q.test}: quarantined at ${String(q.nextjsRef)} but the workflow default NEXTJS_REF is now ${ref}. ` +
          `Re-run the quarantined cases at ${ref} (dispatch the compat suite) and either stamp ` +
          `"reaudited": "${ref}" (wobble re-confirmed / still exonerated) or remove the quarantine. ` +
          `Never bump the workflow ref past a stale quarantine ledger (ADR-0007 graduation addendum §c, mechanized).`,
      ).toBe(true);
    }
  });

  // #194 gate follow-up: the old name claimed "not older than the stamp", but
  // the body only asserts shape + inequality (no version-order comparison) —
  // the name must not overclaim what is enforced.
  it('a reaudited marker, when present, is a well-formed ref distinct from the original stamp', () => {
    for (const q of quarantines) {
      if (q.reaudited === undefined) continue;
      expect(
        REF_SHAPE.test(q.reaudited),
        `${q.test}: reaudited must be a vX.Y.Z ref, got "${q.reaudited}"`,
      ).toBe(true);
      expect(
        q.reaudited,
        `${q.test}: a reaudited stamp equal to the original nextjsRef is meaningless — drop it`,
      ).not.toBe(q.nextjsRef);
    }
  });
});
