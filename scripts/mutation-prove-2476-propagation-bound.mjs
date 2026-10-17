#!/usr/bin/env node
/**
 * Mutation proof for the zone key-rotation propagation bound (default 120 s,
 * minimum 90 s, derived from the kubelet's sync period).
 *
 * Every row breaks ONE rule and requires its `go test` guard to go red:
 *   - the derivation: the 60 s sync frequency, the 1.5x jitter factor, the
 *     30 s margin, the default being worst case + margin, the minimum being the
 *     worst case;
 *   - the validation: the minimum is enforced, enforced with `<` and not `<=`,
 *     and an unset bound means the default;
 *   - the signal: the ZoneSigningKey condition names a bound below the default,
 *     only below it, not in the steady phase, and treats an unset bound as the
 *     default;
 *   - the flag default is the controller's constant, not a copy of its value;
 *   - the contract fixture the Z7 kind lane reads: its default, its minimum and
 *     the minimum's presence.
 *
 * The lane's half (it follows the shipped default instead of hard-coding one)
 * is proved by `mutation-prove-2476-z7-lane-default.mjs`, on the shared driver.
 *
 * Verdicts are by EXIT CODE only, every anchor must occur exactly once
 * (preflight first), the baselines must be green, a CANARY must go red before
 * any green is trusted, a NEUTRAL control (same value, spelled differently) must
 * stay green so a runner that is always red cannot certify the table, every
 * Go row is BUILD-CHECKED first (so a row is killed by a failing assertion, never
 * a compile error), and every restore is content-verified.
 *
 * What this does not prove: the kubelet's actual refresh time on a real node
 * (the Z7 kind lane in CI measures it).
 *
 * Exit 0 = every row behaved as required; 1 = a row survived; 2 = the prover
 * could not run (anchor drift, red baseline, a mutation that does not compile).
 *
 * Usage:  node scripts/mutation-prove-2476-propagation-bound.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2476-propagation-bound';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const ZONEKEY = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/zone_signing_key.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const MAIN = resolve(REPO_ROOT, 'packages/kn-next-operator/cmd/main.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const FIXTURE = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/testdata/zone-identity-contract.json');

const PROVER = { subjects: { zonekey: ZONEKEY, main: MAIN, fixture: FIXTURE } };

const PKG = './internal/controller/';
const unit = (run, pkg = PKG) => ({ kind: 'go', args: ['-run', run, pkg] });

const CONFIG = 'TestZoneSigningKeyConfigDefaultsAndValidation';
const DERIVED = 'TestZoneKeyPropagationBoundIsDerivedFromTheKubeletSyncPeriod';
const WARN = 'TestZoneSigningKeyConditionWarnsOnABoundBelowTheDefault';
const FIXTURE_TEST = 'TestSharedZoneIdentityFixture';

/** A JSON-legal residue marker: strict JSON has no comments, and the guards parse it. */
const jsonMark = `"//${MUTATION_MARKER}": 0,`;

