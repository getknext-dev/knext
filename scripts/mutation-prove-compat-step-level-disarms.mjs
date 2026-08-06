#!/usr/bin/env node
/**
 * Standing mutation proof for the compat gate's OUTSIDE-THE-SCRIPT disarms (#703).
 *
 * WHAT IS BEING PROVED
 * --------------------
 * #700/#701 made the "Fail shard on red results (revocation teeth)" step's three
 * teeth independently provable INSIDE the shell script it runs. That proof
 * cannot see the YAML the step is wrapped in — `tests/helpers/fail-on-red-gate.ts`
 * parses the `run:` block and nothing else, by construction. So the teeth are
 * disarmed from outside, by edits that never touch the script:
 *
 *   - `continue-on-error` on the step (or on the job), in any spelling;
 *   - a narrowed or deleted `if:` on the step;
 *   - a narrowed or deleted `if:` on any OTHER step in the job's reporting tail,
 *     so the summary or the ledger artifact the gate reads never happens;
 *   - a job-level `if:` on `deploy-tests` or anything the ledger `needs:`, so the
 *     job SKIPS — and a skipped job fails nothing, reports
 *     `needs.<job>.result == 'skipped'`, and files no alert either.
 *
 * WHAT THIS PROOF FOUND, AND WHAT IT DID NOT
 * ------------------------------------------
 * Measured on the tree #703 was filed against, BEFORE any fix — this is the
 * evidence the issue asked to be recorded either way, and half of it says the
 * issue's premise was already stale:
 *
 *   ALREADY COVERED by #697. `continue-on-error` on the gate step reds in all
 *   three spellings (`true`, `'true'`, `${{ true }}`) and at job level too, via
 *   `auditNoSwallowedFailures()`. Narrowing the gate step's own `if:` to a
 *   conjunction, and deleting it entirely, both red via `auditFailOnRedGate()`.
 *   #703's items 1-3 needed no new guard; they needed proving, which is this
 *   file.
 *
 *   NOT COVERED, and green under mutation. Narrowing `Summarize shard result`
 *   or `Upload summary artifact` to `always() && github.event_name == 'schedule'`
 *   left `tests/` entirely GREEN — the guard on them was `/if:\s*always\(\)/`,
 *   which a conjunction satisfies. A job-level `if:` on `deploy-tests` was green
 *   everywhere. And the same regex went RED on `${{ always() }}`, the identical
 *   condition: wrong in both directions from one pattern.
 *
 * THE TABLE IS DERIVED, NOT ENUMERATED
 * ------------------------------------
 * #701 regressed four times on adjacent axes, every one of them a shape nobody
 * had listed. So the rows here are GENERATED:
 *
 *   - the `if:` shapes and `continue-on-error` spellings come from
 *     `scripts/lib/workflow-conditioning-shapes.mjs`, the same tables the spec
 *     asserts verdicts for — add a shape there and it gains a mutation row here
 *     and an assertion there, or the coverage preflight below refuses to run;
 *   - the reporting-tail steps are read out of the workflow at run time, so a
 *     step appended to the tail is mutated without anyone editing this file;
 *   - the spine jobs are the `needs:` closure of `shard-ledger`, likewise.
 *
 * BOTH DIRECTIONS, TWICE OVER
 * ---------------------------
 *   1. every row names the assertion that must go RED, and the assertions that
 *      must stay GREEN under the same mutation (independence);
 *   2. `alsoReds` names the assertions that legitimately red as WELL. Two guards
 *      cover the fail-on-red step's `if:` — #697's and the tail audit's — and
 *      hiding that overlap in a shortened `green` list would be the proof lying
 *      about its own scope. It is asserted instead;
 *   3. the INVARIANCE rows (`reds: null`) mutate the workflow to an ADMISSIBLE
 *      spelling and require that NOTHING reds. A rejector that rejects
 *      everything passes every red-when-disarmed test ever written;
 *   4. the SHRINK rows delete an `if:` or a `needs:` edge rather than narrowing
 *      it. Those do not add a problem — they remove a step or a job from what
 *      the audit walks, so the audit passes by looking at less. The non-vacuity
 *      floors are what red, and this is the direction #701's coverage guard
 *      missed: "a check that covers the direction you just came from, not the
 *      direction you are going."
 *
 * RUN IT: `node scripts/mutation-prove-compat-step-level-disarms.mjs`.
 * Serialise it — it holds a live mutation in the workflow while a spec runs, so
 * nothing else may run the suite at the same time.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { runGateTest } from './lib/ci-blocking-gate-proof.mjs';
import { countOccurrences, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';
import {
  ADMISSIBLE_IF_SHAPES,
  CONTINUE_ON_ERROR_SPELLINGS,
  INADMISSIBLE_IF_SHAPES,
} from './lib/workflow-conditioning-shapes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

const COMPAT_SPEC = 'tests/compat-suite-workflow.test.ts';
const FLAKE_SPEC = 'tests/compat-shard-flake-attribution.test.ts';

/**
 * Every assertion this proof scores, as `{ spec, name }`.
 *
 * Two specs on purpose. The `continue-on-error` and gate-`if:` claims are
 * #697's and live in the flake spec; re-asserting them in the compat spec to
 * make this file tidier would be a second implementation of a guard that
 * already exists, which is the defect this repo keeps closing.
 *
 * `vitest -t` takes a REGEX, so every selector here is metacharacter-free — a
 * name containing `always()` would silently become a group.
 */
