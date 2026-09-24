#!/usr/bin/env node
/**
 * The vinext-lane quarantine ledger (#1321; design approved on the issue).
 *
 * The vinext × bun compiled-exec lane runs the node lane's corpus UNCHANGED —
 * its denominator stays 778 and `tests/compat-vinext-lane.test.ts` forbids it
 * narrowing the shared manifest. So this ledger never removes a test from the
 * run. It RECLASSIFIES after the run, at CASE granularity: every entry carries
 * a `cases` snapshot (generated from evidence runs by `refresh`), and only those
 * failing cases move from `failures` into `quarantined`.
 *
 *   - a snapshot case that did not fail anywhere in the run → the entry is STALE
 *     and the run reds (a partial fix cannot stay hidden);
 *   - a failing case NOT in the snapshot → stays a real failure (a new
 *     regression in a ledgered file is never absorbed);
 *   - a file that failed with no case detail (a build/unclassified failure) →
 *     stays a real failure and is not called stale (no result is not a pass).
 *
 * `failed` is only ever DECREASED by the files whose every failing case was
 * quarantined, from the summary's own count. If a shard reports `failed > 0`
 * without a matching per-file `failures` list (the no-marker path of
 * e2e-summary.mjs), nothing is reclassified: without names there is nothing to
 * match, and rebuilding the count from a missing list would turn a red shard
 * green.
 *
 * Founder constraints (recorded on #1321), enforced by `validateLedger`:
 *   - at most 15 files per lane;
 *   - every entry is dated: `added` and `expires`, at most 30 days apart, and it
 *     is invalid (the run reds) once today is past `expires`. No version-only
 *     expiry;
 *   - an `unsupported` entry names the unsupported FEATURE and links the
 *     UPSTREAM issue;
 *   - a `flaky` entry carries mixed evidence (a failing and a passing run).
 *
 * Deliberately NOT named `e2e-*` and NOT under `test/deploy-tests-manifest.*`:
 * those patterns are the shared half of every cell's compat-window fingerprint.
 * The bun-vinext cell declares both files in its own `extraFiles`.
 *
 * CLI (dependency-free, plain Node):
 *   apply   --ledger <json> --summary <shard-summary.json>
 *           validates the ledger, rewrites the summary in place (exit 1 if invalid)
 *   report  --ledger <json> --summaries <dir>
 *           validates, fails on stale entries, prints the published number
 *   refresh --ledger <json> --summaries <run-dir> [--summaries <run-dir> …]
 *           regenerates every entry's `cases` snapshot as the cases that failed
 *           in EVERY given run that reported case names for that file
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_FILE_CAP = 15;
export const MAX_EXPIRY_DAYS = 30;
export const LANES = ['bun-vinext'];
export const CLASSES = ['unsupported', 'flaky'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPSTREAM_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/;
const TEST_PATH_RE = /^test\/.+\.test\.(ts|tsx|js|mjs)$/;

function days(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
const isDate = (d) =>
  typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const nonEmpty = (a) =>
  Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x);

/**
 * @param {any} ledger
 * @param {{ today: string, corpusExcludes?: string[] }} ctx
 * @returns {string[]} every violation; empty means valid
 */
