#!/usr/bin/env node
/**
 * Mutation proof for the SHARDED, multi-ref mutation-prover lane (#2499, #2208),
 * graded by `tests/mutation-prover-lane-sharding.test.ts` on the shared driver.
 *
 * Each row breaks ONE rule of the lane and the guard must go red:
 *
 *   workflow (W..) — a ref is dropped from the schedule or the dispatch default;
 *     fail-fast turned on (a red leg would cancel the rest); the per-leg or
 *     per-prover bound blown past its ceiling; the shard flag or the report flag
 *     dropped; the leg checking out a moving branch instead of the planned sha;
 *     the report upload or the aggregate or the residue check conditioned on
 *     success; the aggregate step made a no-op; the alert no longer watching the
 *     aggregate; a soft-fail on the lane; a toolchain gated by ref name instead of
 *     file presence; a write scope on a non-alert job; a single shard.
 *   library (L..) — the partition leaking a prover; a missing report, a wrong sha,
 *     a missing prover, a declared != run, a broken union, an empty plan, a
 *     disagreeing discovery, a wrong per-leg assignment, an unsafe ref, a bad
 *     shard index, or an unbounded timeout all no longer being findings.
 *   runner (R..) — the kill reaching only the child, the child not leading its own
 *     process group, the shard flag ignored, the timeout not reported, an empty
 *     shard passing, an unknown flag passing, the report's discovered set shrinking
 *     to the shard.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified. The timing-sensitive rows (R01, R02) leave at most
 * a 2.5 s grandchild behind, which exits by itself.
 *
 * Usage:  node scripts/mutation-prove-2499-prover-lane-shards.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/mutation-prover-lane-sharding.test.ts';

/** A mutated workflow must still be YAML, or its red is a red for the wrong reason. */
const parses = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `workflow is not valid YAML: ${err.message}`;
  }
};

