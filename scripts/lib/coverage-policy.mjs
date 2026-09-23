import { activeExemptions } from './dated-exemptions.mjs';
/**
 * The coverage policy — ONE definition (#884).
 *
 * Read by `scripts/check-coverage.mjs`, which enforces the floors over the
 * merged lcov of the bun suite (#871: vitest is gone, so there is one runner).
 * The `COVERAGE_INCLUDE` / `COVERAGE_EXCLUDE` globs do double duty: they scope
 * the floors AND define the honest DENOMINATOR — every matching source file is
 * enumerated from `git ls-files`, and one no test imports is folded in at 0%.
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
 *   - **branches** do NOT merge at all: bun emits no branch records, so the
 *     suite produces no branch data whatsoever. The branch floor is NOT carried
 *     over. It is not "lowered" — it is unmeasurable under this shape, and a
 *     number describing a measurement nobody makes is decoration.
 *   - **statements** are not an lcov concept at all; the old `statements` floor
 *     was v8/istanbul-only and has no representation here.
 *
 * The branch/statement gap is real lost signal. It is recorded in
 * `docs/benchmarks/coverage-baseline.md` rather than hidden behind a floor that
 * cannot fail.
 */

/** Where `scripts/bun-test.mjs --coverage` drops its per-file lcov reports. */
export const BUN_COVERAGE_DIR = 'coverage-bun';