export function validateLedger(ledger, ctx) {
  const out = [];
  if (!ledger || typeof ledger !== 'object') return ['ledger is not an object'];
  if (!LANES.includes(ledger.lane))
    out.push(`unknown lane ${JSON.stringify(ledger.lane)} (allowed: ${LANES.join(', ')})`);
  const entries = Array.isArray(ledger.entries) ? ledger.entries : null;
  if (!entries) return [...out, 'entries is not an array'];
  const files = new Set(entries.map((e) => e?.test));
  if (files.size > LEDGER_FILE_CAP)
    out.push(`${files.size} files ledgered; the cap is ${LEDGER_FILE_CAP} per lane`);
  const excludes = new Set(ctx.corpusExcludes ?? []);
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    const at = `entry ${i} (${e?.test ?? '?'})`;
    if (!e || typeof e !== 'object') {
      out.push(`${at}: not an object`);
      continue;
    }
    if (typeof e.test !== 'string' || !TEST_PATH_RE.test(e.test))
      out.push(`${at}: test path must look like test/….test.ts`);
    if (seen.has(e.test)) out.push(`${at}: duplicate test`);
    seen.add(e.test);
    if (excludes.has(e.test))
      out.push(
        `${at}: excluded from the corpus by the manifest; a ledger entry cannot cover a test that never runs`,
      );
    if (!CLASSES.includes(e.class))
      out.push(`${at}: unknown class ${JSON.stringify(e.class)} (allowed: ${CLASSES.join(', ')})`);
    if (!nonEmpty(e.cases))
      out.push(`${at}: cases must list the failing case snapshot (regenerate it with \`refresh\`)`);
    else if (new Set(e.cases).size !== e.cases.length) out.push(`${at}: cases has duplicates`);
    if (e.class === 'unsupported') {
      if (typeof e.feature !== 'string' || !e.feature.trim())
        out.push(`${at}: an unsupported entry must name the unsupported feature`);
      if (typeof e.upstream !== 'string' || !UPSTREAM_RE.test(e.upstream))
        out.push(`${at}: an unsupported entry must link its upstream issue`);
    } else if (e.upstream !== undefined && !UPSTREAM_RE.test(String(e.upstream))) {
      out.push(`${at}: upstream must be an issue or pull request URL`);
    }
    if (!nonEmpty(e.evidence?.fail))
      out.push(`${at}: evidence.fail must list at least one failing run`);
    if (e.class === 'flaky' && (!nonEmpty(e.evidence?.pass) || !nonEmpty(e.evidence?.fail)))
      out.push(`${at}: a flaky entry needs mixed evidence (a failing run AND a passing run)`);
    if (e.added === undefined) out.push(`${at}: missing added date`);
    else if (!isDate(e.added)) out.push(`${at}: added is not a YYYY-MM-DD date`);
    if (e.expires === undefined)
      out.push(`${at}: missing expires date (a date is mandatory; no version-only expiry)`);
    else if (!isDate(e.expires)) out.push(`${at}: expires is not a YYYY-MM-DD date`);
    if (isDate(e.added) && isDate(e.expires)) {
      const span = days(e.added, e.expires);
      if (span < 0) out.push(`${at}: expires before it was added`);
      if (span > MAX_EXPIRY_DAYS)
        out.push(
          `${at}: expires ${span} days after it was added; the maximum is ${MAX_EXPIRY_DAYS} days`,
        );
      if (isDate(ctx.today) && days(e.expires, ctx.today) > 0)
        out.push(`${at}: expired on ${e.expires} (renew with fresh evidence or remove it)`);
    }
  }
  return out;
}

/**
 * Reclassify one shard summary at case granularity. Pure (returns a new
 * object) and idempotent. Fails closed: a summary whose `failures` list does
 * not account for its `failed` count is returned unreclassified, with the
 * reason in `ledgerSkipped`.
 * @param {any} summary
 * @param {any[]} entries
 */
export function applyLedger(summary, entries) {
  const failed = summary.failed ?? 0;
  const listed = Array.isArray(summary.failures) ? summary.failures : null;
  const prior = summary.quarantined ?? [];
  if (failed > 0 && (!listed || listed.length !== failed)) {
    return {
      ...summary,
      quarantined: prior,
      ledgerSkipped:
        `failed=${failed} but the summary lists ${listed ? listed.length : 'no'} per-file failures; ` +
        'nothing can be matched by name, so nothing was reclassified',
    };
  }
  const byTest = new Map(entries.map((e) => [e.test, e]));
  const quarantined = [...prior];
  const failures = [];
  let removed = 0;
  for (const f of listed ?? []) {
    const e = byTest.get(f.file);
    const cases = f.cases ?? [];
    if (!e || cases.length === 0) {
      failures.push(f); // not ledgered, or a file-level failure with no case detail
      continue;
    }
    const matched = cases.filter((c) => e.cases.includes(c));
    const rest = cases.filter((c) => !e.cases.includes(c));
    if (matched.length > 0) {
      const rec = { file: f.file, cases: matched, class: e.class };
      if (e.upstream) rec.upstream = e.upstream;
      quarantined.push(rec);
    }
    if (rest.length > 0) failures.push({ ...f, cases: rest });
    else removed += 1;
  }
  return { ...summary, failures, failed: failed - removed, quarantined };
}

/**
 * Snapshot cases that did not fail anywhere in the run. A file that did not run
 * (notRunFiles), or failed with no case detail, is not called stale: no result
 * is not a pass.
 * @param {any[]} summaries applied shard summaries
 * @param {any[]} entries
 */
export function staleEntries(summaries, entries) {
  const q = summaries.flatMap((s) => s.quarantined ?? []);
  const notRun = new Set(summaries.flatMap((s) => s.notRunFiles ?? []));
  const noDetail = new Set(
    summaries.flatMap((s) =>
      (s.failures ?? []).filter((f) => !(f.cases ?? []).length).map((f) => f.file),
    ),
  );
  const skipped = summaries.some((s) => s.ledgerSkipped);
  const out = [];
  if (skipped) return out; // an unreclassified shard cannot prove anything passed
  for (const e of entries) {
    if (notRun.has(e.test) || noDetail.has(e.test)) continue;
    const seen = new Set(q.filter((r) => r.file === e.test).flatMap((r) => r.cases));
    const missing = e.cases.filter((c) => !seen.has(c));
    if (missing.length) out.push({ test: e.test, cases: missing });
  }
  return out;
}

