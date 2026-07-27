import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs script without types
import { classifyRuns, renderLedgerTable } from '../scripts/e2e-shard-history.mjs';
// @ts-expect-error — .mjs script without types (same import style as deploy-summary.test.ts)
import { summarize } from '../scripts/e2e-summary.mjs';

const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/test-e2e-deploy.yml'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// T1 / #545 — the flake ATTRIBUTION contract.
//
// MECHANISM (measured, not assumed — see the PR body):
//   * The failing-shard set is STABLE, not rotating, and it is LANE-PARTITIONED.
//     Every "shards 6 and 8" red (2026-07-05, -07-19, -07-26) fell on a Sunday,
//     i.e. the WEEKLY BUN lane (cron '17 5 * * 0'); the node credential lane had
//     exactly ONE shard-level red in the 22 scheduled runs since 2026-07-05.
//   * That one node red (run 29984259723, shard 2/16) was
//     test/e2e/app-dir/segment-cache/dynamic-on-hover — a member of the
//     ALREADY-ROOT-CAUSED #214 segment-cache runtime-prefetch family
//     (vercel/next.js#95301). Nine siblings are quarantined with that ref;
//     dynamic-on-hover is not, because the family was captured as an ENUMERATED
//     file list. Signature: a bare `Exceeded timeout of 60000 ms for a test.`
//     on all three retries, with no assertion — a HANG, not slowness.
//
// WHY THIS FILE EXISTS: none of that was queryable. The per-shard summary
// artifact carried COUNTS only, so "which test failed" required downloading job
// logs, which is exactly what makes a re-run erase the signal (#545 AC 3). The
// contract asserted below is that a red shard NAMES its failing files and
// CLASSIFIES the failure, and that per-shard outcomes survive long enough to be
// counted across the 14-night window.
// ─────────────────────────────────────────────────────────────────────────────

// A faithful, de-timestamped slice of run 29984259723 shard 2/16 (the node-lane
// red): run-tests.js group boundaries + the jest verbose block inside them.
const DYNAMIC_ON_HOVER_RED = `
total: 49
Starting test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts retry 0/2
❌ test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts output:
FAIL Turbopack test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts (148.075 s)
  dynamic on hover
    ✕ prefetches the dynamic data for a Link on hover (60001 ms)

  ● dynamic on hover › prefetches the dynamic data for a Link on hover

    thrown: "Exceeded timeout of 60000 ms for a test.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
end of test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts output
test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts failed due to Error: failed with code: 1
test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts failed to pass within 2 retries
`;

// A faithful slice of the BUN lane red (run 30193384289 shard 6/16): the same
// file carries BOTH a bare-timeout case and fast assertion failures.
const BUN_ASSERTION_RED = `
total: 49
❌ test/e2e/app-dir/app-static/app-static.test.ts output:
FAIL Turbopack test/e2e/app-dir/app-static/app-static.test.ts (204.9 s)
    ✕ should handle partial-gen-params with layout dynamicParams = false correctly (11 ms)
    ✕ should handle dynamicParams: false correctly (59 ms)

  ● app-static › should handle dynamicParams: false correctly

    expect(received).toBe(expected)
end of test/e2e/app-dir/app-static/app-static.test.ts output
test/e2e/app-dir/app-static/app-static.test.ts failed to pass within 2 retries
`;

const GREEN_SHARD = `
total: 2
test/e2e/app-dir/a/a.test.ts finished on retry 0/2 in 12.0s
test/e2e/app-dir/b/b.test.ts finished on retry 0/2 in 9.0s
`;

const meta = { ref: 'v16.2.0', shard: '2/16', excluded: 44, runtime: 'node' };

