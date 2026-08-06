#!/usr/bin/env node
/**
 * Standing mutation proof for the compat-ledger reconciliation (#695).
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * The guards added in #695 assert that a shard which reports nothing appears in
 * the ledger as MISSING and fails the job. On a healthy tree that path never
 * fires — every night either has all sixteen summaries or is red for some other
 * reason — so the guards are exactly the kind that can be written, merged, and
 * be decoration. Run 30790778590 is the reminder of what that costs: the
 * previous ledger reconciled against nothing, dropped the one failing shard, and
 * recorded a clean sheet for a red night that can no longer be reconstructed
 * because the job log has expired.
 *
 * Each mutation below DISARMS one half of the fix and requires the corresponding
 * guard to go RED:
 *
 *   1. the missing-shard reconciliation stops firing  → the completeness spec;
 *   2. the expected total is INFERRED from the artifacts that arrived (the
 *      original defect, restated in one line)          → the fail-closed spec;
 *   3. the ledger is written only when the run is clean → the evidence-survives
 *                                                          spec;
 *   4. the workflow's declared total drifts from the matrix → the cross-check;
 *   5. the ledger computation is re-inlined in the workflow → the run allowlist.
 *
 * Mutations land through the byte-snapshot harness, so restoration is
 * content-addressed and sha256-verified, and every mutation carries the residue
 * marker (`scripts/scan-mutation-residue.mjs` finds one that survives a stall).
 * Never `perl`: a silently-failed substitution yields a green run that proves
 * nothing.
 *
 * Usage:  node scripts/mutation-prove-ledger-completeness.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGateTest } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_SCRIPT = resolve(REPO_ROOT, 'scripts/compat-run-ledger.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

const COMPLETENESS_SPEC = 'tests/compat-run-ledger-completeness.test.ts';
const WORKFLOW_SPEC = 'tests/compat-shard-flake-attribution.test.ts';

/**
 * Every mutation this prover scores. The declaration is DERIVED from the list,
 * so a sixth entry cannot drift from the count the lane compares against (#685).
 *
 * @type {Array<{label:string, file:string, spec:string, test:string, anchor:string, replacement:string}>}
 */