/** The published number: passed / failed / quarantined files over the unchanged total. */
export function publishedNumber(summaries) {
  const sum = (k) => summaries.reduce((n, s) => n + (s[k] ?? 0), 0);
  const stillFailing = new Set(summaries.flatMap((s) => (s.failures ?? []).map((f) => f.file)));
  const quarantined = new Set(summaries.flatMap((s) => (s.quarantined ?? []).map((r) => r.file)));
  const q = [...quarantined].filter((f) => !stillFailing.has(f)).length;
  const passed = sum('passed');
  const failed = sum('failed');
  const notRun = sum('notRun');
  return { passed, failed, quarantined: q, notRun, total: passed + failed + q + notRun };
}

/**
 * Regenerate every entry's `cases` snapshot: the cases that failed in EVERY
 * given run that reported case names for that file. A case failing in only some
 * runs is left out on purpose — it stays a real failure rather than a hidden one.
 * @param {any} ledger
 * @param {any[][]} runs one array of (unapplied) shard summaries per run
 * @returns {{ ledger: any, errors: string[] }}
 */
export function refreshSnapshots(ledger, runs) {
  const errors = [];
  const entries = ledger.entries.map((e) => {
    const perRun = runs
      .map((summaries) =>
        summaries
          .flatMap((s) => s.failures ?? [])
          .filter((f) => f.file === e.test && (f.cases ?? []).length),
      )
      .filter((fs) => fs.length > 0)
      .map((fs) => new Set(fs.flatMap((f) => f.cases)));
    if (perRun.length === 0) {
      errors.push(`${e.test}: no given run reports failing cases for it; it cannot be ledgered`);
      return e;
    }
    const cases = [...perRun[0]].filter((c) => perRun.every((s) => s.has(c))).sort();
    if (cases.length === 0) {
      errors.push(
        `${e.test}: no case failed in every run; it cannot be ledgered at case granularity`,
      );
      return e;
    }
    return { ...e, cases };
  });
  return { ledger: { ...ledger, entries }, errors };
}

function args(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out;
}

function readSummaries(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /compat-suite-summary-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function loadLedger(path) {
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = JSON.parse(
    readFileSync(resolve(path, '..', 'deploy-tests-manifest.knext.json'), 'utf8'),
  );
  const today = new Date().toISOString().slice(0, 10);
  const errors = validateLedger(ledger, { today, corpusExcludes: manifest.rules?.exclude ?? [] });
  return { ledger, errors };
}

function main(argv) {
  const [cmd] = argv;
  const [ledgerPath] = args(argv, 'ledger');
  if (!ledgerPath || !['apply', 'report', 'refresh'].includes(cmd)) {
    console.error(
      'usage: compat-vinext-ledger.mjs apply --ledger <json> --summary <file> | report --ledger <json> --summaries <dir> | refresh --ledger <json> --summaries <run-dir>…',
    );
    return 2;
  }
  if (cmd === 'refresh') {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const runs = args(argv, 'summaries').map(readSummaries);
    if (runs.length === 0 || runs.some((r) => r.length === 0)) {
      console.error(
        '::error::refresh needs at least one --summaries <run-dir> holding shard summaries',
      );
      return 1;
    }
    const { ledger: next, errors } = refreshSnapshots(ledger, runs);
    for (const e of errors) console.error(`::error::vinext quarantine ledger — ${e}`);
    if (errors.length) return 1;
    writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`refreshed ${next.entries.length} case snapshot(s) from ${runs.length} run(s)`);
    return 0;
  }
  const { ledger, errors } = loadLedger(ledgerPath);
  if (errors.length) {
    for (const e of errors) console.error(`::error::vinext quarantine ledger — ${e}`);
    return 1;
  }
  if (cmd === 'apply') {
    const [path] = args(argv, 'summary');
    const before = JSON.parse(readFileSync(path, 'utf8'));
    const after = applyLedger(before, ledger.entries);
    writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
    if (after.ledgerSkipped)
      console.error(`::warning::vinext quarantine ledger — ${after.ledgerSkipped}`);
    for (const r of after.quarantined)
      console.log(
        `quarantined (${r.class}) ${r.file} [${r.cases.join(' | ')}]${r.upstream ? ` — ${r.upstream}` : ''}`,
      );
    console.log(`shard ${after.shard}: failed ${before.failed} -> ${after.failed}`);
    return 0;
  }
  const [dir] = args(argv, 'summaries');
  const summaries = readSummaries(dir);
  if (summaries.length === 0) {
    console.error(
      '::error::vinext quarantine ledger — no shard summaries found; nothing is not green',
    );
    return 1;
  }
  const n = publishedNumber(summaries);
  const line = `vinext × bun: ${n.passed} passed / ${n.failed} failed / ${n.quarantined} quarantined (of ${n.total})`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Quarantine ledger\n\n${line}\n`);
  const stale = staleEntries(summaries, ledger.entries);
  for (const s of stale) {
    console.error(
      `::error::stale quarantine entry — ${s.test} (cases: ${s.cases.join(' | ')}) did not fail in this run; remove them from ${ledgerPath} or refresh the snapshot`,
    );
  }
  return stale.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
