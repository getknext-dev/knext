import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLedger, DEFAULT_OUT_FILE } from '../scripts/compat-run-ledger.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * #695 — the compat run ledger must never record a clean sheet for a red night.
 *
 * THE DEFECT, MEASURED (run 30790778590, node lane, 2026-08-03):
 *   * the workflow concluded FAILURE; the one failing job was
 *     `Deploy tests (shard 16/16)` (job 91614133100);
 *   * that job stopped executing steps mid-way, so its `if: always()`
 *     summarize/upload tail never ran and `compat-suite-summary-15` was never
 *     uploaded;
 *   * the `compat-run-ledger` artifact — the 90-day evidence that exists so a
 *     re-run cannot erase a red night (#545 AC 3) — therefore contained
 *     FIFTEEN shards, `1/16` … `15/16`, every one `failed: 0`;
 *   * the job log has since expired (`BlobNotFound`), so the only surviving
 *     record of that night says it was clean.
 *
 * The ledger did not fail to answer. It answered wrongly, in the reassuring
 * direction, because it was assembled from whatever artifacts happened to
 * arrive and nothing reconciled that set against the matrix.
 *
 * THE PROPERTY THESE TESTS PIN: a ledger that reports fewer shards than the
 * matrix declares is itself an error. `errors.length === 0` must IMPLY a
 * complete ledger — silence and success must never look the same. That
 * implication is asserted over every degradation below rather than
 * case-by-case, so a new way of losing a shard is covered without anyone
 * remembering to add an assertion for it.
 */

const REF = 'v16.2.0';
const TOTAL = 16;

type Shard = ReturnType<typeof shard>;

function shard(n: number, over: Record<string, unknown> = {}) {
  return {
    shard: `${n}/${TOTAL}`,
    ref: REF,
    runtime: 'node',
    passed: 49,
    failed: 0,
    notRun: 0,
    excluded: 44,
    ...over,
  };
}

const FINGERPRINT = {
  fingerprint: 'sha256:deadbeef',
  components: { workflow: 'a' },
  packages: { '@getknext/core': 'b' },
  recorded: { suite: { nextJsCommit: 'abc', nextRef: REF, nextTarballSha256: 'def' } },
};

const allShards = () => Array.from({ length: TOTAL }, (_, i) => shard(i + 1));

function build(shards: Shard[], over: Record<string, unknown> = {}) {
  return buildLedger({
    shards,
    shardTotal: String(TOTAL),
    fingerprint: FINGERPRINT,
    runId: '30790778590',
    runAttempt: '1',
    event: 'schedule',
    ...over,
  });
}

describe('#695 — a shard with no summary artifact is counted MISSING, never omitted', () => {
  it('a complete run reconciles: 16 seen, 16 expected, no errors', () => {
    const { ledger, errors } = build(allShards());
    expect(errors).toEqual([]);
    expect(ledger.shardsExpected).toBe(TOTAL);
    expect(ledger.shardsSeen).toBe(TOTAL);
    expect(ledger.missingShards).toEqual([]);
    expect(ledger.complete).toBe(true);
    expect(ledger.shards).toHaveLength(TOTAL);
  });

  it('reproduces run 30790778590: 15 of 16 uploaded → the ledger is an ERROR, not a clean sheet', () => {
    // The exact shape of the defect: shard 16/16 produced nothing, the other
    // fifteen were green. Before the fix this built a 15-row, all-green ledger
    // and the ledger job concluded success.
    const { ledger, errors, redDetail } = build(allShards().slice(0, 15));

    expect(ledger.shardsSeen).toBe(15);
    expect(ledger.shardsExpected).toBe(16);
    expect(ledger.missingShards).toEqual(['16/16']);
    expect(ledger.complete).toBe(false);
    expect(errors.join('\n')).toMatch(/16\/16/);
    // The alert issue quotes redDetail, so the missing shard has to be named
    // there too — otherwise the night's issue says "deploy-tests failed" and
    // nothing about which shard vanished.
    expect(redDetail).toMatch(/16\/16/);
  });

  it('the missing shard occupies a ROW in the ledger, and that row carries no counts', () => {
    // A reader iterating `ledger.shards` must not see fifteen green rows: the
    // row exists, is marked missing, and its counts are null — never 0, which
    // would read as "ran nothing and passed".
    const { ledger } = build(allShards().slice(0, 15));
    expect(ledger.shards).toHaveLength(TOTAL);

    const row = ledger.shards.find((s) => s.shard === '16/16');
    if (!row) throw new Error('the missing shard has no row in the ledger');
    expect(row.status).toBe('missing');
    expect(row.passed).toBeNull();
    expect(row.failed).toBeNull();
    expect(row.notRun).toBeNull();

    const reported = ledger.shards.find((s) => s.shard === '1/16');
    if (!reported) throw new Error('shard 1/16 is missing from the ledger');
    expect(reported.status).toBe('reported');
  });

  it('the rendered table shows the missing shard rather than skipping it', () => {
    const { table } = build(allShards().slice(0, 15));
    expect(table).toMatch(/\|\s*16\/16\s*\|/);
    expect(table.toUpperCase()).toContain('MISSING');
  });

  it('EVERY single-shard loss is caught — scanned, not enumerated', () => {
    for (let n = 1; n <= TOTAL; n += 1) {
      const { ledger, errors } = build(allShards().filter((s) => s.shard !== `${n}/${TOTAL}`));
      expect(ledger.missingShards, `dropping shard ${n} was not detected`).toEqual([
        `${n}/${TOTAL}`,
      ]);
      expect(ledger.complete).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(ledger.shards).toHaveLength(TOTAL);
    }
  });

  it('a shard present but RED is reported as red, not as missing', () => {
    // The complement: reconciliation must not make a real failure look like an
    // infrastructure loss, or attribution is destroyed in the other direction.
    const shards = allShards();
    shards[15] = shard(16, {
      failed: 1,
      passed: 48,
      failures: [{ file: 'test/e2e/app-dir/x/x.test.ts', kind: 'timeout', timeoutMs: 60000 }],
    });
    const { ledger, redDetail } = build(shards);
    expect(ledger.missingShards).toEqual([]);
    expect(ledger.complete).toBe(true);
    expect(redDetail).toMatch(/16\/16/);
    expect(redDetail).toMatch(/x\.test\.ts/);
  });
});

describe('#695 — the expected shard count is DECLARED, never inferred from what arrived', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not a number', '16-ish'],
    ['zero', '0'],
    ['negative', '-4'],
    ['fractional', '4.5'],
  ])('fails closed when the declared total is %s', (_label, shardTotal) => {
    // Inferring the total from the shards that arrived is precisely the bug:
    // fifteen arriving shards would "declare" fifteen and reconcile perfectly.
    const { ledger, errors } = build(allShards().slice(0, 15), { shardTotal });
    expect(ledger.shardsExpected).toBeNull();
    expect(ledger.complete).toBe(false);
    expect(errors.join('\n')).toMatch(/COMPAT_SHARD_TOTAL/);
  });

  it('a shard whose own denominator disagrees with the declared total is an error', () => {
    // run-tests.js is told `-g N/M`; if M and the declared total ever diverge,
    // the reconciliation would be counting against the wrong denominator.
    const shards = allShards();
    shards[2] = shard(3, { shard: '3/8' });
    const { errors, ledger } = build(shards);
    expect(errors.join('\n')).toMatch(/3\/8/);
    expect(ledger.complete).toBe(false);
  });

  it('a duplicate shard summary is an error (two artifacts cannot buy a full house)', () => {
    const shards = [...allShards().slice(0, 15), shard(15)];
    const { errors, ledger } = build(shards);
    expect(shards).toHaveLength(16); // 16 files, but only 15 distinct shards
    expect(errors.join('\n')).toMatch(/duplicate/i);
    expect(ledger.complete).toBe(false);
  });

  it('a shard id outside the declared range is an error', () => {
    const shards = [...allShards(), shard(17)];
    const { errors, ledger } = build(shards);
    expect(errors.join('\n')).toMatch(/17\/16/);
    expect(ledger.complete).toBe(false);
  });

  it('a malformed shard id is an error, not a silently dropped row', () => {
    const shards = [...allShards().slice(0, 15), shard(16, { shard: 'sixteen' })];
    const { errors, ledger } = build(shards);
    expect(errors.join('\n')).toMatch(/sixteen/);
    expect(ledger.complete).toBe(false);
  });
});

