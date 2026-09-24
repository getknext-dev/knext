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
 *     and the run reds (a partial fix cannot stay hidden). Unsupported entries
 *     only: a flaky entry passing is expected, and its expiry bounds it;
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
 *   - a `flaky` entry carries mixed evidence (a failing and a passing run, at
 *     least three runs in all), expires within 14 days, and at most 5 files may
 *     be flaky. Its stale rule is exempted per run (a pass is expected); the
 *     14-day expiry is what bounds it. `report --history-runs N` additionally
 *     judges each flaky entry over a WINDOW of the lane's own last N
 *     informative runs (this one plus its history): three failures in a row
 *     reds the run (broken, not flaky), three passes in a row reds it (stale).
 *     This is what stops a permanent regression hiding until the 14-day expiry;
 *   - evidence is per run with that run's failing cases, and every snapshot case
 *     must be covered by every failing evidence run — a snapshot cannot grow
 *     past its evidence; an unsupported entry needs at least two failing runs.
 *
 * Deliberately NOT named `e2e-*` and NOT under `test/deploy-tests-manifest.*`:
 * those patterns are the shared half of every cell's compat-window fingerprint.
 * The bun-vinext cell declares both files in its own `extraFiles`.
 *
 * ## The flaky window's history (#1355 review, both rounds)
 * "Informative" history is restricted to completed runs of THIS workflow, on
 * `main`, created ON OR AFTER the earliest flaky entry's `refreshed`/`added`
 * date (a run from before any flaky entry existed cannot be evidence for one
 * — round-2 finding 3), whose shard summaries all carry the DEFAULT
 * `nextjsRef` (a summary's own `ref` field — the same thing a dispatch with a
 * custom ref would change). That covers both the scheduled runs and a
 * workflow_dispatch rerun with default inputs, without needing to parse
 * dispatch inputs back out of the GitHub API. A run that is cancelled, still
 * running, too old, used a custom ref, or is missing a shard is simply NOT
 * informative — it contributes 'none' and history keeps looking further back
 * (backfill) rather than treating it as a for/against data point.
 *
 * A run whose artifacts are gone — genuinely never uploaded, OR expired past
 * GitHub's 90-day retention, both look identical: `gh run download` exits
 * non-zero with "no artifact matches any of the names or patterns provided"
 * — is likewise just NOT informative (`isNoArtifactError`, round-2 finding
 * 1). This is NOT an auth/API error and must never be classified as one: the
 * live bug this fixed was exactly that misclassification, which turned every
 * artifactless-or-expired history run into an UNCAUGHT throw that reddened
 * the whole lane, not a graceful backfill.
 *
 * Fetching a candidate run's summaries — or LISTING candidates in the first
 * place (round-2 finding 2: the common real failure, e.g. an expired/invalid
 * token, happens at `gh run list`, not per-run) — can fail on an auth/API
 * error (`isAuthOrApiError`: a token scope problem, a transient
 * 401/403/429/5xx from `gh`); that is a WARNING and the step is skipped, but
 * `MAX_CONSECUTIVE_HISTORY_SKIPS` such skips IN A ROW (listing and per-run
 * fetches share the SAME counter) fail CLOSED — the `report` command errors
 * out — rather than silently degrading to an ever-smaller window. A success
 * (a fetched, even if uninformative, run) resets the counter; consecutive is
 * consecutive. Only `GITHUB_REPOSITORY` being unset degrades softly with no
 * counter at all (there is nothing to list yet). **Not persisted across
 * separate `report` invocations** — each scheduled/dispatched run of this
 * workflow starts its counter at zero, so "3 consecutive" bounds a single
 * run's own history walk, not three separate nights of the lane failing in a
 * row. Cross-run persistence would need external state this script does not
 * have (no artifact/ledger field is a safe place to keep it); documented as
 * a known gap rather than solved here.
 *
 * The lane is WEEKLY (`compat-vinext.yml`'s schedule), while the flaky expiry
 * is 14 days — about two scheduled runs. A `report --history-runs 3` window
 * therefore usually has at most one or two informative scheduled runs before
 * an entry expires on its own; the window mostly matters for entries whose
 * evidence keeps getting refreshed past 14 days, or ones exercised by an
 * on-demand `workflow_dispatch` in between schedules. If that turns out to be
 * too thin to catch a permanent regression before expiry, a flaky-lane-only
 * dispatch cadence (e.g. a `17 7 * * 3` mid-week run of JUST the flaky files)
 * would close the gap — proposed here, NOT implemented; it needs its own
 * shard-count and cost tradeoff.
 *
 * CLI (dependency-free, plain Node):
 *   apply   --ledger <json> --summary <shard-summary.json>
 *           validates the ledger, rewrites the summary in place (exit 1 if invalid)
 *   report  --ledger <json> --summaries <dir> [--history-runs N]
 *           validates, fails on stale entries (and, with --history-runs, a
 *           broken/stale flaky window), prints the published number
 *   refresh --ledger <json> --run <run-id>=<run-dir> --run <run-id>=<run-dir> [...]
 *           (at least two runs) regenerates every entry's `cases` snapshot as the
 *           cases that failed in EVERY run (a run where the file passed empties
 *           it, so the entry is refused) and writes the per-run evidence used
 *   verify  --ledger <json>
 *           re-derives every entry from the runs its evidence cites (each run's
 *           branch, workflow path, ref and full shard set checked via `gh api`)
 *           and fails on any mismatch, an unfetchable run, or an incomplete
 *           shard set (a missing shard is NEVER counted as a pass). ADVISORY
 *           ONLY — `compat-vinext-ledger-verify.yml` is not a required check,
 *           so it cannot by itself block a merge; treat a red run there as a
 *           signal to fix the ledger, not as a gate. Every evidence run cited
 *           is downloaded from GitHub Actions artifacts, which are retained
 *           90 days: an entry whose evidence ages past that can no longer be
 *           verified (or refreshed from the SAME runs) and needs a fresh
 *           `refresh` against current runs before its next renewal.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_FILE_CAP = 15;
export const MAX_EXPIRY_DAYS = 30;
export const LANES = ['bun-vinext'];
export const CLASSES = ['unsupported', 'flaky'];
/** Design constraints for flaky entries (#1321 design, per-class cap and window). */
export const FLAKY_FILE_CAP = 5;
export const FLAKY_MAX_EXPIRY_DAYS = 14;
export const FLAKY_MIN_EVIDENCE_RUNS = 3;
/** A flaky entry failing, or passing, this many informative runs in a row is not flaky. */
export const FLAKY_WINDOW = 3;
/** The lane's workflow: its name (for `gh run list`) and its checked-out path (for `gh api`). */
export const LANE_WORKFLOW = 'compat-vinext.yml';
export const LANE_WORKFLOW_PATH = `.github/workflows/${LANE_WORKFLOW}`;
/** The pinned ref this lane's credentialed runs use (`compat-vinext.yml`'s default input). */
export const DEFAULT_NEXTJS_REF = 'v16.2.0';
/** Every shard must be present for a run to inform the flaky window or `verify`. */
export const EXPECTED_SHARD_TOTAL = 16;
/** Consecutive per-run history fetch failures (auth/API errors) before `report` fails closed. */
export const MAX_CONSECUTIVE_HISTORY_SKIPS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPSTREAM_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/;
const TEST_PATH_RE = /^test\/.+\.test\.(ts|tsx|js|mjs)$/;
const RUN_ID_RE = /^\d+$/;

function days(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
const isDate = (d) =>
  typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const nonEmpty = (a) =>
  Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x);

/**
 * Evidence is recorded per run, with the cases that run failed — written by
 * `refresh`, never by hand. It is what bounds the snapshot: every snapshot case
 * must have failed in EVERY recorded failing run, so a snapshot cannot grow past
 * its evidence (a hand-added case, or one seen in only some runs, is rejected).
 * @param {any} e
 * @param {string} at
 * @returns {string[]}
 */
function validateEvidence(e, at) {
  const out = [];
  const fail = e.evidence?.fail;
  if (!Array.isArray(fail) || fail.length === 0) {
    out.push(`${at}: evidence.fail must list the failing runs (regenerate it with \`refresh\`)`);
    if (e.class === 'flaky')
      out.push(`${at}: a flaky entry needs mixed evidence (a failing run AND a passing run)`);
    return out;
  }
  const wellFormed = fail.every(
    (r) => r && typeof r === 'object' && RUN_ID_RE.test(String(r.run)) && nonEmpty(r.cases),
  );
  if (!wellFormed) {
    out.push(
      `${at}: every evidence.fail item must be { run, cases } — a run id and the cases it failed`,
    );
    return out;
  }
  const runs = fail.map((r) => String(r.run));
  if (new Set(runs).size !== runs.length) out.push(`${at}: duplicate evidence run`);
  if (e.class === 'flaky') {
    if (!nonEmpty(e.evidence?.pass))
      out.push(`${at}: a flaky entry needs mixed evidence (a failing run AND a passing run)`);
    else if (e.evidence.pass.some((r) => runs.includes(String(r))))
      out.push(`${at}: an evidence run cannot have both passed and failed`);
    else if (runs.length + e.evidence.pass.length < FLAKY_MIN_EVIDENCE_RUNS)
      out.push(
        `${at}: a flaky entry needs at least three evidence runs (got ${runs.length} failing + ${e.evidence.pass.length} passing)`,
      );
  } else if (runs.length < 2) {
    out.push(`${at}: an unsupported entry needs at least two failing runs as evidence`);
  }
  if (nonEmpty(e.cases)) {
    for (const r of fail) {
      const missing = e.cases.filter((c) => !r.cases.includes(c));
      if (missing.length)
        out.push(
          `${at}: snapshot case(s) not covered by evidence run ${r.run} (the snapshot may not grow past its evidence): ${missing.join(' | ')}`,
        );
    }
  }
  return out;
}

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
  const flakyFiles = new Set(entries.filter((e) => e?.class === 'flaky').map((e) => e.test));
  if (flakyFiles.size > FLAKY_FILE_CAP)
    out.push(`${flakyFiles.size} flaky files ledgered; at most ${FLAKY_FILE_CAP} may be flaky`);
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
    out.push(...validateEvidence(e, at));
    if (e.added === undefined) out.push(`${at}: missing added date`);
    else if (!isDate(e.added)) out.push(`${at}: added is not a YYYY-MM-DD date`);
    if (e.expires === undefined)
      out.push(`${at}: missing expires date (a date is mandatory; no version-only expiry)`);
    else if (!isDate(e.expires)) out.push(`${at}: expires is not a YYYY-MM-DD date`);
    if (isDate(e.added) && isDate(e.expires)) {
      const span = days(e.added, e.expires);
      if (span < 0) out.push(`${at}: expires before it was added`);
      const max = e.class === 'flaky' ? FLAKY_MAX_EXPIRY_DAYS : MAX_EXPIRY_DAYS;
      if (span > max)
        out.push(
          `${at}: expires ${span} days after it was added; the maximum is ${max} days${e.class === 'flaky' ? ' for a flaky entry' : ''}`,
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
    // A flaky entry passing is expected, not evidence of a fix: applying the
    // stale rule to it would red every run where the flake happens to pass.
    // Its hard expiry (at most 14 days) is what bounds it.
    if (e.class === 'flaky') continue;
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
 * Where a file stands in one run: its failing cases, a pass, or no result.
 * @param {any[]} summaries one run's (unapplied) shard summaries
 * @param {string} test
 * @returns {{ state: 'fail', cases: string[] } | { state: 'pass' } | { state: 'none' }}
 */
function fileInRun(summaries, test) {
  if (summaries.some((s) => (s.notRunFiles ?? []).includes(test))) return { state: 'none' };
  const fs = summaries.flatMap((s) => s.failures ?? []).filter((f) => f.file === test);
  if (fs.length === 0) return { state: 'pass' };
  if (fs.some((f) => !(f.cases ?? []).length)) return { state: 'none' }; // no case detail
  return { state: 'fail', cases: [...new Set(fs.flatMap((f) => f.cases))].sort() };
}

/**
 * Regenerate every entry's `cases` snapshot and its evidence from at least two
 * runs. The snapshot is the INTERSECTION over every run: a run where the file
 * passed contributes the empty set, so an unsupported entry that passed anywhere
 * is refused rather than re-snapshotted (a regression can never be laundered in
 * as "the cases it fails now"). A run where the file did not run, or failed with
 * no case detail, is not evidence either way and is skipped. For a flaky entry,
 * passing runs are recorded as `evidence.pass` and the snapshot is the failing
 * runs' common cases. `refreshed` records the date; `added` (the expiry window's
 * anchor) is left alone.
 * @param {any} ledger
 * @param {{ id: string, summaries: any[] }[]} runs
 * @param {string} today
 * @returns {{ ledger: any, errors: string[] }}
 */
export function refreshSnapshots(ledger, runs, today) {
  const ids = runs.map((r) => String(r.id));
  if (runs.length < 2 || new Set(ids).size !== ids.length || !ids.every((i) => RUN_ID_RE.test(i)))
    return {
      ledger,
      errors: [
        `refresh needs at least two runs with distinct numeric run ids (got ${ids.join(', ') || 'none'})`,
      ],
    };
  const errors = [];
  const entries = ledger.entries.map((e) => {
    const seen = runs.map((r) => ({ run: String(r.id), ...fileInRun(r.summaries, e.test) }));
    const fail = seen.filter((r) => r.state === 'fail');
    const pass = seen.filter((r) => r.state === 'pass').map((r) => r.run);
    if (e.class !== 'flaky' && pass.length) {
      errors.push(
        `${e.test}: passed in run ${pass.join(', ')}; a passing run empties the snapshot — remove the entry`,
      );
      return e;
    }
    const flakyShort =
      fail.length < 1 || pass.length < 1 || fail.length + pass.length < FLAKY_MIN_EVIDENCE_RUNS;
    if (e.class === 'flaky' ? flakyShort : fail.length < 2) {
      errors.push(
        e.class === 'flaky'
          ? `${e.test}: a flaky entry needs a failing and a passing run, and at least three runs in all, among those given`
          : `${e.test}: needs at least two failing runs with case detail (got ${fail.length}); it cannot be ledgered`,
      );
      return e;
    }
    const cases = fail[0].cases.filter((c) => fail.every((r) => r.cases.includes(c)));
    if (cases.length === 0) {
      errors.push(
        `${e.test}: no case failed in every run; it cannot be ledgered at case granularity`,
      );
      return e;
    }
    const evidence = { fail: fail.map((r) => ({ run: r.run, cases: r.cases })) };
    if (e.class === 'flaky') evidence.pass = pass;
    return { ...e, cases, evidence, refreshed: today };
  });
  return { ledger: { ...ledger, entries }, errors };
}

/**
 * One line per shard whose reclassification was skipped (fail-closed), so the
 * run-level report repeats what each shard warned.
 * @param {any[]} summaries applied shard summaries
 * @returns {string[]}
 */
export function skippedWarnings(summaries) {
  return summaries
    .filter((s) => s.ledgerSkipped)
    .map((s) => `shard ${s.shard}: ${s.ledgerSkipped}`);
}

/**
 * A run is informative for the flaky window (or citable by `verify`) only if
 * every one of its shard summaries is present, `builder:vinext`, and used the
 * DEFAULT nextjsRef — a custom-ref dispatch, or a run missing shards, is not
 * evidence either way (never a "pass").
 * @param {any[]} summaries one run's shard summaries (applied or not)
 * @returns {boolean}
 */
export function isCompleteDefaultRun(summaries) {
  return (
    Array.isArray(summaries) &&
    summaries.length === EXPECTED_SHARD_TOTAL &&
    summaries.every((s) => s.builder === 'vinext' && s.ref === DEFAULT_NEXTJS_REF)
  );
}

/**
 * How one flaky entry's snapshot cases fared in one run: 'fail' when any of
 * them failed (whether still in `failures` or already `quarantined`), 'pass'
 * when the file ran and none did, 'none' when the run says nothing (the file
 * did not run, failed with no case detail, or a shard skipped reclassification).
 * @param {any[]} summaries one run's shard summaries, applied or not
 * @param {any} e
 */
function flakyStatus(summaries, e) {
  if (summaries.length === 0) return 'none';
  if (summaries.some((s) => s.ledgerSkipped)) return 'none';
  if (summaries.some((s) => (s.notRunFiles ?? []).includes(e.test))) return 'none';
  const rows = summaries.flatMap((s) => [...(s.failures ?? []), ...(s.quarantined ?? [])]);
  const mine = rows.filter((r) => r.file === e.test);
  if (mine.some((r) => !(r.cases ?? []).length)) return 'none';
  const failed = new Set(mine.flatMap((r) => r.cases));
  return e.cases.some((c) => failed.has(c)) ? 'fail' : 'pass';
}

/**
 * Judge each flaky entry over its last FLAKY_WINDOW informative runs (oldest
 * first; the current run last). All failing: it is broken, not flaky, and must
 * be reclassified. All passing: it is stale and must be removed. The per-run
 * stale rule does not apply to flaky entries (a single pass is expected); this
 * window is what stops a permanent regression hiding until expiry.
 * @param {any[]} entries
 * @param {any[][]} runs one array of shard summaries per run, oldest first
 * @returns {{ broken: {test: string, runs: number}[], stale: {test: string, runs: number}[] }}
 */
export function flakyWindow(entries, runs) {
  const broken = [];
  const stale = [];
  for (const e of entries) {
    if (e.class !== 'flaky') continue;
    const informative = runs.map((r) => flakyStatus(r, e)).filter((st) => st !== 'none');
    const last = informative.slice(-FLAKY_WINDOW);
    if (last.length < FLAKY_WINDOW) continue;
    if (last.every((st) => st === 'fail')) broken.push({ test: e.test, runs: last.length });
    else if (last.every((st) => st === 'pass')) stale.push({ test: e.test, runs: last.length });
  }
  return { broken, stale };
}

/** True for errors that plausibly come from `gh`'s own auth/API layer, not a local bug. */
export function isAuthOrApiError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /\b(401|403|429|5\d\d)\b|authenticat|rate.?limit|could not resolve|gh: /i.test(msg);
}

/**
 * True when `gh run download` failed because the run simply has no matching
 * artifact — never uploaded (artifactless), or aged past GitHub's 90-day
 * retention (both produce the SAME message; `gh` does not distinguish them).
 * This is NEVER an auth/API error and must be checked FIRST: `gh: ` alone
 * would otherwise make `isAuthOrApiError` swallow it too, mis-tagging a
 * routine "nothing to see here" as a warning-worthy skip.
 */
export function isNoArtifactError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /no artifacts? (found|matches)/i.test(msg);
}

/**
 * The lane's previous runs on `main`, newest first, excluding the current
 * one — CANDIDATES only (any status/conclusion, any age); `collectHistory`
 * decides which are informative and backfills past the rest. `exec` runs `gh`.
 * @param {(args: string[]) => string} exec
 * @param {{ repo: string, currentRunId?: string, limit: number }} opts
 * @returns {{ id: string, status: string, createdAt: string }[]}
 */
export function previousRunCandidates(exec, { repo, currentRunId, limit }) {
  const out = exec([
    'run',
    'list',
    '--workflow',
    LANE_WORKFLOW,
    '--branch',
    'main',
    '--repo',
    repo,
    '--limit',
    String(limit),
    '--json',
    'databaseId,status,createdAt',
  ]);
  return /** @type {{databaseId: number, status: string, createdAt: string}[]} */ (JSON.parse(out))
    .filter((r) => String(r.databaseId) !== String(currentRunId))
    .map((r) => ({ id: String(r.databaseId), status: r.status, createdAt: r.createdAt }));
}

/** Download one run's lane shard summaries into `dir`. */
export function downloadRun(exec, { repo, runId, dir }) {
  exec([
    'run',
    'download',
    runId,
    '--repo',
    repo,
    '--pattern',
    'compat-vinext-summary-*',
    '--dir',
    dir,
  ]);
}

/**
 * One "step" in the walk — listing candidates, or fetching one candidate's
 * summaries — succeeded, was skipped as an auth/API error (consuming the
 * shared `consecutiveSkips` budget), or is a plain "not informative, keep
 * backfilling" outcome that never touches the budget at all. Centralised so
 * listing and per-run fetching are classified identically (#1355 round-2
 * finding 2) and a "no artifact" failure (finding 1) is never miscounted as
 * an auth/API skip.
 * @param {() => any} attempt
 * @param {string} label
 * @param {{ warnings: string[], bump: () => void, reset: () => void, count: () => number }} budget
 * @returns {{ ok: true, value: any } | { ok: false }}
 */
function attemptStep(attempt, label, budget) {
  try {
    const value = attempt();
    budget.reset(); // gh answered normally: whatever the streak was, it is broken
    return { ok: true, value };
  } catch (err) {
    if (isNoArtifactError(err)) {
      budget.reset(); // gh answered normally (just "nothing here"); not a communication skip
      return { ok: false };
    }
    if (!isAuthOrApiError(err)) throw err;
    budget.bump();
    budget.warnings.push(`${label}: could not be fetched (${err?.message ?? err}); skipped`);
    if (budget.count() >= MAX_CONSECUTIVE_HISTORY_SKIPS) {
      throw new Error(
        `${budget.count()} consecutive history steps could not be fetched (auth/API errors); ` +
          'failing closed rather than silently narrowing the flaky window',
      );
    }
    return { ok: false };
  }
}

/**
 * Collect up to `want` INFORMATIVE history runs (oldest first) by walking the
 * lane's candidates newest-first and backfilling past anything uninformative:
 * a run that is not yet completed, predates `since` (the earliest flaky
 * entry's own `refreshed`/`added` date — a run cannot be evidence for an
 * entry that did not exist yet), used a non-default ref, or is missing a
 * shard, is skipped WITHOUT counting against the failure budget below — it
 * simply is not evidence. Likewise a "no artifact" failure downloading a
 * run's summaries (never uploaded, or aged past 90-day retention) is not
 * evidence either, and NOT a skip.
 *
 * An auth/API error — LISTING candidates in the first place, or fetching one
 * candidate's summaries — is a WARNING (that step is skipped); the two share
 * ONE `consecutiveSkips` budget, and `MAX_CONSECUTIVE_HISTORY_SKIPS` such
 * errors IN A ROW fail closed (throw), rather than silently returning an
 * ever-smaller window. A successful step (informative or not) resets the
 * budget to zero. Any other error (a bug, a malformed response) is not
 * swallowed at all. This budget is per-CALL, not persisted across separate
 * invocations of this script — see the module doc.
 * @param {{ list: (opts: {repo: string, currentRunId?: string, limit: number}) => {id: string, status: string, createdAt?: string}[], fetchSummaries: (id: string) => any[] }} deps
 * @param {{ repo: string, currentRunId?: string, want: number, since?: string }} opts
 * @returns {{ history: any[][], warnings: string[] }}
 */
export function collectHistory(deps, { repo, currentRunId, want, since }) {
  const warnings = [];
  let consecutiveSkips = 0;
  const budget = {
    warnings,
    bump: () => {
      consecutiveSkips += 1;
    },
    reset: () => {
      consecutiveSkips = 0;
    },
    count: () => consecutiveSkips,
  };
  const listed = attemptStep(
    () => deps.list({ repo, currentRunId, limit: want * 4 + 10 }),
    'run list',
    budget,
  );
  const candidates = listed.ok ? listed.value : [];
  const history = [];
  for (const c of candidates) {
    if (history.length >= want) break;
    if (c.status !== 'completed') continue; // cancelled / in-progress: 'none', backfill
    if (since && c.createdAt && c.createdAt < since) continue; // predates the entry: 'none', backfill
    const fetched = attemptStep(() => deps.fetchSummaries(c.id), `run ${c.id}`, budget);
    if (!fetched.ok) continue; // no-artifact or auth/API-skip: 'none', backfill either way
    const summaries = fetched.value;
    if (summaries.length === 0) continue; // artifactless (empty, not an error): 'none', backfill
    if (!isCompleteDefaultRun(summaries)) continue; // custom ref or missing shard: 'none', backfill
    history.push(summaries);
  }
  return { history: history.reverse(), warnings };
}

const canonical = (e) =>
  JSON.stringify({
    cases: [...(e.cases ?? [])].sort(),
    fail: [...(e.evidence?.fail ?? [])]
      .map((r) => ({ run: String(r.run), cases: [...(r.cases ?? [])].sort() }))
      .sort((a, b) => a.run.localeCompare(b.run)),
    pass: [...(e.evidence?.pass ?? [])].map(String).sort(),
  });

/**
 * Re-derive every entry from the runs it lists and compare. Catches evidence
 * that is invented (the run does not exist), cited from another lane, cited
 * from a non-`main`/wrong-workflow run, cited with a custom ref, missing a
 * shard (never counted as a pass), or that does not say what the entry
 * claims, e.g. an unsupported entry relabelled flaky with a "passing" run
 * where the file actually failed.
 * @param {any} ledger
 * @param {(runId: string) => { meta: { headBranch: string, path: string }, summaries: any[] }} fetchRun
 * @returns {string[]}
 */
export function verifyEvidence(ledger, fetchRun) {
  const errors = [];
  // One fetch per distinct run: several entries usually cite the same runs.
  const cache = new Map();
  const fetchOnce = (id) => {
    if (!cache.has(id)) {
      try {
        cache.set(id, { ok: true, value: fetchRun(id) });
      } catch (error) {
        cache.set(id, { ok: false, error });
      }
    }
    const hit = cache.get(id);
    if (!hit.ok) throw hit.error;
    return hit.value;
  };
  for (const e of ledger.entries) {
    const ids = [
      ...(e.evidence?.fail ?? []).map((r) => String(r.run)),
      ...(e.evidence?.pass ?? []).map(String),
    ];
    const runs = [];
    for (const id of ids) {
      let result;
      try {
        result = fetchOnce(id);
      } catch (err) {
        errors.push(`${e.test}: evidence run ${id} could not be fetched (${err?.message ?? err})`);
        continue;
      }
      const { meta, summaries } = result;
      if (meta?.headBranch !== 'main') {
        errors.push(
          `${e.test}: evidence run ${id} is not on main (head_branch=${meta?.headBranch})`,
        );
        continue;
      }
      if (meta?.path !== LANE_WORKFLOW_PATH) {
        errors.push(
          `${e.test}: evidence run ${id} is not a ${LANE_WORKFLOW} run (path=${meta?.path})`,
        );
        continue;
      }
      if (!summaries.length || summaries.some((x) => x.builder !== 'vinext')) {
        errors.push(`${e.test}: evidence run ${id} is not a vinext-lane run`);
        continue;
      }
      if (summaries.length < EXPECTED_SHARD_TOTAL) {
        errors.push(
          `${e.test}: evidence run ${id} is missing shard summaries (${summaries.length}/${EXPECTED_SHARD_TOTAL}); a missing shard is never counted as a pass`,
        );
        continue;
      }
      if (!summaries.every((s) => s.ref === DEFAULT_NEXTJS_REF)) {
        errors.push(`${e.test}: evidence run ${id} did not use the default nextjsRef`);
        continue;
      }
      runs.push({ id, summaries });
    }
    if (runs.length !== ids.length) continue;
    const { ledger: derived, errors: refreshErrors } = refreshSnapshots(
      { entries: [e] },
      runs,
      e.refreshed ?? '',
    );
    if (refreshErrors.length) {
      errors.push(...refreshErrors.map((m) => `${m} (re-derived from its listed runs)`));
      continue;
    }
    if (canonical(derived.entries[0]) !== canonical(e))
      errors.push(
        `${e.test}: cases/evidence does not match what refresh derives from the runs it lists (${ids.join(', ')}) — regenerate it with \`refresh\``,
      );
  }
  return errors;
}

const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Fetch runs into a temp dir, read their summaries, and always remove the dir. */
function withRuns(fn) {
  const root = mkdtempSync(join(tmpdir(), 'knext-vinext-ledger-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One run's `head_branch` and checked-out workflow `path`, via `gh api`. */
function runMeta(repo, runId) {
  const raw = gh(['api', `repos/${repo}/actions/runs/${runId}`]);
  const parsed = JSON.parse(raw);
  return { headBranch: parsed.head_branch, path: parsed.path };
}

function args(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out;
}

/** Read every lane shard summary JSON file in `dir` (recursively). */
export function readSummaries(dir) {
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
  if (!ledgerPath || !['apply', 'report', 'refresh', 'verify'].includes(cmd)) {
    console.error(
      'usage: compat-vinext-ledger.mjs apply --ledger <json> --summary <file> | report --ledger <json> --summaries <dir> [--history-runs N] | refresh --ledger <json> --run <run-id>=<run-dir> --run <run-id>=<run-dir>… | verify --ledger <json>',
    );
    return 2;
  }
  if (cmd === 'refresh') {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const runs = args(argv, 'run').map((spec) => {
      const at = String(spec).indexOf('=');
      return at > 0
        ? { id: spec.slice(0, at), summaries: readSummaries(spec.slice(at + 1)) }
        : { id: '', summaries: [] };
    });
    if (runs.length < 2 || runs.some((r) => !r.id || r.summaries.length === 0)) {
      console.error(
        '::error::refresh needs at least two --run <run-id>=<run-dir>, each holding shard summaries',
      );
      return 1;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { ledger: next, errors } = refreshSnapshots(ledger, runs, today);
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
  if (cmd === 'verify') {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) {
      console.error('::error::verify needs GITHUB_REPOSITORY (owner/name) and a gh token');
      return 1;
    }
    const failures = withRuns((root) =>
      verifyEvidence(ledger, (id) => {
        const dir = join(root, id);
        downloadRun(gh, { repo, runId: id, dir });
        return { meta: runMeta(repo, id), summaries: readSummaries(dir) };
      }),
    );
    for (const f of failures) console.error(`::error::vinext quarantine ledger — ${f}`);
    if (failures.length === 0)
      console.log(`verified ${ledger.entries.length} ledger entries against their listed runs`);
    return failures.length ? 1 : 0;
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
  for (const w of skippedWarnings(summaries))
    console.error(`::warning::vinext quarantine ledger — ${w}`);
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
  const window = flakyHistory(argv, ledger, summaries);
  for (const b of window.broken)
    console.error(
      `::error::flaky entry is broken, not flaky — ${b.test} failed its snapshot case in ${b.runs} consecutive informative runs; reclassify it as unsupported (with its upstream issue) or fix it`,
    );
  for (const st of window.stale)
    console.error(
      `::error::stale flaky entry — ${st.test} passed ${st.runs} consecutive informative runs; remove it from ${ledgerPath}`,
    );
  return stale.length || window.broken.length || window.stale.length ? 1 : 0;
}

/**
 * The flaky window for `report --history-runs N`: this run plus the lane's
 * last N informative runs on main (see `collectHistory`). `GITHUB_REPOSITORY`
 * being unset, or the initial run listing failing outright, degrades SOFTLY
 * to a warning (window skipped, 14-day flaky expiry still bounds every
 * entry) — `collectHistory` itself fails CLOSED on a run of unreadable
 * candidates (see its doc comment), and that error is deliberately NOT
 * caught here.
 */
// Exported ONLY for its integration test (a fake `gh` binary on PATH,
// #1355 round-2 finding 1/2/3): `gh` itself is not dependency-injected here
// the way `previousRunCandidates`/`downloadRun` are, so proving the
// since/budget wiring end to end needs the real function, not a re-implementation.
export function flakyHistory(argv, ledger, current) {
  const [n] = args(argv, 'history-runs');
  const flakyEntries = ledger.entries.filter((e) => e.class === 'flaky');
  if (!n || flakyEntries.length === 0) return { broken: [], stale: [] };
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(
      `::warning::vinext quarantine ledger — flaky history unavailable (GITHUB_REPOSITORY is not set); the window check was skipped, the ${FLAKY_MAX_EXPIRY_DAYS}-day flaky expiry still bounds every flaky entry`,
    );
    return { broken: [], stale: [] };
  }
  // A run predating the OLDEST flaky entry's own refreshed/added date cannot
  // be evidence for it (round-2 finding 3); `collectHistory` filters on this.
  const since = `${flakyEntries.map((e) => e.refreshed ?? e.added).sort()[0]}T00:00:00Z`;
  const { history, warnings } = withRuns((root) =>
    collectHistory(
      {
        list: (opts) => previousRunCandidates(gh, opts),
        fetchSummaries: (id) => {
          const dir = join(root, id);
          downloadRun(gh, { repo, runId: id, dir });
          return readSummaries(dir);
        },
      },
      { repo, currentRunId: process.env.GITHUB_RUN_ID, want: Number(n), since },
    ),
  );
  for (const w of warnings) console.error(`::warning::vinext quarantine ledger — ${w}`);
  return flakyWindow(ledger.entries, [...history, current]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::vinext quarantine ledger — ${err?.message ?? err}`);
    process.exit(1);
  }
}