const MUTATIONS = [
  {
    label: 'the missing-shard reconciliation stops firing',
    file: LEDGER_SCRIPT,
    spec: COMPLETENESS_SPEC,
    test: 'reproduces run 30790778590',
    anchor: 'if (expected !== null && missingShards.length > 0) {',
    replacement: 'if (expected !== null && missingShards.length > 999) {',
  },
  {
    // NOTE the honest scope: with COMPAT_SHARD_TOTAL merely UNSET, production
    // is double-covered — the sibling denominator check catches it too. What
    // this disarms is the fail-closed REFUSAL to infer, which is the property
    // the spec pins; it is not the only thing standing between the workflow and
    // a wrong count.
    label: 'the declared total falls back to the count that arrived',
    file: LEDGER_SCRIPT,
    spec: COMPLETENESS_SPEC,
    test: 'fails closed when the declared total is',
    anchor: '  const expected = parseShardTotal(shardTotal);',
    replacement: '  const expected = parseShardTotal(shardTotal) ?? observed.length;',
  },
  {
    label: 'a damaged artifact kills the process before the ledger is written',
    file: LEDGER_SCRIPT,
    spec: COMPLETENESS_SPEC,
    test: 'still produces a ledger, and still reds',
    // Disarms the per-file guard by making the catch RETHROW — i.e. restores
    // the unguarded `JSON.parse` mapped over the directory, which is exactly
    // what died before the ledger was written.
    anchor:
      '    return { value: null, error: `${label}: ${err instanceof Error ? err.message : err}` };',
    replacement: '    throw err;',
  },
  {
    label: 'the ledger is written only when the run is clean',
    file: LEDGER_SCRIPT,
    spec: COMPLETENESS_SPEC,
    test: 'still leaves the ledger on disk',
    // `\\n` on purpose: the anchor must match the two characters `\` and `n`
    // that appear in the source template literal, not a real newline. The
    // harness refuses an anchor that does not occur exactly once, which is how
    // the first version of this entry was caught rather than silently proving
    // nothing.
    anchor: '  writeFileSync(outFile, `${JSON.stringify(ledger, null, 2)}\\n`);',
    replacement:
      '  if (errors.length === 0) writeFileSync(outFile, `${JSON.stringify(ledger, null, 2)}\\n`);',
  },
  {
    label: "the workflow's declared total drifts from the matrix",
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the deploy-tests matrix IS the declared total',
    anchor: "  COMPAT_SHARD_TOTAL: '16'",
    replacement: "  COMPAT_SHARD_TOTAL: '15'",
  },
  // ── Finding 1: the step's COMMAND is not the only thing that matters ───────
  // Each of these left the whole suite green before the `auditLedgerJob`
  // allowlist landed, while `shard-ledger` concluded SUCCESS on a red night.
  // Five spellings on purpose: the finding IS that one spelling is not a rule.
  // The file-wide `continue-on-error:\s*true` text guard catches only the last
  // of them, and this repo had already written the expression form down as that
  // regex's known evasion.
  ...[
    ['step `if: ${{ false }}` — the step never runs, so no ledger is written', 'if: ${{ false }}'],
    ['step `continue-on-error: ${{ true }}` (expression)', 'continue-on-error: ${{ true }}'],
    ["step `continue-on-error: 'true'` (quoted scalar)", "continue-on-error: 'true'"],
    ['step `continue-on-error: true` (bare literal)', 'continue-on-error: true'],
  ].map(([label, line]) => ({
    label,
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the ledger job cannot be skipped or made unfailable',
    anchor: '        id: ledger\n',
    replacement: `        id: ledger\n        ${line}\n`,
  })),
  {
    label: 'job-level `continue-on-error: ${{ true }}` — one level up from the step',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the ledger job cannot be skipped or made unfailable',
    // Deliberately NOT prefixed with a newline: the harness prepends its
    // residue marker using the replacement's leading whitespace, so an anchor
    // that starts at a line boundary would splice that marker onto the END of
    // the previous line and corrupt the YAML — the guard would then go red on a
    // parse error rather than on the disarm, proving nothing.
    // (The marker literal is deliberately not written out here: the residue
    // scan refuses any tracked file containing it, and an allowlist entry for
    // this file would be exactly the silent exemption that guard must not have.)
    anchor: '    timeout-minutes: 10\n    outputs:',
    replacement: '    timeout-minutes: 10\n    continue-on-error: ${{ true }}\n    outputs:',
  },
  // ── Finding 3: the evidence can be written somewhere nobody uploads ────────
  {
    label: 'the audited step is relocated with `working-directory: /tmp`',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the audited step cannot be redirected away from the evidence path',
    anchor: '        id: ledger\n',
    replacement: '        id: ledger\n        working-directory: /tmp\n',
  },
  {
    label: 'the evidence path is redirected with `OUT_FILE` in the step env',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the audited step cannot be redirected away from the evidence path',
    anchor: '          EVENT_NAME: ${{ github.event_name }}\n',
    replacement:
      '          EVENT_NAME: ${{ github.event_name }}\n          OUT_FILE: /tmp/l.json\n',
  },
  // ── Round 3: the same boundaries, one level out from where they were drawn ─
  // Every one of these passed the round-2 guards. The pattern is identical each
  // time: the VALUE was checked and the PRESENCE was not, or the STEP was
  // checked and the level above it was not.
  {
    label: 'the job-level `if: always()` is DELETED — with `needs:`, the job simply skips',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the load-bearing wiring is PRESENT',
    anchor: '    needs: deploy-tests\n    if: always()\n',
    replacement: '    needs: deploy-tests\n',
  },
  {
    label: 'the job stops exporting red_detail — the alert quotes an empty string',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the load-bearing wiring is PRESENT',
    anchor: '    outputs:\n      red_detail: ${{ steps.ledger.outputs.red_detail }}\n',
    replacement: '    outputs: {}\n',
  },
  {
    label: 'the audited step stops setting EVENT_NAME — provenance silently becomes undefined',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the load-bearing wiring is PRESENT',
    anchor: '          EVENT_NAME: ${{ github.event_name }}\n',
    replacement: '          # EVENT_NAME removed\n',
  },
  {
    label: 'WORKFLOW-level `env: OUT_FILE` — inherited by the step, relocates the evidence',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'no INHERITED env or defaults can redirect the evidence',
    anchor: "  COMPAT_SHARD_TOTAL: '16'\n",
    replacement: "  COMPAT_SHARD_TOTAL: '16'\n  OUT_FILE: /tmp/laundered.json\n",
  },
  {
    label: 'WORKFLOW-level `defaults: run: working-directory` — the step-level form one level up',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'no INHERITED env or defaults can redirect the evidence',
    anchor: 'jobs:\n  build-next:',
    replacement: 'defaults:\n  run:\n    working-directory: /tmp\njobs:\n  build-next:',
  },
  {
    label: 'the FINGERPRINT artifact is read unguarded again — a damaged one kills the write',
    file: LEDGER_SCRIPT,
    spec: COMPLETENESS_SPEC,
    test: 'a FINGERPRINT artifact that is',
    anchor:
      "    ? readJsonObject(fingerprintFile, fingerprintFile.split('/').pop() ?? fingerprintFile)",
    replacement: "    ? { value: JSON.parse(readFileSync(fingerprintFile, 'utf8')), error: null }",
  },
  {
    label: 'the red alert stops covering CANCELLED (silence becomes success again)',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the red alert fires when the ledger or the shards are CANCELLED',
    anchor:
      "       needs.shard-ledger.result == 'failure' || needs.shard-ledger.result == 'cancelled' ||\n       needs.deploy-tests.result == 'cancelled')",
    replacement: "       needs.shard-ledger.result == 'failure')",
  },
  {
    label: 'the ledger computation is re-inlined in the workflow',
    file: WORKFLOW,
    spec: WORKFLOW_SPEC,
    test: 'the ledger job runs the audited script',
    anchor: '        run: node knext/scripts/compat-run-ledger.mjs',
    replacement: [
      '        run: |',
      "          node -e \"require('node:fs').writeFileSync('compat-run-ledger.json', '{}')\"",
    ].join('\n'),
  },
];

