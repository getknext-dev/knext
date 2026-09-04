/**
 * The coverage policy — ONE definition, read by both consumers (#884).
 *
 * Consumers:
 *   - `vitest.config.ts`      — the include/exclude that define the honest
 *                               DENOMINATOR (every source file enumerated, an
 *                               untouched one at 0%).
 *   - `scripts/check-coverage.mjs` — the floors, enforced over the MERGED lcov
 *                               of both runners.
 *
 * Why vitest no longer enforces the floors: after the bun migration it collects
 * 3 test files out of 338, so its numerator is a rounding error while its
 * denominator is the whole tree. Thresholds there measured 1.37% against a 77%
 * floor. The gate moved; the numbers did not.
 *
 * ## What survives an lcov merge, and what does not
 *
 * Measured on bun 1.4.0. bun's lcov emits `SF` / `FNF` / `FNH` / `DA` / `LF` /
 * `LH` and nothing else — no `FN`/`FNDA` names, no `BRDA`/`BRF`/`BRH`.
 * Consequences, stated rather than papered over:
 *
 *   - **lines** merge EXACTLY. `DA` carries per-line identity, so the union of
 *     executed lines across reports is the true union. This is the floor that
 *     matters and it is enforced.
 *   - **functions** merge as a CONSERVATIVE LOWER BOUND. With counts but no
 *     identity, `max()` across reports under-reports a file both runners
 *     touched. Under-reporting is the safe direction for a floor, so it is
 *     enforced — at a floor set to the measured merged number.
 *   - **branches** do NOT merge at all: bun emits no branch records, so a branch
 *     percentage over the merge would be computed from vitest's 3 files only.
 *     That is the dishonest denominator this gate exists to prevent, so the
 *     branch floor is NOT carried over. It is not "lowered" — it is
 *     unmeasurable under this shape, and a number describing a measurement
 *     nobody makes is decoration.
 *   - **statements** are not an lcov concept at all; the old `statements` floor
 *     was v8/istanbul-only and has no representation here.
 *
 * The branch/statement gap is real lost signal. It is recorded in
 * `docs/benchmarks/coverage-baseline.md` rather than hidden behind a floor that
 * cannot fail.
 */

/** Where `scripts/bun-test.mjs --coverage` drops its per-file lcov reports. */
export const BUN_COVERAGE_DIR = 'coverage-bun';

/** Where vitest writes its report (its default), and the merged report we write next to it. */
export const VITEST_LCOV = 'coverage/lcov.info';
export const MERGED_LCOV = 'coverage/lcov.merged.info';

/**
 * The honest denominator: every source file under a package's `src/`, counted
 * whether or not a test imports it. Adding an untested file must LOWER the
 * percentage, never raise it.
 */
export const COVERAGE_INCLUDE = ['packages/*/src/**/*.{ts,tsx}'];

export const COVERAGE_EXCLUDE = [
  // Untracked local cruft (0 tracked files in git) — never repo code.
  '**/packages/admin/**',
  '**/packages/knext/**',
  // Tests, type-only decls, and generated/index barrels carry no logic to cover.
  '**/*.test.{ts,tsx}',
  '**/*.d.ts',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.config.{ts,js,mjs}',
];

/**
 * Global floors, over the MERGED report.
 *
 * Measured 2026-09-04 on the full merge (336 bun reports + vitest's):
 * **lines 78.41% (8546/10899), functions 79.70%** over 79 files. The old
 * global floors — 77 lines / 74 functions — still hold against that, so they
 * are UNCHANGED. Ratchet convention: floors sit just below the measured
 * baseline; raise them as coverage lands, never lower one to get green.
 */
export const THRESHOLDS = {
  lines: 77,
  functions: 74,
};

/**
 * Per-package floor for @getknext/core (`packages/kn-next`). The aggregate
 * ratchet above can otherwise mask a regression in this one package behind
 * lib/db/ui, which sit above 90%.
 *
 * ## Why these are 78/76 and not the old 90/87
 *
 * This is a RE-BASELINE onto a different denominator, not a coverage
 * regression, and the difference is measurable rather than argued. For
 * `packages/kn-next/src/**`:
 *
 *   - vitest's v8 provider counts **3430** lines;
 *   - the merged report counts **9644** — bun's `DA` records are ~2.8x more
 *     granular over the same files.
 *
 * A percentage over 9644 lines is simply not the same quantity as one over
 * 3430, so carrying 90 across would be asserting a number nobody has measured.
 * The merged baseline, measured 2026-09-04, is **lines 78.09% (7531/9644),
 * functions 76.88% (492/640)**; the floors are set just below it, per the
 * ratchet convention, so any drop from today reds.
 *
 * The old 90/87 figures are NOT lost — they are recorded in
 * `docs/benchmarks/coverage-baseline.md` with the provider they were measured
 * under. What was lost when vitest stopped collecting the suite was the
 * measurement, not the coverage.
 */