const A = {
  coe: {
    spec: FLAKE_SPEC,
    name: 'NO job or step anywhere can swallow its failure — every spelling, every job',
  },
  gateIf: { spec: FLAKE_SPEC, name: 'the fail-on-red gate exists and cannot be conditioned off' },
  tail: {
    spec: COMPAT_SPEC,
    name: '#703 every step in the deploy-tests reporting tail carries an ADMISSIBLE',
  },
  tailVac: { spec: COMPAT_SPEC, name: '#703 the deploy-tests reporting tail is NON-VACUOUS' },
  spine: { spec: COMPAT_SPEC, name: '#703 no job on the ledger spine can be conditioned off' },
  spineVac: { spec: COMPAT_SPEC, name: '#703 the ledger spine walk is NON-VACUOUS' },
  shapes: { spec: COMPAT_SPEC, name: '#703 every inadmissible' },
};

// ── what the workflow currently looks like, read rather than assumed ─────────

const SOURCE = readFileSync(WORKFLOW, 'utf8');
const DOC = parse(SOURCE) ?? {};
const JOBS = DOC.jobs ?? {};

/** The job that owns the compat verdict, and the job the ledger hangs from. */
const VERDICT_JOB = 'deploy-tests';
const SPINE_ROOT = 'shard-ledger';
const GATE_STEP = 'Fail shard on red results (revocation teeth)';

/**
 * The reporting tail, MIRRORING the rule in `tests/helpers/workflow-conditioning.ts`:
 * the longest run of steps at the END of the job in which every step declares an
 * `if:`. The helper owns the rule; this is the prover's copy of it, and the
 * preflight cross-checks the two by asserting the count the spec's floor names.
 */
function reportingTail() {
  const steps = JOBS[VERDICT_JOB]?.steps ?? [];
  let first = steps.length;
  while (first > 0 && steps[first - 1] && 'if' in steps[first - 1]) first -= 1;
  return steps.slice(first);
}

/** `shard-ledger` and every job it transitively `needs:`, in discovery order. */
function spineJobs() {
  const seen = [];
  const queue = [SPINE_ROOT];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.includes(id)) continue;
    seen.push(id);
    const needs = JOBS[id]?.needs;
    const deps = typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs : [];
    queue.push(...deps.filter((d) => typeof d === 'string'));
  }
  return seen;
}

