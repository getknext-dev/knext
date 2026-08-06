#!/usr/bin/env node
/**
 * Standing mutation proof for the compat fail-on-red gate's THREE teeth (#700).
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * `.github/workflows/test-e2e-deploy.yml`'s "Fail shard on red results
 * (revocation teeth)" step is the only thing that turns a red compat RESULT
 * into a red compat JOB, and it carries three independent exits: a MISSING
 * summary, `failed > 0 || notRun > 0`, and a TRUNCATED summary. The guard
 * protecting all three used to be one regex over the whole step block —
 *
 *     expect(/exit 1|process\.exit\(1\)/.test(gate)).toBe(true)
 *
 * — so deleting any ONE tooth left the OR satisfied by the other two.
 * Re-measured before the fix on the tree this prover landed on: removing
 * `process.exit(1)` from the `failed > 0` branch kept that assertion GREEN and
 * every other spec green with it (61 files, 1446 passed).
 *
 * THE PROOF IS TWO-DIRECTIONAL, and that is the whole point of this file.
 * Every row asserts BOTH:
 *
 *   1. the assertion that OWNS the disarmed branch goes RED, and
 *   2. the assertions that own the OTHER branches stay GREEN.
 *
 * Direction 2 is what distinguishes "three independent teeth" from "one red
 * standing in for the others" — without it, a single catch-all assertion that
 * reddens on everything would satisfy direction 1 for all nine rows and prove
 * nothing new about independence.
 *
 * PRESENCE, VALUE **AND POLARITY**. Each tooth is disarmed several ways: by
 * DELETING its exit (presence), by making the exit or threshold inert —
 * `process.exit(0)`, `failed > 999` (value) — and by making the branch fire on
 * the WRONG case: `!( … )`, `||` swapped for `&&`, a dead conjunct (polarity).
 *
 * The polarity rows exist because the first version of this proof did not have
 * them on the JS teeth. It covered "the exit is moved into the ELSE arm" for
 * tooth 1 and nothing equivalent for teeth 2 and 3, and all four polarity edits
 * above were measured GREEN across every assertion — including a ONE-CHARACTER
 * `||` → `&&` that reproduces run 28552585087 verbatim. Sibling coverage: if an
 * axis is worth guarding on one tooth it is worth guarding on all of them.
 *
 * The FIXTURE rows exist for the round after that, and the lesson is one level
 * down again: replacing an under-specified ORACLE (a syntax match) with a better
 * one (evaluation) still leaves you with an oracle, and the probe summaries then
 * ARE the contract. Probing only `{failed, notRun, truncated}` at 0 and 1
 * accepted `=== 1` (run 28552585087's own shape), an upper bound `< 2`, and —
 * because a real summary carries `shard`, `ref`, `passed`, `excluded`,
 * `expectedTotal` and the gate's own `console.log` prints five of them — both
 * `s.shard === undefined && ( … )` (never fires) and `… || s.passed > 0`
 * (permanently red). Same axis, reached through data the fixtures did not model.
 * The fixtures are now full, internally-consistent summaries, and these rows
 * pin that they stay so.
 *
 * The CEILING rows are the round after THAT, and they are the reason this axis
 * is now closed rather than merely raised. Probing `failed ∈ {0,1,8}` accepts
 * any upper bound above 8 — `&& s.failed < 9` survived, and so did
 * `&& s.failed < s.expectedTotal`, which passes a shard where EVERY selected
 * test failed. The counts are bounded above by `expectedTotal`, so the fixtures
 * probe its top (`failed: meta.expectedTotal`).
 * The last row is the same lesson from the other side: a fixture that invents a
 * key the emitter OMITS hides a condition that throws on every green shard.
 *
 * BE PRECISE ABOUT WHAT THAT CLOSES. An earlier version of this note claimed
 * probing the top "terminates the axis — no further rung exists", and that was
 * wrong: `&& s.failed < 46` survived it, because nothing tied the hardcoded 45
 * to anything. A finite probe set cannot close an infinite family by
 * enumeration. What closes it is the METADATA-INVARIANCE property added in the
 * round after: every case is evaluated under two metadata assignments with
 * DIFFERENT `expectedTotal`s and the verdict must be identical, so any constant
 * bound between them fires on one and not the other. Formally, what terminates
 * is the monotone constant-bound sub-family up to the largest probe, plus
 * everything keyed on metadata; a bound above every probe still survives, and
 * that is stated rather than papered over.
 *
 * Mutations land through the byte-snapshot harness, so restoration is
 * content-addressed and sha256-verified, and every mutation carries the residue
 * marker. Rows landing INSIDE the embedded `node -e '…'` program pass
 * `commentPrefix: '//'`, because the file is YAML and the harness would
 * otherwise stamp a `#` comment into the middle of a JavaScript program.
 * MEASURED, so the reason is stated correctly: that does NOT make the guard red
 * on a parse error — `ts.createSourceFile` is error-tolerant and the row still
 * reds with the right message. What it does is leave the workflow carrying a
 * program that could not RUN, so the mutation disarms strictly more than the row
 * claims and a reader cannot tell which half produced the red. Never `perl`.
 *
 * Usage:  node scripts/mutation-prove-compat-fail-on-red-teeth.mjs
 *
 * ── OPERATIONAL NOTE FOR ANYONE MUTATING BY HAND ─────────────────────────────
 * Run the TARGETED assertion, never the whole suite, while a mutation is live.
 * `tests/mutation-residue-scan.test.ts` scans every tracked file for the
 * harness's residue marker — which a live mutation, by design, carries — so a
 * whole-suite run reports that spec as failing whatever the mutation did. This
 * prover is immune because every run is `<spec> -t <name>`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGateTest } from './lib/ci-blocking-gate-proof.mjs';
import { countOccurrences, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const HELPER = resolve(REPO_ROOT, 'tests/helpers/fail-on-red-gate.ts');
const SPEC = 'tests/compat-suite-workflow.test.ts';

/** The five assertions this proof scores against, by `vitest -t` selector. */
const T = {
  vacuity: '#700 the teeth audit is NON-VACUOUS',
  missing: '#700 tooth 1/3',
  failed: '#700 tooth 2/3',
  truncated: '#700 tooth 3/3',
  reaches: '#700 the gate script',
  // Not a tooth — the guard on the ORACLE the three teeth are judged with.
  shape: '#700 the probe summaries',
  // Also not a tooth — the guard that keeps the ORACLE describing both
  // runtime lanes. Without it a single-variant probe set would satisfy the
  // invariance check vacuously.
  lanes: '#700 the polarity probes cover BOTH runtime lanes',
};

