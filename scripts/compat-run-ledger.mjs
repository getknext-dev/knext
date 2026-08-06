#!/usr/bin/env node
/**
 * scripts/compat-run-ledger.mjs — the compat run ledger, and its RECONCILIATION
 * against the matrix (#695, on top of #545 sprint-1 T1 / S1).
 *
 * WHAT THIS REPLACES, AND WHY IT MOVED OUT OF THE WORKFLOW
 * -------------------------------------------------------
 * The ledger used to be a heredoc inside the `shard-ledger` job of
 * `.github/workflows/test-e2e-deploy.yml`. It collapsed a night into one
 * lane-labelled record — every shard's counts, every failing file, its cases and
 * its failure kind — by reading the `compat-suite-summary-*` artifacts the shard
 * jobs uploaded.
 *
 * It reconciled that set against NOTHING. A shard whose job stops executing
 * steps (runner loss, a job-level cancellation — a job timeout is a
 * cancellation, not a failure) never reaches its `if: always()` summarize/upload
 * tail, so it uploads no artifact, so it simply was not in the ledger.
 *
 * MEASURED (run 30790778590, node lane, 2026-08-03): the workflow concluded
 * FAILURE; the single failing job was `Deploy tests (shard 16/16)` (job
 * 91614133100); `compat-suite-summary-15` was never uploaded; the retained
 * `compat-run-ledger` artifact contains FIFTEEN shards, `1/16`…`15/16`, every
 * one `failed: 0`. The `shard-ledger` job itself concluded SUCCESS, because its
 * only floors were "zero summaries at all" and "a shard executed zero tests" —
 * fifteen of sixteen trips neither. The job log has since expired
 * (`BlobNotFound`), so the only surviving evidence of that red night says it was
 * clean.
 *
 * That is the worst failure mode an evidence trail has: it does not fail to
 * answer, it answers wrongly and in the reassuring direction. The `#545` AC 3
 * artifact exists precisely so a re-run cannot erase a red night; a ledger that
 * silently drops the failing shard erases it without even a re-run.
 *
 * THE CONTRACT
 * ------------
 *   * the expected shard count is DECLARED (`COMPAT_SHARD_TOTAL`, workflow-level
 *     env, cross-checked against the matrix by
 *     tests/compat-shard-flake-attribution.test.ts) and NEVER inferred from what
 *     arrived — inference is the bug: fifteen arriving shards would "declare"
 *     fifteen and reconcile perfectly;
 *   * every expected shard occupies a ROW. A shard that reported nothing gets a
 *     placeholder with `status: 'missing'` and NULL counts — never 0, which
 *     reads as "ran nothing and passed";
 *   * `errors.length === 0` IMPLIES a complete ledger. Silence and success must
 *     not look the same, so incompleteness, duplication, an out-of-range id, a
 *     malformed id, a denominator that disagrees with the declaration, and an
 *     undeclared total are all errors, and every error fails the job;
 *   * the ledger JSON is written BEFORE any of that is evaluated, and the upload
 *     step is `if: always()`, so the incomplete ledger is still retained. The
 *     evidence of a broken night must survive the job that failed on it.
 *
 * Living in a script rather than a heredoc is not cosmetic: the reconciliation
 * is behaviour, and behaviour embedded in workflow YAML can only be guarded by
 * matching text. `tests/compat-run-ledger-completeness.test.ts` exercises the
 * real function; `scripts/mutation-prove-ledger-completeness.mjs` proves those
 * guards are not decoration.
 *
 * LIMITS OF THE WORKFLOW-SIDE GUARDS — measured, recorded, and deliberately NOT
 * built for. Both were reproduced against the real guards and judged contrived,
 * so they are written down here instead of being chased with more assertions:
 *
 *   * the command allowlist in tests/compat-shard-flake-attribution.test.ts
 *     scans `run:` strings, so a `uses:` step could in principle write the
 *     ledger without tripping it;
 *   * the "nothing else writes the ledger file" scan is literal-filename and
 *     line-based, so a computed spelling (`NAME=compat-run-ledger; … >
 *     "${NAME}.json"`) evades it.
 *
 * Neither is a laundering route in practice: `actions/upload-artifact` v4+
 * REJECTS a duplicate artifact name, so a second job cannot quietly replace the
 * `compat-run-ledger` this job uploads. What the guards do close is the whole
 * class that costs nothing to reach by accident — a skipped or unfailable step,
 * a relocated output path, a re-inlined computation.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The artifact filename. Exported so the workflow's upload path is one fact. */
