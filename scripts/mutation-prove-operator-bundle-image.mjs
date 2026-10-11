#!/usr/bin/env node
/**
 * Mutation proof for the operator release-integrity guard (S3-O2):
 * `scripts/verify-operator-bundle-image.mjs` + its wiring in
 * `.github/workflows/operator-supply-chain.yml`, specified by
 * `tests/verify-operator-bundle-image.test.ts`.
 *
 * A guard that stays green when its subject is removed is decoration, so each mutation
 * removes or loosens one piece and REQUIRES the spec to go red. Graded on the spec's
 * EXIT CODE only. The negative control (a comment edit) must stay GREEN, or every red
 * is equally explained by a harness that can only see red.
 *
 * Restoration is from a BYTE SNAPSHOT (scripts/lib/mutation-harness.mjs); the harness
 * refuses an anchor that does not occur exactly once.
 *
 * Usage:  node scripts/mutation-prove-operator-bundle-image.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/verify-operator-bundle-image.test.ts';

const GUARD = resolve(REPO_ROOT, 'scripts/verify-operator-bundle-image.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');

/** `subjects:` as a map of consts so tests/mutation-prover-lane.test.ts can resolve each anchor. */
const LANE = { subjects: { guard: GUARD, workflow: WORKFLOW } };

const STEP_HEAD =
  "        if: steps.channel.outputs.is_version_tag == 'true' && steps.trivy.outcome == 'success'\n" +
  '        env:\n          DIGEST: ${{ steps.push.outputs.digest }}\n          RELEASE_TAG:';

const MUTATIONS = [
  {
    id: 'G1',
    claim: 'the image tag is no longer compared with the release tag (the v1.0.0 defect)',
    subject: 'guard',
    anchor: '  if (p[2] !== want) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'G2',
    claim: 'the digest is no longer compared with the one this run built',
    subject: 'guard',
    anchor: '  if (p[3] !== digest) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'G3',
    claim: 'a bundle with no operator image line is accepted',
    subject: 'guard',
    anchor: "  if (refs.size === 0) return { ok: false, reason: 'no kn-next-operator image",
    replacement: "  if (false) return { ok: false, reason: 'no kn-next-operator image",
  },
  {
    id: 'G4',
    claim: 'a read error is swallowed into a pass',
    subject: 'guard',
    anchor: '      ? { ok: false, reason: r.error }\n',
    replacement: '      ? { ok: true }\n',
  },
  {
    id: 'G5',
    claim: 'two distinct operator images are accepted (first one wins)',
    subject: 'guard',
    anchor: '  if (refs.size > 1) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'G6',
    claim: 'only the first --install file is checked',
    subject: 'guard',
    anchor: '  for (const file of opts.install) {\n',
    replacement: '  for (const file of opts.install.slice(0, 1)) {\n',
  },
  {
    id: 'G7',
    claim: 'a failed check no longer fails the process',
    subject: 'guard',
    anchor: '  return failed ? 1 : 0;\n',
    replacement: '  return 0;\n',
  },
  {
    id: 'W1',
    claim: 'the workflow stops verifying the install-vX.Y.Z.yaml asset',
    subject: 'workflow',
    anchor:
      '            --install packages/kn-next-operator/dist/install.yaml \\\n' +
      '            --install "${VERSIONED_ASSET}"\n',
    replacement: '            --install packages/kn-next-operator/dist/install.yaml\n',
  },
  {
    id: 'W2',
    claim: "the workflow stops passing this run's pushed digest to the guard",
    subject: 'workflow',
    anchor: '            --digest "${DIGEST}" \\\n',
    replacement: '            --digest "sha256:0000" \\\n',
  },
  {
    id: 'W3',
    claim: 'the guard step is allowed to fail without failing the job',
    subject: 'workflow',
    anchor: STEP_HEAD,
    replacement: STEP_HEAD.replace('        env:', '        continue-on-error: true\n        env:'),
  },
  {
    id: 'NEG',
    claim: 'NEGATIVE CONTROL: a comment sentence is reworded (must stay GREEN)',
    subject: 'guard',
    anchor: ' * Node builtins only (the publishing job has no install step).\n',
    replacement: ' * Node builtins only (the publishing job has no install step at all).\n',
    expect: 'green',
  },
];

declareMutations(MUTATIONS.length);

/** The spec's exit code — the only signal graded. */
function specExit(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const result = spawnSync(process.execPath, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

const baseline = specExit(SPEC);
console.log(`Baseline ${SPEC}: exit=${baseline}`);
if (baseline !== 0) {
  console.error(`FATAL: ${SPEC} is not green before anything is mutated`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
for (const m of MUTATIONS) {
  const expect = m.expect ?? 'red';
  const file = LANE.subjects[m.subject];
  if (file === undefined) {
    console.error(`FATAL: ${m.id} names an unknown subject ${JSON.stringify(m.subject)}`);
    process.exit(1);
  }
  const snap = snapshot(file);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = specExit(SPEC);
  } finally {
    restore(snap);
  }
  const ok = expect === 'red' ? code !== 0 : code === 0;
  console.log(`${m.id} ${ok ? 'ok  ' : 'FAIL'} exit=${code} (expected ${expect}) — ${m.claim}`);
  if (ok) pass += 1;
  else fail += 1;
  recordMutation();
  const after = specExit(SPEC);
  if (after !== 0) {
    console.error(`FATAL: ${SPEC} exit=${after} after restoring ${m.id}`);
    process.exit(1);
  }
}

console.log(`\n${pass} of ${MUTATIONS.length} graded as expected, ${fail} not.`);
process.exit(fail === 0 ? 0 : 1);
