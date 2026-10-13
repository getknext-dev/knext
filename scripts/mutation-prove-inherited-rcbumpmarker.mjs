#!/usr/bin/env node
/**
 * Mutation proof for #2325 — an `rcBumpMarker` that reaches a PR through a
 * MERGED-IN branch must not count as introduced by that PR.
 *
 * Two halves, two specs:
 *   * the decision, in `scripts/compat-credential-freeze-guard.mjs`
 *     (`markerArrivedViaMerge`, the `markerIntroducedByPr` short-circuit, the
 *     `evaluateFreezeGuard` branch, and the CLI's required, array-typed
 *     `--inherited-pins-file`), proved against
 *     `tests/compat-credential-freeze-guard.test.ts`;
 *   * the collection, the workflow's "Collect the pins at merged-in parents"
 *     step and the flag on the guard invocation, proved against
 *     `tests/compat-credential-freeze-guard-workflow.test.ts`, whose #2325
 *     block runs that step verbatim in real git fixture repos.
 *
 * Each mutation removes one piece of behaviour and must turn its spec RED by
 * EXIT CODE (`scripts/lib/guard-prover.mjs`: baseline green, canary red,
 * every anchor exactly once, clean tree between mutations). Commit first: the
 * harness refuses a dirty tree.
 *
 * Deliberately NOT a row: dropping `inheritedPins` from the
 * `markerIntroducedByPr` call inside `evaluateFreezeGuard`. The
 * `markerArrivedViaMerge` branch above it already refuses the same input, so
 * that mutation survives by design (defence in depth), and a row for it would
 * be a known survivor.
 *
 * Usage:  node scripts/mutation-prove-inherited-rcbumpmarker.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SCRIPT = resolve(REPO_ROOT, 'scripts/compat-credential-freeze-guard.mjs');
const GUARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/compat-credential-freeze-guard.yml');
const UNIT_SPEC = 'tests/compat-credential-freeze-guard.test.ts';
const WORKFLOW_SPEC = 'tests/compat-credential-freeze-guard-workflow.test.ts';

/** A mutated workflow must still parse, or its red is for the wrong reason. */
function validYaml(text) {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `YAML no longer parses: ${err.message}`;
  }
}

const SCRIPT_MUTATIONS = [
  {
    id: 'S1',
    expect: 'red',
    claim:
      'markerIntroducedByPr stops consulting the merged-in pins — an exported caller reads a ' +
      'merged-in marker as introduced again',
    subject: 'guard',
    anchor: '  if (markerArrivedViaMerge(headPin, inheritedPins)) return false;\n',
    replacement: '  void 0;\n',
  },
  {
    id: 'S2',
    expect: 'red',
    claim: 'markerArrivedViaMerge never matches — every merged-in marker exempts frozen files',
    subject: 'guard',
    anchor: '    return !!m && m.date === head.date && m.reason === head.reason;',
    replacement: '    return false;',
  },
  {
    id: 'S3',
    expect: 'red',
    claim:
      'the match drops `reason` — a merge PR that re-authorizes with a new reason (same date) ' +
      'is wrongly refused',
    subject: 'guard',
    anchor: '    return !!m && m.date === head.date && m.reason === head.reason;',
    replacement: '    return !!m && m.date === head.date;',
  },
  {
    id: 'S4',
    expect: 'red',
    claim:
      'evaluateFreezeGuard loses its merged-in branch — the refusal reports the merge base, ' +
      'pointing the author at the wrong fix',
    subject: 'guard',
    anchor: '  if (validity.valid && markerArrivedViaMerge(headPin, inheritedPins)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'S5',
    expect: 'red',
    claim:
      'the CLI no longer requires --inherited-pins-file — the documented fail-closed message ' +
      'is gone',
    subject: 'guard',
    anchor: '  if (!inheritedPinsFile) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'S6',
    expect: 'red',
    claim:
      'the CLI accepts a non-array --inherited-pins-file — a malformed collection is silently ' +
      'treated as "no merges"',
    subject: 'guard',
    anchor: '  if (!Array.isArray(inheritedPins)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'S7',
    expect: 'red',
    claim:
      'the CLI reads the inherited pins but never hands them to evaluateFreezeGuard — the ' +
      'end-to-end merge PR goes green',
    subject: 'guard',
    anchor: '    mergeBasePin,\n    inheritedPins,\n    touchedFiles,\n',
    replacement: '    mergeBasePin,\n    touchedFiles,\n',
  },
];

