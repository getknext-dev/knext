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
 * The two findings are the two ways this gate has to die (#871: the suite runs
 * entirely under bun, so vitest is no longer a wiring concern):
 *   1. the bun runner stops emitting coverage    -> the numerator vanishes and
 *      `check-coverage.mjs` has no per-file reports to merge;
 *   2. the checker stops running, or is disarmed -> nothing is enforced.
 * (The honest DENOMINATOR is no longer a separate CI step — `check-coverage.mjs`
 * enumerates the source files itself and folds untested ones in at 0%.)
 */

const BUN_STEP = 'run: node scripts/bun-test.mjs --coverage';
const GATE_STEP = 'run: node scripts/check-coverage.mjs';

/**
 * @param {string} ciYaml the contents of `.github/workflows/ci.yml`
 * @returns {string[]} one finding per problem, `[]` when the wiring is intact
 */
export function auditCoverageWiring(ciYaml) {
  const findings = [];
  const steps = ciYaml.split('\n').map((l) => l.trim());

  const idxBun = steps.indexOf(BUN_STEP);
  const idxGate = steps.indexOf(GATE_STEP);

  if (idxBun === -1) {
    findings.push(
      `the bun runner is not invoked as \`${BUN_STEP}\` — without --coverage the gate has no numerator`,
    );
  }
  if (idxGate === -1) {
    findings.push(
      `the coverage gate is not invoked as \`${GATE_STEP}\` — nothing enforces the floors`,
    );
  }

  // Order matters: the checker merges what the bun runner left on disk.
  if (idxGate !== -1 && idxBun !== -1 && idxGate < idxBun) {
    findings.push('the coverage gate runs BEFORE the bun runner, so it would merge stale reports');
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