const MUTATIONS = [
  // ── the workflow ──────────────────────────────────────────────────────────
  {
    id: 'W01',
    subject: 'wf',
    claim: 'the SCHEDULED default drops integration/v2 (the v2 provers never re-run)',
    anchor: "LANE_REFS: ${{ inputs.refs || 'main integration/v2' }}",
    replacement: "LANE_REFS: ${{ inputs.refs || 'main' }}",
    validate: parses,
  },
  {
    id: 'W02',
    subject: 'wf',
    claim: 'the DISPATCH default drops integration/v2',
    anchor: "        default: 'main integration/v2'",
    replacement: "        default: 'main'",
    validate: parses,
  },
  {
    id: 'W03',
    subject: 'wf',
    claim: 'fail-fast on: one red leg cancels the other eleven',
    anchor: '      fail-fast: false',
    replacement: '      fail-fast: true',
    validate: parses,
  },
  {
    id: 'W04',
    subject: 'wf',
    claim: 'the per-leg ceiling is blown past any real bound',
    anchor: '    timeout-minutes: 160',
    replacement: '    timeout-minutes: 360',
    validate: parses,
  },
  {
    id: 'W05',
    subject: 'wf',
    claim: 'the per-prover bound is no longer below the leg ceiling',
    anchor: '          KNEXT_PROVER_TIMEOUT_MS: 6000000',
    replacement: '          KNEXT_PROVER_TIMEOUT_MS: 99999999',
    validate: parses,
  },
  {
    id: 'W06',
    subject: 'wf',
    claim: 'the leg runs every prover instead of its shard',
    anchor: '          --shard ${{ matrix.shard }}/${{ matrix.shards }}',
    replacement: '          --shard 1/1',
    validate: parses,
  },
  {
    id: 'W07',
    subject: 'wf',
    claim: 'the leg checks out the moving branch name, not the planned sha',
    anchor: '          ref: ${{ matrix.sha }}',
    replacement: '          ref: ${{ matrix.ref }}',
    validate: parses,
  },
  {
    id: 'W08',
    subject: 'wf',
    claim: 'the leg writes no report for the aggregate',
    anchor: '          --report "${{ runner.temp }}/lane-report/',
    replacement: '          --no-report "${{ runner.temp }}/lane-report/',
    validate: parses,
  },
  {
    id: 'W09',
    subject: 'wf',
    claim: "a red leg's report is not uploaded (the aggregate cannot tell red from missing)",
    anchor: '        if: always()\n        uses: actions/upload-artifact',
    replacement: '        if: success()\n        uses: actions/upload-artifact',
    validate: parses,
  },
  {
    id: 'W10',
    subject: 'wf',
    claim: 'the residue check only runs when the provers passed',
    anchor: '      - name: Assert no mutation residue survived\n        if: always()',
    replacement: '      - name: Assert no mutation residue survived\n        if: success()',
    validate: parses,
  },
  {
    id: 'W11',
    subject: 'wf',
    claim: 'the aggregate does not run when a leg failed (the missing leg goes unnamed)',
    anchor: '    if: always()\n    runs-on: ubuntu-latest\n    timeout-minutes: 10',
    replacement: '    if: success()\n    runs-on: ubuntu-latest\n    timeout-minutes: 10',
    validate: parses,
  },
  {
    id: 'W12',
    subject: 'wf',
    claim: 'the aggregate step does nothing',
    anchor: '        run: node scripts/prover-lane-aggregate.mjs',
    replacement: "        run: 'true'",
    validate: parses,
  },
  {
    id: 'W13',
    subject: 'wf',
    claim: 'the alert no longer waits for / watches the aggregate',
    anchor: '    needs: [plan, run-mutation-provers, aggregate]',
    replacement: '    needs: [plan, run-mutation-provers]',
    validate: parses,
  },
  {
    id: 'W14',
    subject: 'wf',
    claim: 'the lane soft-fails: a red leg cannot fail the run',
    anchor: '    name: Prove ${{ matrix.name }}',
    replacement: '    name: Prove ${{ matrix.name }}\n    continue-on-error: true',
    validate: parses,
  },
  {
    id: 'W15',
    subject: 'wf',
    claim: 'a toolchain is gated by REF NAME instead of file presence',
    anchor: "        if: ${{ hashFiles('crates/rust-toolchain.toml') != '' }}",
    replacement: "        if: ${{ matrix.ref == 'integration/v2' }}",
    validate: parses,
  },
  {
    id: 'W16',
    subject: 'wf',
    claim: 'a non-alert job holds a write scope',
    anchor: '    timeout-minutes: 10\n    steps:',
    replacement: '    timeout-minutes: 10\n    permissions:\n      contents: write\n    steps:',
    validate: parses,
  },
  {
    id: 'W17',
    subject: 'wf',
    claim: 'one shard: the split (and the per-leg bound it buys) is gone',
    anchor: '          LANE_SHARDS: 6',
    replacement: '          LANE_SHARDS: 1',
    validate: parses,
  },
  {
    id: 'W18',
    subject: 'wf',
    claim: 'the matrix is a static literal, not the planned one (the sha pin is bypassed)',
    anchor: '      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}',
    replacement:
      '      matrix: { include: [{ ref: main, sha: abc, shard: 1, shards: 1, slug: main }] }',
    validate: parses,
  },
  {
    id: 'W19',
    subject: 'wf',
    claim: 'the opt-in per-leg cargo target dir is gone',
    anchor: '          KNEXT_LANE_CARGO_TARGET_DIR: ${{ runner.temp }}/cargo-target',
    replacement: '          KNEXT_LANE_UNUSED: 1',
    validate: parses,
  },
  {
    id: 'W20',
    subject: 'wf',
    claim: 'the cargo target dir goes lane-wide (measured to break knext-ffi-crates)',
    anchor: '          KNEXT_LANE_CARGO_TARGET_DIR: ${{ runner.temp }}/cargo-target',
    replacement:
      '          KNEXT_LANE_CARGO_TARGET_DIR: ${{ runner.temp }}/cargo-target\n          CARGO_TARGET_DIR: ${{ runner.temp }}/cargo-target',
    validate: parses,
  },
  // ── the library ───────────────────────────────────────────────────────────
  {
    id: 'L01',
    subject: 'lib',
    claim: 'the partition is off by one: a prover falls out of every shard',
    anchor: '  return [...provers].sort(byPath).filter((p) => owner.get(p.relPath) === index - 1);',
    replacement:
      '  return [...provers].sort(byPath).filter((p) => owner.get(p.relPath) === index);',
  },
  {
    id: 'L02',
    subject: 'lib',
    claim: 'a leg with no report is not a finding',
    anchor:
      '      findings.push(\n        `${label}: no report — the leg was cancelled, crashed, or its artifact is missing`,\n      );',
    replacement: '      void label;',
  },
  {
    id: 'L03',
    subject: 'lib',
    claim: 'a report for the wrong sha is not a finding',
    anchor: '    if (report.sha !== leg.sha) {',
    replacement: '    if (false) {',
  },
  {
    id: 'L04',
    subject: 'lib',
    claim: 'a prover assigned to a shard but absent from its results is not a finding',
    anchor:
      '        findings.push(\n          `${label}: ${relPath} is assigned to this shard but missing from its results`,\n        );',
    replacement: '        void relPath;',
  },
  {
    id: 'L05',
    subject: 'lib',
    claim: 'declared != run is trusted to the leg’s own (possibly empty) findings',
    anchor:
      '          findings.push(\n            `${label}: ${relPath}: declared ${r.declared} mutation(s) but ran ${r.run}`,\n          );',
    replacement: '          void r;',
  },
  {
    id: 'L06',
    subject: 'lib',
    claim: 'the final union check is gone (a partition wrong everywhere passes)',
    anchor: '    if (present.length === legs.length && !sameSet(first, assignedAll)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'L07',
    subject: 'lib',
    claim: 'an empty plan is a pass',
    anchor: '  if (!Array.isArray(expected) || expected.length === 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'L08',
    subject: 'lib',
    claim: 'a ref with shell syntax is accepted into the matrix',
    anchor: "    if (!SAFE_REF_RE.test(ref) || ref.includes('..'))",
    replacement: '    if (false)',
  },
  {
    id: 'L09',
    subject: 'lib',
    claim: 'legs that discovered different provers are not a finding',
    anchor: '      if (!sameSet(first, report.discovered)) {',
    replacement: '      if (false) {',
  },
  {
    id: 'L10',
    subject: 'lib',
    claim: "a leg's assigned set is no longer checked against the partition function",
    anchor: '    if (!Array.isArray(report.assigned) || !sameSet(entitled, report.assigned)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'L11',
    subject: 'lib',
    claim: 'shard index above the count is accepted',
    anchor: '  if (count < 1 || index < 1 || index > count) {',
    replacement: '  if (count < 1 || index < 1) {',
  },
  {
    id: 'L12',
    subject: 'lib',
    claim: 'a nonsense per-prover bound is accepted (and would run unbounded)',
    anchor: '  if (!Number.isFinite(n) || n <= 0) {',
    replacement: '  if (false) {',
  },
  {
    id: 'L14',
    subject: 'lib',
    claim: 'a pending (not yet merged) heavy prover is weighted as 1 once it arrives',
    anchor: '  PROVER_WEIGHT_MINUTES[p.relPath] ?? PENDING_PROVER_WEIGHT_MINUTES[p.relPath] ?? 1;',
    replacement: '  PROVER_WEIGHT_MINUTES[p.relPath] ?? 1;',
  },
  {
    id: 'L13',
    subject: 'lib',
    claim: 'the default per-prover bound is zero (every prover times out) ',
    anchor: "  if (raw === undefined || raw === '') return 100 * 60 * 1000;",
    replacement: "  if (raw === undefined || raw === '') return 0;",
  },
  // ── the runner ────────────────────────────────────────────────────────────
  {
    id: 'R01',
    subject: 'runner',
    claim: 'the kill reaches only the prover, not its children (orphans keep mutating the tree)',
    anchor: "        process.kill(-child.pid, 'SIGKILL');",
    replacement: "        process.kill(child.pid, 'SIGKILL');",
  },
  {
    id: 'R02',
    subject: 'runner',
    claim: 'the prover does not lead its own process group (no group to kill)',
    anchor: '      detached: true,',
    replacement: '      detached: false,',
  },
  {
    id: 'R03',
    subject: 'runner',
    claim: 'the shard flag is parsed and then ignored',
    anchor:
      'const provers = shard ? shardProvers(discovered, shard.index, shard.count) : discovered;',
    replacement: 'const provers = discovered;',
  },
  {
    id: 'R04',
    subject: 'runner',
    claim: 'a timeout is not reported as one',
    anchor: '  if (run.timedOut) {',
    replacement: '  if (false) {',
  },
  {
    id: 'R05',
    subject: 'runner',
    claim: 'an empty shard passes vacuously',
    anchor: '\nif (provers.length === 0) {',
    replacement: '\nif (false) {',
  },
  {
    id: 'R06',
    subject: 'runner',
    claim: 'an unrecognised flag is ignored (a typo runs the wrong set)',
    anchor:
      '      fatal(\n        `unknown argument ${JSON.stringify(a)} — an unrecognised flag must not mean "run everything"`,\n      );',
    replacement: '      void a;',
  },
  {
    id: 'R07',
    subject: 'runner',
    claim: "the report's discovered set shrinks to the shard (the union can never be checked)",
    anchor: '    discovered: discovered.map((p) => p.relPath),',
    replacement: '    discovered: provers.map((p) => p.relPath),',
  },
];

// A real mutation of a real subject, distinct from the rows, so it also proves
// the runner reads the file under proof.
const CANARY = {
  subject: 'lib',
  anchor: "export const LANE_REFS = Object.freeze(['main', 'integration/v2']);",
  replacement: "export const LANE_REFS = Object.freeze(['main']);",
};

// Inline literal: the lane's subject-existence audit reads these from the call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    wf: '.github/workflows/mutation-prover-nightly.yml',
    lib: 'scripts/lib/prover-shard.mjs',
    runner: 'scripts/run-mutation-provers.mjs',
  },
});

console.log('=== mutation proof: the sharded two-ref mutation-prover lane (#2499, #2208) ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
