/**
 * The vinext-lane quarantine ledger (#1321; design approved on the issue).
 *
 * The vinext × bun compiled-exec lane runs the node lane's corpus unchanged, so
 * its denominator stays 778. Failures that are unsupported by design (with a
 * named feature and an upstream issue), or flaky with current mixed evidence,
 * are RECLASSIFIED after the run as `quarantined` rather than removed from the
 * corpus — they still run every time. The ledger is bounded (at most 15 files),
 * dated (at most 30 days per entry, no version-only expiry), and a ledgered
 * failure that stops failing reds the run, so the ledger only shrinks on
 * evidence.
 *
 * What is guarded here:
 *   - every red condition of the validator (the approved constraints);
 *   - reclassification never changes passed / notRun / expectedTotal / excluded;
 *   - stale detection across a run's shards;
 *   - the real ledger file is valid today;
 *   - the workflow wires both halves, and the ledger lives OUTSIDE the file
 *     patterns the compat-window fingerprint freezes for every cell (so adding
 *     it cannot reset the node lanes' 14-night windows).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyLedger,
  LEDGER_FILE_CAP,
  MAX_EXPIRY_DAYS,
  publishedNumber,
  staleEntries,
  validateLedger,
} from '../scripts/compat-vinext-ledger.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = 'test/compat-vinext-ledger.json';
const WORKFLOW = '.github/workflows/compat-vinext.yml';
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const TODAY = '2026-09-24';
const CORPUS_EXCLUDES = ['test/e2e/excluded/by-manifest.test.ts'];

// biome-ignore lint/suspicious/noExplicitAny: fixtures are plain JSON
type Any = any;

function entry(over: Record<string, unknown> = {}): Any {
  return {
    test: 'test/e2e/app-dir/fallback-shells/fallback-shells.test.ts',
    scope: 'file',
    class: 'unsupported',
    feature: 'PPR fallback shells',
    upstream: 'https://github.com/cloudflare/vinext/issues/1359',
    evidence: { fail: ['35995001855'] },
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

  it('a whole-file entry needs a named feature AND an upstream issue link', () => {
    expect(errs(ledger([entry({ feature: '' })])).join()).toMatch(/feature/);
    expect(errs(ledger([entry({ upstream: undefined })])).join()).toMatch(/upstream/);
    expect(errs(ledger([entry({ upstream: 'see chat' })])).join()).toMatch(/upstream/);
  });

  it('flaky entries are per-case with mixed evidence (at least one pass and one fail run)', () => {
    const flaky = entry({
      class: 'flaky',
      scope: 'cases',
      cases: ['should scroll to the specified hash'],
      evidence: { fail: ['1'], pass: ['2'] },
    });
    expect(errs(ledger([flaky]))).toEqual([]);
    expect(errs(ledger([{ ...flaky, scope: 'file', cases: undefined }])).join()).toMatch(
      /per-case/,
    );
    expect(errs(ledger([{ ...flaky, evidence: { fail: ['1'] } }])).join()).toMatch(/mixed/);
    expect(errs(ledger([{ ...flaky, evidence: { pass: ['2'] } }])).join()).toMatch(/mixed/);
  });

  it('a per-case entry must list its cases', () => {
    expect(errs(ledger([entry({ scope: 'cases', cases: [] })])).join()).toMatch(/cases/);
  });

  it('every entry needs failing-run evidence', () => {
    expect(errs(ledger([entry({ evidence: { fail: [] } })])).join()).toMatch(/evidence/);
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
  failures: [
    {
      file: 'test/e2e/app-dir/fallback-shells/fallback-shells.test.ts',
      kind: 'assertion',
      cases: ['a', 'b'],
    },
    {
      file: 'test/e2e/app-dir/navigation/navigation.test.ts',
      kind: 'assertion',
      cases: ['hash', 'other'],
    },
    { file: 'test/e2e/unrelated/x.test.ts', kind: 'timeout', cases: ['c'] },
  ],
  ...over,
});
const caseEntry = (cases: string[]) =>
  entry({
    test: 'test/e2e/app-dir/navigation/navigation.test.ts',
    class: 'flaky',
    scope: 'cases',
    cases,
    evidence: { fail: ['1'], pass: ['2'] },
  });

describe('applyLedger: reclassification, never narrowing', () => {
  it('moves a whole-file match to quarantined and leaves the other failures', () => {
    const out = applyLedger(summary(), [entry()]);
    expect(out.failed).toBe(2);
    expect(out.failures.map((f: Any) => f.file)).toEqual([
      'test/e2e/app-dir/navigation/navigation.test.ts',
      'test/e2e/unrelated/x.test.ts',
    ]);
    expect(out.quarantined).toEqual([
      {
        file: 'test/e2e/app-dir/fallback-shells/fallback-shells.test.ts',
        cases: ['a', 'b'],
        class: 'unsupported',
        upstream: 'https://github.com/cloudflare/vinext/issues/1359',
      },
    ]);
  });

  it('a per-case entry quarantines only its cases; the file stays failed while other cases fail', () => {
    const out = applyLedger(summary(), [caseEntry(['hash'])]);
    expect(out.failed).toBe(3);
    const nav = out.failures.find((f: Any) => f.file.includes('navigation'));
    expect(nav.cases).toEqual(['other']);
    expect(out.quarantined[0].cases).toEqual(['hash']);
  });

  it('a per-case entry covering every failing case quarantines the file', () => {
    const out = applyLedger(summary(), [caseEntry(['hash', 'other'])]);
    expect(out.failed).toBe(2);
    expect(out.failures.some((f: Any) => f.file.includes('navigation'))).toBe(false);
  });

  it('never changes passed, notRun, excluded, expectedTotal or truncated (the denominator)', () => {
    const before = summary();
    const out = applyLedger(before, [entry(), caseEntry(['hash'])]);
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

  it('with no matching failures it only adds an empty quarantined list', () => {
    const s = summary({ failures: [], failed: 0 });
    expect(applyLedger(s, [entry()])).toEqual({ ...s, quarantined: [] });
  });
});

describe('staleEntries: a ledgered failure that stopped failing reds the run', () => {
  it('an entry quarantined in some shard is not stale', () => {
    const shards = [
      applyLedger(summary(), [entry()]),
      applyLedger(summary({ failures: [], failed: 0 }), [entry()]),
    ];
    expect(staleEntries(shards, [entry()])).toEqual([]);
  });

  it('an entry that matched nothing in any shard is stale', () => {
    const shards = [applyLedger(summary({ failures: [], failed: 0 }), [entry()])];
    expect(staleEntries(shards, [entry()]).map((s: Any) => s.test)).toEqual([entry().test]);
  });

  it('a per-case entry is stale when any listed case did not fail', () => {
    const e = caseEntry(['hash', 'gone']);
    const shards = [applyLedger(summary(), [e])];
    expect(staleEntries(shards, [e])).toEqual([{ test: e.test, cases: ['gone'] }]);
  });

  it('a not-run file is not called stale (no result is not a pass)', () => {
    const shards = [
      applyLedger(summary({ failures: [], failed: 0, notRun: 1, notRunFiles: [entry().test] }), [
        entry(),
      ]),
    ];
    expect(staleEntries(shards, [entry()])).toEqual([]);
  });
});

describe('publishedNumber: passed / failed / quarantined over the unchanged denominator', () => {
  it('sums shards and keeps the total equal to passed + failed + quarantined + notRun', () => {
    const a = applyLedger(summary(), [entry()]);
    const b = applyLedger(summary({ failures: [], failed: 0, passed: 47 }), [entry()]);
    const n = publishedNumber([a, b]);
    expect(n).toEqual({ passed: 91, failed: 2, quarantined: 1, notRun: 0, total: 94 });
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
    expect(rec.continueOnError ?? rec['continue-on-error']).toBeUndefined();
  });
});