export const PER_PATH_THRESHOLDS = {
  'packages/kn-next/src/**': {
    lines: 78,
    functions: 76,
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * DATED EXCEPTIONS for the metrics this shape cannot measure (sprint 2, lane G)
 *
 * The module docs above explain, correctly, why `branches` and `statements` are
 * not gated: bun's lcov carries no `BRDA`/`BRF`/`BRH`, so a branch percentage
 * over the merge would come from vitest's three collected files, and
 * `statements` is not an lcov concept at all. That reasoning stands.
 *
 * WHAT DID NOT STAND is the form it was recorded in. It was a paragraph — here
 * and in `docs/benchmarks/coverage-baseline.md` — and a paragraph is not a
 * control. Nothing re-asked the question, nothing dated it, and by
 * `security.md`'s own words a documented expectation degrades and its efficacy
 * is unobservable until it has already failed. Two metrics left the gate and the
 * only thing standing between that and permanence was somebody remembering.
 *
 * So it is now the same dated-exception shape the repo already uses for an
 * accepted Trivy or npm-audit finding (`precompile-closure.mjs:206-248`), with
 * the two properties that made that one work:
 *
 *   - an UNKNOWN KEY THROWS. A typo'd `expiress` otherwise reads as an entry
 *     that never expires while looking exactly like one that does — the
 *     quietest possible way to neuter the clock.
 *   - EXPIRY FAILS CLOSED. Past `expires`, the metric stops being excused, and
 *     `assertEveryMetricAccountedFor` then throws because it has neither a floor
 *     nor a live exception. The gate goes RED and someone has to decide again,
 *     which is the entire purpose of a date.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every metric the gate is expected to have an opinion about. */
export const GATED_METRICS = Object.freeze(['lines', 'functions', 'branches', 'statements']);

const EXCEPTION_KEYS = new Set(['metric', 'justification', 'added', 'expires', 'note']);

/**
 * The two metrics excused today, with the clock that forces the re-decision.
 *
 * The expiry is deliberately NOT "when bun ships BRDA" — an exception whose
 * expiry is another project's roadmap never expires. It is a date, and if bun
 * still emits no branch records on that date the answer is a renewed entry with
 * a fresh justification, made deliberately, rather than by default.
 */
export const COVERAGE_METRIC_EXCEPTIONS = Object.freeze([
  Object.freeze({
    metric: 'branches',
    justification:
      'bun 1.4.0 lcov emits SF/FNF/FNH/DA/LF/LH and no BRDA/BRF/BRH, so a branch percentage over ' +
      "the merged report would be computed from vitest's 3 collected files against the whole " +
      "tree's denominator — the dishonest denominator this gate exists to prevent. Restoring a " +
      'branch floor needs branch records from the bun side, not a smaller denominator.',
    added: '2026-09-04',
    expires: '2026-12-01',
    note: "Renew with a fresh measurement of bun's lcov output, or land a branch source and a floor.",
  }),
  Object.freeze({
    metric: 'statements',
    justification:
      'statements is not an lcov concept at all — the old floor was a v8/istanbul-provider ' +
      'quantity with no representation in the merged report. There is nothing to lower and ' +
      'nothing to measure; a floor here would be a number describing a measurement nobody makes.',
    added: '2026-09-04',
    expires: '2026-12-01',
    note: 'Only actionable if the gate gains an istanbul-shaped source; otherwise renew or retire the metric from GATED_METRICS.',
  }),
]);

/**
 * The metrics excused RIGHT NOW. Throws on a malformed or unknown-keyed entry.
 *
 * @param {Date} [now]
 * @param {ReadonlyArray<Record<string, unknown>>} [entries] injectable for tests
 * @returns {Set<string>}
 */
export function activeMetricExceptions(now = new Date(), entries = COVERAGE_METRIC_EXCEPTIONS) {
  const active = new Set();
  for (const entry of entries) {
    if (!entry?.metric) {
      throw new Error(`coverage exception: an entry has no \`metric\`: ${JSON.stringify(entry)}`);
    }
    const unknown = Object.keys(entry).filter((k) => !EXCEPTION_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `coverage exception: ${entry.metric} has unknown key(s) [${unknown.join(', ')}] — allowed ` +
          `keys are [${[...EXCEPTION_KEYS].join(', ')}]. A misspelled \`expires\` never expires.`,
      );
    }
    if (typeof entry.justification !== 'string' || entry.justification.length < 40) {
      throw new Error(
        `coverage exception: ${entry.metric} has no substantive \`justification\` — "we do not ` +
          'measure it" is the thing being excused, not the reason',
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.added ?? '')) {
      throw new Error(`coverage exception: ${entry.metric} has no valid \`added\` date`);
    }
    // REQUIRED, unlike the security allowlist's optional form. That one covers
    // findings that can be permanently accepted; a metric leaving the gate never
    // can be, so an entry with no clock is rejected outright.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) {
      throw new Error(
        `coverage exception: ${entry.metric} has no valid \`expires\` date — an exception with no ` +
          'clock is not an exception, it is a silent removal',
      );
    }
    if (new Date(`${entry.expires}T00:00:00Z`) <= now) continue; // lapsed — no longer suppresses
    active.add(entry.metric);
  }
  return active;
}

/**
 * Every gated metric must have EITHER a floor OR a live exception. Throws if not.
 *
 * This is what turns the expiry into teeth. Without it, a lapsed exception and a
 * quietly deleted one are indistinguishable from outside: in both cases the
 * metric simply is not checked, and the gate stays green.
 *
 * @param {Record<string, number>} floors
 * @param {Set<string>} excused
 */
export function assertEveryMetricAccountedFor(floors, excused) {
  const orphans = GATED_METRICS.filter((m) => floors[m] === undefined && !excused.has(m));
  if (orphans.length > 0) {
    throw new Error(
      `coverage gate: [${orphans.join(', ')}] have neither a floor nor a live dated exception. ` +
        'An exception in `COVERAGE_METRIC_EXCEPTIONS` has expired (or was removed): either set a ' +
        'floor now that the metric is measurable, or renew the exception with a fresh ' +
        'justification and a new `expires`. This is deliberately fail-closed — see ' +
        'docs/benchmarks/coverage-baseline.md.',
    );
  }
}