export const DEFAULT_OUT_FILE = 'compat-run-ledger.json';

/** Where the `shard-ledger` job downloads the per-shard summaries. */
export const DEFAULT_SUMMARY_DIR = 'summaries';

/** Where it downloads the night's frozen-set fingerprint (#545 S1). */
export const DEFAULT_FINGERPRINT_FILE = 'fingerprint/compat-window-fingerprint.json';

/**
 * @typedef {object} ShardRow
 * @property {string} shard              `N/M` as run-tests.js was invoked with.
 * @property {'reported'|'missing'} status
 * @property {string} [runtime]
 * @property {string} [runtimeVersion]
 * @property {string} [ref]
 * @property {number|null} [passed]
 * @property {number|null} [failed]
 * @property {number|null} [notRun]
 * @property {number} [excluded]
 * @property {number} [expectedTotal]    Selected-test count for the shard.
 * @property {boolean} [truncated]
 * @property {string} [note]
 * @property {Array<{file:string,kind:string,timeoutMs?:number,cases?:string[]}>} [failures]
 * @property {string[]} [notRunFiles]
 */

/**
 * @typedef {object} Ledger
 * @property {string|undefined} runId
 * @property {string|undefined} runAttempt
 * @property {string|undefined} event
 * @property {string} lane
 * @property {string|null} ref
 * @property {string|null} windowFingerprint
 * @property {unknown} windowFingerprintComponents
 * @property {unknown} windowFingerprintPackages
 * @property {unknown} suiteProvenance
 * @property {number|null} shardsExpected
 * @property {number} shardsSeen
 * @property {string[]} missingShards
 * @property {boolean} complete
 * @property {ShardRow[]} shards
 */

/**
 * Parse a `N/M` shard id. Returns null for anything else — a malformed id is
 * reported, never coerced into a number that happens to parse.
 *
 * @param {unknown} raw
 * @returns {{index:number,total:number}|null}
 */
export function parseShardId(raw) {
  const m = /^(\d+)\/(\d+)$/.exec(String(raw ?? ''));
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1) return null;
  return { index, total };
}

/**
 * Parse the DECLARED shard total. Fails closed: anything that is not a positive
 * integer yields null, and null is an error rather than a fallback.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseShardTotal(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const missingRow = (shard) => ({
  shard,
  status: /** @type {'missing'} */ ('missing'),
  passed: null,
  failed: null,
  notRun: null,
  note:
    'NO compat-suite-summary artifact was uploaded for this shard — the job produced no result ' +
    '(runner loss or cancellation: an `if: always()` step does not run when a job is cancelled). ' +
    'This is NOT a green shard.',
});

/**
 * Build the run ledger and every reason it must fail the job.
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} input.shards Parsed `compat-suite-summary-*.json` contents.
 * @param {unknown} input.shardTotal               The DECLARED total (COMPAT_SHARD_TOTAL).
 * @param {any} [input.fingerprint]                Parsed compat-window-fingerprint.json, or null.
 * @param {string} [input.runId]
 * @param {string} [input.runAttempt]
 * @param {string} [input.event]
 * @returns {{ledger:Ledger, errors:string[], redDetail:string, table:string}}
 */
