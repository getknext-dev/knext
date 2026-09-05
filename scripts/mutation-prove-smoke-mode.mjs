#!/usr/bin/env node
/**
 * Mutation proof for T6c's compat-smoke mode resolution.
 *
 * WHAT T6c CLAIMED, AND WHY IT NEEDS PROVING
 * ------------------------------------------
 * `compat-smoke.mjs` picks its entire execution model from one boolean, and the
 * two branches are not cosmetic variants of each other: single-exec spawns the
 * binary with no script argument and no preload and SKIPS the `--version` probe
 * in check (h), because the binary would boot a second server and the check
 * would hang. The boolean used to be `SERVER_CMD === SERVER_PATH` — string
 * identity over two env-overridable paths — so a symlink, a `./` prefix or a
 * relative spelling flipped the runner into the standalone branch silently.
 *
 * The failure mode is a HANG, which in CI reads as "slow" long before it reads
 * as "wrong". Three claims, each one line:
 *
 *   1. resolution goes through `realpathSync`, so two spellings of one file are
 *      one file;
 *   2. an UNRESOLVABLE path does not read as single-exec — two ENOENTs must not
 *      compare equal just because their strings happen to;
 *   3. an explicit `SMOKE_MODE` that contradicts the paths is a LOUD failure,
 *      and an unknown `SMOKE_MODE` value is refused rather than treated as
 *      "unset".
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-smoke-single-exec-mode.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'resolution reverts to the LEXICAL path — a symlinked or relative spelling of the binary ' +
      'compares unequal again and the smoke silently takes the standalone branch that hangs',
    subject: 'mode',
    anchor: '    return realpathSync(resolve(p));',
    replacement: '    return resolve(p);',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'an UNRESOLVABLE path falls back to its own string instead of null — two ENOENTs then ' +
      'compare equal and an unbuilt binary reads as single-exec, skipping the very probe that ' +
      'would have reported the missing build',
    subject: 'mode',
    anchor: '    return null;\n  }\n}',
    replacement: '    return resolve(p);\n  }\n}',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'an explicit SMOKE_MODE that CONTRADICTS the filesystem stops being a failure — the flag ' +
      'silently overrides reality, which is the mode flip this whole fix exists to make loud',
    subject: 'mode',
    anchor: '    if (stated !== derived) {',
    replacement: '    if (false && stated !== derived) {',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'an unknown SMOKE_MODE value is accepted — a typo then reads as "not a single-exec run" ' +
      'rather than as a mistake, which is a mode flip wearing a green tick',
    subject: 'mode',
    anchor: '    if (!SMOKE_MODES.includes(smokeMode)) {',
    replacement: '    if (false && !SMOKE_MODES.includes(smokeMode)) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the runner goes back to `SERVER_CMD === SERVER_PATH` — the scan half of the guard exists ' +
      'because a reviewer remembering not to reintroduce it is what failed the first time',
    subject: 'runner',
    anchor: 'const { singleExec } = resolveSmokeMode({',
    replacement: 'const singleExec = SERVER_CMD === SERVER_PATH;\nconst _unused = ({',
  },
];

/**
 * NEGATIVE CONTROL. The contradiction message prints both paths and both
 * resolutions so a CI log alone explains the failure. Rewording it must leave
 * the guard GREEN — otherwise the four reds above are equally explained by the
 * spec asserting on the module's TEXT, and the guard would red on every
 * improvement to its own diagnostics.
 */
const NEGATIVE = {
  id: 'M6',
  expect: 'green',
  claim: 'the contradiction MESSAGE is reworded — the guard asserts behaviour, not prose',
  subject: 'mode',
  anchor:
    "          'variables rather than the mode: the two branches spawn different argv and run ' +",
  replacement:
    "          'variables rather than the mode (reworded by the negative control): the two branches spawn different argv and run ' +",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    mode: 'apps/file-manager/scripts/compat-smoke-mode.mjs',
    runner: 'apps/file-manager/scripts/compat-smoke.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (T6c smoke-mode resolution) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary inverts the derived answer outright. Every case in the spec keys
// on it, so this must red — and it proves the runner is pointed at this spec
// rather than exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'mode',
  anchor:
    '  const derived = resolvedCmd !== null && resolvedPath !== null && resolvedCmd === resolvedPath;',
  replacement:
    '  const derived = !(resolvedCmd !== null && resolvedPath !== null && resolvedCmd === resolvedPath);',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