const WORKFLOW_MUTATIONS = [
  {
    id: 'W1',
    expect: 'red',
    claim:
      "merge_group stops skipping the queue's own merges — the queued PR's own marker reads " +
      'as inherited and a legitimate PR is refused in the queue',
    subject: 'workflow',
    anchor: '              if (queueMerges.has(merge)) continue;',
    replacement: `              /* ${MUTATION_MARKER} */ void 0;`,
    validate: validYaml,
  },
  {
    id: 'W2',
    expect: 'red',
    claim:
      'the queue-merge skip applies to pull_request too — a merge PR skips its own merge ' +
      'commit and the merged-in marker exempts frozen files again',
    subject: 'workflow',
    anchor: '              GITHUB_EVENT_NAME === "merge_group"',
    replacement: `              /* ${MUTATION_MARKER} */ true`,
    validate: validYaml,
  },
  {
    id: 'W3',
    expect: 'red',
    claim: 'no merged-in parent is read — the collection is always empty',
    subject: 'workflow',
    anchor: '              for (const parent of mergedIn) {',
    replacement: `              for (const parent of mergedIn.slice(0, 0)) { /* ${MUTATION_MARKER} */`,
    validate: validYaml,
  },
  {
    id: 'W4',
    expect: 'red',
    claim: 'the walk covers no commits (head..head) — the collection is always empty',
    subject: 'workflow',
    anchor: '"--merges", "--parents", `${MERGE_BASE}..${HEAD_SHA}`',
    replacement: `"--merges", "--parents", \`\${HEAD_SHA}..\${HEAD_SHA}\` /* ${MUTATION_MARKER} */`,
    validate: validYaml,
  },
  {
    id: 'W5',
    expect: 'red',
    claim: 'the guard invocation stops passing --inherited-pins-file',
    subject: 'workflow',
    anchor: '            --inherited-pins-file inherited-pins.json \\\n',
    replacement: `            # ${MUTATION_MARKER}\n            \\\n`,
    validate: validYaml,
  },
];

declareMutations(SCRIPT_MUTATIONS.length + WORKFLOW_MUTATIONS.length);

const scriptProver = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: UNIT_SPEC,
  subjects: { guard: GUARD_SCRIPT },
});
const workflowProver = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: WORKFLOW_SPEC,
  subjects: { workflow: GUARD_WORKFLOW },
});

console.log(`=== mutation proof: ${UNIT_SPEC} (#2325 decision) ===`);
scriptProver.preflight(SCRIPT_MUTATIONS);
console.log(`=== mutation proof: ${WORKFLOW_SPEC} (#2325 collection) ===`);
workflowProver.preflight(WORKFLOW_MUTATIONS);

scriptProver.baseline();
scriptProver.proveCanSeeRed({
  subject: 'guard',
  anchor: '  if (!base) return true;',
  replacement: '  if (!base) return false;',
});
console.log('\n=== decision mutations ===');
for (const m of SCRIPT_MUTATIONS) {
  scriptProver.run(m);
  recordMutation();
}
scriptProver.finish(SCRIPT_MUTATIONS.length);

workflowProver.baseline();
workflowProver.proveCanSeeRed({
  subject: 'workflow',
  anchor: '                pins.push({ rcBumpMarker: marker });',
  replacement: `                /* ${MUTATION_MARKER} */ void 0;`,
});
console.log('\n=== collection mutations ===');
for (const m of WORKFLOW_MUTATIONS) {
  workflowProver.run(m);
  recordMutation();
}
workflowProver.finish(WORKFLOW_MUTATIONS.length);
