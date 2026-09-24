#!/usr/bin/env node
/**
 * The vinext-lane quarantine ledger (#1321; design approved on the issue).
 *
 * The vinext × bun compiled-exec lane runs the node lane's corpus UNCHANGED —
 * its denominator stays 778 and `tests/compat-vinext-lane.test.ts` forbids it
 * narrowing the shared manifest. So this ledger never removes a test from the
 * run. It RECLASSIFIES after the run: a failure matching a live entry moves from
 * `failures` into `quarantined`, and the shard's `failed` count drops by the
 * files that no longer have a failing case. `passed`, `notRun`, `excluded`,
 * `expectedTotal` and `truncated` are never touched.
 *
 * Founder constraints (recorded on #1321), enforced by `validateLedger`:
 *   - at most 15 files per lane;
 *   - every entry is dated: `added` and `expires`, at most 30 days apart, and it
 *     is invalid (the run reds) once today is past `expires`. No version-only
 *     expiry;
 *   - a whole-file entry names the unsupported FEATURE and links the UPSTREAM
 *     issue;
 *   - a flaky entry is per-case, with mixed evidence (a failing and a passing run);
 *   - a ledgered failure that stops failing reds the run (`staleEntries`), so the
 *     ledger only ever shrinks on evidence.
 *
 * Deliberately NOT named `e2e-*` and NOT under `test/deploy-tests-manifest.*`:
 * those patterns are the shared half of every cell's compat-window fingerprint,
 * and matching them would reset the node lanes' 14-night windows for a change
 * that only concerns the vinext lane.
 *
 * CLI (dependency-free, plain Node):
 *   node scripts/compat-vinext-ledger.mjs apply  --ledger <json> --summary <shard-summary.json>
 *     validates the ledger, rewrites the summary in place (exit 1 if invalid)
 *   node scripts/compat-vinext-ledger.mjs report --ledger <json> --summaries <dir>
 *     validates, fails on stale entries, prints the published number (exit 1 on either)
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
    if (e.scope !== 'file' && e.scope !== 'cases')
      out.push(`${at}: scope must be "file" or "cases"`);
    if (e.scope === 'cases' && !nonEmpty(e.cases))
      out.push(`${at}: a per-case entry must list its cases`);
    if (e.scope === 'file') {
      if (typeof e.feature !== 'string' || !e.feature.trim())
        out.push(`${at}: a whole-file entry must name the unsupported feature`);
      if (typeof e.upstream !== 'string' || !UPSTREAM_RE.test(e.upstream))
        out.push(`${at}: a whole-file entry must link its upstream issue`);
    } else if (e.upstream !== undefined && !UPSTREAM_RE.test(String(e.upstream))) {
      out.push(`${at}: upstream must be an issue or pull request URL`);
    }
    if (!nonEmpty(e.evidence?.fail))
      out.push(`${at}: evidence.fail must list at least one failing run`);
    if (e.class === 'flaky') {
      if (e.scope !== 'cases') out.push(`${at}: a flaky entry must be per-case`);
      if (!nonEmpty(e.evidence?.pass) || !nonEmpty(e.evidence?.fail))
        out.push(`${at}: a flaky entry needs mixed evidence (a failing run AND a passing run)`);
    }
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
 * Reclassify one shard summary. Pure: returns a new object. Idempotent: an
 * already-applied summary has no remaining matching failures.
 * @param {any} summary
 * @param {any[]} entries
 */
export function applyLedger(summary, entries) {
  const byTest = new Map(entries.map((e) => [e.test, e]));
  const quarantined = [...(summary.quarantined ?? [])];
  const failures = [];
  for (const f of summary.failures ?? []) {
    const e = byTest.get(f.file);
    if (!e) {
      failures.push(f);
      continue;
    }
    const cases = f.cases ?? [];
    const matched = e.scope === 'file' ? cases : cases.filter((c) => e.cases.includes(c));
    const rest = e.scope === 'file' ? [] : cases.filter((c) => !e.cases.includes(c));
    if (matched.length > 0 || e.scope === 'file') {
      const rec = { file: f.file, cases: matched, class: e.class };
      if (e.upstream) rec.upstream = e.upstream;
      quarantined.push(rec);
    }
    if (e.scope === 'cases' && (rest.length > 0 || cases.length === 0))
      failures.push({ ...f, cases: rest });
  }
  return { ...summary, failures, failed: failures.length, quarantined };
}

/**
 * Entries (or per-case parts) that matched no failure anywhere in the run.
 * A file that did not run (notRunFiles) is never called stale: no result is
 * not a pass.
 * @param {any[]} summaries applied shard summaries
 * @param {any[]} entries
 */
export function staleEntries(summaries, entries) {
  const q = summaries.flatMap((s) => s.quarantined ?? []);
  const notRun = new Set(summaries.flatMap((s) => s.notRunFiles ?? []));
  const out = [];
  for (const e of entries) {
    if (notRun.has(e.test)) continue;
    const hits = q.filter((r) => r.file === e.test);
    if (e.scope === 'file') {
      if (hits.length === 0) out.push({ test: e.test });
    } else {
      const seenCases = new Set(hits.flatMap((r) => r.cases));
      const missing = e.cases.filter((c) => !seenCases.has(c));
      if (missing.length) out.push({ test: e.test, cases: missing });
    }
  }
  return out;
}

/** The published number: passed / failed / quarantined files over the unchanged total. */
export function publishedNumber(summaries) {
  const sum = (k) => summaries.reduce((n, s) => n + (s[k] ?? 0), 0);
  const quarantined = new Set(summaries.flatMap((s) => (s.quarantined ?? []).map((r) => r.file)));
  // A file with a quarantined case AND a remaining failing case counts once, as failed.
  const stillFailing = new Set(summaries.flatMap((s) => (s.failures ?? []).map((f) => f.file)));
  const q = [...quarantined].filter((f) => !stillFailing.has(f)).length;
  const passed = sum('passed');
  const failed = sum('failed');
  const notRun = sum('notRun');
  return { passed, failed, quarantined: q, notRun, total: passed + failed + q + notRun };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
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
  const ledgerPath = arg(argv, 'ledger');
  if (!ledgerPath || (cmd !== 'apply' && cmd !== 'report')) {
    console.error(
      'usage: compat-vinext-ledger.mjs apply --ledger <json> --summary <file> | report --ledger <json> --summaries <dir>',
    );
    return 2;
  }
  const { ledger, errors } = loadLedger(ledgerPath);
  if (errors.length) {
    for (const e of errors) console.error(`::error::vinext quarantine ledger — ${e}`);
    return 1;
  }
  if (cmd === 'apply') {
    const path = arg(argv, 'summary');
    const before = JSON.parse(readFileSync(path, 'utf8'));
    const after = applyLedger(before, ledger.entries);
    writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
    for (const r of after.quarantined)
      console.log(`quarantined (${r.class}) ${r.file}${r.upstream ? ` — ${r.upstream}` : ''}`);
    console.log(
      `shard ${after.shard}: failed ${before.failed} -> ${after.failed}, quarantined ${after.quarantined.length}`,
    );
    return 0;
  }
  const dir = arg(argv, 'summaries');
  const summaries = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /compat-suite-summary-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
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
      `::error::stale quarantine entry — ${s.test}${s.cases ? ` (cases: ${s.cases.join(' | ')})` : ''} did not fail in this run; remove it from ${ledgerPath}`,
    );
  }
  return stale.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
