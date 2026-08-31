import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CaseResult,
  type CompatCase,
  casesForLane,
  LANES,
  laneVerdict,
  type QuarantineEntry,
  quarantineEntryProblems,
  renderLaneSummaryMarkdown,
  summarizeLedger,
  upstreamRefs,
} from './compat-lane-ledger';

/**
 * F5 (#281/#282) — the LANE LEDGER that finishes the compat-ledger acceptance
 * criteria on top of the schema landed by #325/#329:
 *
 *   #281 — a compat CASE declares its lane(s); the runner FILTERS by lane; a
 *          node-lane failure leaves the bun lane green (and vice-versa).
 *   #281 — the ledger prints a PER-LANE SUMMARY (passing / quarantined / failing
 *          per lane) usable in the parity docs.
 *   #282 — quarantine entries require a DATED justification AND an upstream
 *          reference (never quarantine a regression); the cap already fails CI
 *          (deploy-manifest-lanes.test.ts) — here we enforce the entry SHAPE.
 *
 * These are correctness-INFRA assertions: they touch no live matrix verdict and
 * claim no new parity.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');

interface Manifest {
  $knextQuarantines?: QuarantineEntry[];
}
const manifest: Manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : {};
const quarantines: QuarantineEntry[] = manifest.$knextQuarantines ?? [];

describe('#281 lane-scoped cases — the runner filters by lane', () => {
  const cases: CompatCase[] = [
    { id: 'a. App Router page', lanes: ['node', 'bun'] },
    { id: 'node-only. NODE_COMPILE_CACHE bytecode', lanes: ['node'] },
    { id: 'bun-only. bun keep-alive guard (#188)', lanes: ['bun'] },
  ];

  it('a case declares its lane(s) and casesForLane filters to that lane', () => {
    expect(casesForLane(cases, 'node').map((c) => c.id)).toEqual([
      'a. App Router page',
      'node-only. NODE_COMPILE_CACHE bytecode',
    ]);
    expect(casesForLane(cases, 'bun').map((c) => c.id)).toEqual([
      'a. App Router page',
      'bun-only. bun keep-alive guard (#188)',
    ]);
  });

  it('a NODE-lane failure leaves the BUN lane GREEN (and does not appear in the bun verdict)', () => {
    const results: CaseResult[] = [
      { id: 'a. App Router page', lane: 'node', passed: true },
      { id: 'node-only. NODE_COMPILE_CACHE bytecode', lane: 'node', passed: false },
      { id: 'a. App Router page', lane: 'bun', passed: true },
      { id: 'bun-only. bun keep-alive guard (#188)', lane: 'bun', passed: true },
    ];
    const node = laneVerdict(results, 'node');
    const bun = laneVerdict(results, 'bun');
    expect(node.green, 'the node lane must be RED (its node-only case failed)').toBe(false);
    expect(node.failing).toEqual(['node-only. NODE_COMPILE_CACHE bytecode']);
    // The core #281 guarantee: the node failure does NOT red the bun lane.
    expect(bun.green, 'a node-lane failure must NOT red the bun lane').toBe(true);
    expect(bun.failing).toEqual([]);
  });

  it('a BUN-lane failure leaves the NODE lane GREEN (the symmetric guarantee)', () => {
    const results: CaseResult[] = [
      { id: 'a. App Router page', lane: 'node', passed: true },
      { id: 'a. App Router page', lane: 'bun', passed: true },
      { id: 'bun-only. bun keep-alive guard (#188)', lane: 'bun', passed: false },
    ];
    expect(laneVerdict(results, 'bun').green).toBe(false);
    expect(laneVerdict(results, 'node').green).toBe(true);
  });
});

describe('#281 per-lane ledger summary (usable in the parity docs)', () => {
  it('summarizes passing / quarantined / failing per lane over the two lanes', () => {
    const results: CaseResult[] = [
      { id: 'a', lane: 'node', passed: true },
      { id: 'b', lane: 'node', passed: false },
      { id: 'a', lane: 'bun', passed: true },
    ];
    const q: QuarantineEntry[] = [
      { test: 'x', lane: 'node' },
      { test: 'y', lane: 'node' },
      { test: 'z', lane: 'bun' },
    ];
    const summary = summarizeLedger({ quarantines: q, results });
    const node = summary.find((s) => s.lane === 'node');
    const bun = summary.find((s) => s.lane === 'bun');
    expect(node).toEqual({ lane: 'node', passing: 1, quarantined: 2, failing: 1 });
    expect(bun).toEqual({ lane: 'bun', passing: 1, quarantined: 1, failing: 0 });
  });

  it('is TOTAL-CONSERVING on quarantines: sum(per-lane quarantined) === ledger size', () => {
    const summary = summarizeLedger({ quarantines });
    const summed = summary.reduce((acc, s) => acc + s.quarantined, 0);
    expect(summed).toBe(quarantines.length);
  });

  it('emits every lane even when a lane has no data (no lane silently vanishes)', () => {
    const summary = summarizeLedger({ quarantines: [] });
    expect(summary.map((s) => s.lane).sort()).toEqual([...LANES].sort());
  });

  it('renders a markdown table (a per-lane block the parity doc can embed)', () => {
    const md = renderLaneSummaryMarkdown(summarizeLedger({ quarantines }));
    expect(md).toContain('| Lane |');
    expect(md).toContain('| node |');
    expect(md).toContain('| bun |');
    // one data row per lane
    for (const lane of LANES) expect(md).toContain(`| ${lane} |`);
  });
});

describe('#282 quarantine entry shape — dated justification + upstream ref (never hide a regression)', () => {
  it('every LIVE ledger entry carries a dated justification AND an upstream reference', () => {
    expect(quarantines.length).toBeGreaterThan(0);
    for (const e of quarantines) {
      expect(
        quarantineEntryProblems(e),
        `live quarantine "${e.test}" fails the dated+upstream contract`,
      ).toEqual([]);
    }
  });

  it('rejects an entry with NO date and NO upstream reference (a bare skip)', () => {
    const bare: QuarantineEntry = {
      test: 'test/e2e/synthetic/bare.test.ts',
      mechanism: 'it is flaky, skipping',
      lane: 'node',
    };
    const problems = quarantineEntryProblems(bare);
    expect(problems.length).toBe(2);
    expect(problems.join(' ')).toMatch(/dated/i);
    expect(problems.join(' ')).toMatch(/upstream/i);
  });

  it('rejects a REGRESSION masquerade: dated, but with NO upstream cause cited', () => {
    // This is the criterion-4 guard: a quarantine must point at a known-upstream
    // gap. An entry that is dated but cites no upstream issue/run is a regression
    // being hidden — it must be rejected.
    const regression: QuarantineEntry = {
      test: 'test/e2e/synthetic/regression.test.ts',
      mechanism: 'broke after our refactor on 2026-07-20',
      evidence: 'started failing 2026-07-20 on our branch',
      lane: 'node',
    };
    const problems = quarantineEntryProblems(regression);
    expect(problems.join(' ')).toMatch(/upstream/i);
    expect(problems.join(' ')).not.toMatch(/dated/i); // the date IS present
  });

  it('accepts a well-formed entry (ISO date OR a CI run id counts as dated evidence)', () => {
    const viaRunId: QuarantineEntry = {
      test: 'test/e2e/synthetic/ok.test.ts',
      evidence: 'run 28593534713: hung 3/3 attempts',
      provenance: 'upstream fix vercel/next.js#95301 (post-ref)',
      lane: 'node',
    };
    expect(quarantineEntryProblems(viaRunId)).toEqual([]);
    const viaIso: QuarantineEntry = {
      test: 'test/e2e/synthetic/ok2.test.ts',
      evidence: 'first observed 2026-07-05',
      provenance: 'documented Bun edge-sandbox gap, PR #189',
      lane: 'bun',
    };
    expect(quarantineEntryProblems(viaIso)).toEqual([]);
  });
});

describe('#512 the UPSTREAM half needs a real issue/PR ref — a run id is DATED evidence only', () => {
  /**
   * The softening #512 closes: `UPSTREAM_RE` used to accept a bare `run NNNNN`,
   * so one run id satisfied BOTH halves. A regression's own red run has a run id
   * too, so that shape could pin a quarantine to nothing but the failure it hides.
   */
  it('an entry whose UPSTREAM half is ONLY a run id FAILS (and is still counted as dated)', () => {
    const runIdOnly: QuarantineEntry = {
      test: 'test/e2e/synthetic/run-id-only.test.ts',
      mechanism: '60s timeout, no assertion diff',
      evidence: 'run 28593534713: failed 3/3 attempts',
      lane: 'node',
    };
    const problems = quarantineEntryProblems(runIdOnly);
    expect(problems.length, `a run-id-only entry must be rejected: ${problems.join(' | ')}`).toBe(
      1,
    );
    expect(problems[0]).toMatch(/upstream/i);
    // The run id is still legitimate DATED evidence — only the upstream half rejects it.
    expect(problems.join(' ')).not.toMatch(/dated/i);
    expect(upstreamRefs(runIdOnly)).toEqual([]);
  });

  it('the HASHED run-id spelling ("run #28599745695") is not an upstream ref either', () => {
    // Residual hole found reviewing #512: `#\d{3,6}` had no trailing boundary, so an
    // 11-digit run id written with a hash yielded the PREFIX "#285997" — a knext issue
    // number that does not exist — and the entry passed. All three run-id spellings
    // (`run N`, `.../actions/runs/N`, `run #N`) must fail the upstream half alike.
    const hashedRunId: QuarantineEntry = {
      test: 'test/e2e/synthetic/hashed-run-id.test.ts',
      mechanism: '60s timeout, no assertion diff',
      evidence: 'first observed 2026-07-20 in run #28599745695',
      lane: 'node',
    };
    expect(upstreamRefs(hashedRunId)).toEqual([]);
    const problems = quarantineEntryProblems(hashedRunId);
    expect(
      problems.length,
      `a hashed run id must not satisfy upstream: ${problems.join(' | ')}`,
    ).toBe(1);
    expect(problems[0]).toMatch(/upstream/i);
    // …while a genuine 3–6 digit knext ref in the same shape still counts.
    expect(upstreamRefs({ test: 't', evidence: 'first observed 2026-07-20, see #214' })).toEqual([
      '#214',
    ]);
  });

  it('a run id remains the ONLY dated evidence an entry needs when a real upstream ref is present', () => {
    const ok: QuarantineEntry = {
      test: 'test/e2e/synthetic/run-id-dated.test.ts',
      evidence: 'run 28593534713: failed 3/3 attempts', // no ISO date anywhere
      provenance: 'root cause fixed upstream in vercel/next.js#95301',
      lane: 'node',
    };
    expect(quarantineEntryProblems(ok)).toEqual([]);
    expect(upstreamRefs(ok)).toContain('vercel/next.js#95301');
  });

  it('an ACTIONS-RUN url is not an upstream ref, but an issue/PR url is', () => {
    const actionsUrl: QuarantineEntry = {
      test: 'test/e2e/synthetic/actions-url.test.ts',
      evidence: 'https://github.com/vercel/next.js/actions/runs/28593534713 on 2026-07-20',
      lane: 'node',
    };
    expect(upstreamRefs(actionsUrl)).toEqual([]);
    expect(quarantineEntryProblems(actionsUrl).join(' ')).toMatch(/upstream/i);

    const issueUrl: QuarantineEntry = {
      test: 'test/e2e/synthetic/issue-url.test.ts',
      evidence: 'first observed 2026-07-20',
      provenance: 'https://github.com/vercel/next.js/pull/95301',
      lane: 'node',
    };
    expect(quarantineEntryProblems(issueUrl)).toEqual([]);
    expect(upstreamRefs(issueUrl)).toContain('https://github.com/vercel/next.js/pull/95301');
  });

  it('a version pin (nextjsRef "v16.2.0") does NOT count as an upstream reference', () => {
    const versionOnly: QuarantineEntry = {
      test: 'test/e2e/synthetic/version-pin.test.ts',
      nextjsRef: 'v16.2.0',
      evidence: 'run 28593534713: failed 3/3',
      lane: 'node',
    };
    expect(upstreamRefs(versionOnly)).toEqual([]);
    expect(quarantineEntryProblems(versionOnly).join(' ')).toMatch(/upstream/i);
  });

  it('every LIVE entry is SCANNED (not enumerated) and rests on a named issue/PR ref', () => {
    expect(quarantines.length).toBeGreaterThan(0);
    const unbacked = quarantines.filter((e) => upstreamRefs(e).length === 0).map((e) => e.test);
    expect(
      unbacked,
      `these live quarantines cite no real issue/PR ref (a run id no longer counts): ${unbacked.join(', ')}`,
    ).toEqual([]);
  });
});