describe('#695 — the pre-existing floors still hold', () => {
  it('zero shard summaries is an error (no results is NOT green)', () => {
    const { errors, ledger } = build([]);
    expect(errors.join('\n')).toMatch(/no shard summaries/i);
    expect(ledger.complete).toBe(false);
    expect(ledger.shards).toHaveLength(TOTAL);
  });

  it('a missing window fingerprint is an error', () => {
    const { errors } = build(allShards(), { fingerprint: null });
    expect(errors.join('\n')).toMatch(/fingerprint/i);
  });

  it('a shard that executed ZERO tests is an error (the buyable green)', () => {
    const shards = allShards();
    shards[4] = shard(5, { passed: 0, failed: 0, notRun: 0 });
    const { errors } = build(shards);
    expect(errors.join('\n')).toMatch(/test-count floor/i);
  });

  it('the lane is read from the shards, and a mixed set is labelled mixed', () => {
    const shards = allShards();
    shards[0] = shard(1, { runtime: 'bun' });
    const { ledger } = build(shards);
    expect(ledger.lane).toMatch(/^mixed\(/);
  });
});

describe('#695 — the fail-closed invariant: no error means COMPLETE', () => {
  const variants: Array<[string, Shard[], Record<string, unknown>]> = [
    ['complete', allShards(), {}],
    ['one missing', allShards().slice(0, 15), {}],
    ['many missing', allShards().slice(0, 3), {}],
    ['none at all', [], {}],
    ['duplicate', [...allShards().slice(0, 15), shard(15)], {}],
    ['out of range', [...allShards(), shard(17)], {}],
    ['malformed id', [...allShards().slice(0, 15), shard(16, { shard: '' })], {}],
    ['wrong denominator', [...allShards().slice(0, 15), shard(16, { shard: '16/8' })], {}],
    ['no declared total', allShards(), { shardTotal: undefined }],
    ['no fingerprint', allShards(), { fingerprint: null }],
  ];

  it.each(variants)('%s: errors empty ⟹ complete AND fully populated', (_label, shards, over) => {
    const { ledger, errors } = build(shards, over);
    if (errors.length === 0) {
      expect(ledger.complete).toBe(true);
      expect(ledger.shardsSeen).toBe(ledger.shardsExpected);
      expect(ledger.shards).toHaveLength(TOTAL);
      // and nothing in a clean ledger may be a placeholder
      expect(ledger.shards.filter((s) => s.status === 'missing')).toEqual([]);
    }
  });

  it.each(
    variants,
  )('%s: NOT complete ⟹ at least one error (never silent)', (_label, shards, over) => {
    // The direction that matters most, stated separately rather than as an
    // `else`: a ledger that is not a faithful record of the matrix must never
    // be emitted quietly. `complete` is the SHARD-SET verdict, so a complete
    // set with a different floor violated (no fingerprint) legitimately keeps
    // complete:true while still erroring — conflating the two in one `else`
    // would have asserted the wrong thing.
    const { ledger, errors } = build(shards, over);
    if (!ledger.complete) expect(errors.length).toBeGreaterThan(0);
  });

  it('the variant table is not vacuous — at least one variant is clean and most are not', () => {
    const clean = variants.filter(([, shards, over]) => build(shards, over).errors.length === 0);
    expect(clean).toHaveLength(1);
    expect(clean[0]?.[0]).toBe('complete');
  });
});

describe('#695 — the artifact path is one fact, shared with the workflow', () => {
  it('exports the ledger filename so the upload step cannot drift from the writer', () => {
    expect(DEFAULT_OUT_FILE).toBe('compat-run-ledger.json');
  });
});

describe('#695 — end to end, in the shape the shard-ledger job runs it', () => {
  /** Lay out a fake job workspace: `summaries/`, `fingerprint/`, and run the CLI. */
  function runCli(shards: Shard[]) {
    const dir = mkdtempSync(join(tmpdir(), 'knext-ledger-'));
    mkdirSync(join(dir, 'summaries'));
    mkdirSync(join(dir, 'fingerprint'));
    for (const s of shards) {
      const safe = String(s.shard).replace('/', '-');
      writeFileSync(join(dir, 'summaries', `compat-suite-summary-${safe}.json`), JSON.stringify(s));
    }
    writeFileSync(
      join(dir, 'fingerprint', 'compat-window-fingerprint.json'),
      JSON.stringify(FINGERPRINT),
    );
    const stepSummary = join(dir, 'step-summary.md');
    const output = join(dir, 'output.txt');
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/compat-run-ledger.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        COMPAT_SHARD_TOTAL: String(TOTAL),
        RUN_ID: '30790778590',
        RUN_ATTEMPT: '1',
        EVENT_NAME: 'schedule',
        GITHUB_STEP_SUMMARY: stepSummary,
        GITHUB_OUTPUT: output,
      },
    });
    const ledgerPath = join(dir, DEFAULT_OUT_FILE);
    return {
      status: res.status,
      stderr: `${res.stderr ?? ''}`,
      ledger: existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null,
      stepSummary: existsSync(stepSummary) ? readFileSync(stepSummary, 'utf8') : '',
      output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    };
  }

  it('a complete night exits 0 and writes a complete ledger', () => {
    const run = runCli(allShards());
    expect(run.status).toBe(0);
    expect(run.ledger?.complete).toBe(true);
    expect(run.ledger?.shards).toHaveLength(TOTAL);
  });

  it('a night missing a shard exits NON-ZERO but still leaves the ledger on disk', () => {
    // The evidence of a broken night has to survive the job that failed on it:
    // the upload step is `if: always()`, so writing the ledger only on the happy
    // path would move the hole rather than close it.
    const run = runCli(allShards().slice(0, 15));
    expect(run.status).not.toBe(0);
    expect(run.ledger).not.toBeNull();
    expect(run.ledger?.complete).toBe(false);
    expect(run.ledger?.missingShards).toEqual(['16/16']);
    expect(run.stderr).toMatch(/::error::/);
    expect(run.stderr).toMatch(/16\/16/);
    // and the alert issue's quoted detail names it too
    expect(run.output).toMatch(/red_detail<<KNEXT_EOF/);
    expect(run.output).toMatch(/16\/16/);
    expect(run.stepSummary.toUpperCase()).toContain('MISSING');
  });
});