/** `//` for rows landing inside the embedded JS; `#` (the default) elsewhere. */
const JS = { commentPrefix: '//' };

// ── anchors, each asserted to occur exactly once by the harness ──────────────

const MISSING_BRANCH = [
  '            echo "::error::${SUMMARY} is missing — no results is NOT green; the summarize step failed upstream"',
  '            exit 1',
  '          fi',
  '',
].join('\n');

const FAILED_EXIT = '              process.exit(1);\n            }\n            // #171 follow-up';
const FAILED_COND = '            if ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0) {';
const TRUNC_EXIT = '              process.exit(1);\n            }\n          \' "${SUMMARY}"';
const TRUNC_COND = '            if (s.truncated === true) {';
const NODE_CLOSE = '          \' "${SUMMARY}"';
const SET_E = '          set -euo pipefail\n          SAFE_SHARD=';
const STEP_NAME = '      - name: Fail shard on red results (revocation teeth)\n';
const MISSING_COND = '          if [ ! -f "${SUMMARY}" ]; then';
const NODE_OPEN = "          node -e '\n            const s = require";

/**
 * Every mutation this prover scores.
 *
 * `reds` is the assertion that MUST go red; `green` is the set that must stay
 * green under the same mutation. `green` is written out per row rather than
 * derived as "everything else", because the derivation would silently absorb a
 * sixth assertion added later and claim an independence nobody proved.
 *
 * `also` carries the SECOND edit of the one row that needs two — a disarm that
 * only bites in combination cannot be expressed as a single substitution, and
 * inventing a fake single anchor for it would prove a different thing.
 *
 * `file` defaults to the WORKFLOW. One row names the helper instead: the probe
 * summaries are the oracle the three teeth are judged with, so the guard that
 * holds them to the emitter's real shape needs disarming too, and its subject
 * lives in the test helper rather than in the workflow.
 *
 * @type {Array<{label:string, anchor:string, replacement:string, options?:object, also?:Array<{anchor:string,replacement:string,options?:object}>, reds:string, green:string[]}>}
 */
