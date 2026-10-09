#!/usr/bin/env node
/**
 * The vinext STRUCTURAL-GAP ledger (founder decision, 2026-10-09; ADR-0007 §g,
 * Amendment).
 *
 * About 49 official Next.js deploy-test files fail on the vinext lane for one
 * reason: vinext does not implement the Next.js 16.3 client-router architecture
 * (segment cache, prefetch scheduling, app shells, ...). A knext patch cannot fix
 * that, so the per-file ledger (`test/compat-vinext-ledger.json`, cap 15, 30-day
 * expiry — founder constraints from the original ledger design, enforced by
 * `compat-vinext-ledger.mjs`) is the wrong tool for it, and widening THAT ledger
 * is not an option. This is a second ledger beside it, with its own explicit
 * bounds. It is a SCOPE statement ("vinext stays Beta"), not a way to turn the
 * lane green.
 *
 * Bounds, all enforced by `validateStructuralGaps`:
 *   - ONE shared gap record (`gap`): the reason, the upstream links and two
 *     dates. A file carries only `test` + a `cases` snapshot (+ a free-text
 *     `note`); a per-file reason / date / upstream is rejected, so the 49
 *     justifications cannot drift apart or be individually renewed.
 *   - `gap.reviewBy` is at most 92 days after `gap.recorded` (quarterly). Past
 *     it the run reds — the review is forced, not hoped for.
 *   - a hard cap of 49 files, FROZEN at the number first quarantined. It can only
 *     go DOWN: a file may never be added, and the cap never raised, without a new
 *     ADR-0007 amendment (the test pins the cap at or below the original 49).
 *   - every file is a real corpus member: it matches the manifest's include
 *     globs, is not excluded, and is not already quarantined by the manifest.
 *     (A file that matches but does not exist never fails, so the stale rule
 *     below reds it on the first run.)
 *   - the ledger applies ONLY to the vinext lane: `lane` must be `bun-vinext`,
 *     `apply`/`report` REFUSE a shard summary whose `builder` is not `vinext`
 *     (the four stable credential cells carry none, or `webpack`), only
 *     `compat-vinext.yml` references it, and the stable cells' compat-window
 *     fingerprints do not freeze it.
 *
 * Matching reuses the per-file ledger's `applyLedger` at CASE granularity: the
 * snapshot cases of a failing file move from `failures` to `quarantined`
 * (class `structural`); a NEW failing case in a ledgered file stays a real
 * failure; a file-level failure with no case detail (a build or deploy failure)
 * stays a real failure. `failed` is only ever decreased by files whose every
 * failing case was quarantined.
 *
 * Staleness is deliberately FILE-level, not case-level (the per-file ledger is
 * case-level). With ~170 snapshot cases, several of them timing-sensitive
 * prefetch assertions, a case-level rule would red the nightly on one lucky
 * pass of one case — the opposite of what a quarantine is for. So:
 *   - the whole file passed (no snapshot case failed, no failure of any kind) →
 *     STALE, the run reds, remove the entry;
 *   - some snapshot cases passed but the file still fails → a non-red warning
 *     to shrink the snapshot (progress is surfaced, not punished);
 *   - a file that did not run, or failed with no case detail, is never called
 *     stale: no result is not a pass.
 *
 * Dependency-free, plain Node. Imported by `compat-vinext-ledger.mjs` (the
 * `--structural` flag of `apply` and `report`); it must NOT import it back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Frozen at the count first quarantined (2026-10-09). Only ever lowered; raising it needs an ADR-0007 amendment. */
export const STRUCTURAL_FILE_CAP = 49;
/**
 * The ORIGINAL 49 files first quarantined (2026-10-09), pinned as a SET, not
 * just a count: a count alone lets one ledgered file be swapped for a different
 * failing one. The ledger's files must always be a subset of this list. Adding a
 * path here needs a new ADR-0007 amendment; removing one (the file now passes) is fine.
 */