const GO_MUTATIONS = [
  // --- the derivation --------------------------------------------------------
  {
    id: 'D01',
    claim: 'the default loses its margin (worst case only, 90 s)',
    subject: 'zonekey',
    anchor:
      'DefaultZoneKeyPropagationBound = ZoneKeyKubeletRefreshWorstCase + ZoneKeyPropagationMargin',
    replacement: 'DefaultZoneKeyPropagationBound = ZoneKeyKubeletRefreshWorstCase',
    test: unit(`${CONFIG}|${DERIVED}`),
  },
  {
    id: 'D02',
    claim: 'the minimum falls back to the bare sync frequency (the old 60 s)',
    subject: 'zonekey',
    anchor: 'MinZoneKeyPropagationBound = ZoneKeyKubeletRefreshWorstCase',
    replacement: 'MinZoneKeyPropagationBound = ZoneKeyKubeletSyncFrequency',
    test: unit(`${CONFIG}|${DERIVED}`),
  },
  {
    id: 'D03',
    claim: 'the jitter factor is dropped from the worst case (60 s, not 90 s)',
    subject: 'zonekey',
    anchor: 'ZoneKeyKubeletRefreshWorstCase = ZoneKeyKubeletSyncFrequency * 3 / 2',
    replacement: 'ZoneKeyKubeletRefreshWorstCase = ZoneKeyKubeletSyncFrequency * 1',
    test: unit(`${CONFIG}|${DERIVED}`),
  },
  {
    id: 'D04',
    claim: 'the margin shrinks (the default drifts back toward the measured worst case)',
    subject: 'zonekey',
    anchor: 'ZoneKeyPropagationMargin       = 30 * time.Second',
    replacement: 'ZoneKeyPropagationMargin       = 5 * time.Second',
    test: unit(`${CONFIG}|${DERIVED}`),
  },
  {
    id: 'D05',
    claim: 'the kubelet sync frequency constant is changed away from its documented 60 s',
    subject: 'zonekey',
    anchor: 'ZoneKeyKubeletSyncFrequency    = 60 * time.Second',
    replacement: 'ZoneKeyKubeletSyncFrequency    = 40 * time.Second',
    test: unit(`${CONFIG}|${DERIVED}`),
  },
  // --- the validation ---------------------------------------------------------
  {
    id: 'V01',
    claim: 'the minimum is no longer enforced (a 60 s bound is accepted)',
    subject: 'zonekey',
    anchor: 'if c.PropagationBound < MinZoneKeyPropagationBound {',
    replacement: 'if c.PropagationBound < 0 {',
    test: unit(CONFIG),
  },
  {
    id: 'V02',
    claim: 'the minimum itself is refused (off by one: < becomes <=)',
    subject: 'zonekey',
    anchor: 'if c.PropagationBound < MinZoneKeyPropagationBound {',
    replacement: 'if c.PropagationBound <= MinZoneKeyPropagationBound {',
    test: unit(CONFIG),
  },
  {
    id: 'V03',
    claim: 'an unset bound resolves to the minimum instead of the default',
    subject: 'zonekey',
    anchor: 'c.PropagationBound = DefaultZoneKeyPropagationBound',
    replacement: 'c.PropagationBound = MinZoneKeyPropagationBound',
    test: unit(CONFIG),
  },
  // --- the signal -------------------------------------------------------------
  {
    id: 'S01',
    claim: 'a bound below the default is no longer detected (no warning ever)',
    subject: 'zonekey',
    anchor: 'st.shortBound = st.bound < DefaultZoneKeyPropagationBound',
    replacement: 'st.shortBound = false',
    test: unit(WARN),
  },
  {
    id: 'S02',
    claim: 'the warning fires for the default bound too',
    subject: 'zonekey',
    anchor: 'st.shortBound = st.bound < DefaultZoneKeyPropagationBound',
    replacement: 'st.shortBound = st.bound <= DefaultZoneKeyPropagationBound',
    test: unit(WARN),
  },
  {
    id: 'S03',
    claim: 'the warning is never shown (the condition drops the sentence)',
    subject: 'zonekey',
    anchor: 'if st.shortBound && st.phase != zoneKeyPhaseSteady {',
    replacement: 'if false {',
    test: unit(WARN),
  },
  {
    id: 'S04',
    claim: 'the warning is shown in the steady phase, where nothing is in flight',
    subject: 'zonekey',
    anchor: 'if st.shortBound && st.phase != zoneKeyPhaseSteady {',
    replacement: 'if st.shortBound {',
    test: unit(WARN),
  },
  {
    id: 'S05',
    claim: 'the warning fires whatever the bound (the phase check alone decides)',
    subject: 'zonekey',
    anchor: 'if st.shortBound && st.phase != zoneKeyPhaseSteady {',
    replacement: 'if st.phase != zoneKeyPhaseSteady {',
    test: unit(WARN),
  },
  {
    id: 'S06',
    claim: 'an unset (zero) bound is read as zero seconds, so the default warns',
    subject: 'zonekey',
    anchor: 'st.bound = in.cfg.withDefaults().PropagationBound',
    replacement: 'st.bound = in.cfg.PropagationBound',
    test: unit(WARN),
  },
  // --- the flag ---------------------------------------------------------------
  {
    id: 'F01',
    claim: "the flag's default is a copy of a number, not the controller's constant",
    subject: 'main',
    anchor: '"zone-signing-key-propagation-bound", controller.DefaultZoneKeyPropagationBound,',
    replacement: '"zone-signing-key-propagation-bound", 90*time.Second,',
    test: {
      kind: 'go',
      args: ['-run', 'TestPropagationBoundFlagDefaultsToTheControllerConstant', './cmd'],
    },
  },
  // --- the contract fixture the Z7 kind lane reads ----------------------------
  {
    id: 'X01',
    claim: "the fixture's default bound drifts from the operator's (90 s)",
    subject: 'fixture',
    anchor: '"propagationBoundSeconds": 120,',
    replacement: `${jsonMark}\n    "propagationBoundSeconds": 90,`,
    test: unit(FIXTURE_TEST),
  },
  {
    id: 'X02',
    claim: "the fixture's minimum drifts from the operator's (60 s)",
    subject: 'fixture',
    anchor: '"propagationBoundMinimumSeconds": 90,',
    replacement: `${jsonMark}\n    "propagationBoundMinimumSeconds": 60,`,
    test: unit(FIXTURE_TEST),
  },
  {
    id: 'X03',
    claim: 'the fixture no longer carries the minimum the lane reads',
    subject: 'fixture',
    anchor: '"propagationBoundMinimumSeconds": 90,',
    replacement: jsonMark,
    test: unit(FIXTURE_TEST),
  },
];

