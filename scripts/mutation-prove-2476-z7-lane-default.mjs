#!/usr/bin/env node
/**
 * Mutation proof for the Z7 kind e2e lane following the operator's shipped
 * key-rotation propagation bound instead of hard-coding one. Companion to
 * `mutation-prove-2476-propagation-bound.mjs`, which proves the operator side
 * with `go test`; this half is graded by the lane's own guard
 * (tests/z7-identity-kind-e2e-lane.test.ts) on the shared driver.
 *
 * Each row breaks ONE rule in the lane script and the guard must go red:
 *   - a literal default bound written into the script (L01) or a literal
 *     minimum (L02);
 *   - the flag passed even when no override is set, so the lane stops being a
 *     canary for the shipped default (L03);
 *   - the unset case no longer checked to run the operator WITHOUT the flag
 *     (L04);
 *   - the expected default or minimum read from a field that is not the
 *     operator's (L05, L06).
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-2476-z7-lane-default.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The lane: the Z7 kind e2e follows the shipped default.
const LANE_MUTATIONS = [
  {
    id: 'L01',
    subject: 'runsh',
    claim: 'the lane hard-codes its default bound (and so stops following the operator)',
    anchor: 'BOUND="${Z7_PROPAGATION_BOUND:-${SHIPPED_BOUND_SECONDS}s}"',
    replacement: 'BOUND="${Z7_PROPAGATION_BOUND:-90s}"',
  },
  {
    id: 'L02',
    subject: 'runsh',
    claim: 'the lane hard-codes the minimum it accepts',
    anchor:
      '[ "${BOUND_SECONDS}" -ge "${MIN_BOUND_SECONDS}" ] \\\n  || { echo "the operator refuses a bound below ${MIN_BOUND_SECONDS}s" >&2; exit 64; }',
    replacement:
      '[ "${BOUND_SECONDS}" -ge 60 ] \\\n  || { echo "the operator refuses a bound below ${MIN_BOUND_SECONDS}s" >&2; exit 64; }',
  },
  {
    id: 'L03',
    subject: 'runsh',
    claim:
      'the lane passes the flag even when no override is set (no longer a canary of the default)',
    anchor: '  if [ -n "${Z7_PROPAGATION_BOUND:-}" ]; then\n    awk -v bound="${BOUND}" \'',
    replacement: '  if true; then\n    awk -v bound="${BOUND}" \'',
  },
  {
    id: 'L04',
    subject: 'runsh',
    claim: 'the lane no longer checks that the operator runs without the flag when unset',
    anchor:
      '      | jq -e \'[.spec.template.spec.containers[0].args[] | select(startswith("--zone-signing-key-propagation-bound"))] | length == 0\' >/dev/null \\\n',
    replacement:
      '      | jq -e \'[.spec.template.spec.containers[0].args[] | select(startswith("--zone-signing-key-propagation-bound"))] | length >= 0\' >/dev/null \\\n',
  },
  {
    id: 'L05',
    subject: 'runsh',
    claim: "the lane reads the expected default from a field that is not the operator's default",
    anchor:
      'SHIPPED_BOUND_SECONDS="$(jq -er \'.rotation.propagationBoundSeconds\' "${BOUND_FIXTURE}")" \\\n',
    replacement:
      'SHIPPED_BOUND_SECONDS="$(jq -er \'.rotation.overlapSeconds\' "${BOUND_FIXTURE}")" \\\n',
  },
  {
    id: 'L06',
    subject: 'runsh',
    claim: "the lane reads the minimum from a field that is not the operator's minimum",
    anchor:
      'MIN_BOUND_SECONDS="$(jq -er \'.rotation.propagationBoundMinimumSeconds\' "${BOUND_FIXTURE}")" \\\n',
    replacement:
      'MIN_BOUND_SECONDS="$(jq -er \'.rotation.overlapSeconds\' "${BOUND_FIXTURE}")" \\\n',
  },
];

// The subjects are an inline literal, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/z7-identity-kind-e2e-lane.test.ts',
  subjects: { runsh: 'packages/grpc/e2e/z7-identity-kind/run.sh' },
});

console.log('=== mutation proof: the Z7 kind lane follows the shipped propagation bound ===');
lane.preflight(LANE_MUTATIONS);
declareMutations(LANE_MUTATIONS.length);

lane.baseline();
lane.proveCanSeeRed({
  subject: 'runsh',
  anchor: LANE_MUTATIONS[0].anchor,
  replacement: LANE_MUTATIONS[0].replacement,
});
for (const m of LANE_MUTATIONS) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(LANE_MUTATIONS.length);