const TAIL = reportingTail();
const SPINE = spineJobs();

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A tail step's RAW opening two lines — the `- name:` line exactly as written,
 * plus the `if:` line under it.
 *
 * Read out of the source rather than rebuilt from the parsed name, and that is
 * not fussiness: `Upload summary artifact (consumed by #41 matrix publisher)`
 * parses to `Upload summary artifact (consumed by`, because ` #` opens a YAML
 * comment. An anchor built from the parsed name would occur ZERO times, and
 * the row would be reported as a stale anchor rather than as the mutation it
 * was meant to be.
 */
function rawStepHead(parsedName) {
  const re = new RegExp(
    `^      - name: ${escapeRe(parsedName)}[^\\n]*\\n        if: [^\\n]*\\n`,
    'm',
  );
  const match = SOURCE.match(re);
  if (!match) throw new Error(`no raw step head found for ${JSON.stringify(parsedName)}`);
  return match[0];
}

/** Just the `- name:` line of that head, for replacements that drop the `if:`. */
function rawNameLine(parsedName) {
  return `${rawStepHead(parsedName).split('\n')[0]}\n`;
}

/** A job's key line, at the two-space indent GitHub requires. */
function jobKey(id) {
  return `  ${id}:\n`;
}

/**
 * A job-level `if:` disarm, expressed as ONE substitution.
 *
 * A job that already declares an `if:` must have it REPLACED — injecting a
 * second one is a duplicate YAML key, which fails to parse, and every assertion
 * then reds for a reason that has nothing to do with the disarm. That is the
 * "check WHY the red appeared" trap, built into the mutation rather than into
 * the reading of it.
 *
 * The anchor for that case runs from the JOB KEY down to the `if:` line rather
 * than being the `if:` line alone. Two reasons, both of which have already cost
 * a run: `    if: always()` is a substring of the eight-space step-level form,
 * so it does not occur exactly once; and an anchor that starts with a newline
 * gets the harness's residue marker prepended at column zero, which welds the
 * comment onto the end of the PREVIOUS line and eats it.
 */
function jobIfDisarm(id, value) {
  const key = jobKey(id);
  if (!('if' in (JOBS[id] ?? {}))) {
    return { anchor: key, replacement: `${key}    if: ${value}\n` };
  }
  const at = SOURCE.indexOf(key);
  if (at === -1) throw new Error(`job key for \`${id}\` not found in the workflow source`);
  const lines = SOURCE.slice(at).split('\n');
  const ifAt = lines.findIndex((line, i) => i > 0 && /^    if: /.test(line));
  if (ifAt === -1) throw new Error(`job \`${id}\` parses with an \`if:\` but none is on one line`);
  const head = `${lines.slice(0, ifAt + 1).join('\n')}\n`;
  return {
    anchor: head,
    replacement: `${lines.slice(0, ifAt).join('\n')}\n    if: ${value}\n`,
  };
}

/** The canonical narrowing disarm — the one #703 was filed for. */
const CANONICAL_NARROWING = "always() && github.event_name == 'schedule'";

/**
 * `bare` (`if: always()`) is the spelling the tree ALREADY uses everywhere, so
 * it cannot be reached by a substitution — the harness refuses a mutation that
 * changes nothing, correctly. It is proved by the BASELINE check instead: every
 * scored assertion is required green before the first mutation, on a tree whose
 * every `if:` is the bare form. Written down as an explicit exemption rather
 * than left as a gap in the coverage count.
 */
const ADMISSIBLE_COVERED_BY_BASELINE = new Set(['bare']);

// ── the table ────────────────────────────────────────────────────────────────

/**
 * @type {Array<{
 *   label: string,
 *   anchor: string,
 *   replacement: string,
 *   covers?: string,
 *   reds: {spec: string, name: string} | null,
 *   alsoReds?: Array<{spec: string, name: string}>,
 *   green: Array<{spec: string, name: string}>,
 * }>}
 */
const MUTATIONS = [];