export const STRUCTURAL_CANONICAL_FILES = Object.freeze([
  'test/e2e/app-dir/action-forward-loop/action-forward-loop.test.ts',
  'test/e2e/app-dir/actions-discarded-navigation-revert/actions-discarded-navigation-revert.test.ts',
  'test/e2e/app-dir/app-inline-css/index.test.ts',
  'test/e2e/app-dir/app-prefetch/prefetching.test.ts',
  'test/e2e/app-dir/asset-prefix-absolute/asset-prefix-absolute.test.ts',
  'test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts',
  'test/e2e/app-dir/instant-navigation-testing-api/instant-navigation-testing-api.test.ts',
  'test/e2e/app-dir/navigation-focus/navigation-focus.test.ts',
  'test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts',
  'test/e2e/app-dir/parallel-routes-scroll-owner/parallel-routes-scroll-owner.test.ts',
  'test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts',
  'test/e2e/app-dir/partial-prefetching-config/partial-prefetching-config.test.ts',
  'test/e2e/app-dir/partial-prefetching-deep-propagation/partial-prefetching-deep-propagation.test.ts',
  'test/e2e/app-dir/partial-prefetching-segment-config/partial-prefetching-segment-config.test.ts',
  'test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts',
  'test/e2e/app-dir/proxy-prefix-rewrite-prefetch-loop/proxy-prefix-rewrite-prefetch-loop.test.ts',
  'test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts',
  'test/e2e/app-dir/rsc-basic/rsc-basic-blocking-ssr.test.ts',
  'test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts',
  'test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts',
  'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations-global-runtime.test.ts',
  'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations-partial-prefetching.test.ts',
  'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts',
  'test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts',
  'test/e2e/app-dir/segment-cache/force-stale/force-stale.test.ts',
  'test/e2e/app-dir/segment-cache/headers-keyed-caches/headers-keyed-caches.test.ts',
  'test/e2e/app-dir/segment-cache/memory-pressure/segment-cache-memory-pressure.test.ts',
  'test/e2e/app-dir/segment-cache/optimistic-routing-rewrite-detection-regression/optimistic-routing-rewrite-detection-regression.test.ts',
  'test/e2e/app-dir/segment-cache/prefetch-app-shell/prefetch-app-shell.test.ts',
  'test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts',
  'test/e2e/app-dir/segment-cache/prefetch-scheduling/prefetch-scheduling.test.ts',
  'test/e2e/app-dir/segment-cache/prefetch-static-shell/prefetch-static-shell.test.ts',
  'test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params-shared-loading-state.test.ts',
  'test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts',
  'test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts',
  'test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts',
  'test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts',
  'test/e2e/app-dir/service-worker-scopes/service-worker-scopes.test.ts',
  'test/e2e/app-dir/service-worker/service-worker-register.test.ts',
  'test/e2e/app-dir/use-cache-default-profile-expire-zero/use-cache-default-profile-expire-zero.test.ts',
  'test/e2e/app-dir/use-offline/use-offline.test.ts',
  'test/e2e/app-document-import-order/app-document-import-order.test.ts',
  'test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts',
  'test/e2e/next-image-legacy/asset-prefix/asset-prefix.test.ts',
  'test/e2e/next-image-legacy/unicode/unicode.test.ts',
  'test/e2e/next-image-legacy/unoptimized/unoptimized.test.ts',
  'test/e2e/next-image-new/asset-prefix/asset-prefix.test.ts',
  'test/e2e/react-current-version/react-current-version.test.ts',
  'test/e2e/service-worker-pages/service-worker-pages.test.ts',
]);
const CANONICAL_SET = new Set(STRUCTURAL_CANONICAL_FILES);

export const STRUCTURAL_MAX_REVIEW_DAYS = 92;
/** The only lane the ledger may name. Never a stable credential cell. */
export const STRUCTURAL_LANES = ['bun-vinext'];
/** The only shard-summary `builder` it may be applied to. */
export const STRUCTURAL_BUILDER = 'vinext';
/** The `class` its quarantined records carry in summaries and the run ledger. */
export const STRUCTURAL_CLASS = 'structural';
export const STRUCTURAL_REASON =
  'vinext does not implement the Next.js 16.3 client-router architecture';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPSTREAM_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/\d+$/;
const FILE_KEYS = new Set(['test', 'cases', 'note']);

const isDate = (d) =>
  typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const days = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const nonEmpty = (a) =>
  Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x);

/**
 * Compile a manifest glob (`**`, `*`, `{a,b}` with empty alternatives — the only
 * shapes `deploy-tests-manifest.knext.json` uses) to an anchored RegExp.
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '{') {
      depth += 1;
      re += '(?:';
    } else if (c === '}' && depth > 0) {
      depth -= 1;
      re += ')';
    } else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (globs, path) =>
  (Array.isArray(globs) ? globs : []).some((g) => globToRegExp(String(g)).test(path));

/** Does the manifest's `rules.include` select this test file? */
export function manifestIncludes(manifest, test) {
  return matchesAny(manifest?.rules?.include, test);
}
/** Does the manifest's `rules.exclude` drop this test file from the corpus? */
export function manifestExcludes(manifest, test) {
  return matchesAny(manifest?.rules?.exclude, test);
}

