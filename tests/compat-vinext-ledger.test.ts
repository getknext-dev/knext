/**
 * The vinext-lane quarantine ledger (#1321; design approved on the issue).
 *
 * The vinext × bun compiled-exec lane runs the node lane's corpus unchanged, so
 * its denominator stays 778. Failures that are unsupported by design (with a
 * named feature and an upstream issue), or flaky with current mixed evidence,
 * are RECLASSIFIED after the run as `quarantined` rather than removed from the
 * corpus — they still run every time. Reclassification is at CASE granularity:
 * every entry carries a generated snapshot of its failing cases, a snapshot case
 * that stops failing reds the run (stale), and a new failing case in a ledgered
 * file stays a real failure.
 *
 * What is guarded here:
 *   - every red condition of the validator (the approved constraints);
 *   - reclassification: snapshot-only, never absorbs a new case, fails closed
 *     when a shard's failure list does not account for its failed count, and
 *     never changes passed / notRun / expectedTotal / excluded;
 *   - stale detection (including a PARTIAL fix);
 *   - snapshot regeneration (`refresh`);
 *   - quarantined results persist in the shared per-night run ledger, and a lane
 *     without them renders exactly as before;
 *   - the real ledger file is valid today;
 *   - the workflow applies and reconciles the ledger, and the ledger lives
 *     OUTSIDE the file patterns the compat-window fingerprint freezes for
 *     every cell;
 *   - the flaky window: informative-run filtering (branch/workflow/ref/shard
 *     completeness), backfill past uninformative runs, and fail-closed
 *     behaviour on a run of unfetchable history (#1355 review finding 1/3);
 *   - `verify`: branch/workflow/ref/shard-completeness re-derivation, so a
 *     relabelled or invented entry cannot escape via a bad citation (#1355
 *     review finding 2), and its advisory (non-required) wiring.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, renderTable } from '../scripts/compat-run-ledger.mjs';
import {
  applyLedger,
  CLASSES,
  classifyListingError,
  collectHistory,
  DEFAULT_NEXTJS_REF,
  downloadRun,
  EXPECTED_SHARD_TOTAL,
  FLAKY_FILE_CAP,
  FLAKY_MAX_EXPIRY_DAYS,
  flakyHistory,
  flakyWindow,
  isAuthOrApiError,
  isCompleteDefaultRun,
  isNoArtifactError,
  LEDGER_FILE_CAP,
  LISTING_RETRY_ATTEMPTS,
  LISTING_RETRY_BASE_MS,
  MAX_CONSECUTIVE_HISTORY_SKIPS,
  MAX_EXPIRY_DAYS,
  previousRunCandidates,
  publishedNumber,
  readSummaries,
  refreshSnapshots,
  retryAfterMs,
  skippedWarnings,
  staleEntries,
  validateLedger,
  verifyEvidence,
} from '../scripts/compat-vinext-ledger.mjs';

// Some fixtures below create a fresh mkdtemp PER FETCH inside a `fetchSummaries`
// closure (collectHistory can call it more than once) rather than once up front,
// so they cannot be paired with an inline `finally`. Register each one here and
// remove them all in a single afterAll (#880/#939 — a temp dir outside the repo
// that is never removed still leaks, one directory per run, forever).
const dynamicTempDirs: string[] = [];
afterAll(() => {
  for (const d of dynamicTempDirs) rmSync(d, { recursive: true, force: true });
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = 'test/compat-vinext-ledger.json';
const WORKFLOW = '.github/workflows/compat-vinext.yml';
const VERIFY_WORKFLOW = '.github/workflows/compat-vinext-ledger-verify.yml';
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const TODAY = '2026-09-24';
const CORPUS_EXCLUDES = ['test/e2e/excluded/by-manifest.test.ts'];
const SHELLS = 'test/e2e/app-dir/fallback-shells/fallback-shells.test.ts';
const NAV = 'test/e2e/app-dir/navigation/navigation.test.ts';

// biome-ignore lint/suspicious/noExplicitAny: fixtures are plain JSON
type Any = any;

function entry(over: Record<string, unknown> = {}): Any {
  return {
    test: SHELLS,
    class: 'unsupported',
    feature: 'PPR fallback shells',
    upstream: 'https://github.com/cloudflare/vinext/issues/1359',
    cases: ['a', 'b'],
    evidence: {
      fail: [
        { run: '1', cases: ['a', 'b'] },
        { run: '2', cases: ['a', 'b', 'c'] },
      ],
    },
    added: '2026-09-24',
    expires: '2026-10-24',
    ...over,
  };
}
function ledger(entries: Any[]): Any {
  return { lane: 'bun-vinext', entries };
}
const errs = (l: Any, today = TODAY) =>
  validateLedger(l, { today, corpusExcludes: CORPUS_EXCLUDES });

describe('validateLedger: the approved constraints', () => {
  it('accepts a well-formed entry', () => {
    expect(errs(ledger([entry()]))).toEqual([]);
  });

  it('constants match the founder constraints', () => {
    expect(LEDGER_FILE_CAP).toBe(15);
    expect(MAX_EXPIRY_DAYS).toBe(30);
  });

  it('reds an undated entry (no added / no expires)', () => {
    expect(errs(ledger([entry({ expires: undefined })])).join()).toMatch(/expires/);
    expect(errs(ledger([entry({ added: undefined })])).join()).toMatch(/added/);
  });

  it('reds an expiry more than 30 days after it was added', () => {
    expect(errs(ledger([entry({ expires: '2026-10-25' })])).join()).toMatch(/30 days/);
  });

  it('reds an expired entry (today past its expiry)', () => {
    expect(errs(ledger([entry()]), '2026-10-25').join()).toMatch(/expired/);
    expect(errs(ledger([entry()]), '2026-10-24')).toEqual([]);
  });

  it('rejects a version-only expiry (a date is mandatory)', () => {
    const e = entry({ expires: undefined, expiresWithVinext: '1.0.0' });
    expect(errs(ledger([e])).join()).toMatch(/expires/);
  });

  it('reds a lane over the 15-file cap', () => {
    const many = Array.from({ length: 16 }, (_, i) => entry({ test: `test/e2e/x${i}/x.test.ts` }));
    expect(errs(ledger(many)).join()).toMatch(/15/);
    expect(errs(ledger(many.slice(0, 15)))).toEqual([]);
  });

  it('an unsupported entry needs a named feature AND an upstream issue link', () => {
    expect(errs(ledger([entry({ feature: '' })])).join()).toMatch(/feature/);
    expect(errs(ledger([entry({ upstream: undefined })])).join()).toMatch(/upstream/);
    expect(errs(ledger([entry({ upstream: 'see chat' })])).join()).toMatch(/upstream/);
  });

  it('every entry carries a non-empty, duplicate-free case snapshot', () => {
    expect(errs(ledger([entry({ cases: [] })])).join()).toMatch(/snapshot/);
    expect(errs(ledger([entry({ cases: undefined })])).join()).toMatch(/snapshot/);
    expect(errs(ledger([entry({ cases: ['a', 'a'] })])).join()).toMatch(/duplicates/);
  });

  it('a flaky entry needs mixed evidence (at least one pass and one fail run)', () => {
    const flaky = entry({
      test: NAV,
      class: 'flaky',
      feature: undefined,
      upstream: undefined,
      cases: ['hash'],
      evidence: { fail: [{ run: '1', cases: ['hash'] }], pass: ['2', '3'] },
      expires: '2026-10-08',
    });
    expect(errs(ledger([flaky]))).toEqual([]);
    const failOnly = { fail: [{ run: '1', cases: ['hash'] }] };
    expect(errs(ledger([{ ...flaky, evidence: failOnly }])).join()).toMatch(/mixed/);
    expect(errs(ledger([{ ...flaky, evidence: { pass: ['2'] } }])).join()).toMatch(/mixed/);
    const same = { fail: [{ run: '1', cases: ['hash'] }], pass: ['1'] };
    expect(errs(ledger([{ ...flaky, evidence: same }])).join()).toMatch(/both passed and failed/);
  });

  it('a flaky entry needs at least three evidence runs, expires within 14 days, and at most 5 are ledgered', () => {
    const flaky = navEntry(['hash']);
    expect(errs(ledger([flaky]))).toEqual([]);
    const two = { fail: [{ run: '1', cases: ['hash'] }], pass: ['2'] };
    expect(errs(ledger([{ ...flaky, evidence: two }])).join()).toMatch(
      /at least three evidence runs/,
    );
    expect(FLAKY_MAX_EXPIRY_DAYS).toBe(14);
    expect(errs(ledger([{ ...flaky, expires: '2026-10-09' }])).join()).toMatch(/14 days/);
    // an unsupported entry keeps the 30-day window
    expect(errs(ledger([entry({ expires: '2026-10-24' })]))).toEqual([]);
    expect(FLAKY_FILE_CAP).toBe(5);
    const flakies = Array.from({ length: 6 }, (_, i) => ({
      ...flaky,
      test: `test/e2e/flaky${i}/x.test.ts`,
    }));
    expect(errs(ledger(flakies)).join()).toMatch(/6 flaky files .* at most 5/);
    expect(errs(ledger(flakies.slice(0, 5)))).toEqual([]);
  });

  it('every entry needs failing-run evidence recorded per run, with that run’s cases', () => {
    expect(errs(ledger([entry({ evidence: { fail: [] } })])).join()).toMatch(/evidence/);
    expect(errs(ledger([entry({ evidence: { fail: ['1', '2'] } })])).join()).toMatch(
      /\{ run, cases \}/,
    );
    const second = { run: '2', cases: ['a', 'b'] };
    for (const bad of [
      { run: 'latest', cases: ['a', 'b'] }, // not a numeric run id
      { run: '1' }, // no cases
      { run: '1', cases: [] }, // empty cases
    ])
      expect(errs(ledger([entry({ evidence: { fail: [bad, second] } })])).join()).toMatch(
        /\{ run, cases \}/,
      );
    const dup = {
      fail: [
        { run: '1', cases: ['a', 'b'] },
        { run: '1', cases: ['a', 'b'] },
      ],
    };
    expect(errs(ledger([entry({ evidence: dup })])).join()).toMatch(/duplicate evidence run/);
  });

  it('an unsupported entry needs at least two failing evidence runs', () => {
    const one = { fail: [{ run: '1', cases: ['a', 'b'] }] };
    expect(errs(ledger([entry({ evidence: one })])).join()).toMatch(/at least two failing runs/);
  });

  it('rejects snapshot GROWTH: every snapshot case must have failed in every recorded run', () => {
    // 'c' failed only in run 2 — adding it to the snapshot is growth the evidence does not cover
    const grown = errs(ledger([entry({ cases: ['a', 'b', 'c'] })])).join();
    expect(grown).toMatch(/not covered by evidence run 1/);
    expect(grown).toMatch(/c/);
    // a case no run ever failed
    expect(errs(ledger([entry({ cases: ['a', 'z'] })])).join()).toMatch(/not covered/);
    // shrinking stays allowed
    expect(errs(ledger([entry({ cases: ['a'] })]))).toEqual([]);
  });

  it('rejects an unknown lane or class, a duplicate test, and a corpus-excluded test', () => {
    expect(errs({ lane: 'node', entries: [entry()] }).join()).toMatch(/lane/);
    expect(errs(ledger([entry({ class: 'upstream-bug' })])).join()).toMatch(/class/);
    expect(errs(ledger([entry(), entry()])).join()).toMatch(/duplicate/);
    expect(errs(ledger([entry({ test: CORPUS_EXCLUDES[0] })])).join()).toMatch(/excluded/);
    expect(errs(ledger([entry({ test: 'fallback-shells' })])).join()).toMatch(/test path/);
  });

  it('rejects a malformed date', () => {
    expect(errs(ledger([entry({ expires: '24/10/2026' })])).join()).toMatch(/date/);
  });
});

const summary = (over: Record<string, unknown> = {}): Any => ({
  passed: 44,
  failed: 3,
  notRun: 0,
  excluded: 44,
  expectedTotal: 47,
  truncated: false,
  shard: '1/16',
  runtime: 'bun',
  builder: 'vinext',
  ref: 'v16.2.0',
  failures: [
    { file: SHELLS, kind: 'assertion', cases: ['a', 'b'] },
    { file: NAV, kind: 'assertion', cases: ['hash', 'other'] },
    { file: 'test/e2e/unrelated/x.test.ts', kind: 'timeout', cases: ['c'] },
  ],
  ...over,
});
const navEntry = (cases: string[]) =>
  entry({
    test: NAV,
    class: 'flaky',
    feature: undefined,
    upstream: undefined,
    cases,
    evidence: { fail: [{ run: '1', cases }], pass: ['2', '3'] },
    expires: '2026-10-08',
  });

// A full 16-shard run (EXPECTED_SHARD_TOTAL), all default-ref by default. Shard 1 carries the
// interesting failures/passes; the other 15 are plain clean shards.
const fullRun = (
  over: Record<string, unknown> = {},
  shardOver: Record<string, unknown> = {},
): Any[] => [
  summary({ shard: '1/16', ...shardOver, ...over }),
  ...Array.from({ length: 15 }, (_, i) =>
    summary({ shard: `${i + 2}/16`, failed: 0, failures: [], ...over }),
  ),
];

describe('applyLedger: case-level reclassification, never narrowing', () => {
  it('quarantines the snapshot cases and removes the file from failed when nothing else fails', () => {
    const out = applyLedger(summary(), [entry()]);
    expect(out.failed).toBe(2);
    expect(out.failures.map((f: Any) => f.file)).toEqual([NAV, 'test/e2e/unrelated/x.test.ts']);
    expect(out.quarantined).toEqual([
      {
        file: SHELLS,
        cases: ['a', 'b'],
        class: 'unsupported',
        upstream: 'https://github.com/cloudflare/vinext/issues/1359',
      },
    ]);
  });

  it('a NEW failing case in a ledgered file stays a real failure (never absorbed)', () => {
    const s = summary();
    s.failures[0].cases = ['a', 'b', 'new-regression'];
    const out = applyLedger(s, [entry()]);
    expect(out.failed).toBe(3);
    const shells = out.failures.find((f: Any) => f.file === SHELLS);
    expect(shells.cases).toEqual(['new-regression']);
    expect(out.quarantined[0].cases).toEqual(['a', 'b']);
  });

  it('only snapshot cases are quarantined; the file stays failed while other cases fail', () => {
    const out = applyLedger(summary(), [navEntry(['hash'])]);
    expect(out.failed).toBe(3);
    expect(out.failures.find((f: Any) => f.file === NAV).cases).toEqual(['other']);
    expect(out.quarantined[0].cases).toEqual(['hash']);
  });

  it('a file-level failure with no case detail is never quarantined', () => {
    const s = summary();
    s.failures[0] = { file: SHELLS, kind: 'unclassified', cases: [] };
    const out = applyLedger(s, [entry()]);
    expect(out.failed).toBe(3);
    expect(out.quarantined).toEqual([]);
  });

  it('fails CLOSED when failed > 0 but the per-file failures are missing (no-marker path)', () => {
    const s = summary({ failed: 3, failures: undefined });
    for (const entries of [[], [entry()]]) {
      const out = applyLedger(s, entries);
      expect(out.failed).toBe(3);
      expect(out.quarantined).toEqual([]);
      expect(out.ledgerSkipped).toMatch(/failed=3/);
    }
    const partial = applyLedger(summary({ failed: 5 }), [entry()]);
    expect(partial.failed).toBe(5);
    expect(partial.ledgerSkipped).toBeDefined();
  });

  it('derives failed from the summary count, never from the list', () => {
    const out = applyLedger(summary(), []);
    expect(out.failed).toBe(3);
    expect(out.ledgerSkipped).toBeUndefined();
  });

  it('never changes passed, notRun, excluded, expectedTotal or truncated (the denominator)', () => {
    const before = summary();
    const out = applyLedger(before, [entry(), navEntry(['hash'])]);
    for (const k of ['passed', 'notRun', 'excluded', 'expectedTotal', 'truncated', 'shard']) {
      expect(out[k], k).toEqual(before[k]);
    }
  });

  it('does not mutate its input and is idempotent', () => {
    const before = summary();
    const copy = JSON.parse(JSON.stringify(before));
    const once = applyLedger(before, [entry()]);
    expect(before).toEqual(copy);
    expect(applyLedger(once, [entry()])).toEqual(once);
  });
});

describe('staleEntries: a ledgered failure that stopped failing reds the run', () => {
  it('an entry whose snapshot cases all failed somewhere is not stale', () => {
    const shards = [
      applyLedger(summary(), [entry()]),
      applyLedger(summary({ failures: [], failed: 0 }), [entry()]),
    ];
    expect(staleEntries(shards, [entry()])).toEqual([]);
  });

  it('a PARTIAL fix (one snapshot case now passes) is stale', () => {
    const s = summary();
    s.failures[0].cases = ['a'];
    expect(staleEntries([applyLedger(s, [entry()])], [entry()])).toEqual([
      { test: SHELLS, cases: ['b'] },
    ]);
  });

  it('a full fix is stale', () => {
    const s = summary({ failed: 2 });
    s.failures = s.failures.slice(1);
    expect(staleEntries([applyLedger(s, [entry()])], [entry()])).toEqual([
      { test: SHELLS, cases: ['a', 'b'] },
    ]);
  });

  it('a FLAKY entry that passed this run is not stale (a pass is expected; its expiry bounds it)', () => {
    // NAV passes outright this run; navEntry is flaky, so that is not evidence
    // of a fix. An unsupported entry in the same position IS stale (above).
    const s = summary({ failed: 2 });
    s.failures = s.failures.filter((f: Any) => f.file !== NAV);
    const flaky = navEntry(['hash']);
    expect(staleEntries([applyLedger(s, [flaky])], [flaky])).toEqual([]);
    const unsupported = entry({ test: NAV, cases: ['hash'] });
    expect(staleEntries([applyLedger(s, [unsupported])], [unsupported])).toEqual([
      { test: NAV, cases: ['hash'] },
    ]);
  });

  it('not-run, no-case-detail and unreclassified shards never prove a pass', () => {
    const notRun = summary({ failed: 2, notRun: 1, notRunFiles: [SHELLS] });
    notRun.failures = notRun.failures.slice(1);
    expect(staleEntries([applyLedger(notRun, [entry()])], [entry()])).toEqual([]);
    const noDetail = summary();
    noDetail.failures[0] = { file: SHELLS, kind: 'unclassified', cases: [] };
    expect(staleEntries([applyLedger(noDetail, [entry()])], [entry()])).toEqual([]);
    const skipped = applyLedger(summary({ failures: undefined }), [entry()]);
    expect(staleEntries([skipped], [entry()])).toEqual([]);
  });
});

describe('publishedNumber: passed / failed / quarantined over the unchanged denominator', () => {
  it('sums shards and keeps the total equal to passed + failed + quarantined + notRun', () => {
    const a = applyLedger(summary(), [entry()]);
    const b = applyLedger(summary({ failures: [], failed: 0, passed: 47 }), [entry()]);
    expect(publishedNumber([a, b])).toEqual({
      passed: 91,
      failed: 2,
      quarantined: 1,
      notRun: 0,
      total: 94,
    });
  });
});

describe('refreshSnapshots: the snapshot is generated from evidence', () => {
  const REFRESHED = '2026-09-25';
  const run = (id: string, cases: string[] | null, over: Record<string, unknown> = {}) => ({
    id,
    summaries: [
      summary({
        failures: cases === null ? [] : [{ file: SHELLS, kind: 'assertion', cases }],
        failed: cases === null ? 0 : 1,
        ...over,
      }),
    ] as Any[],
  });
  const refresh = (l: Any, runs: Any[]) => refreshSnapshots(l, runs, REFRESHED);

  it('keeps the cases that failed in EVERY run, sorted, and writes the evidence it used', () => {
    const { ledger: next, errors } = refresh(ledger([entry({ cases: ['x'] })]), [
      run('11', ['b', 'a', 'flaky']),
      run('12', ['a', 'b']),
    ]);
    expect(errors).toEqual([]);
    const e = next.entries[0];
    expect(e.cases).toEqual(['a', 'b']);
    expect(e.evidence.fail).toEqual([
      { run: '11', cases: ['a', 'b', 'flaky'] },
      { run: '12', cases: ['a', 'b'] },
    ]);
    expect(e.refreshed).toBe(REFRESHED);
    expect(e.added).toBe('2026-09-24'); // the expiry window's anchor is not moved by a refresh
    expect(errs(next)).toEqual([]);
  });

  it('a run where the file PASSED contributes the empty set: a regression is never laundered in', () => {
    // run A fails an old case plus a NEW regression; run B passes the file outright
    const { ledger: next, errors } = refresh(ledger([entry()]), [
      run('21', ['old', 'REGRESSION']),
      run('22', null),
    ]);
    expect(errors.join()).toMatch(/passed in run 22/);
    expect(next.entries[0].cases).toEqual(entry().cases); // nothing written for it
    expect(next.entries[0].cases).not.toContain('REGRESSION');
  });

  it('refuses a single run, and a run id given twice', () => {
    expect(refresh(ledger([entry()]), [run('31', ['a'])]).errors.join()).toMatch(
      /at least two runs/,
    );
    expect(refresh(ledger([entry()]), [run('31', ['a']), run('31', ['a'])]).errors.join()).toMatch(
      /at least two runs/,
    );
  });

  it('skips a run where the file did not run or failed with no case detail — and then needs two others', () => {
    const noDetail = {
      id: '43',
      summaries: [
        summary({ failures: [{ file: SHELLS, kind: 'unclassified', cases: [] }], failed: 1 }),
      ] as Any[],
    };
    const notRun = run('44', null, { notRunFiles: [SHELLS], notRun: 1 });
    const ok = refresh(ledger([entry()]), [
      run('41', ['a']),
      run('42', ['a', 'b']),
      noDetail,
      notRun,
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.ledger.entries[0].cases).toEqual(['a']);
    expect(ok.ledger.entries[0].evidence.fail.map((r: Any) => r.run)).toEqual(['41', '42']);
    expect(refresh(ledger([entry()]), [run('41', ['a']), noDetail, notRun]).errors.join()).toMatch(
      /at least two failing runs/,
    );
  });

  it('refuses an entry whose runs share no failing case', () => {
    expect(refresh(ledger([entry()]), [run('51', ['a']), run('52', ['b'])]).errors.join()).toMatch(
      /every run/,
    );
  });

  it('a flaky entry: passing runs become evidence.pass, the snapshot is the failing runs’ common cases', () => {
    const flaky = navEntry(['hash']);
    const nav = (id: string, cases: string[] | null) => ({
      id,
      summaries: [
        summary({
          failures: cases === null ? [] : [{ file: NAV, kind: 'assertion', cases }],
          failed: cases === null ? 0 : 1,
        }),
      ] as Any[],
    });
    const { ledger: next, errors } = refresh(ledger([flaky]), [
      nav('61', ['hash']),
      nav('62', null),
      nav('63', null),
    ]);
    expect(errors).toEqual([]);
    expect(next.entries[0].evidence).toEqual({
      fail: [{ run: '61', cases: ['hash'] }],
      pass: ['62', '63'],
    });
    const short = refresh(ledger([flaky]), [nav('61', ['hash']), nav('62', null)]);
    expect(short.errors.join()).toMatch(/at least three/);
  });
});

describe('flakyWindow: a flaky entry is judged over the last three runs', () => {
  const failRun = () => [applyLedger(summary(), [navEntry(['hash'])])];
  const passRun = () => {
    const s = summary({ failed: 2 });
    s.failures = s.failures.filter((f: Any) => f.file !== NAV);
    return [s];
  };
  const flaky = navEntry(['hash']);

  it('three failures in a row is broken, not flaky', () => {
    const v = flakyWindow([flaky], [failRun(), failRun(), failRun()]);
    expect(v.broken).toEqual([{ test: NAV, runs: 3 }]);
    expect(v.stale).toEqual([]);
  });

  it('three passes in a row is stale', () => {
    const v = flakyWindow([flaky], [passRun(), passRun(), passRun()]);
    expect(v.stale).toEqual([{ test: NAV, runs: 3 }]);
    expect(v.broken).toEqual([]);
  });

  it('a mixed window is neither; only the LAST three informative runs count', () => {
    expect(flakyWindow([flaky], [failRun(), passRun(), failRun()])).toEqual({
      broken: [],
      stale: [],
    });
  });

  it('fewer than three informative runs gives no verdict', () => {
    expect(flakyWindow([flaky], [failRun(), failRun()])).toEqual({ broken: [], stale: [] });
  });

  it('ignores unsupported entries (their stale rule is per run)', () => {
    const unsupported = entry({ test: NAV, cases: ['hash'] });
    expect(flakyWindow([unsupported], [failRun(), failRun(), failRun()])).toEqual({
      broken: [],
      stale: [],
    });
  });
});

describe('isCompleteDefaultRun: a run is informative only complete and on the default ref', () => {
  it('accepts a full 16-shard default-ref run', () => {
    expect(isCompleteDefaultRun(fullRun())).toBe(true);
  });

  it('rejects a run missing a shard (never counted as a pass)', () => {
    expect(isCompleteDefaultRun(fullRun().slice(0, 15))).toBe(false);
  });

  it('rejects a custom-ref run', () => {
    expect(isCompleteDefaultRun(fullRun({ ref: 'v16.3.0-canary' }))).toBe(false);
  });

  it('rejects an artifactless run (no summaries)', () => {
    expect(isCompleteDefaultRun([])).toBe(false);
  });

  it('EXPECTED_SHARD_TOTAL matches the lane shard count', () => {
    expect(EXPECTED_SHARD_TOTAL).toBe(16);
  });

  it('DEFAULT_NEXTJS_REF matches the fixture summaries’ ref field', () => {
    expect(DEFAULT_NEXTJS_REF).toBe(summary().ref);
  });
});

describe('isAuthOrApiError: distinguishes gh auth/API failures from other errors', () => {
  it('recognizes common gh auth/API failure text', () => {
    for (const msg of [
      'HTTP 401: Bad credentials',
      'HTTP 403: rate limit exceeded',
      'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN',
      'HTTP 500: Internal Server Error',
    ])
      expect(isAuthOrApiError(new Error(msg))).toBe(true);
  });

  it('does not treat an ordinary error as an auth/API error', () => {
    expect(isAuthOrApiError(new Error('ENOENT: no such file or directory'))).toBe(false);
  });
});

describe('collectHistory: backfill past uninformative runs, fail closed on repeated auth errors', () => {
  const candidate = (id: string, status = 'completed') => ({ id, status });

  it('backfills past a cancelled, artifactless, and custom-ref run to reach `want`', () => {
    const list = () => [
      candidate('10', 'cancelled'), // uninformative: not completed — must not even be fetched
      candidate('9'), // artifactless: empty summaries
      candidate('8'), // custom ref
      candidate('7'), // good
      candidate('6'), // good
    ];
    const fetchSummaries = (id: string) => {
      if (id === '10') throw new Error('a cancelled run must never be fetched');
      if (id === '9') return [];
      if (id === '8') return fullRun({ ref: 'v16.3.0-canary' });
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    const { history, warnings } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '11', want: 2 },
    );
    expect(history.length).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('a run missing shards is treated the same as artifactless: uninformative, backfilled', () => {
    const list = () => [candidate('10'), candidate('9')];
    const fetchSummaries = (id: string) =>
      id === '10' ? fullRun().slice(0, 10) : fullRun({ shard: '1/16', failed: 0, failures: [] });
    const { history } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '11', want: 1 },
    );
    expect(history.length).toBe(1);
  });

  it('an auth/API error fetching one run is a warning and that run is skipped', () => {
    const list = () => [candidate('10'), candidate('9')];
    const fetchSummaries = (id: string) => {
      if (id === '10') throw new Error('HTTP 401: Bad credentials');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    const { history, warnings } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '11', want: 1 },
    );
    expect(history.length).toBe(1);
    expect(warnings.join()).toMatch(/run 10.*401/);
  });

  it(`fails CLOSED after ${MAX_CONSECUTIVE_HISTORY_SKIPS} consecutive auth/API errors, not silently narrowing`, () => {
    const list = () => Array.from({ length: 10 }, (_, i) => candidate(String(10 - i)));
    const fetchSummaries = () => {
      throw new Error('HTTP 403: rate limit exceeded');
    };
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 2 }),
    ).toThrow(/consecutive/);
  });

  it('a non-auth error is never swallowed', () => {
    const list = () => [candidate('10')];
    const fetchSummaries = () => {
      throw new Error('unexpected: JSON.parse failed');
    };
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 1 }),
    ).toThrow(/unexpected/);
  });

  it('a successful step resets the consecutive counter, so alternating skips never fail closed', () => {
    // skip, SUCCESS (resets), skip, skip: 3 skip EVENTS total, but never 3 IN A ROW.
    // Without the reset, this sequence would wrongly hit the threshold and throw.
    const list = () => [
      candidate('13'),
      candidate('12'),
      candidate('11'),
      candidate('10'),
      candidate('9'),
    ];
    const fetchSummaries = (id: string) => {
      if (id === '13' || id === '11' || id === '10') throw new Error('HTTP 401: Bad credentials');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    const { history, warnings } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '14', want: 10 }, // > candidates, so the walk never breaks early
    );
    expect(history.length).toBe(2);
    expect(warnings.length).toBe(3);
  });

  it('WITHOUT the reset (proof the above test is discriminating): 3 skips with one success between them would still throw if the reset were missing', () => {
    // This is the same fixture as above but demonstrates why the reset test
    // matters: a naive re-implementation without `budget.reset()` throws
    // here. We assert the mutation-provable anchor exists and is exercised,
    // not the buggy behaviour itself (that would defeat the point).
    let sawReset = false;
    const list = () => [candidate('13'), candidate('12'), candidate('11')];
    const fetchSummaries = (id: string) => {
      if (id === '12') sawReset = true; // the success in the middle
      if (id === '13' || id === '11') throw new Error('HTTP 401: Bad credentials');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '14', want: 5 }),
    ).not.toThrow();
    expect(sawReset).toBe(true);
  });

  it('a listing auth/API failure is FATAL, not a soft skip — there is nothing to fall back to (#1363 round-3 finding 2)', () => {
    const list = () => {
      throw new Error('HTTP 401: Bad credentials');
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    // collectHistory is only ever called when there's a flaky entry to judge,
    // so a listing failure means the window CANNOT be judged at all — this
    // must throw (reddening the run), never warn-and-exit-0. A prior version
    // treated this as one soft skip with zero candidates, so it could never
    // reach the 3-consecutive threshold and every such run silently passed.
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 1 }),
    ).toThrow(/could not list[\s\S]*401/);
  });

  // #1400 review — every listing-error fixture below uses a REALISTIC `gh`
  // stderr string (the shape `gh` actually prints, "Command failed: gh run
  // list ... HTTP <code>: <reason>"), never a raw Node network-error string
  // like `ECONNRESET`/`ENOTFOUND` — `gh` wraps those in its own wording
  // before they ever reach this script, so testing against the RAW Node
  // shape proves nothing about what classifyListingError actually has to
  // parse in production.
  const GH_502 =
    'Command failed: gh run list --workflow compat-vinext.yml --branch main --repo o/r --limit 46 --json databaseId,status,createdAt\nHTTP 502: Bad Gateway (https://api.github.com/repos/o/r/actions/workflows/compat-vinext.yml/runs)';
  const GH_DNS =
    'Command failed: gh run list --workflow compat-vinext.yml --branch main --repo o/r --limit 46 --json databaseId,status,createdAt\nGet "https://api.github.com/repos/o/r/actions/workflows/compat-vinext.yml/runs": dial tcp: lookup api.github.com: could not resolve host';
  const GH_401 =
    'Command failed: gh run list --workflow compat-vinext.yml --branch main --repo o/r --limit 46 --json databaseId,status,createdAt\nHTTP 401: Bad credentials (https://api.github.com/repos/o/r/actions/workflows/compat-vinext.yml/runs)';
  const GH_403_PERMISSION =
    'Command failed: gh run list --workflow compat-vinext.yml --branch main --repo o/r --limit 46 --json databaseId,status,createdAt\nHTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/actions/workflows/compat-vinext.yml/runs)';
  const GH_403_RATE_LIMIT =
    'Command failed: gh run list --workflow compat-vinext.yml --branch main --repo o/r --limit 46 --json databaseId,status,createdAt\nHTTP 403: API rate limit exceeded for installation ID 123456. (https://api.github.com/repos/o/r/actions/workflows/compat-vinext.yml/runs)';
  const GH_JSON_PARSE = 'unexpected: JSON.parse failed on gh run list output';

  it("classifyListingError: 'fatal' for 401, a plain 403, and 'authenticat...' wording — never retried (#1400)", () => {
    expect(classifyListingError(new Error(GH_401))).toBe('fatal');
    expect(classifyListingError(new Error(GH_403_PERMISSION))).toBe('fatal');
    expect(classifyListingError(new Error('gh: authentication required'))).toBe('fatal');
  });

  it("classifyListingError: 'retryable' for 5xx, 429, a RATE-LIMIT 403, DNS, connection reset, timeout (#1400)", () => {
    expect(classifyListingError(new Error(GH_502))).toBe('retryable');
    expect(classifyListingError(new Error('HTTP 429: too many requests'))).toBe('retryable');
    expect(classifyListingError(new Error(GH_403_RATE_LIMIT))).toBe('retryable');
    expect(classifyListingError(new Error(GH_DNS))).toBe('retryable');
    expect(classifyListingError(new Error('read: connection reset by peer'))).toBe('retryable');
    expect(classifyListingError(new Error('context deadline exceeded (Client.Timeout)'))).toBe(
      'retryable',
    );
  });

  it("classifyListingError: 'local' for a JSON parse failure — not an HTTP/network shape at all (#1400)", () => {
    expect(classifyListingError(new Error(GH_JSON_PARSE))).toBe('local');
  });

  it('retryAfterMs: parses a Retry-After hint from the error text when gh surfaces one, else null (#1400)', () => {
    expect(retryAfterMs('secondary rate limit hit. retry after: 30')).toBe(30_000);
    expect(retryAfterMs('Retry-After 12')).toBe(12_000);
    expect(retryAfterMs(GH_502)).toBeNull();
  });

  it('a LOCAL listing error (JSON parse failure) is never swallowed and NEVER retried — distinct from a retryable one (#1400)', () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      throw new Error(GH_JSON_PARSE);
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    const sleeps: number[] = [];
    // sleep: (ms) => sleeps.push(ms) — asserted empty below: a local/
    // deterministic failure must not cost a single backoff wait.
    expect(() =>
      collectHistory(
        { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
        { repo: 'o/r', currentRunId: '11', want: 1 },
      ),
    ).toThrow(/does not look like a transient API\/network error/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it(`a persisting RETRYABLE listing error (HTTP 502) is retried exactly ${LISTING_RETRY_ATTEMPTS} times total (${LISTING_RETRY_ATTEMPTS - 1} retries) before failing closed, and the failure message says so (#1365/#1400)`, () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      throw new Error(GH_502);
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    const sleeps: number[] = [];
    expect(() =>
      collectHistory(
        { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
        { repo: 'o/r', currentRunId: '11', want: 1 },
      ),
    ).toThrow(new RegExp(`after ${LISTING_RETRY_ATTEMPTS} attempts[\\s\\S]*HTTP 502`));
    expect(calls).toBe(LISTING_RETRY_ATTEMPTS);
    // Exponential backoff: base, 2x base, 4x base, ... — one sleep between
    // each pair of attempts, so ATTEMPTS-1 sleeps total, never one PER
    // attempt (that would sleep needlessly after the last, doomed attempt).
    expect(sleeps).toHaveLength(LISTING_RETRY_ATTEMPTS - 1);
    expect(sleeps).toEqual(
      Array.from({ length: LISTING_RETRY_ATTEMPTS - 1 }, (_, i) => LISTING_RETRY_BASE_MS * 2 ** i),
    );
  });

  it('a RETRYABLE listing error (DNS) that clears on the SECOND attempt succeeds — the retry is what makes this NOT red (#1365/#1400)', () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      if (calls === 1) throw new Error(GH_DNS);
      return [candidate('10'), candidate('9')];
    };
    const fetchSummaries = (id: string) =>
      fullRun({
        shard: '1/16',
        failed: id === '10' ? 1 : 0,
        failures: id === '10' ? ['a.spec.ts'] : [],
      });
    const sleeps: number[] = [];
    const { history, warnings } = collectHistory(
      { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
      { repo: 'o/r', currentRunId: '11', want: 2 },
    );
    expect(calls).toBe(2);
    expect(sleeps).toEqual([LISTING_RETRY_BASE_MS]);
    expect(history).toHaveLength(2);
    // The blip is visible in warnings — a run that limped through a flaky
    // network window must not read identically to a clean first-try run
    // (the same discipline this repo's other retry-with-backoff guards use).
    expect(
      warnings.some((w) => /attempt 1[\s\S]*could not resolve host[\s\S]*retrying/.test(w)),
    ).toBe(true);
  });

  it('a RETRY-AFTER hint (a rate-limited 403 with a numeric wait) is honoured in PREFERENCE to the exponential backoff (#1400)', () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(`${GH_403_RATE_LIMIT}\nsecondary rate limit hit. retry after: 7 seconds`);
      }
      return [candidate('10')];
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    const sleeps: number[] = [];
    collectHistory(
      { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
      { repo: 'o/r', currentRunId: '11', want: 1 },
    );
    // 7s from the hint, NOT LISTING_RETRY_BASE_MS from the exponential default.
    expect(sleeps).toEqual([7_000]);
  });

  it('a FATAL listing error (401) is NEVER retried — fails closed on the very first attempt (#1365/#1400)', () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      throw new Error(GH_401);
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    const sleeps: number[] = [];
    expect(() =>
      collectHistory(
        { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
        { repo: 'o/r', currentRunId: '11', want: 1 },
      ),
    ).toThrow(/could not list[\s\S]*401/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('a FATAL listing error (plain permission 403, not rate-limited) is NEVER retried (#1400)', () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      throw new Error(GH_403_PERMISSION);
    };
    const fetchSummaries = () => fullRun({ shard: '1/16', failed: 0, failures: [] });
    const sleeps: number[] = [];
    expect(() =>
      collectHistory(
        { list, fetchSummaries, sleep: (ms) => sleeps.push(ms) },
        { repo: 'o/r', currentRunId: '11', want: 1 },
      ),
    ).toThrow(/could not list[\s\S]*403/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('a "no artifact" failure downloading a run is NOT an auth/API error: skipped, not warned, not a fail-closed contributor', () => {
    const list = () => [candidate('10'), candidate('9')];
    const fetchSummaries = (id: string) => {
      if (id === '10')
        throw new Error(
          'Command failed: gh run download 10 --repo o/r --pattern compat-vinext-summary-* --dir /tmp/x\nno artifact matches any of the names or patterns provided',
        );
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    const { history, warnings } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '11', want: 1 },
    );
    expect(history.length).toBe(1);
    expect(warnings).toEqual([]); // no-artifact is silent backfill, not a warning-worthy skip
  });

  it(`a run of ${MAX_CONSECUTIVE_HISTORY_SKIPS} consecutive "no artifact" failures does NOT fail closed (they are not skips at all)`, () => {
    const list = () => Array.from({ length: 10 }, (_, i) => candidate(String(10 - i)));
    const fetchSummaries = (id: string) => {
      if (Number(id) > 5)
        throw new Error('no artifact matches any of the names or patterns provided');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 1 }),
    ).not.toThrow();
  });

  it('a "no artifact" skip resets a PRIOR auth-error streak too, not just its own', () => {
    // skip(auth,1), skip(auth,2), no-artifact (must reset to 0), skip(auth,1):
    // only reaches 1 if the no-artifact skip resets the streak. Without that
    // reset, the streak would be 3 and this would throw.
    const list = () => [
      candidate('13'),
      candidate('12'),
      candidate('11'),
      candidate('10'),
      candidate('9'),
    ];
    const fetchSummaries = (id: string) => {
      if (id === '13' || id === '12' || id === '10') throw new Error('HTTP 401: Bad credentials');
      if (id === '11') throw new Error('no artifact matches any of the names or patterns provided');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    expect(() =>
      collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '14', want: 1 }),
    ).not.toThrow();
  });

  it('`since` excludes history runs created before it (a run cannot be evidence for an entry that did not exist yet)', () => {
    const list = () => [
      { id: '10', status: 'completed', createdAt: '2026-09-01T00:00:00Z' }, // too old
      { id: '9', status: 'completed', createdAt: '2026-09-20T00:00:00Z' }, // ok
    ];
    const fetchSummaries = (id: string) => {
      if (id === '10') throw new Error('must never be fetched: predates `since`');
      return fullRun({ shard: '1/16', failed: 0, failures: [] });
    };
    const { history } = collectHistory(
      { list, fetchSummaries },
      { repo: 'o/r', currentRunId: '11', want: 1, since: '2026-09-10T00:00:00Z' },
    );
    expect(history.length).toBe(1);
  });
});

describe('isNoArtifactError: distinguishes "nothing to see here" from a real gh failure', () => {
  it('recognizes the real gh CLI message for a missing/expired artifact', () => {
    expect(
      isNoArtifactError(
        new Error(
          'Command failed: gh run download 10 --repo o/r --pattern compat-vinext-summary-* --dir /tmp/x\nno artifact matches any of the names or patterns provided',
        ),
      ),
    ).toBe(true);
  });

  it('recognizes the SECOND real gh CLI message (a 0-artifact run, live from gh run download 33965643199)', () => {
    expect(
      isNoArtifactError(
        new Error(
          'Command failed: gh run download 33965643199 --repo o/r --pattern compat-vinext-summary-* --dir /tmp/x\nno valid artifacts found to download',
        ),
      ),
    ).toBe(true);
  });

  it('catches an unseen-but-same-shaped variant, not just the two literal strings (whack-a-mole resistance)', () => {
    expect(isNoArtifactError(new Error('no artifacts available for download'))).toBe(true);
  });

  it('does not treat an auth/API error as a no-artifact error', () => {
    expect(isNoArtifactError(new Error('HTTP 401: Bad credentials'))).toBe(false);
  });

  it('a no-artifact message is never ALSO classified as an auth/API error', () => {
    const msg =
      'Command failed: gh run download 10 --repo o/r --pattern compat-vinext-summary-* --dir /tmp/x\nno artifact matches any of the names or patterns provided';
    expect(isNoArtifactError(new Error(msg))).toBe(true);
    expect(isAuthOrApiError(new Error(msg))).toBe(false);
  });
});

describe('downloadRun against a REAL gh failure (a fake gh binary, not a mocked return value)', () => {
  // #1355 round-2 finding 1: the bug was in how the string thrown by a REAL
  // `gh run download` failure gets classified, not in any mocked stand-in for
  // it. This drives the real `downloadRun` + `readSummaries` through a fake
  // `gh` EXECUTABLE that reproduces gh's actual exit code and stderr text.
  const fakeGh = (behavior: 'no-artifact' | 'no-valid-artifact' | 'ok') => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-fake-gh-'));
    const script = join(dir, 'gh');
    const body =
      behavior === 'no-artifact'
        ? '#!/bin/sh\necho "no artifact matches any of the names or patterns provided" 1>&2\nexit 1\n'
        : behavior === 'no-valid-artifact'
          ? '#!/bin/sh\necho "no valid artifacts found to download" 1>&2\nexit 1\n'
          : '#!/bin/sh\n# args: run download <id> --repo <r> --pattern <p> --dir <dir> ($9)\nmkdir -p "$9"\necho "{}" > "$9/compat-suite-summary-1.json"\nexit 0\n';
    writeFileSync(script, body);
    chmodSync(script, 0o755);
    return { dir, script };
  };
  const realExec = (bin: string) => (args: string[]) =>
    execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('a real "no artifact" gh failure is classified by isNoArtifactError, not swallowed as a generic throw', () => {
    const { dir, script } = fakeGh('no-artifact');
    const outDir = join(dir, 'out');
    try {
      let threw: unknown;
      try {
        downloadRun(realExec(script), { repo: 'o/r', runId: '999', dir: outDir });
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeDefined();
      expect(isNoArtifactError(threw)).toBe(true);
      expect(isAuthOrApiError(threw)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the SECOND real "no valid artifacts found to download" gh failure (a 0-artifact run) is also classified, not swallowed', () => {
    const { dir, script } = fakeGh('no-valid-artifact');
    const outDir = join(dir, 'out');
    try {
      let threw: unknown;
      try {
        downloadRun(realExec(script), { repo: 'o/r', runId: '33965643199', dir: outDir });
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeDefined();
      expect(isNoArtifactError(threw)).toBe(true);
      expect(isAuthOrApiError(threw)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collectHistory, wired to the REAL downloadRun + readSummaries, backfills past a real "no valid artifacts" run too', () => {
    const { dir: noValidDir, script: noValidScript } = fakeGh('no-valid-artifact');
    const { dir: okDir, script: okScript } = fakeGh('ok');
    try {
      const list = () => [
        { id: '10', status: 'completed' }, // 0-artifact run: the SECOND gh wording
        { id: '9', status: 'completed' },
      ];
      const fetchSummaries = (id: string) => {
        const outDir = mkdtempSync(join(tmpdir(), 'knext-fake-gh-run-'));
        dynamicTempDirs.push(outDir);
        const script = id === '10' ? noValidScript : okScript;
        downloadRun(realExec(script), { repo: 'o/r', runId: id, dir: outDir });
        return readSummaries(outDir);
      };
      expect(() =>
        collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 1 }),
      ).not.toThrow();
    } finally {
      rmSync(noValidDir, { recursive: true, force: true });
      rmSync(okDir, { recursive: true, force: true });
    }
  });

  it('collectHistory, wired to the REAL downloadRun + readSummaries, backfills past a real "no artifact" run', () => {
    const { dir: noArtifactDir, script: noArtifactScript } = fakeGh('no-artifact');
    const { dir: okDir, script: okScript } = fakeGh('ok');
    try {
      const list = () => [
        { id: '10', status: 'completed' }, // will hit the real no-artifact gh
        { id: '9', status: 'completed' }, // will hit the real ok gh
      ];
      const fetchSummaries = (id: string) => {
        const outDir = mkdtempSync(join(tmpdir(), 'knext-fake-gh-run-'));
        dynamicTempDirs.push(outDir);
        const script = id === '10' ? noArtifactScript : okScript;
        downloadRun(realExec(script), { repo: 'o/r', runId: id, dir: outDir });
        return readSummaries(outDir);
      };
      // The 'ok' script writes `{}`, which is not a full/complete default run
      // (isCompleteDefaultRun rejects it), so `want` stays unmet — the point
      // here is that collectHistory does NOT throw on the real no-artifact run.
      expect(() =>
        collectHistory({ list, fetchSummaries }, { repo: 'o/r', currentRunId: '11', want: 1 }),
      ).not.toThrow();
    } finally {
      rmSync(noArtifactDir, { recursive: true, force: true });
      rmSync(okDir, { recursive: true, force: true });
    }
  });
});

describe('flakyHistory: end-to-end CLI glue against a REAL gh on PATH (#1355 round-2 finding 3)', () => {
  // `gh` is invoked internally via `execFileSync('gh', …)`, not injected, so
  // proving the `since` filter is actually wired from the ledger's flaky
  // entries through to `collectHistory` needs a real `gh` on PATH, not a
  // re-implementation of flakyHistory's internals.
  it('never downloads a candidate created before the oldest flaky entry’s refreshed/added date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-fake-gh-path-'));
    const log = join(dir, 'calls.log');
    const script = join(dir, 'gh');
    // run list -> two candidates: one BEFORE `since` (2026-09-01), one AFTER
    // (2026-09-20). run download -> logs the run id it was asked for, then
    // fails with "no artifact" (cheapest way to make every download a no-op
    // that still proves whether it was ATTEMPTED at all).
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `echo "$@" >> "${log}"`,
        'if [ "$1" = "run" ] && [ "$2" = "list" ]; then',
        '  echo \'[{"databaseId":20,"status":"completed","createdAt":"2026-09-20T00:00:00Z"},{"databaseId":10,"status":"completed","createdAt":"2026-09-01T00:00:00Z"}]\'',
        '  exit 0',
        'fi',
        'if [ "$1" = "run" ] && [ "$2" = "download" ]; then',
        '  echo "no artifact matches any of the names or patterns provided" 1>&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const oldPath = process.env.PATH;
    const oldRepo = process.env.GITHUB_REPOSITORY;
    const oldRunId = process.env.GITHUB_RUN_ID;
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.GITHUB_REPOSITORY = 'o/r';
    process.env.GITHUB_RUN_ID = '999';
    try {
      const flaky = navEntry(['hash']);
      flaky.added = '2026-09-15'; // since = 2026-09-15T00:00:00Z: run 10 predates it, run 20 doesn't
      flaky.refreshed = undefined;
      const argv = ['report', '--ledger', LEDGER_PATH, '--summaries', 'x', '--history-runs', '3'];
      flakyHistory(argv, ledger([flaky]), [summary({ failed: 0, failures: [] })]);
      const log_contents = readFileSync(log, 'utf8');
      expect(log_contents).toMatch(/run download 20/);
      expect(log_contents).not.toMatch(/run download 10\b/);
    } finally {
      process.env.PATH = oldPath;
      if (oldRepo === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = oldRepo;
      if (oldRunId === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = oldRunId;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('previousRunCandidates / downloadRun: raw gh glue for the flaky window history', () => {
  it('lists this workflow’s runs on main, excluding the current run, any status, WITH createdAt (for the `since` date filter)', () => {
    const calls: string[][] = [];
    const exec = (a: string[]) => {
      calls.push(a);
      return JSON.stringify([
        { databaseId: 30, status: 'completed', createdAt: '2026-09-24T00:00:00Z' },
        { databaseId: 29, status: 'cancelled', createdAt: '2026-09-23T00:00:00Z' },
        { databaseId: 28, status: 'completed', createdAt: '2026-09-22T00:00:00Z' },
      ]);
    };
    expect(previousRunCandidates(exec, { repo: 'o/r', currentRunId: '30', limit: 5 })).toEqual([
      { id: '29', status: 'cancelled', createdAt: '2026-09-23T00:00:00Z' },
      { id: '28', status: 'completed', createdAt: '2026-09-22T00:00:00Z' },
    ]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['run', 'list', '--workflow', 'compat-vinext.yml']),
    );
    expect(calls[0]).toEqual(expect.arrayContaining(['--branch', 'main', '--repo', 'o/r']));
    expect(calls[0]).toContain('databaseId,status,createdAt');
  });

  it('downloads only the lane’s shard summaries for a run', () => {
    const calls: string[][] = [];
    downloadRun(
      (a: string[]) => {
        calls.push(a);
        return '';
      },
      { repo: 'o/r', runId: '28', dir: '/tmp/x' },
    );
    expect(calls[0]).toEqual([
      'run',
      'download',
      '28',
      '--repo',
      'o/r',
      '--pattern',
      'compat-vinext-summary-*',
      '--dir',
      '/tmp/x',
    ]);
  });
});

describe('verifyEvidence: every entry re-derives from the branch/workflow/ref/shard-checked runs it lists', () => {
  const vinextRun = (over: Record<string, unknown> = {}) => fullRun(over);
  const meta = (over: Record<string, unknown> = {}) => ({
    headBranch: 'main',
    path: WORKFLOW,
    ...over,
  });
  const RUNS: Record<string, Any> = {
    '101': {
      meta: meta(),
      summaries: vinextRun({
        failures: [{ file: SHELLS, kind: 'assertion', cases: ['a', 'b', 'c'] }],
      }),
    },
    '102': {
      meta: meta(),
      summaries: vinextRun({ failures: [{ file: SHELLS, kind: 'assertion', cases: ['a', 'b'] }] }),
    },
    '103': { meta: meta(), summaries: vinextRun({ failed: 0, failures: [] }) },
    '104': {
      meta: meta(),
      summaries: vinextRun({ failures: [{ file: NAV, kind: 'timeout', cases: ['hash'] }] }),
    },
    '105': { meta: meta(), summaries: vinextRun({ failed: 0, failures: [] }) },
    '106': { meta: meta(), summaries: vinextRun({ failed: 0, failures: [] }) },
    '107': {
      meta: meta({ path: '.github/workflows/test-e2e-deploy.yml' }),
      summaries: vinextRun({ failures: [{ file: NAV, kind: 'timeout', cases: ['hash'] }] }),
    },
    '108': {
      meta: meta({ headBranch: 'feature/x' }),
      summaries: vinextRun({ failures: [{ file: NAV, kind: 'timeout', cases: ['hash'] }] }),
    },
    '109': { meta: meta(), summaries: vinextRun().slice(0, 15) }, // missing a shard
    '110': { meta: meta(), summaries: vinextRun({ ref: 'v16.3.0-canary' }) }, // custom ref
  };
  const fetchRun = (id: string) => {
    if (!RUNS[id]) throw new Error(`run ${id} not found`);
    return RUNS[id];
  };
  const shells = entry({
    evidence: {
      fail: [
        { run: '101', cases: ['a', 'b', 'c'] },
        { run: '102', cases: ['a', 'b'] },
      ],
    },
  });
  const nav = navEntry(['hash']);
  nav.evidence = { fail: [{ run: '104', cases: ['hash'] }], pass: ['105', '106'] };

  it('a ledger generated by refresh from its listed runs verifies clean', () => {
    expect(verifyEvidence(ledger([shells, nav]), fetchRun)).toEqual([]);
  });

  it('an unsupported entry relabelled flaky with an INVENTED pass run is caught', () => {
    const relabel = {
      ...shells,
      class: 'flaky',
      evidence: { fail: shells.evidence.fail, pass: ['999'] },
    };
    expect(verifyEvidence(ledger([relabel]), fetchRun).join()).toMatch(/999/);
  });

  it('relabelled flaky citing a REAL run where the file failed as a pass is caught', () => {
    const relabel = {
      ...shells,
      class: 'flaky',
      evidence: { fail: [shells.evidence.fail[0]], pass: ['102', '103'] },
    };
    expect(verifyEvidence(ledger([relabel]), fetchRun).join()).toMatch(/does not match/);
  });

  it('a hand-edited snapshot or evidence list is caught', () => {
    expect(verifyEvidence(ledger([{ ...shells, cases: ['a'] }]), fetchRun).join()).toMatch(
      /does not match/,
    );
  });

  it('fetches each run once even when several entries cite it', () => {
    const seen: string[] = [];
    const counting = (id: string) => {
      seen.push(id);
      return fetchRun(id);
    };
    const shells2 = { ...shells, test: 'test/e2e/other/other.test.ts' };
    verifyEvidence(ledger([shells, shells2]), counting);
    expect(seen.sort()).toEqual(['101', '102']);
  });

  it('a run from a different workflow path cannot be cited', () => {
    const other = navEntry(['hash']);
    other.evidence = { fail: [{ run: '107', cases: ['hash'] }], pass: ['105', '106'] };
    expect(verifyEvidence(ledger([other]), fetchRun).join()).toMatch(/not a .*run \(path=/);
  });

  it('a run whose head_branch is not main cannot be cited', () => {
    const other = navEntry(['hash']);
    other.evidence = { fail: [{ run: '108', cases: ['hash'] }], pass: ['105', '106'] };
    expect(verifyEvidence(ledger([other]), fetchRun).join()).toMatch(/not on main/);
  });

  it('a run missing a shard cannot be cited — a missing shard is never a pass', () => {
    const other = navEntry(['hash']);
    other.evidence = { fail: [{ run: '104', cases: ['hash'] }], pass: ['109', '106'] };
    expect(verifyEvidence(ledger([other]), fetchRun).join()).toMatch(/missing shard summaries/);
  });

  it('a custom-ref run cannot be cited', () => {
    const other = navEntry(['hash']);
    other.evidence = { fail: [{ run: '104', cases: ['hash'] }], pass: ['110', '106'] };
    expect(verifyEvidence(ledger([other]), fetchRun).join()).toMatch(/default nextjsRef/);
  });
});

describe('report repeats every skipped-shard warning', () => {
  it('lists each shard whose reclassification was skipped', () => {
    const skipped = applyLedger(summary({ shard: '3/16', failures: undefined }), []);
    expect(skippedWarnings([summary(), skipped])).toEqual([`shard 3/16: ${skipped.ledgerSkipped}`]);
  });
});

describe('quarantined results persist in the shared per-night run ledger', () => {
  it('buildLedger keeps each shard’s quarantined list, and renderTable shows it', () => {
    const applied = applyLedger(summary({ shard: '1/1' }), [entry()]);
    const { ledger: run } = buildLedger({ shards: [applied], shardTotal: 1 });
    expect(run.shards[0].quarantined).toEqual(applied.quarantined);
    const table = renderTable(run);
    expect(table).toContain('quarantined');
    expect(table).toContain(SHELLS);
  });

  it('a lane without a quarantine ledger renders exactly as before (no quarantined section)', () => {
    const plain = summary({ shard: '1/1' });
    const { ledger: run } = buildLedger({ shards: [plain], shardTotal: 1 });
    expect(renderTable(run)).not.toContain('quarantined');
  });
});

describe('the real ledger', () => {
  const real = JSON.parse(read(LEDGER_PATH));
  const manifest = JSON.parse(read('test/deploy-tests-manifest.knext.json'));

  it('is valid today, under the cap, every unsupported entry naming its upstream issue and every flaky one carrying mixed evidence', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(validateLedger(real, { today, corpusExcludes: manifest.rules.exclude })).toEqual([]);
    expect(real.entries.length).toBeLessThanOrEqual(LEDGER_FILE_CAP);
    for (const e of real.entries) {
      expect(CLASSES).toContain(e.class);
      if (e.class === 'unsupported')
        expect(e.upstream).toMatch(/^https:\/\/github\.com\/cloudflare\/vinext\/issues\/\d+$/);
      else {
        expect(e.evidence.fail.length, e.test).toBeGreaterThanOrEqual(1);
        expect(e.evidence.pass.length, e.test).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('lives outside the harness patterns the compat-window fingerprint freezes for every cell', async () => {
    const { HARNESS_ROOTS } = await import('../scripts/compat-window-fingerprint.mjs');
    for (const rel of [LEDGER_PATH, 'scripts/compat-vinext-ledger.mjs']) {
      const [dir, ...rest] = rel.split('/');
      const name = rest.join('/');
      for (const root of HARNESS_ROOTS as Any[]) {
        if (root.kind === 'dir' && root.path === dir) {
          expect(root.match.test(name), `${rel} would enter the shared fingerprint`).toBe(false);
        }
      }
    }
  });
});

describe('workflow wiring', () => {
  // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
  const wf = (Bun as any).YAML.parse(read(WORKFLOW)) as Any;
  const steps = (job: string): Any[] => wf.jobs[job].steps;
  const idx = (list: Any[], re: RegExp) => list.findIndex((s) => re.test(s.name ?? ''));

  it('applies the ledger to each shard summary after summarizing, before upload and the red gate', () => {
    const s = steps('deploy-tests');
    const apply = idx(s, /quarantine ledger/i);
    expect(apply).toBeGreaterThan(idx(s, /^Summarize shard result/));
    expect(apply).toBeLessThan(idx(s, /Upload summary artifact/));
    expect(apply).toBeLessThan(idx(s, /red results/i));
    expect(s[apply].if).toBe('always()');
    expect(s[apply].run).toContain('scripts/compat-vinext-ledger.mjs apply');
    expect(s[apply].run).toContain('test/compat-vinext-ledger.json');
  });

  it('the red gate still fails on any remaining failed/notRun (not softened)', () => {
    const gate = steps('deploy-tests').find((st) => /red results/i.test(st.name ?? ''));
    expect(gate.run).toContain('(s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0');
    expect(gate.run).toContain('process.exit(1)');
  });

  it('reconciles the ledger over the whole run in the shard-ledger job (stale entries red it)', () => {
    const s = steps('shard-ledger');
    const rec = s.find((st) => /quarantine ledger/i.test(st.name ?? ''));
    expect(rec).toBeDefined();
    expect(rec.run).toContain('scripts/compat-vinext-ledger.mjs report');
    expect(rec['continue-on-error']).toBeUndefined();
  });

  it('the reconcile step reads the lane’s own previous runs (flaky window) with a read-only token', () => {
    const rec = steps('shard-ledger').find((st) => /quarantine ledger/i.test(st.name ?? ''));
    expect(rec.run).toMatch(/--history-runs \d+/);
    expect(rec.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(wf.jobs['shard-ledger'].permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('a PR that touches the ledger re-derives every entry from its listed runs, ADVISORY only', () => {
    const verify = (Bun as Any).YAML.parse(read(VERIFY_WORKFLOW)) as Any;
    const paths = verify.on.pull_request.paths as string[];
    expect(paths).toContain('test/compat-vinext-ledger.json');
    expect(paths).toContain('scripts/compat-vinext-ledger.mjs');
    // #1376 round 3: DEFAULT_NEXTJS_REF now reads this manifest directly, so
    // a manifest-only edit must re-run this check too.
    expect(paths).toContain('.github/compat-credentialed-next-version.json');
    expect(verify.permissions).toEqual({ contents: 'read', actions: 'read' });
    const job = Object.values(verify.jobs)[0] as Any;
    const step = job.steps.find((st: Any) => /compat-vinext-ledger\.mjs verify/.test(st.run ?? ''));
    expect(step).toBeDefined();
    expect(step.run).toContain('--ledger test/compat-vinext-ledger.json');
    expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(JSON.stringify(verify)).not.toContain('continue-on-error');
    // Advisory: documented as non-required, and its job name says so too —
    // nothing here can assert branch-protection config from repo files, so
    // the workflow's own text is where that claim has to live and be caught
    // by a review if it ever silently became a required check.
    expect(verify.name).toMatch(/advisory/i);
    expect(job.name).toMatch(/not a required check/i);
  });
});