// A. `continue-on-error`, every spelling, at STEP and JOB level.
//    Scored against #697's sweep, which asks "is it literally `false`?" rather
//    than banning forms — so the point of running five spellings is not to test
//    five branches (there is one) but to prove there is one.
for (const spelling of CONTINUE_ON_ERROR_SPELLINGS) {
  MUTATIONS.push({
    label: `continue-on-error: ${spelling.yaml} on the fail-on-red STEP`,
    anchor: rawStepHead(GATE_STEP),
    replacement: `${rawStepHead(GATE_STEP)}        continue-on-error: ${spelling.yaml}\n`,
    covers: `coe:${spelling.id}`,
    reds: A.coe,
    green: [A.gateIf, A.tail, A.tailVac, A.spine],
  });
  MUTATIONS.push({
    label: `continue-on-error: ${spelling.yaml} on the ${VERDICT_JOB} JOB`,
    anchor: jobKey(VERDICT_JOB),
    replacement: `${jobKey(VERDICT_JOB)}    continue-on-error: ${spelling.yaml}\n`,
    covers: `coe-job:${spelling.id}`,
    reds: A.coe,
    green: [A.gateIf, A.tail, A.tailVac, A.spine],
  });
}

// B1. Every INADMISSIBLE `if:` shape, on the gate step.
//     The shape axis is proved once, on one step, because ONE function
//     (`isAdmissibleIf`) judges all of them — repeating the shapes per step
//     would buy runtime, not evidence. Position is proved separately in B2.
for (const shape of INADMISSIBLE_IF_SHAPES) {
  MUTATIONS.push({
    label: `the fail-on-red step's if: becomes ${shape.yaml} — ${shape.why}`,
    anchor: rawStepHead(GATE_STEP),
    replacement: `${rawNameLine(GATE_STEP)}        if: ${shape.yaml}\n`,
    covers: `if-shape:${shape.id}`,
    reds: A.gateIf,
    // The tail audit covers this step too, and says so out loud.
    alsoReds: [A.tail],
    green: [A.coe, A.spine, A.spineVac, A.tailVac],
  });
}

// B2. The POSITION axis: the canonical narrowing, on every OTHER step in the
//     tail. Derived from the workflow, so a step appended to the tail is
//     mutated without this file changing.
for (const step of TAIL) {
  if (step.name === GATE_STEP) continue;
  MUTATIONS.push({
    label: `tail step "${step.name}" is narrowed to a conjunction`,
    anchor: rawStepHead(step.name),
    replacement: `${rawNameLine(step.name)}        if: ${CANONICAL_NARROWING}\n`,
    covers: `tail-narrow:${step.name}`,
    reds: A.tail,
    green: [A.gateIf, A.coe, A.spine, A.tailVac],
  });
}

// B3. The SHRINK direction: the `if:` is DELETED rather than narrowed. The step
//     leaves the suffix, taking every step above it with it, and the
//     admissibility audit then passes by judging fewer steps. The floor reds.
for (const step of TAIL) {
  const isGate = step.name === GATE_STEP;
  MUTATIONS.push({
    label: `tail step "${step.name}" loses its if: entirely (the tail SHRINKS)`,
    anchor: rawStepHead(step.name),
    replacement: rawNameLine(step.name),
    covers: `tail-delete:${step.name}`,
    reds: A.tailVac,
    // Deleting the GATE's `if:` is also #697's business: a step with no `if:`
    // does not run after a failed shard step, which is the only time it matters.
    alsoReds: isGate ? [A.gateIf] : [],
    green: isGate ? [A.tail, A.coe, A.spine] : [A.tail, A.gateIf, A.coe, A.spine],
  });
}

// C. A job-level `if:` on every job of the reconciliation spine.
for (const id of SPINE) {
  const { anchor, replacement } = jobIfDisarm(id, "github.event_name == 'schedule'");
  MUTATIONS.push({
    label: `job \`${id}\` gains a narrowing job-level if: (the whole job SKIPS)`,
    anchor,
    replacement,
    covers: `spine-if:${id}`,
    reds: A.spine,
    green: [A.tail, A.tailVac, A.gateIf, A.spineVac],
  });
}