const MUTATIONS = [
  // ── tooth 1: a MISSING summary ────────────────────────────────────────────
  {
    label: 'tooth 1 PRESENCE — the missing-summary branch loses its `exit`',
    anchor: MISSING_BRANCH,
    replacement: MISSING_BRANCH.split('\n')
      .filter((l) => l.trim() !== 'exit 1')
      .join('\n'),
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 1 VALUE — the missing-summary branch exits ZERO',
    anchor: MISSING_BRANCH,
    replacement: MISSING_BRANCH.replace('exit 1', 'exit 0'),
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The exit is still THERE, and the block still contains the string
    // `exit 1` — it now fires on the OPPOSITE condition, failing the job
    // whenever the summary is PRESENT and passing it when it is absent. Any
    // check that searched the block for text would call this a tooth.
    label: 'tooth 1 VALUE — the exit is moved into the ELSE arm (it now fires on the wrong case)',
    anchor: MISSING_BRANCH,
    replacement: MISSING_BRANCH.replace(
      '            exit 1\n',
      '          else\n            exit 1\n',
    ),
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // POLARITY on the shell tooth. The `exit 1` is untouched; the TEST is. The
    // gate now fails every shard whose summary is present and passes every
    // shard that reported nothing — the precise inversion of the tooth.
    label: 'tooth 1 POLARITY — the file test is inverted (`! -f` becomes `-f`)',
    anchor: MISSING_COND,
    replacement: '          if [ -f "${SUMMARY}" ]; then',
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches, T.shape, T.lanes],
  },
  // ── tooth 2: failed > 0 / notRun > 0 — the measured defect ────────────────
  {
    // THE row this issue exists for. Before the fix this left the whole
    // `tests/` suite green while the step exited 0 on a night with real
    // failures.
    label: 'tooth 2 PRESENCE — the `failed > 0` branch loses its `process.exit(1)`',
    anchor: FAILED_EXIT,
    replacement: '            }\n            // #171 follow-up',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 VALUE — the `failed > 0` branch exits ZERO',
    anchor: FAILED_EXIT,
    replacement: '              process.exit(0);\n            }\n            // #171 follow-up',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 VALUE — the threshold is raised to one that can never fire',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) > 999 || (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 PRESENCE — the branch reads a field the summary does not carry',
    anchor: FAILED_COND,
    replacement: '            if ((s.failedTypo ?? 0) > 0 || (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.shape, T.lanes],
  },
  {
    // The exact inversion: the gate now fails every CLEAN shard and passes
    // every red one. Nothing syntactic distinguishes it — the `failed > 0`
    // comparison is still right there.
    label: 'tooth 2 POLARITY — the whole condition is negated with `!( … )`',
    anchor: FAILED_COND,
    replacement: '            if (!((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // ONE CHARACTER. `failed=8, notRun=0` — run 28552585087's shape exactly —
    // then evaluates false and the step exits 0.
    label: 'tooth 2 POLARITY — `||` becomes `&&` (only a shard red BOTH ways fails)',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) > 0 && (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 POLARITY — a dead conjunct on a field no summary carries',
    anchor: FAILED_COND,
    replacement:
      '            if (s.neverSet === "zzz" && ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  // ── FIXTURE REALISM: the round-3 findings ─────────────────────────────────
  // Every row below was measured GREEN against a probe set of
  // {failed, notRun, truncated} at 0 and 1. They are not new axes — they are
  // the SAME polarity axis, reached through data the fixtures did not model.
  // The lesson is one level down from round 2: replacing an under-specified
  // ORACLE with a better one still leaves you with an oracle, and the fixtures
  // then ARE the contract.
  {
    // Correct at 1, wrong at 8. This IS run 28552585087: eight real failures,
    // step exits 0, workflow SUCCESS, night counted toward the 14-night window.
    label: 'tooth 2 THRESHOLD — `> 0` becomes `=== 1` (correct at one failure, dead at eight)',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) === 1 || (s.notRun ?? 0) === 1) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 THRESHOLD — an UPPER bound `&& (s.failed ?? 0) < 2` caps what can go red',
    anchor: FAILED_COND,
    replacement:
      '            if (((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0) && (s.failed ?? 0) < 2) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The exact INVERSE of the `s.neverSet === "zzz"` row above — and the
    // inverse is the one that worked, because the gap was in the fixture.
    label: 'tooth 2 FIXTURE — `s.shard === undefined &&` (true only for a summary nobody emits)',
    anchor: FAILED_COND,
    replacement:
      '            if (s.shard === undefined && ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 FIXTURE — `|| s.passed > 0` makes the gate PERMANENTLY red',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0 || s.passed > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  // ── The probe CEILING: round 3 raised it, it did not remove it ────────────
  // Probing failed ∈ {0,1,8} accepts any upper bound above 8. `expectedTotal`
  // bounds the counts from above, so the fixtures now probe its TOP — and that
  // closes the family via the metadata-invariance property rather than moving it
  // up one rung again — see the header for what that does and does not cover.
  {
    // NOT academic. Against a real e2e-summary.mjs artifact for a shard where
    // every selected test failed (`passed:0, failed:N, expectedTotal:N`) this
    // evaluates FALSE — exit 0, workflow SUCCESS, on the worst shard state there is.
    label:
      'tooth 2 CEILING — `&& (s.failed ?? 0) < (s.expectedTotal ?? 0)` (an all-fail shard passes)',
    anchor: FAILED_COND,
    replacement:
      '            if (((s.failed ?? 0) > 0 && (s.failed ?? 0) < (s.expectedTotal ?? 0)) || (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // Above the round-3 probe of 8, and this repo's own history records a
    // 491-failure run (scripts/e2e-summary.mjs:176-179).
    label: 'tooth 2 CEILING — an upper bound `< 9`, one rung above the round-3 probes',
    anchor: FAILED_COND,
    replacement:
      '            if (((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0) && (s.failed ?? 0) < 9) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 2 CEILING — the same bound on the OTHER count (`notRun < 4`)',
    anchor: FAILED_COND,
    replacement:
      '            if ((s.failed ?? 0) > 0 || ((s.notRun ?? 0) > 0 && (s.notRun ?? 0) < 4)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  // ── METADATA-KEYED dead conjuncts: the mirror of the `undefined` spelling ──
  // The rows above key a dead conjunct on a field no summary carries. These key
  // it on the CONSTANT VALUE the probes happened to use — and every one of them
  // survived the round-4 fixtures, because only the counts varied. Two fail OPEN
  // on ordinary maintenance: `NEXTJS_REF` is bumped every cycle, and the same
  // `deploy-tests` job runs the Bun weekly lane through `KNEXT_RUNTIME`.
  ...[
    ['the Next.js REF — the gate dies silently at the next ref bump', 's.ref === "v16.2.1"'],
    ['the SHARD id — only shard 3 of 16 can ever go red', 's.shard === "3/16"'],
    ['the RUNTIME lane — one line disarms the entire Bun weekly', 's.runtime === "node"'],
    ['the EXCLUDED count — a per-shard value', 's.excluded === 2'],
    ['the EXPECTED TOTAL — 44 or 45 depending on the shard', 's.expectedTotal === 45'],
  ].map(([label, guard]) => ({
    label: `tooth 2 METADATA — dead conjunct keyed on ${label}`,
    anchor: FAILED_COND,
    replacement: `            if (${guard} && ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {`,
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  })),
  {
    // The permanently-red half of the same class, keyed on metadata: every shard
    // whose selection is 44 rather than 45 goes red for no reason.
    label: 'tooth 2 METADATA — `|| s.expectedTotal !== 45` reds every 44-test shard',
    anchor: FAILED_COND,
    replacement:
      '            if ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0 || s.expectedTotal !== 45) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The ceiling that survived "probe the top of the domain". It is closed by
    // INVARIANCE, not by a bigger probe: it fires on a 45-test shard where every
    // test failed and not on a 90-test one, so the verdict moves with metadata.
    label: 'tooth 2 CEILING — `< 46`, above the round-4 probe (closed by invariance, not by size)',
    anchor: FAILED_COND,
    replacement:
      '            if (((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0) && (s.failed ?? 0) < 46) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The `==`/`!=` refusal is only a guarantee in an EVALUATED position. Hidden
    // behind a ternary whose test no fixture gave a value, the arm was never
    // reached. Closed by the fixture fix rather than by a new rule — which is
    // the point: one realistic summary shuts three doors.
    label: 'tooth 2 REFUSAL — an unmodelled `==` hidden in a ternary arm',
    anchor: FAILED_COND,
    replacement:
      '            if (s.shard ? (s.failed ?? 0) == 999 : ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  // ── tooth 3: a TRUNCATED summary ──────────────────────────────────────────
  {
    label: 'tooth 3 PRESENCE — the truncated branch loses its `process.exit(1)`',
    anchor: TRUNC_EXIT,
    replacement: '            }\n          \' "${SUMMARY}"',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 VALUE — the truncated branch exits ZERO',
    anchor: TRUNC_EXIT,
    replacement: '              process.exit(0);\n            }\n          \' "${SUMMARY}"',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 VALUE — the truncated test is inverted to one that never fires',
    anchor: TRUNC_COND,
    replacement: '            if (s.truncated === false) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 POLARITY — the truncated test is negated with `!( … )`',
    anchor: TRUNC_COND,
    replacement: '            if (!(s.truncated === true)) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 POLARITY — a dead conjunct on a field no summary carries',
    anchor: TRUNC_COND,
    replacement: '            if (s.neverSet === "zzz" && s.truncated === true) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 FIXTURE — `s.ref === undefined &&` (true only for a summary nobody emits)',
    anchor: TRUNC_COND,
    replacement: '            if (s.ref === undefined && s.truncated === true) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 FIXTURE — `|| s.passed > 0` makes the gate PERMANENTLY red',
    anchor: TRUNC_COND,
    replacement: '            if (s.truncated === true || s.passed > 0) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The oracle disagreeing with reality in the OTHER direction. An earlier
    // fixture emitted `notRunFiles: []` on a green shard; the emitter OMITS the
    // key (`e2e-summary.mjs:267-270`, spread-conditional) and the gate reads it
    // as `s.notRunFiles ?? []`. So this stayed green against the fixture while
    // on a real green artifact it throws `TypeError: Cannot read properties of
    // undefined` — a non-zero exit on EVERY green shard. Caught now by the
    // evaluator's nullish-base refusal, which the faithful omission reaches.
    label: 'tooth 3 FIXTURE — `|| s.notRunFiles.length > 0` THROWS on every green shard',
    anchor: TRUNC_COND,
    replacement: '            if (s.truncated === true || s.notRunFiles.length > 0) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    // The same throw through ELEMENT access rather than property access. It
    // always reddened; what it used to red WITH was "teach me this construct",
    // which sends a reader to the evaluator instead of to the permanently-red
    // gate. The class is about the consequence, so it has to cover every access
    // form that produces it.
    label: 'tooth 3 FIXTURE — `|| s.notRunFiles[0] === "x"` throws through ELEMENT access',
    anchor: TRUNC_COND,
    replacement: '            if (s.truncated === true || s.notRunFiles[0] === "x") {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'tooth 3 METADATA — dead conjunct keyed on the Next.js ref',
    anchor: TRUNC_COND,
    replacement: '            if (s.ref === "v16.2.1" && s.truncated === true) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity, T.shape, T.lanes],
  },
  // ── the exit status must reach the step at all ────────────────────────────
  // Three teeth are worth nothing if the command carrying them is neutered.
  {
    label: 'all three teeth are neutered at once — the `node -e` invocation is `|| true`d',
    anchor: NODE_CLOSE,
    replacement: '          \' "${SUMMARY}" || true',
    reds: T.reaches,
    green: [T.missing, T.failed, T.truncated, T.vacuity, T.shape, T.lanes],
  },
  {
    label: 'errexit is turned OFF for the whole gate script',
    anchor: SET_E,
    replacement: '          set +e\n          SAFE_SHARD=',
    reds: T.reaches,
    green: [T.missing, T.failed, T.truncated, T.vacuity, T.shape, T.lanes],
  },
  {
    // The COMBINATION is the point, and it is why this row needs two edits.
    // The "reaches" checks used to sit AFTER the `program === null` bail-out,
    // so a gate whose program had moved out of `node -e` AND had errexit turned
    // off produced an EMPTY finding list: the assertion titled "the exit status
    // reaches the step" was green while its own claim was false. Either edit
    // alone is caught; only together did they hide.
    label: 'errexit is OFF **and** the program is no longer inline (the vacuous-pass case)',
    anchor: SET_E,
    replacement: '          set +e\n          SAFE_SHARD=',
    also: [
      {
        anchor: NODE_OPEN,
        replacement: "          node gate.mjs '\n            const s = require",
      },
    ],
    reds: T.reaches,
    // Teeth 2 and 3 SHOULD red — their program is genuinely unreachable now.
    // Only tooth 1, which lives in the shell prelude, is unaffected.
    green: [T.missing, T.shape, T.lanes],
  },
  {
    // The SECOND vacuous-pass shape, one hole over from the row above. The
    // swallow checks used to slice the script from `node -e '`; move the
    // program out AND append `|| true` and there was no anchor to slice from,
    // so the finding list came back empty again. Fixing one instance of a shape
    // and not scanning for the rest is how the sibling always gets missed.
    label: 'the program is no longer inline **and** the invocation is `|| true`d',
    anchor: NODE_CLOSE,
    replacement: '          \' "${SUMMARY}" || true',
    also: [
      {
        anchor: NODE_OPEN,
        replacement: "          node gate.mjs '\n            const s = require",
      },
    ],
    reds: T.reaches,
    green: [T.missing, T.shape, T.lanes],
  },
  {
    label: 'the gate is put in a PIPELINE — the pipeline reports tee’s status, not the gate’s',
    anchor: NODE_CLOSE,
    replacement: '          \' "${SUMMARY}" | tee /dev/null',
    reds: T.reaches,
    green: [T.missing, T.failed, T.truncated, T.vacuity, T.shape, T.lanes],
  },
  // ── the ORACLE guard is not decoration either ─────────────────────────────
  {
    // The only row that mutates the helper rather than the workflow. It
    // reinstates the exact defect round 4 found: the probe builder emits
    // `notRunFiles: []` on a green shard, which the emitter never does. The
    // shape guard must notice, because that one key is what hid a condition
    // throwing `TypeError` on every green artifact — and pinning the four
    // spellings I happened to think of would not have closed the class.
    label: 'the probe builder invents `notRunFiles: []`, a key the emitter OMITS',
    file: HELPER,
    anchor: '    ...(notRun > 0\n      ? {\n          notRunFiles: Array.from(',
    replacement:
      '    notRunFiles: [],\n    ...(notRun > 0\n      ? {\n          notRunFiles: Array.from(',
    reds: T.shape,
    green: [T.missing, T.failed, T.truncated, T.reaches, T.vacuity, T.lanes],
  },
  {
    // Collapse the probe set to ONE metadata variant. Invariance then holds
    // vacuously — nothing to differ against — so every metadata row above would
    // silently stop proving anything while all five per-tooth assertions stayed
    // green. The lanes guard is the only thing that notices, which is exactly
    // why it exists as an assertion rather than as a comment.
    label: 'the probe set collapses to ONE metadata variant (invariance holds vacuously)',
    file: HELPER,
    anchor: 'export const METADATA_VARIANTS: readonly ShardMeta[] = [NODE_LANE, BUN_LANE];',
    replacement: 'export const METADATA_VARIANTS: readonly ShardMeta[] = [NODE_LANE];',
    reds: T.lanes,
    green: [T.missing, T.failed, T.truncated, T.reaches, T.vacuity, T.shape],
  },
  {
    // The emitter's FIFTH conditional spread. Drop it from the builder and the
    // bun probe no longer describes what the bun lane actually emits — the same
    // oracle-vs-reality divergence as `notRunFiles`, one key over.
    label: 'the probe builder stops emitting `runtimeVersion` on the bun lane',
    file: HELPER,
    anchor:
      '    ...(meta.runtimeVersion === undefined ? {} : { runtimeVersion: meta.runtimeVersion }),',
    replacement: '    ...{},',
    reds: T.shape,
    green: [T.missing, T.failed, T.truncated, T.reaches, T.vacuity, T.lanes],
  },
  // ── the non-vacuity guard is not decoration either ────────────────────────
  {
    // A total disarm: with the step renamed, the audit locates nothing. Scored
    // against the non-vacuity assertion, which is the one whose whole job is to
    // notice that the parse matched nothing. `green` is empty ON PURPOSE — every
    // per-tooth assertion SHOULD red here, and pretending otherwise would be the
    // proof lying about its own scope.
    label: 'the gate step is renamed — the audit locates no branches at all',
    anchor: STEP_NAME,
    replacement: '      - name: Fail shard on red results\n',
    reds: T.vacuity,
    green: [T.shape, T.lanes],
  },
];

/** Every edit a row applies, in order. Most rows have exactly one. */
function editsOf(row) {
  return [
    { anchor: row.anchor, replacement: row.replacement, options: row.options ?? {} },
    ...(row.also ?? []).map((e) => ({ ...e, options: e.options ?? {} })),
  ];
}

/**
 * PREFLIGHT: every anchor occurs exactly once, and no two rows produce the same
 * mutated file.
 *
 * The second half is the one that has actually bitten: an anchor made only of
 * indentation substring-matches a more-indented sibling, two rows collapse into
 * one mutation, both go red, and `declared === run` cannot see it because the
 * duplicate row DOES run — it just proves nothing new. Computed in memory,
 * before anything touches disk.
 */
function preflight() {
  const problems = [];
  const seen = new Map();
  for (const row of MUTATIONS) {
    const { label } = row;
    const file = row.file ?? WORKFLOW;
    const source = readFileSync(file, 'utf8');
    let mutated = source;
    let bad = false;
    // Every edit, in order — a multi-edit row's later anchors are checked
    // against the text its earlier edits produced, which is what the harness
    // will see at run time.
    for (const { anchor, replacement } of editsOf(row)) {
      const n = countOccurrences(mutated, anchor);
      if (n !== 1) {
        problems.push(`"${label}": anchor occurs ${n} times (expected exactly 1)`);
        bad = true;
        break;
      }
      mutated = mutated.replace(anchor, () => replacement);
    }
    if (bad) continue;
    if (mutated === source) {
      problems.push(`"${label}": substitution changes nothing`);
      continue;
    }
    const fingerprint = `${file} :: ${createHash('sha256').update(mutated).digest('hex')}`;
    if (seen.has(fingerprint)) {
      problems.push(
        `"${label}" produces a mutated file byte-identical to "${seen.get(fingerprint)}" — ` +
          'two rows, one mutation. Re-anchor on text, not indentation.',
      );
      continue;
    }
    seen.set(fingerprint, label);
  }
  if (problems.length > 0) {
    console.error('FATAL: mutation table preflight failed\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Preflight: ${MUTATIONS.length} rows, all anchored once and all distinct.\n`);
}

preflight();
declareMutations(MUTATIONS.length);

/** Run one assertion and refuse to interpret a run in which nothing executed. */
function scored(selector, when) {
  const run = runGateTest(REPO_ROOT, SPEC, selector);
  if (run.ran === 0) {
    console.error(
      `   FATAL: no test matching ${JSON.stringify(selector)} ran ${when} ` +
        `(launched=${run.launched}, collected=${run.collected}, noTestFiles=${run.noTestFiles})`,
    );
    return null;
  }
  return run;
}

// Baseline: every assertion this proof scores is GREEN before any mutation.
for (const selector of Object.values(T)) {
  const base = scored(selector, 'at baseline');
  if (base === null) process.exit(1);
  if (!base.ok) {
    console.error(`FATAL: ${SPEC} -t ${JSON.stringify(selector)} is RED before any mutation`);
    process.exit(1);
  }
}
console.log(`baseline: ${Object.keys(T).length} targeted assertion(s) green\n`);

let pass = 0;
let fail = 0;

for (const row of MUTATIONS) {
  const { label, reds, green } = row;
  console.log(`── disarming: ${label}`);
  const snap = snapshot(row.file ?? WORKFLOW);
  let verdict = 'ok';
  try {
    for (const { anchor, replacement, options } of editsOf(row)) {
      mutate(snap, anchor, replacement, options);
    }

    const red = scored(reds, 'under mutation');
    if (red === null) {
      restore(snap);
      process.exit(1);
    }
    if (red.ok) {
      console.log(
        `   x DECORATION: ${JSON.stringify(reds)} stayed GREEN with its subject disarmed`,
      );
      verdict = 'fail';
    } else {
      console.log(`   ok ${JSON.stringify(reds)} went RED (${red.ran} test(s) ran)`);
    }

    // Direction 2 — independence. A sibling that reds here means the teeth are
    // not separable after all, and one red would be standing in for the others.
    for (const selector of green) {
      const sibling = scored(selector, 'as an independence check');
      if (sibling === null) {
        restore(snap);
        process.exit(1);
      }
      if (sibling.ok) {
        console.log(`   ok ${JSON.stringify(selector)} stayed green (independent)`);
      } else {
        console.log(`   x NOT INDEPENDENT: ${JSON.stringify(selector)} also went red`);
        verdict = 'fail';
      }
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (verdict === 'fail') fail += 1;
  else pass += 1;

  const after = scored(reds, 'after restore');
  if (after === null || !after.ok) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`\n${pass} row(s) proved, ${fail} row(s) failed`);
if (fail > 0) process.exit(1);