export function buildLedger({ shards, shardTotal, fingerprint, runId, runAttempt, event }) {
  /** @type {string[]} */
  const errors = [];
  // Problems that make the SHARD SET untrustworthy, as opposed to the other
  // floors (fingerprint, empty selection) which are about a set that is itself
  // complete. `complete` is the shard-set verdict, so only these clear it.
  /** @type {string[]} */
  const structural = [];
  /** Record a shard-set problem: it is an error AND it clears `complete`. */
  const structuralError = (message) => {
    structural.push(message);
    errors.push(message);
  };
  const observed = [...(shards ?? [])];
  const expected = parseShardTotal(shardTotal);

  if (expected === null) {
    structuralError(
      `COMPAT_SHARD_TOTAL is not a positive integer (got ${JSON.stringify(shardTotal ?? null)}) — ` +
        'the ledger REFUSES to infer the expected shard count from the artifacts that arrived: ' +
        'that inference is the #695 defect, since fifteen arriving shards would "declare" fifteen ' +
        'and reconcile perfectly.',
    );
  }

  // ── Classify every observed summary against the declaration ────────────────
  /** @type {Map<number, Record<string, any>>} */
  const byIndex = new Map();
  for (const summary of observed) {
    const id = parseShardId(summary?.shard);
    if (!id) {
      structuralError(
        `malformed shard id ${JSON.stringify(summary?.shard ?? null)} in a shard summary` +
          // The FILE, when the row came from an unreadable artifact: triage
          // otherwise has to guess which of sixteen uploads was damaged.
          `${summary?.readError ? ` (unreadable artifact — ${summary.readError})` : ''} — a row ` +
          'that cannot be placed against the matrix is never silently dropped.',
      );
      continue;
    }
    if (expected !== null && id.total !== expected) {
      structuralError(
        `shard ${summary.shard} declares a total of ${id.total}, but this run declares ` +
          `${expected} — run-tests.js was sharded against a different denominator than the ` +
          'ledger reconciles against.',
      );
    }
    if (expected !== null && id.index > expected) {
      structuralError(
        `shard ${summary.shard} is outside the declared range 1..${expected} — an unexpected ` +
          'shard cannot count toward a complete run.',
      );
      continue;
    }
    if (byIndex.has(id.index)) {
      structuralError(
        `duplicate shard summary for ${summary.shard} — two artifacts for one shard cannot buy a ` +
          'full house.',
      );
      continue;
    }
    byIndex.set(id.index, summary);
  }

  // ── Reconcile: every expected shard gets a row, present or not ─────────────
  /** @type {string[]} */
  const missingShards = [];
  /** @type {ShardRow[]} */
  const rows = [];
  if (expected !== null) {
    for (let i = 1; i <= expected; i += 1) {
      const summary = byIndex.get(i);
      if (summary) {
        rows.push({ ...summary, status: /** @type {'reported'} */ ('reported') });
      } else {
        const id = `${i}/${expected}`;
        missingShards.push(id);
        rows.push(missingRow(id));
      }
    }
  } else {
    for (const summary of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      rows.push({ ...summary[1], status: /** @type {'reported'} */ ('reported') });
    }
  }

  const seen = byIndex.size;
  if (expected !== null && missingShards.length > 0) {
    structuralError(
      `shard-count reconciliation FAILED — the matrix declares ${expected} shard(s) and only ` +
        `${seen} reported: missing ${missingShards.join(', ')}. A shard that produced no summary ` +
        'is NOT green; it produced no result at all (#695). Triage the job log NOW — it expires ' +
        'long before this artifact does.',
    );
  }

  // The lane is READ from the shards' own artifacts, never inferred from cron
  // timing (#545: the two schedules are 90 minutes apart on the same ref, so a
  // timing heuristic would launder a bun red into the node credential lane's
  // flake rate).
  const reported = rows.filter((r) => r.status === 'reported');
  const lanes = [...new Set(reported.map((s) => s.runtime))];
  const lane = lanes.length === 1 ? String(lanes[0]) : `mixed(${lanes.join('+')})`;

  // `complete` is the SHARD-SET verdict, and it is cleared by every structural
  // problem — not only by a missing shard. A duplicate, an out-of-range id, a
  // malformed id or a denominator that disagrees with the declaration all mean
  // the set does not correspond to the matrix, and each of them can otherwise
  // make `seen === expected` arithmetically true over the wrong rows.
  const complete = expected !== null && seen === expected && structural.length === 0;

  /** @type {Ledger} */
  const ledger = {
    runId,
    runAttempt,
    event,
    lane,
    ref: reported[0]?.ref ?? null,
    windowFingerprint: fingerprint?.fingerprint ?? null,
    windowFingerprintComponents: fingerprint?.components ?? null,
    windowFingerprintPackages: fingerprint?.packages ?? null,
    // RECORDED, NOT FROZEN (#574 architect gate): the resolved next.js commit +
    // next-tarball digest. They do not feed the fingerprint — a suite bump must
    // be a visible decision, not a silent reset — but the window log needs them
    // to tell "the suite moved" apart from "knext moved" when a night behaves
    // differently at a stable digest.
    suiteProvenance: fingerprint?.recorded?.suite ?? null,
    shardsExpected: expected,
    shardsSeen: seen,
    missingShards,
    complete,
    shards: rows,
  };

  // ── The pre-existing floors (#545), unchanged in meaning ───────────────────
  if (seen === 0) {
    errors.push('no shard summaries at all — the run produced no ledger; that is NOT green');
  }
  if (!ledger.windowFingerprint) {
    errors.push(
      'no compat-window fingerprint recorded for this run — the frozen set (workflow + ' +
        'scripts/e2e-* + deploy manifest + the packed @getknext/* closure) has no digest, so this ' +
        'night cannot count toward the v1.0 14-night window. See ' +
        'scripts/compat-window-fingerprint.mjs and the build-next job.',
    );
  }
  // A shard reporting failed:0/notRun:0 over ZERO executed tests is not green,
  // it is empty. The per-shard gate already rejects a TRUNCATED shard; this
  // rejects the other end: a shard whose selection was empty in the first place.
  const empty = reported.filter((s) => (s.passed ?? 0) + (s.failed ?? 0) + (s.notRun ?? 0) === 0);
  if (empty.length > 0) {
    errors.push(
      `per-shard test-count floor violated — shard(s) ${empty.map((s) => s.shard).join(', ')} ` +
        'reported ZERO executed tests. A pass count of 0 is buyable and must never count toward ' +
        'the v1.0 streak.',
    );
  }

  return { ledger, errors, redDetail: renderRedDetail(ledger), table: renderTable(ledger) };
}