// D. INVARIANCE. An admissible spelling must red NOTHING. Without these rows a
//    guard that rejected every `if:` would satisfy every row above.
for (const shape of ADMISSIBLE_IF_SHAPES) {
  if (ADMISSIBLE_COVERED_BY_BASELINE.has(shape.id)) continue;
  MUTATIONS.push({
    label: `the fail-on-red step's if: becomes ${shape.yaml} — the SAME condition, and nothing may red`,
    anchor: rawStepHead(GATE_STEP),
    replacement: `${rawNameLine(GATE_STEP)}        if: ${shape.yaml}\n`,
    covers: `admissible:${shape.id}`,
    reds: null,
    green: [A.gateIf, A.tail, A.tailVac, A.spine, A.spineVac, A.coe, A.shapes],
  });
}

// E. The spine's own SHRINK direction: cut a `needs:` edge and the closure gets
//    smaller, so a job that can now be silenced stops being judged at all.
MUTATIONS.push({
  label: `${VERDICT_JOB}'s \`needs:\` list is emptied (the spine SHRINKS)`,
  anchor: '    needs: build-next\n',
  replacement: '    needs: []\n',
  covers: 'spine-shrink',
  reds: A.spineVac,
  green: [A.tail, A.tailVac, A.gateIf],
});

// ── preflight ────────────────────────────────────────────────────────────────

/**
 * Refuse to run unless every anchor occurs exactly once, no two rows produce the
 * same file, every shape in the shared tables has a row, and the derived tail
 * and spine still match the floors the spec asserts.
 *
 * The last of those is the cross-check between this file's copy of the tail rule
 * and the helper's. Two implementations of one derivation can only diverge, and
 * a prover whose idea of "the tail" had drifted would quietly stop mutating a
 * step while still reporting a full table.
 */
