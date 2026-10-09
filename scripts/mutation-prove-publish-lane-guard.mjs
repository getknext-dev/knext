#!/usr/bin/env node
/**
 * Mutation proof for the PUBLISH-LANE GUARD (#2035, v2 task R0).
 *
 * `tests/publish-lane-guard.test.ts` and `tests/publish-lane-guard-workflow.test.ts`
 * claim that `release.yml` refuses any ref outside an exact allowlist and any
 * version whose major is not the lane's, before a job can touch the npm token.
 * A guard that stays green when its subject is removed is decoration, so each
 * mutation below removes or loosens one piece of that protection and REQUIRES
 * the named spec to go red.
 *
 * Graded on the spec's EXIT CODE, never on its output: a grep over coloured
 * test output once certified fourteen decorative mutations as red.
 *
 * The negative control (a comment edit) must stay GREEN. Without it, every red
 * below is equally explained by a harness that can only see red.
 *
 * Restoration is from a BYTE SNAPSHOT via scripts/lib/mutation-harness.mjs; every
 * anchor is asserted to occur exactly once (the harness refuses otherwise), and
 * every mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-publish-lane-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/release.yml');
const GUARD = resolve(REPO_ROOT, 'scripts/publish-lane-guard.mjs');
const UNIT_SPEC = 'tests/publish-lane-guard.test.ts';
const WORKFLOW_SPEC = 'tests/publish-lane-guard-workflow.test.ts';

/**
 * The files mutated, keyed by the `subject` each mutation names. Spelled as a
 * `subjects:` map so `tests/mutation-prover-lane.test.ts` can resolve every
 * anchor below against its file at PR time (an anchor that stops matching is a
 * PR-time red, not a nightly surprise).
 */
const LANE = { subjects: { workflow: WORKFLOW, guard: GUARD } };

const REF_STEP =
  '      - name: Refuse a ref outside the publish-lane allowlist (fail-closed)\n' +
  '        env:\n' +
  '          PUBLISH_REF: ${{ github.ref }}\n' +
  '        run: node scripts/publish-lane-guard.mjs ref --ref "$PUBLISH_REF"\n';

const MAJOR_STEP =
  '      - name: Refuse a computed major that does not match the lane (fail-closed)\n' +
  '        env:\n' +
  '          PUBLISH_REF: ${{ github.ref }}\n' +
  '        run: node scripts/publish-lane-guard.mjs major --ref "$PUBLISH_REF"\n';

const RELEASE_IF =
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n" +
  "      && needs.version-pr.outputs.has_changesets == 'false'\n" +
  "      && needs.publish-preflight.outputs.should_publish == 'true'\n";