/**
 * The job-summary table: one row per EXPECTED shard, missing ones included.
 *
 * @param {Ledger} ledger
 * @returns {string}
 */
export function renderTable(ledger) {
  const rows = ledger.shards.map((s) => {
    if (s.status === 'missing') {
      return `| ${s.shard} | — | MISSING | MISSING | MISSING | — | **no summary artifact — the shard produced NO result** |`;
    }
    const named = (s.failures ?? [])
      .map((f) => `${f.file} [${f.kind}${f.timeoutMs !== undefined ? ` ${f.timeoutMs}ms` : ''}]`)
      .join('<br>');
    return `| ${s.shard} | ${s.runtime}${s.runtimeVersion ? ` ${s.runtimeVersion}` : ''} | ${s.passed} | ${s.failed} | ${s.notRun} | ${s.expectedTotal ?? 'n/a'} | ${named || '—'} |`;
  });
  return [
    `### Compat per-shard ledger — lane \`${ledger.lane}\`, ref \`${ledger.ref}\``,
    '',
    `shards: ${ledger.shardsSeen} reported of ${ledger.shardsExpected ?? 'UNDECLARED'} expected — ` +
      `${ledger.complete ? 'COMPLETE' : `INCOMPLETE (missing ${ledger.missingShards.join(', ') || 'n/a'})`}`,
    '',
    `frozen-set fingerprint: \`${ledger.windowFingerprint ?? 'MISSING'}\``,
    '',
    `suite provenance (recorded, NOT frozen): next.js \`${ledger.suiteProvenance?.nextJsCommit ?? 'n/a'}\` (ref \`${ledger.suiteProvenance?.nextRef ?? 'n/a'}\`), next tarball sha256 \`${ledger.suiteProvenance?.nextTarballSha256 ?? 'n/a'}\``,
    '',
    '| shard | lane | passed | failed | notRun | expected | named failures |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * The detail the red alert quotes, so a red night's ISSUE names the tests — and,
 * since #695, names the shards that reported nothing at all.
 *
 * @param {Ledger} ledger
 * @returns {string}
 */
export function renderRedDetail(ledger) {
  const missing = ledger.shards
    .filter((s) => s.status === 'missing')
    .map(
      (s) =>
        `  - shard ${s.shard}: **NO SUMMARY ARTIFACT** — the shard job produced no result ` +
        '(runner loss / cancellation). This is NOT a green shard; its job log expires long ' +
        'before this ledger does, so triage it now.',
    );
  const red = ledger.shards
    .filter((s) => s.status === 'reported' && ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0))
    .map((s) => {
      const named = (s.failures ?? [])
        .map(
          (f) =>
            `    - \`${f.file}\` kind=${f.kind}${f.timeoutMs !== undefined ? ` timeoutMs=${f.timeoutMs}` : ''}${f.cases?.length ? ` — ${f.cases.join('; ')}` : ''}`,
        )
        .join('\n');
      const phantom = (s.notRunFiles ?? [])
        .map((f) => `    - \`${f}\` (jest infra abort, never ran)`)
        .join('\n');
      return `  - shard ${s.shard} (${s.runtime}): failed=${s.failed} notRun=${s.notRun}\n${[named, phantom].filter(Boolean).join('\n')}`;
    });
  return [...missing, ...red].join('\n');
}

/**
 * Read every `compat-suite-summary*.json` the download step landed.
 *
 * A DAMAGED artifact must not kill the process. `JSON.parse` mapped over the
 * directory threw before the ledger was ever written, so a truncated or
 * zero-byte upload produced a stack trace and NO evidence at all — the #695
 * property ("the emitted ledger records expected, seen and missing") unmet on
 * exactly the path where an artifact is damaged. The inconsistency gave it
 * away: a summary whose content was literal `null` was already handled
 * gracefully (malformed id → a `missing` row), while a zero-byte file crashed.
 *
 * So every file is parsed under its own guard, and a file that cannot be read,
 * cannot be parsed, or does not parse to an object becomes a synthetic row
 * carrying `readError`. It then travels the malformed-id path — reported,
 * NAMED, and unable to occupy the shard it claims.
 */
export function readSummaries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('compat-suite-summary') && f.endsWith('.json'))
    .map((f) => {
      try {
        const parsed = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { shard: null, readError: `${f}: parsed to ${typeof parsed}, not an object` };
        }
        return parsed;
      } catch (err) {
        return { shard: null, readError: `${f}: ${err instanceof Error ? err.message : err}` };
      }
    });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const summaryDir = process.env.SUMMARY_DIR || DEFAULT_SUMMARY_DIR;
  const fingerprintFile = process.env.FINGERPRINT_FILE || DEFAULT_FINGERPRINT_FILE;
  const outFile = process.env.OUT_FILE || DEFAULT_OUT_FILE;

  const { ledger, errors, redDetail, table } = buildLedger({
    shards: readSummaries(summaryDir),
    shardTotal: process.env.COMPAT_SHARD_TOTAL,
    // #545 (S1) — the frozen-set fingerprint for THIS night, READ from the
    // artifact the build-next job wrote and never recomputed here: the shard
    // jobs run against the workspace that job packed, so recomputing from a
    // fresh checkout would fingerprint a tree the run never used.
    fingerprint: existsSync(fingerprintFile)
      ? JSON.parse(readFileSync(fingerprintFile, 'utf8'))
      : null,
    runId: process.env.RUN_ID,
    runAttempt: process.env.RUN_ATTEMPT,
    event: process.env.EVENT_NAME,
  });

  // WRITE FIRST, ALWAYS. The upload step is `if: always()`, so an INCOMPLETE
  // ledger is still retained — the evidence of a broken night has to survive
  // the job that fails on it.
  writeFileSync(outFile, `${JSON.stringify(ledger, null, 2)}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `red_detail<<KNEXT_EOF\n${redDetail || '  (no shard summary carried named failures — check the job logs)'}\nKNEXT_EOF\n`,
    );
  }

  console.log(table);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
}