// A mutation that changes NOTHING about behaviour (the same 30 s, spelled as a
// sum): every guard must stay green. A runner that exits non-zero for any
// mutation at all would otherwise certify the whole table.
const NEUTRAL = {
  id: 'N01',
  claim: 'control: the same 30 s margin, spelled 20 s + 10 s, changes nothing',
  subject: 'zonekey',
  anchor: 'ZoneKeyPropagationMargin       = 30 * time.Second',
  replacement: 'ZoneKeyPropagationMargin       = 20*time.Second + 10*time.Second',
  test: unit(`${CONFIG}|${DERIVED}|${WARN}`),
};

// --- the go driver ---------------------------------------------------------

function envtestAssetsPresent() {
  if (process.env.KUBEBUILDER_ASSETS) return true;
  const dir = `${OPERATOR_MODULE}/bin/k8s`;
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function run(bin, args, { showErrors = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    // stderr is kept ONLY to explain a failed build check to a human; no
    // verdict ever reads it (verdicts are exit codes).
    stdio: ['ignore', 'ignore', showErrors ? 'pipe' : 'ignore'],
    env: { ...process.env, KNEXT_REQUIRE_BUNDLE: '1' },
    timeout: 1_800_000,
  });
  if (r.error || r.status === null) {
    console.error(`${NAME}: cannot run ${bin}: ${r.error?.message ?? r.signal}`);
    process.exit(2);
  }
  if (showErrors && r.status !== 0) console.error(String(r.stderr ?? '').slice(-2000));
  return r.status;
}

/** The row's guard. -count=1: never trust a cached verdict for a mutated tree. */
const guardExit = (test) => run('go', ['test', '-count=1', ...test.args]);

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
const buildsExit = () =>
  run('go', ['test', '-count=1', '-run', '^$', PKG, './cmd'], { showErrors: true });

/** Plant one mutation, return {built, code}; the subject is restored either way. */
function grade(m) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit();
    code = built === 0 ? guardExit(m.test) : undefined;
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (built !== 0) {
    console.error(
      `${NAME}: ${m.id}'s mutation does not compile (exit ${built}); the row proves nothing`,
    );
    process.exit(2);
  }
  return code;
}

// --- main ---------------------------------------------------------------------

declareMutations(GO_MUTATIONS.length);
console.log(`${NAME}: ${GO_MUTATIONS.length} mutations declared (+ canary and neutral control)`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of [...GO_MUTATIONS, NEUTRAL]) {
  const count =
    snapshot(PROVER.subjects[m.subject]).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `${NAME}: ${m.id}'s anchor occurs ${count} times in ${PROVER.subjects[m.subject]}; aborting`,
    );
    process.exit(2);
  }
}
if (!envtestAssetsPresent()) {
  console.error(
    `${NAME}: no envtest binaries (set KUBEBUILDER_ASSETS or run \`make setup-envtest\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}

// Green baseline on a clean tree, for every distinct guard.
assertTreeClean(REPO_ROOT, 'baseline');
const seen = new Set();
for (const m of [...GO_MUTATIONS, NEUTRAL]) {
  const key = JSON.stringify(m.test);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = guardExit(m.test);
  if (code !== 0) {
    console.error(`${NAME}: baseline RED for ${m.id}'s guard (exit ${code}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: operator baseline green (${seen.size} distinct guards)`);

// STEP 0: the harness can SEE red. A real mutation of a real subject, graded by
// the same runner: if it stays green, nothing below means anything.
const canary = grade({ ...GO_MUTATIONS[0], id: 'canary' });
if (canary === 0) {
  console.error(
    `${NAME}: the canary mutation left the guard GREEN; the harness cannot observe red`,
  );
  process.exit(2);
}
console.log(`step 0 ok: the harness sees red (canary exit=${canary})`);

// The neutral control must stay green.
const neutral = grade(NEUTRAL);
if (neutral !== 0) {
  console.error(
    `${NAME}: the neutral control went RED (exit ${neutral}); the runner is not trustworthy`,
  );
  process.exit(2);
}
console.log(`control ok: ${NEUTRAL.id} stays green — ${NEUTRAL.claim}`);

let failed = 0;
for (const m of GO_MUTATIONS) {
  const code = grade(m);
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

console.log(
  `${NAME}: ${GO_MUTATIONS.length - failed}/${GO_MUTATIONS.length} rows went red as required`,
);
process.exit(failed === 0 ? 0 : 1);
