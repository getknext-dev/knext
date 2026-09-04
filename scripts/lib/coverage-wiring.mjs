/**
 * Is the coverage gate actually WIRED into CI? (#884)
 *
 * A pure function over the workflow text, deliberately: the guard for CI wiring
 * has to be mutation-provable, and a test that reads `.github/workflows/ci.yml`
 * off disk can only be mutated by editing the tree — which the `mutation-prove-*`
 * lane cannot do here (that lane resolves a VITEST runner, and these specs are
 * `bun:test`). Made pure, the same guard is proved by handing it a mutated
 * workflow string in memory, with nothing to restore and no residue to leak.
 *
 * The three findings are the three ways this gate has to die:
 *   1. the bun runner stops emitting coverage    -> the numerator vanishes;
 *   2. vitest stops emitting coverage            -> the denominator vanishes;
 *   3. the checker stops running, or is disarmed -> nothing is enforced.
 */

const BUN_STEP = 'run: node scripts/bun-test.mjs --coverage';
const VITEST_STEP = 'run: bun x vitest run --coverage';
const GATE_STEP = 'run: node scripts/check-coverage.mjs';

/**
 * @param {string} ciYaml the contents of `.github/workflows/ci.yml`
 * @returns {string[]} one finding per problem, `[]` when the wiring is intact
 */
export function auditCoverageWiring(ciYaml) {
  const findings = [];
  const steps = ciYaml.split('\n').map((l) => l.trim());

  const idxBun = steps.indexOf(BUN_STEP);
  const idxVitest = steps.indexOf(VITEST_STEP);
  const idxGate = steps.indexOf(GATE_STEP);

  if (idxBun === -1) {
    findings.push(
      `the bun runner is not invoked as \`${BUN_STEP}\` — without --coverage the merged gate has almost no numerator`,
    );
  }
  if (idxVitest === -1) {
    findings.push(
      `vitest is not invoked as \`${VITEST_STEP}\` — its enumeration is the only honest denominator`,
    );
  }
  if (idxGate === -1) {
    findings.push(
      `the coverage gate is not invoked as \`${GATE_STEP}\` — nothing enforces the floors`,
    );
  }

  // Order matters: the checker merges what the two runners left on disk.
  if (idxGate !== -1 && idxBun !== -1 && idxGate < idxBun) {
    findings.push('the coverage gate runs BEFORE the bun runner, so it would merge stale reports');
  }
  if (idxGate !== -1 && idxVitest !== -1 && idxGate < idxVitest) {
    findings.push('the coverage gate runs BEFORE vitest, so it would merge stale reports');
  }

  // A step that cannot red is decoration. Scoped to the gate step's own block.
  if (idxGate !== -1) {
    const block = gateStepBlock(ciYaml);
    if (/continue-on-error/.test(block)) {
      findings.push(
        'the coverage gate step carries continue-on-error, so it can never fail the job',
      );
    }
    if (/^\s+if:/m.test(block)) {
      findings.push('the coverage gate step is conditional, so it can be skipped rather than run');
    }
  }

  return findings;
}

/** The YAML from the gate step's `- name:` up to the next step at any indent. */
function gateStepBlock(ciYaml) {
  const start = ciYaml.indexOf(GATE_STEP);
  if (start === -1) return '';
  // Walk back to this step's own `- name:`, then forward to the next one.
  const nameAt = ciYaml.lastIndexOf('- name:', start);
  const from = nameAt === -1 ? start : nameAt;
  const next = ciYaml.indexOf('- name:', from + 1);
  return next === -1 ? ciYaml.slice(from) : ciYaml.slice(from, next);
}