/** The merged report `scripts/check-coverage.mjs` writes out for codecov / genhtml. */
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
 * Re-measured 2026-09-17 after vitest's removal (#871), over the bun per-file
 * reports plus the generated 0% denominator: **lines 78.47%, functions 85.97%**.
 * The old global floors — 77 lines / 74 functions — still hold against that, so
 * they are UNCHANGED. Ratchet convention: floors sit just below the measured
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
 *
 * ## Ratchet: coverage batch B1 (#1232)
 *
 * New tests for `utils/asset-upload.ts` (`hasStorage`, `pruneOldBuilds`'s
 * remote-listing-failure fallback), `adapters/image-cache-sync.ts` (watch
 * attach failure, reconcile's own store-list failure, `defaultCacheDir()`),
 * and a first test file for `adapters/vinext-image-optimizer.ts` (previously
 * 0% covered) raised the local merged measurement to
 * **lines 78.92% (9939/12593)**. The floor moves to 78.5 — just below the
 * measured number, per the ratchet convention, rounded down to 0.5.
 *
 * ## Ratchet: coverage batch B3 (#1234) — preview.ts / validate.ts
 *
 * The plan (`.claude/research/coverage-95-plan.md`) estimated ~316 uncovered
 * lines across `cli/preview.ts` + `cli/validate.ts`. Measuring the ACTUAL
 * uncovered EXECUTABLE lines (not bun's raw `DA` count, which per #1248 also
 * instruments comments, blank lines, lone braces, and — newly confirmed here —
 * the continuation line of a multi-line template literal or chained call)
 * found the real gap was far smaller than the plan's estimate: `validate.ts`
 * had ZERO genuine uncovered executable lines (every "uncovered" DA line was
 * noise, verified line-by-line against the source and cross-checked against
 * existing tests for the branches those lines sit in) — its raw 61.9% is
 * entirely a denominator artifact of its unusually large comment-to-code
 * ratio. `preview.ts` had exactly two real gaps: `defaultPreflight` (the
 * production `PreviewPreflight` wired when a caller omits `deps.preflight` —
 * every existing preview test injects a no-op) and `extractTag`'s
 * no-tag-found fallback (`Date.now()` buildId for a digest-only image ref).
 * Both closed, mutation-proved. The dispatcher (`preview()` + its
 * `isEntrypoint` self-entry block) and `defaultBuildAndPush`'s docker/npm
 * shell-outs are deliberately left uncovered — same repo-wide pattern as
 * `deploy()` in `deploy.ts` (its own dispatcher is equally untested
 * in-process; real coverage of that class comes from `cli-node-runtime.test.ts`
 * spawning the BUILT bin, which is opaque to V8/bun coverage by design, per
 * `cli-usage-surface.test.ts`'s own docblock). Full-suite local measurement
 * (244 of 245 per-package `src` test files; `coverage-margin.test.ts`
 * excluded, a known separate hang, #1248-adjacent) raised
 * **`packages/kn-next/src/**` lines to 79.01% (9955/12600)**. The floor moves
 * to 79.0 — just below the measured number, rounded down to 0.5.
 */
export const PER_PATH_THRESHOLDS = {
  'packages/kn-next/src/**': {
    lines: 79.0,
    functions: 76,
  },
};

/**
 * HONEST line floors (#1248, ADR-0057) — gated IN ADDITION to the raw floors
 * above, never instead of them.
 *
 * The raw line % counts every `DA` record bun emits, and bun emits them on blank
 * lines, comments, lone braces and type-only syntax inside any function a given
 * test process never ran; the per-process merge keeps them. The honest % drops
 * only those records, classified by the TypeScript parser with EXECUTABLE as the
 * default (`scripts/lib/executable-lines.mjs`), so an uncovered executable line
 * is always still counted here.
 *
 * Measured 2026-09-23 on the merged per-process report plus the generated 0%
 * denominator (the same input the raw floors judge), after coverage batches B1 and B3:
 *
 *   - global:                  raw 79.16% (10989/13882) → honest **92.54% (9183/9923)**
 *   - packages/kn-next/src/**: raw 79.08% (9974/12612)  → honest **92.47% (8303/8979)**
 *
 * 3959 DA records were excluded: punctuation 1935, comment 1334, blank 317,
 * type-only 309, template-literal continuation 64. Floors sit at the measured
 * value rounded DOWN to 0.5, per the ratchet convention. Raise them as coverage
 * lands; never lower one to get green.
 *
 * ## Ratchet: coverage batch B2 (#1233) — cr-builder.ts / deploy.ts / rollback.ts / db-bind.ts
 *
 * The cluster-write path (ADR-0001). New tests closed real honest-uncovered gaps:
 * cr-builder.ts's spec.resources/revalidation/secrets.envMap/preview emission branches
 * and the validateTaggedRef/validateCRImageRef/resolveDigest error messages;
 * deploy.ts's parseCliArgs early-exit paths (--help, --version incl. getCliVersion's
 * try/catch, an unknown flag, the ADR-0046 stray-positional check), applyOverrides'
 * --bucket-without-storage UsageError, and describeFailedCRApply's two kubectl-apply
 * diagnoses (pre-1.25 client vs. generic, incl. the probe-itself-throws leg);
 * rollback.ts's --context flag; db-bind.ts's --context flag, buildDbBindPatch's
 * required-secret guard, extractDsnFromSecretManifest's base64-decode-throws fallback,
 * the local kn-next.config.ts load branch, and dbMain's non-dry-run confirmation log.
 * rollback.ts and db-bind.ts are now honest-100% on their own files.
 *
 * Full local suite (433 test files; 3 pre-existing environment-only failures unrelated
 * to this batch — apps/file-manager/next-adapter.test.ts, tests/bun-exec-example-suite-
 * collection.test.ts, tests/scaffold-pack-contents.test.ts — none touch cr-builder.ts /
 * deploy.ts / rollback.ts / db-bind.ts or their tests), measured with `dist/` built for
 * kn-next + lib + db (their DTS build depends on each other; an unbuilt `dist/` starves
 * public-api-surface.test.ts / publish-surface.test.ts / validate-public-export.test.ts /
 * cli-node-runtime.test.ts of the artifacts they assert on and silently drops their
 * coverage contribution — this is a LOCAL-measurement precondition, not a code change):
 *
 *   - global:                  raw 79.29% (11035/13917) → honest **92.92% (9225/9928)**
 *   - packages/kn-next/src/**: raw 79.23% (10020/12647) → honest **92.89% (8345/8984)**
 *
 * Floors move to 92.5 (both), the measured value rounded DOWN to 0.5, per the ratchet
 * convention. Raw floors are left unchanged (79 / 79.0) — both measure above their raw
 * floor already; raising them is not this batch's target and the margin is kept.
 * A residual, non-actionable gap remains in both cr-builder.ts and deploy.ts: the
 * `isEntrypoint` self-entry dispatcher block in deploy.ts (lines 975-1063) is left
 * deliberately untested in-process, matching the B3 precedent above (covered by
 * cli-node-runtime.test.ts's built-binary spawn suite, not unit tests); and a handful of
 * lines in both files are the 2nd+ physical line of a `+`-joined multi-line string
 * literal inside an already-executed throw/return. Verified directly against the
 * per-process lcov (`coverage-bun/*.info`), not assumed: in the report from a test that
 * ACTUALLY executes the branch (e.g. deploy-apply-diagnostics.test.ts, cr-apply-strict-
 * validation.test.ts), bun emits NO `DA` record at all for these continuation lines —
 * only for the statement's first physical line. They still appear as `DA:<n>,0` in the
 * MERGED report the gate reads, but that 0 is contributed by OTHER, unrelated test files
 * that import the module without ever executing that branch (their per-file static scan
 * covers the whole source, so it emits a `DA` for every line, none of them reachable from
 * that file). Net effect either way: no test that exercises the branch can raise these
 * lines' hit count, because the report that would carry the hit never emits a record for
 * them to begin with.
 *
 * ## Ratchet: continuation-line attribution (#1262, ADR-0057 Amendment 1)
 *
 * Part of that residual is now attributed rather than left permanently uncovered:
 * `scripts/lib/continuation-attribution.mjs` gives a line that is PURELY a string-
 * literal / `+` continuation the merged hit count of its statement's first line —
 * never a line carrying a call, an identifier, a `${…}` substitution, a conditional
 * or a short-circuit; never one whose statement evaluates a call, a short-circuit or
 * a string-converted identifier before it; and never one whose statement does not
 * start its own basic block (JSC counts block ENTRY, so `boom(); throw new Error('a'
 * +` reads hit on the throw line although it never runs). Honest number only; the
 * raw number is untouched. No test changed and nothing was excluded: the same
 * 9928 / 8984 honest lines are counted, 11 of them attributed (deploy.ts 229-231 /
 * 300 / 304-306, preflight.ts 345 / 355-356, next-adapter.ts 118). Lines after a
 * `${…}` conversion — deploy.ts 287-295, cr-builder.ts 453-454 / 480-482 / 579 —
 * deliberately stay uncovered. Re-measured on the full suite with `dist/` built as
 * above (2 pre-existing environment-only failures:
 * tests/bun-exec-example-suite-collection.test.ts, tests/scaffold-pack-contents.test.ts):
 *
 *   - global:                  raw 79.29% (11035/13917) → honest **93.03% (9236/9928)**
 *   - packages/kn-next/src/**: raw 79.23% (10020/12647) → honest **93.01% (8356/8984)**
 *
 * Measured 93.03 / 93.01, but floors stay at 92.5: at 93.0 core would have 0 lines of headroom (reds in-flight #1264/#1266), so the ratchet waits for the next coverage batch.
 *
 * ## Ratchet: coverage batch B4 (#1235) — build/publish pipeline
 *
 * `cli/vinext-build.ts`'s real gaps: `clearStagedNative`'s manifest-unreadable
 * catch (corrupt `.integrity.json`), `readResolvedSharpManifest`'s unreadable-
 * candidate catch, and `detectBunVersion`'s two failure branches (bun missing
 * from PATH vs. a bun that spawned but failed) — none previously exercised.
 * `cli/build.ts`, `cli/postcompile-smoke.ts` and `cli/standalone-exec-build.ts`
 * had NO real gaps at all: their honest-uncovered lines are entirely the
 * documented non-actionable residue (string-literal continuations after a
 * `${…}` substitution earlier in the same statement, per the #1262 amendment
 * above, plus `build.ts`'s `isEntrypoint` self-entry dispatcher block — same
 * precedent as `deploy.ts`'s). `vinext-build.ts`'s `fetchImgPackage` npm-pack
 * shell-out (lines 650-677) is left deliberately uncovered — genuine
 * subprocess/network, class c, out of scope for this batch.
 *
 * Full local suite (444 test files after this batch; the same 2 pre-existing
 * environment-only failures as B2/B3, plus `tests/scaffold-pack-contents.test.ts`
 * timing out under load — none touch `cli/vinext-build.ts`, `cli/build.ts`,
 * `cli/postcompile-smoke.ts` or `cli/standalone-exec-build.ts`), measured with
 * `dist/` built for kn-next + lib + db:
 *
 *   - global:                  raw 79.25% (11130/14044) → honest **93.15% (9327/10013)**
 *   - packages/kn-next/src/**: raw 79.18% (10115/12774) → honest **93.14% (8447/9069)**
 *
 * Rounding 93.14 down to 0.5 gives 93.0 — but that leaves only ~0.14 points of
 * headroom above the new floor, well under the ~0.3-point margin this ratchet
 * requires (the #1268 zero-headroom lesson: a floor with no slack reds any
 * concurrent in-flight PR that so much as jitters a line). So the floor STAYS
 * at 92.5; the measured value is recorded here for the next batch to ratchet
 * from.
 */
export const HONEST_THRESHOLDS = {
  lines: 92.5,
};

export const HONEST_PER_PATH_THRESHOLDS = {
  'packages/kn-next/src/**': {
    lines: 92.5,
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
      'bun 1.4.0 lcov emits SF/FNF/FNH/DA/LF/LH and no BRDA/BRF/BRH, so the suite emits no branch ' +
      'records at all — there is nothing to compute a branch percentage from. Restoring a branch ' +
      'floor needs branch records from the bun side, which the current lcov output does not carry.',
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
  // Delegated to the shared reader (#927). This function used to carry its own
  // copy of the unknown-key / required-`expires` rules, and the prover lane then
  // needed the same rules — two copies of a check whose failure mode is silent in
  // both directions is the copy-instead-of-share defect this repo keeps fixing.
  return activeExemptions(entries, { field: 'metric', now });
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