function preflight() {
  const problems = [];

  if (TAIL.length < 4) {
    problems.push(
      `the derived reporting tail is ${TAIL.length} step(s) — the spec asserts a floor of 4, so ` +
        'either the workflow changed or this file and tests/helpers/workflow-conditioning.ts ' +
        'have drifted apart',
    );
  }
  if (SPINE.length < 3) {
    problems.push(`the derived ledger spine is ${SPINE.length} job(s) — the spec's floor is 3`);
  }
  if (!TAIL.some((s) => s.name === GATE_STEP)) {
    problems.push(`the reporting tail does not contain \`${GATE_STEP}\` — every row here is stale`);
  }

  const covered = new Set(MUTATIONS.map((m) => m.covers));
  for (const shape of INADMISSIBLE_IF_SHAPES) {
    if (!covered.has(`if-shape:${shape.id}`)) {
      problems.push(`inadmissible shape \`${shape.id}\` has no mutation row`);
    }
  }
  for (const shape of ADMISSIBLE_IF_SHAPES) {
    if (ADMISSIBLE_COVERED_BY_BASELINE.has(shape.id)) continue;
    if (!covered.has(`admissible:${shape.id}`)) {
      problems.push(`admissible spelling \`${shape.id}\` has no invariance row`);
    }
  }
  for (const spelling of CONTINUE_ON_ERROR_SPELLINGS) {
    if (!covered.has(`coe:${spelling.id}`) || !covered.has(`coe-job:${spelling.id}`)) {
      problems.push(`continue-on-error spelling \`${spelling.id}\` is not covered at both levels`);
    }
  }
  for (const step of TAIL) {
    if (!covered.has(`tail-delete:${step.name}`)) {
      problems.push(`tail step "${step.name}" has no deletion row`);
    }
  }
  for (const id of SPINE) {
    if (!covered.has(`spine-if:${id}`)) problems.push(`spine job \`${id}\` has no disarm row`);
  }

  const seen = new Map();
  for (const row of MUTATIONS) {
    const n = countOccurrences(SOURCE, row.anchor);
    if (n !== 1) {
      problems.push(`"${row.label}": anchor occurs ${n} times (expected exactly 1)`);
      continue;
    }
    const mutated = SOURCE.replace(row.anchor, () => row.replacement);
    if (mutated === SOURCE) {
      problems.push(`"${row.label}": substitution changes nothing`);
      continue;
    }
    const fingerprint = createHash('sha256').update(mutated).digest('hex');
    if (seen.has(fingerprint)) {
      problems.push(
        `"${row.label}" produces a file byte-identical to "${seen.get(fingerprint)}" — two rows, ` +
          'one mutation, and the duplicate proves nothing while still being counted',
      );
      continue;
    }
    seen.set(fingerprint, row.label);
  }

  if (problems.length > 0) {
    console.error('FATAL: mutation table preflight failed\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `Preflight: ${MUTATIONS.length} rows, all anchored once and all distinct.\n` +
      `  reporting tail (${TAIL.length}): ${TAIL.map((s) => s.name).join(' | ')}\n` +
      `  ledger spine  (${SPINE.length}): ${SPINE.join(' -> ')}\n`,
  );
}

preflight();
declareMutations(MUTATIONS.length);

/** Run ONE assertion, refusing to interpret a run in which nothing executed. */
function scored(target, when) {
  const run = runGateTest(REPO_ROOT, target.spec, target.name);
  if (run.ran === 0) {
    console.error(
      `   FATAL: no test matching ${JSON.stringify(target.name)} ran in ${target.spec} ${when} ` +
        `(launched=${run.launched}, collected=${run.collected}, noTestFiles=${run.noTestFiles})`,
    );
    return null;
  }
  return run;
}

const ALL = Object.values(A);
for (const target of ALL) {
  const base = scored(target, 'at baseline');
  if (base === null) process.exit(1);
  if (!base.ok) {
    console.error(
      `FATAL: ${target.spec} -t ${JSON.stringify(target.name)} is RED before any mutation`,
    );
    process.exit(1);
  }
}
console.log(`baseline: ${ALL.length} targeted assertion(s) green\n`);

let pass = 0;
let fail = 0;

for (const row of MUTATIONS) {
  console.log(`── disarming: ${row.label}`);
  const snap = snapshot(WORKFLOW);
  let verdict = 'ok';
  try {
    mutate(snap, row.anchor, row.replacement, { commentPrefix: '#' });

    if (row.reds !== null) {
      const red = scored(row.reds, 'under mutation');
      if (red === null) {
        restore(snap);
        process.exit(1);
      }
      if (red.ok) {
        console.log(
          `   x DECORATION: ${JSON.stringify(row.reds.name)} stayed GREEN with its subject disarmed`,
        );
        verdict = 'fail';
      } else {
        console.log(`   ok ${JSON.stringify(row.reds.name)} went RED (${red.ran} test(s) ran)`);
      }
    }

    // Declared overlap: these MUST red too. Silence here would mean the row's
    // `green` list had been trimmed to hide a second guard rather than name it.
    for (const target of row.alsoReds ?? []) {
      const extra = scored(target, 'as a declared-overlap check');
      if (extra === null) {
        restore(snap);
        process.exit(1);
      }
      if (extra.ok) {
        console.log(`   x DECLARED OVERLAP MISSING: ${JSON.stringify(target.name)} stayed green`);
        verdict = 'fail';
      } else {
        console.log(`   ok ${JSON.stringify(target.name)} also went red (declared)`);
      }
    }

    for (const target of row.green) {
      const sibling = scored(target, 'as an independence check');
      if (sibling === null) {
        restore(snap);
        process.exit(1);
      }
      if (sibling.ok) {
        console.log(`   ok ${JSON.stringify(target.name)} stayed green (independent)`);
      } else {
        console.log(`   x NOT INDEPENDENT: ${JSON.stringify(target.name)} also went red`);
        verdict = 'fail';
      }
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (verdict === 'fail') fail += 1;
  else pass += 1;
}

// One post-restore check, over every assertion: the file is byte-identical to
// its snapshot after each row (the harness proves that by sha256), so re-running
// the whole set per row would buy nothing but minutes.
for (const target of ALL) {
  const after = scored(target, 'after the final restore');
  if (after === null || !after.ok) {
    console.error(`FATAL: ${target.spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`\n${pass} row(s) proved, ${fail} row(s) failed`);
if (fail > 0) process.exit(1);