/**
 * @param {any} ledger
 * @param {{ today: string, manifest?: any }} ctx
 * @returns {string[]} every violation; empty means valid
 */
export function validateStructuralGaps(ledger, ctx) {
  const out = [];
  if (!ledger || typeof ledger !== 'object') return ['structural-gap ledger is not an object'];
  if (!STRUCTURAL_LANES.includes(ledger.lane))
    out.push(
      `unknown lane ${JSON.stringify(ledger.lane)} (allowed: ${STRUCTURAL_LANES.join(', ')}; it never applies to a stable credential cell)`,
    );

  const g = ledger.gap;
  if (!g || typeof g !== 'object') {
    out.push('gap: the shared gap record is missing');
  } else {
    if (typeof g.id !== 'string' || !g.id.trim()) out.push('gap: id is missing');
    if (g.reason !== STRUCTURAL_REASON)
      out.push(`gap: reason must be exactly ${JSON.stringify(STRUCTURAL_REASON)}`);
    const links = Array.isArray(g.upstream) ? g.upstream : null;
    if (!links || links.length === 0) {
      out.push('gap: upstream must list the tracking links');
    } else {
      const repos = [];
      for (const u of links) {
        const m = typeof u === 'string' ? UPSTREAM_RE.exec(u) : null;
        if (m) repos.push(m[1]);
        else
          out.push(`gap: upstream ${JSON.stringify(u)} is not a GitHub issue or pull request URL`);
      }
      if (!repos.includes('cloudflare/vinext'))
        out.push('gap: upstream must link a cloudflare/vinext issue or pull request');
      if (!repos.includes('getknext-dev/knext'))
        out.push('gap: upstream must link the getknext-dev/knext tracking issue');
    }
    for (const k of ['recorded', 'reviewBy']) {
      if (g[k] === undefined) out.push(`gap: missing ${k} date (a date is mandatory)`);
      else if (!isDate(g[k])) out.push(`gap: ${k} is not a YYYY-MM-DD date`);
    }
    if (isDate(g.recorded) && isDate(ctx.today) && days(ctx.today, g.recorded) > 0)
      out.push(`gap: recorded in the future (${g.recorded})`);
    if (isDate(g.recorded) && isDate(g.reviewBy)) {
      const span = days(g.recorded, g.reviewBy);
      if (span < 0) out.push('gap: reviewBy is before it was recorded');
      else if (span > STRUCTURAL_MAX_REVIEW_DAYS)
        out.push(
          `gap: reviewBy is ${span} days after it was recorded; the maximum is ${STRUCTURAL_MAX_REVIEW_DAYS} days`,
        );
    }
    if (isDate(g.reviewBy) && isDate(ctx.today) && days(g.reviewBy, ctx.today) > 0)
      out.push(
        `gap: reviewBy ${g.reviewBy} has passed (review the gap: renew with fresh evidence, or remove the files that now pass)`,
      );
  }

  const files = Array.isArray(ledger.files) ? ledger.files : null;
  if (!files) return [...out, 'files is not an array'];
  if (files.length > STRUCTURAL_FILE_CAP)
    out.push(`${files.length} files ledgered; the cap is ${STRUCTURAL_FILE_CAP}`);
  const manifestQuarantined = new Set(
    (ctx.manifest?.$knextQuarantines ?? []).map((q) => q?.test).filter(Boolean),
  );
  const seen = new Set();
  for (const [i, f] of files.entries()) {
    const at = `file ${i} (${f?.test ?? '?'})`;
    if (!f || typeof f !== 'object') {
      out.push(`${at}: not an object`);
      continue;
    }
    for (const k of Object.keys(f))
      if (!FILE_KEYS.has(k))
        out.push(
          `${at}: unexpected key ${JSON.stringify(k)} (the reason, dates and upstream live in the one shared gap record)`,
        );
    if (typeof f.test !== 'string') {
      out.push(`${at}: test must be a path`);
    } else {
      if (!CANONICAL_SET.has(f.test))
        out.push(
          `${at}: not one of the original ${STRUCTURAL_CANONICAL_FILES.length} quarantined files; adding or swapping a file needs a new ADR-0007 amendment`,
        );
      if (seen.has(f.test)) out.push(`${at}: duplicate test`);
      seen.add(f.test);
      if (manifestExcludes(ctx.manifest, f.test))
        out.push(
          `${at}: excluded by the manifest; a ledger entry cannot cover a test that never runs`,
        );
      else if (!manifestIncludes(ctx.manifest, f.test))
        out.push(
          `${at}: not a corpus member of the deploy-test manifest (no include glob matches)`,
        );
      if (manifestQuarantined.has(f.test))
        out.push(`${at}: already quarantined by the manifest; one mechanism per file`);
    }
    if (!nonEmpty(f.cases))
      out.push(`${at}: cases must list the failing case snapshot (non-empty strings)`);
    else if (new Set(f.cases).size !== f.cases.length) out.push(`${at}: duplicate case`);
  }
  return out;
}