describe('#545 — a red shard NAMES its failing tests (summary artifact is the ledger)', () => {
  it('lists the failing test FILE, not just a count', () => {
    const s = summarize(DYNAMIC_ON_HOVER_RED, meta);
    expect(s.failed).toBe(1);
    expect(s.failures).toEqual([
      expect.objectContaining({
        file: 'test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts',
      }),
    ]);
  });

  it('classifies the bare per-case jest timeout as kind "timeout" (the #95301 hang signature)', () => {
    const s = summarize(DYNAMIC_ON_HOVER_RED, meta);
    expect(s.failures[0].kind).toBe('timeout');
    expect(s.failures[0].timeoutMs).toBe(60000);
  });

  it('names the failing CASE, de-duplicated across retries', () => {
    // The real log prints the ✕ line once per retry (3 retries). One entry.
    const thrice = DYNAMIC_ON_HOVER_RED.repeat(3);
    const s = summarize(thrice, meta);
    expect(s.failures[0].cases).toEqual(['prefetches the dynamic data for a Link on hover']);
  });

  it('classifies a non-timeout failure as kind "assertion" (so the two are never conflated)', () => {
    const s = summarize(BUN_ASSERTION_RED, { ...meta, runtime: 'bun' });
    expect(s.failures[0].kind).toBe('assertion');
    expect(s.failures[0].timeoutMs).toBeUndefined();
    expect(s.failures[0].cases).toContain('should handle dynamicParams: false correctly');
  });

  it('OMITS the failures key on a green shard (node artifact stays byte-stable for the #41 publisher)', () => {
    const s = summarize(GREEN_SHARD, meta);
    expect(s.failed).toBe(0);
    expect(Object.keys(s)).not.toContain('failures');
    expect(Object.keys(s)).not.toContain('notRunFiles');
  });

  it('names phantom infra-abort files under notRunFiles, never under failures', () => {
    const phantom = `
total: 1
❌ test/e2e/app-dir/ghost/ghost.test.ts output:
No tests found, exiting with code 1
end of test/e2e/app-dir/ghost/ghost.test.ts output
test/e2e/app-dir/ghost/ghost.test.ts failed to pass within 2 retries
`;
    const s = summarize(phantom, meta);
    expect(s.notRun).toBe(1);
    expect(s.notRunFiles).toEqual(['test/e2e/app-dir/ghost/ghost.test.ts']);
    expect(Object.keys(s)).not.toContain('failures');
  });

  it('keeps the failure record LANE-attributable (bun and node reds are never pooled)', () => {
    const s = summarize(DYNAMIC_ON_HOVER_RED, { ...meta, runtime: 'bun' });
    expect(s.runtime).toBe('bun');
    expect(s.failures).toHaveLength(1);
  });
});

describe('#545 AC1 — per-shard outcomes are queryable across scheduled runs, lane labelled', () => {
  const runs = [
    {
      databaseId: 30193384289,
      createdAt: '2026-07-26T07:46:00Z',
      event: 'schedule',
      conclusion: 'failure',
      jobs: [
        { name: 'Deploy tests (shard 6/16)', conclusion: 'failure' },
        { name: 'Deploy tests (shard 8/16)', conclusion: 'failure' },
        { name: 'Deploy tests (shard 1/16)', conclusion: 'success' },
      ],
      lane: 'bun',
    },
    {
      databaseId: 29984259723,
      createdAt: '2026-07-23T06:10:54Z',
      event: 'schedule',
      conclusion: 'failure',
      jobs: [{ name: 'Deploy tests (shard 2/16)', conclusion: 'failure' }],
      lane: 'node',
    },
    {
      databaseId: 30243647123,
      createdAt: '2026-07-27T06:43:12Z',
      event: 'schedule',
      conclusion: 'success',
      jobs: [{ name: 'Deploy tests (shard 1/16)', conclusion: 'success' }],
      lane: 'node',
    },
  ];

  it('extracts the failing SHARD IDs per run', () => {
    const rows = classifyRuns(runs);
    expect(rows.find((r: any) => r.runId === 30193384289).failedShards).toEqual(['6/16', '8/16']);
    expect(rows.find((r: any) => r.runId === 29984259723).failedShards).toEqual(['2/16']);
    expect(rows.find((r: any) => r.runId === 30243647123).failedShards).toEqual([]);
  });

  it('labels every row with the lane it came from', () => {
    const rows = classifyRuns(runs);
    expect(rows.map((r: any) => r.lane).sort()).toEqual(['bun', 'node', 'node']);
  });

  it('never GUESSES the lane — an unattributable run is reported as unknown, not as node', () => {
    // The lane must come from the run's own evidence (the summary artifact's
    // `runtime`). Inferring it from cron timing is what #545 explicitly warns
    // against; a silent "node" default would launder a bun red into the
    // credential lane's flake rate.
    const rows = classifyRuns([{ ...runs[1], lane: undefined }]);
    expect(rows[0].lane).toBe('unknown');
  });

  it('computes a per-lane flake rate from stable-vs-rotating shard evidence', () => {
    const rows = classifyRuns(runs);
    const node = rows.filter((r: any) => r.lane === 'node');
    expect(node.filter((r: any) => r.failedShards.length > 0)).toHaveLength(1);
    expect(node).toHaveLength(2);
  });

  it('renders a queryable table that names the lane and the failing shards', () => {
    const table = renderLedgerTable(classifyRuns(runs));
    expect(table).toContain('bun');
    expect(table).toContain('6/16, 8/16');
    expect(table).toContain('2/16');
  });
});

