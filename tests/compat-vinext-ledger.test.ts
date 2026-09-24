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
 *   - the workflow wires both halves, and the ledger lives OUTSIDE the file
 *     patterns the compat-window fingerprint freezes for every cell.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, renderTable } from '../scripts/compat-run-ledger.mjs';
import {
  applyLedger,
  LEDGER_FILE_CAP,
  MAX_EXPIRY_DAYS,
  publishedNumber,
  refreshSnapshots,
  skippedWarnings,
  staleEntries,
  validateLedger,
} from '../scripts/compat-vinext-ledger.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = 'test/compat-vinext-ledger.json';
const WORKFLOW = '.github/workflows/compat-vinext.yml';
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
      evidence: { fail: [{ run: '1', cases: ['hash'] }], pass: ['2'] },
    });
    expect(errs(ledger([flaky]))).toEqual([]);
    const failOnly = { fail: [{ run: '1', cases: ['hash'] }] };
    expect(errs(ledger([{ ...flaky, evidence: failOnly }])).join()).toMatch(/mixed/);
    expect(errs(ledger([{ ...flaky, evidence: { pass: ['2'] } }])).join()).toMatch(/mixed/);
    const same = { fail: [{ run: '1', cases: ['hash'] }], pass: ['1'] };
    expect(errs(ledger([{ ...flaky, evidence: same }])).join()).toMatch(/both passed and failed/);
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
    evidence: { fail: [{ run: '1', cases }], pass: ['2'] },
  });

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
    ]);
    expect(errors).toEqual([]);
    expect(next.entries[0].evidence).toEqual({
      fail: [{ run: '61', cases: ['hash'] }],
      pass: ['62'],
    });
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

  it('is valid today, under the cap, with every entry naming its upstream issue', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(validateLedger(real, { today, corpusExcludes: manifest.rules.exclude })).toEqual([]);
    expect(real.entries.length).toBeLessThanOrEqual(LEDGER_FILE_CAP);
    for (const e of real.entries)
      expect(e.upstream).toMatch(/^https:\/\/github\.com\/cloudflare\/vinext\/issues\/\d+$/);
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
});
