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
const SPEC = 'tests/compat-suite-workflow.test.ts';

/** The five assertions this proof scores against, by `vitest -t` selector. */
const T = {
  vacuity: '#700 the teeth audit is NON-VACUOUS',
  missing: '#700 tooth 1/3',
  failed: '#700 tooth 2/3',
  truncated: '#700 tooth 3/3',
  reaches: '#700 the gate script',
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
    green: [T.failed, T.truncated, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 1 VALUE — the missing-summary branch exits ZERO',
    anchor: MISSING_BRANCH,
    replacement: MISSING_BRANCH.replace('exit 1', 'exit 0'),
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches, T.vacuity],
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
    green: [T.failed, T.truncated, T.reaches, T.vacuity],
  },
  {
    // POLARITY on the shell tooth. The `exit 1` is untouched; the TEST is. The
    // gate now fails every shard whose summary is present and passes every
    // shard that reported nothing — the precise inversion of the tooth.
    label: 'tooth 1 POLARITY — the file test is inverted (`! -f` becomes `-f`)',
    anchor: MISSING_COND,
    replacement: '          if [ -f "${SUMMARY}" ]; then',
    reds: T.missing,
    green: [T.failed, T.truncated, T.reaches],
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
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 2 VALUE — the `failed > 0` branch exits ZERO',
    anchor: FAILED_EXIT,
    replacement: '              process.exit(0);\n            }\n            // #171 follow-up',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 2 VALUE — the threshold is raised to one that can never fire',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) > 999 || (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 2 PRESENCE — the branch reads a field the summary does not carry',
    anchor: FAILED_COND,
    replacement: '            if ((s.failedTypo ?? 0) > 0 || (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches],
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
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  {
    // ONE CHARACTER. `failed=8, notRun=0` — run 28552585087's shape exactly —
    // then evaluates false and the step exits 0.
    label: 'tooth 2 POLARITY — `||` becomes `&&` (only a shard red BOTH ways fails)',
    anchor: FAILED_COND,
    replacement: '            if ((s.failed ?? 0) > 0 && (s.notRun ?? 0) > 0) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 2 POLARITY — a dead conjunct on a field no summary carries',
    anchor: FAILED_COND,
    replacement:
      '            if (s.neverSet === "zzz" && ((s.failed ?? 0) > 0 || (s.notRun ?? 0) > 0)) {',
    options: JS,
    reds: T.failed,
    green: [T.missing, T.truncated, T.reaches, T.vacuity],
  },
  // ── tooth 3: a TRUNCATED summary ──────────────────────────────────────────
  {
    label: 'tooth 3 PRESENCE — the truncated branch loses its `process.exit(1)`',
    anchor: TRUNC_EXIT,
    replacement: '            }\n          \' "${SUMMARY}"',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 3 VALUE — the truncated branch exits ZERO',
    anchor: TRUNC_EXIT,
    replacement: '              process.exit(0);\n            }\n          \' "${SUMMARY}"',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 3 VALUE — the truncated test is inverted to one that never fires',
    anchor: TRUNC_COND,
    replacement: '            if (s.truncated === false) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 3 POLARITY — the truncated test is negated with `!( … )`',
    anchor: TRUNC_COND,
    replacement: '            if (!(s.truncated === true)) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity],
  },
  {
    label: 'tooth 3 POLARITY — a dead conjunct on a field no summary carries',
    anchor: TRUNC_COND,
    replacement: '            if (s.neverSet === "zzz" && s.truncated === true) {',
    options: JS,
    reds: T.truncated,
    green: [T.missing, T.failed, T.reaches, T.vacuity],
  },
  // ── the exit status must reach the step at all ────────────────────────────
  // Three teeth are worth nothing if the command carrying them is neutered.
  {
    label: 'all three teeth are neutered at once — the `node -e` invocation is `|| true`d',
    anchor: NODE_CLOSE,
    replacement: '          \' "${SUMMARY}" || true',
    reds: T.reaches,
    green: [T.missing, T.failed, T.truncated, T.vacuity],
  },
  {
    label: 'errexit is turned OFF for the whole gate script',
    anchor: SET_E,
    replacement: '          set +e\n          SAFE_SHARD=',
    reds: T.reaches,
    green: [T.missing, T.failed, T.truncated, T.vacuity],
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
    green: [T.missing],
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
    green: [],
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
  const source = readFileSync(WORKFLOW, 'utf8');
  for (const row of MUTATIONS) {
    const { label } = row;
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
    const fingerprint = createHash('sha256').update(mutated).digest('hex');
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
  const snap = snapshot(WORKFLOW);
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