/**
 * Slice one workflow STEP's text by its `- name:` header, up to the next step
 * or job header. Text-scanned rather than YAML-parsed, matching the deliberate
 * choice in tests/compat-suite-workflow.test.ts (the repo keeps no direct `yaml`
 * dep). Scoping matters: an unscoped file-wide match is how a guard passes while
 * the behaviour it protects is gone.
 */
function sliceStep(name: string): string {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  expect(start, `workflow step "${name}" not found`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const end = rest.search(/\n {6}- name:|\n {2}[a-z][a-z-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('#545 AC3 — a re-run cannot erase the signal (workflow contract)', () => {
  it('the red-shard gate prints the named failing tests, not only the counts', () => {
    // Mechanism guard: without this the ONLY record of *which* test failed is
    // the job log, which is what makes "re-run until green" free.
    //
    // SCOPED to the gate STEP, not the whole file. An unscoped /s\.failures/
    // stayed GREEN under mutation because the aggregate ledger job also reads
    // `s.failures` — a textbook decoration guard, caught by the mutation proof.
    const step = sliceStep('Fail shard on red results');
    expect(step).toMatch(/s\.failures/);
    expect(step).toMatch(/s\.notRunFiles/);
  });

  it('the shard summary artifact outlives a 14-night window (retention >= 90 days)', () => {
    // retention-days: 14 could not even cover the v1.0 gate's own 14-run window,
    // so the flake rate was unauditable after the fact by construction.
    // Scoped to the LEDGER artifacts only — the intermediate workspace tarball
    // is deliberately retention-days: 1 (a multi-GB blob, not evidence).
    const ledgerUploads = [
      ...WORKFLOW.matchAll(
        /name:\s*(compat-suite-summary[^\n]*|compat-run-ledger[^\n]*)\n(?:(?!\s*-\s|\s*name:)[^\n]*\n)*?\s*retention-days:\s*(\d+)/g,
      ),
    ];
    expect(ledgerUploads.length).toBeGreaterThanOrEqual(2);
    for (const m of ledgerUploads) expect(Number(m[2])).toBeGreaterThanOrEqual(90);
  });

  it('the nightly red alert carries the failing shard IDs and test names in its body', () => {
    // BOTH halves, or the guard is decoration: renaming only the env wiring left
    // the `${RED_SHARD_DETAIL}` body reference behind and a single-token match
    // stayed green (caught by the mutation proof).
    expect(WORKFLOW).toMatch(
      /RED_SHARD_DETAIL:\s*\$\{\{\s*needs\.shard-ledger\.outputs\.red_detail\s*\}\}/,
    );
    expect(WORKFLOW).toMatch(/\$\{RED_SHARD_DETAIL\}/);
  });

  it('an aggregate ledger job records every shard outcome for the run', () => {
    expect(WORKFLOW).toMatch(/^ {2}shard-ledger:$/m);
  });

  it('the shard step has NO retry/continue-on-error escape hatch (a retry is not a fix)', () => {
    // #545: "The tempting shortcut is a blanket retry on failed shards, which
    // would make the gate permanently green and permanently meaningless."
    expect(WORKFLOW).not.toMatch(/continue-on-error:\s*true/);
    expect(WORKFLOW).not.toMatch(/nick-fields\/retry/);
  });
});