declareMutations(MUTATIONS.length);

let pass = 0;
let fail = 0;

/** A baseline the whole proof rests on: every targeted guard is GREEN first. */
for (const { spec, test, label } of MUTATIONS) {
  const base = runGateTest(REPO_ROOT, spec, test);
  if (base.ran === 0) {
    console.error(
      `FATAL: no test matching ${JSON.stringify(test)} ran in ${spec} ` +
        `(launched=${base.launched}, collected=${base.collected}, noTestFiles=${base.noTestFiles}) ` +
        `— the proof for "${label}" would be vacuous`,
    );
    process.exit(1);
  }
  if (!base.ok) {
    console.error(`FATAL: ${spec} -t ${JSON.stringify(test)} is RED before any mutation`);
    process.exit(1);
  }
}
console.log(`baseline: ${MUTATIONS.length} targeted guard(s) green\n`);

for (const { label, file, spec, test, anchor, replacement } of MUTATIONS) {
  console.log(`── disarming: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    const run = runGateTest(REPO_ROOT, spec, test);
    if (run.ran === 0) {
      console.error(`   FATAL: the guard did not run under mutation (${spec} -t ${test})`);
      restore(snap);
      process.exit(1);
    }
    if (run.ok) {
      console.log('   x DECORATION: the guard stayed GREEN with its subject disarmed');
      fail += 1;
    } else {
      console.log(`   ok went RED as required (${run.ran} test(s) ran)`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  const after = runGateTest(REPO_ROOT, spec, test);
  if (!after.ok || after.ran === 0) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`\n${pass} disarm(s) went red, ${fail} stayed green`);
if (fail > 0) process.exit(1);