/**
 * The ledger's files as entries the per-file ledger's `applyLedger` understands.
 * @param {any} ledger a VALID structural-gap ledger
 */
export function structuralEntries(ledger) {
  const upstream = ledger.gap.upstream[0];
  return ledger.files.map((f) => ({
    test: f.test,
    class: STRUCTURAL_CLASS,
    cases: f.cases,
    upstream,
  }));
}

/**
 * The structural ledger is vinext-only. A shard summary from any other cell (the
 * four stable cells carry no `builder`, or `webpack`) is refused.
 * @param {any} summary
 * @returns {string | null} the refusal, or null when the summary is a vinext one
 */
export function structuralApplyRefusal(summary) {
  if (summary?.builder === STRUCTURAL_BUILDER) return null;
  return (
    `refusing to apply the structural-gap ledger to a summary whose builder is ` +
    `${JSON.stringify(summary?.builder ?? null)} (shard ${summary?.shard ?? '?'}); it is ` +
    `${STRUCTURAL_BUILDER}-only and never applies to a stable credential cell`
  );
}

/**
 * Cases claimed by BOTH ledgers. A file may legitimately sit in both (the
 * per-file ledger quarantines a few cases for their own reasons, the rest of
 * the file fails for the structural gap) but a CASE is quarantined by one
 * mechanism only, so the two reclassification passes never fight over it.
 * @param {any} ledger
 * @param {{ test: string, cases?: string[] }[]} perFileEntries
 * @returns {{ test: string, cases: string[] }[]}
 */
export function overlapWithPerFile(ledger, perFileEntries) {
  const mine = new Map(ledger.files.map((f) => [f.test, new Set(f.cases)]));
  return perFileEntries
    .map((e) => ({
      test: e.test,
      cases: (e.cases ?? []).filter((c) => mine.get(e.test)?.has(c)),
    }))
    .filter((o) => o.cases.length > 0);
}

/**
 * Stale / shrinkable entries over a whole run (APPLIED shard summaries).
 * @param {any[]} summaries
 * @param {any} ledger a VALID structural-gap ledger
 * @returns {{ stale: { test: string }[], shrink: { test: string, cases: string[] }[] }}
 */
export function staleStructural(summaries, ledger) {
  const stale = [];
  const shrink = [];
  if (summaries.some((s) => s.ledgerSkipped)) return { stale, shrink }; // proves nothing passed
  const notRun = new Set(summaries.flatMap((s) => s.notRunFiles ?? []));
  const failures = summaries.flatMap((s) => s.failures ?? []);
  const noDetail = new Set(failures.filter((f) => !(f.cases ?? []).length).map((f) => f.file));
  const failing = new Set(failures.map((f) => f.file));
  const quarantined = summaries.flatMap((s) => s.quarantined ?? []);
  for (const f of ledger.files) {
    if (notRun.has(f.test) || noDetail.has(f.test)) continue;
    const seen = new Set(
      quarantined
        .filter((q) => q.file === f.test && q.class === STRUCTURAL_CLASS)
        .flatMap((q) => q.cases),
    );
    if (seen.size === 0) {
      if (!failing.has(f.test)) stale.push({ test: f.test });
      continue;
    }
    const missing = f.cases.filter((c) => !seen.has(c));
    if (missing.length) shrink.push({ test: f.test, cases: missing });
  }
  return { stale, shrink };
}

/**
 * Read + validate the ledger against the manifest that sits beside it.
 * @param {string} path
 * @param {string} today YYYY-MM-DD
 */
export function loadStructuralGaps(path, today) {
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = JSON.parse(
    readFileSync(resolve(path, '..', 'deploy-tests-manifest.knext.json'), 'utf8'),
  );
  return { ledger, errors: validateStructuralGaps(ledger, { today, manifest }) };
}