const MUTATIONS = [
  {
    id: 'M1',
    claim: 'the ref guard step is removed from the guard job',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: `${REF_STEP}\n`,
    replacement: '\n',
    expect: 'red',
  },
  {
    id: 'M2',
    claim: 'the allowlist is widened to a prefix match on integration/v (admits v1-coldstart)',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: '  const expectedMajor = PUBLISH_LANES.get(ref);\n',
    replacement:
      '  const expectedMajor =\n' +
      '    PUBLISH_LANES.get(ref) ?? (/^refs\\/heads\\/integration\\/v/.test(ref) ? 1 : undefined);\n',
    expect: 'red',
  },
  {
    id: 'M3',
    claim: 'the allowlist gains an `integration/v*` glob entry',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: "  ['refs/heads/integration/v2', 2],\n",
    replacement: "  ['refs/heads/integration/v2', 2],\n  ['refs/heads/integration/v*', 1],\n",
    expect: 'red',
  },
  {
    id: 'M4',
    claim: 'the major check step is removed from the guard job',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: `\n${MAJOR_STEP}`,
    replacement: '\n',
    expect: 'red',
  },
  {
    id: 'M5',
    claim: 'the major comparison is disabled in the script',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: '    if (parsed.major !== lane.expectedMajor) {\n',
    replacement: '    if (parsed.major !== parsed.major) {\n',
    expect: 'red',
  },
  {
    id: 'M6',
    claim: 'the `major` CLI ignores a failed check and exits 0',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: '  if (!result.ok) {\n',
    replacement: '  if (result.ok === null) {\n',
    expect: 'red',
  },
  {
    id: 'M7',
    claim: 'the credentialed `release` job no longer names the guard in its own needs',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor:
      '    needs: [publish-lane-guard, audit, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    replacement: '    needs: [audit, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    expect: 'red',
  },
  {
    id: 'M8',
    claim: "the `release` job's if: gains always(), so it starts after a FAILED guard",
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: RELEASE_IF,
    replacement: RELEASE_IF.replace('    if: >-\n', '    if: >-\n      always()\n      && '),
    expect: 'red',
  },
  {
    id: 'M9',
    claim: 'the ref check reads `github.ref_name` (a tag named main would pass)',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: REF_STEP,
    replacement: REF_STEP.replace('${{ github.ref }}', '${{ github.ref_name }}'),
    expect: 'red',
  },
  {
    id: 'M10',
    claim: 'the ref check step is softened with continue-on-error',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: REF_STEP,
    replacement: REF_STEP.replace(
      '        env:\n',
      '        continue-on-error: true\n        env:\n',
    ),
    expect: 'red',
  },
  {
    id: 'M11',
    claim: 'the `pack` job no longer hangs from the guard',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor:
      '    name: Pack the @getknext/* fixed group ONCE (npm pack, the real publish tool)\n' +
      '    runs-on: ubuntu-latest\n' +
      '    needs: publish-lane-guard\n',
    replacement:
      '    name: Pack the @getknext/* fixed group ONCE (npm pack, the real publish tool)\n' +
      '    runs-on: ubuntu-latest\n',
    expect: 'red',
  },
  {
    id: 'M12',
    claim: 'the release-cut pattern loses its end anchor',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: '(-rc\\.(0|[1-9][0-9]*))?$/;\n',
    replacement: '(-rc\\.(0|[1-9][0-9]*))?/;\n',
    expect: 'red',
  },
  {
    id: 'M13',
    claim: 'release cuts are opened to major 2',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: 'export const RELEASE_CUT_MAJORS = Object.freeze([1]);\n',
    replacement: 'export const RELEASE_CUT_MAJORS = Object.freeze([1, 2]);\n',
    expect: 'red',
  },
  {
    id: 'M14',
    claim: "a release cut no longer has to publish exactly its name's version",
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: '    if (lane.expectedVersion !== null && pkg.version !== lane.expectedVersion) {\n',
    replacement: '    if (lane.expectedVersion !== null && pkg.version === null) {\n',
    expect: 'red',
  },
  {
    id: 'NEG',
    claim: 'NEGATIVE CONTROL: a doc-comment sentence is reworded (must stay GREEN)',
    subject: 'guard',
    spec: UNIT_SPEC,
    anchor: ' * Majors a release cut may publish. Only the 1.x line publishes through cuts\n',
    replacement: ' * Majors a release cut may publish; only the 1.x line publishes through cuts\n',
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

for (const spec of [UNIT_SPEC, WORKFLOW_SPEC]) {
  const code = specExit(spec);
  console.log(`Baseline ${spec}: exit=${code}`);
  if (code !== 0) {
    console.error(`FATAL: ${spec} is not green before anything is mutated`);
    process.exit(1);
  }
}

let pass = 0;
let fail = 0;
for (const m of MUTATIONS) {
  const file = LANE.subjects[m.subject];
  if (file === undefined) {
    console.error(`FATAL: ${m.id} names an unknown subject ${JSON.stringify(m.subject)}`);
    process.exit(1);
  }
  const snap = snapshot(file);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = specExit(m.spec);
  } finally {
    restore(snap);
  }
  const red = code !== 0;
  const ok = m.expect === 'red' ? red : !red;
  console.log(
    `${m.id} ${ok ? 'ok  ' : 'FAIL'} exit=${code} (expected ${m.expect}) — ${m.claim} [${m.spec}]`,
  );
  if (ok) pass += 1;
  else fail += 1;
  recordMutation();
  const after = specExit(m.spec);
  if (after !== 0) {
    console.error(`FATAL: ${m.spec} exit=${after} after restoring ${m.id}`);
    process.exit(1);
  }
}

console.log(`\n${pass} of ${MUTATIONS.length} graded as expected, ${fail} not.`);
process.exit(fail === 0 ? 0 : 1);
