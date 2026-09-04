#!/usr/bin/env node
/**
 * Mutation proof for T6a's shipped-runner provenance check.
 *
 * WHAT T6a CLAIMED, AND WHY IT NEEDS PROVING
 * ------------------------------------------
 * The two SIGTERM e2es are `security.md` runtime-hardening gates. Both open by
 * packing `packages/{lib,db,kn-next}` and installing the tarballs into a
 * throwaway runner. `bun pm pack` rewrites `workspace:^` to a CONCRETE range, so
 * a changeset that bumps `core` and not `lib` can leave that range unsatisfiable
 * by the local lib tarball — at which point npm resolves the PUBLISHED package
 * instead, and the gate proves the shipped supervisor against a dependency
 * nobody in this repo built. The old assertions could not see it: they checked
 * that `node-server.js`, `prom-client` and `pino` EXIST, and a published tarball
 * satisfies all three.
 *
 * That is the quietest defect shape there is — a gate that keeps passing while
 * silently changing what it tests. So the three claims are:
 *
 *   1. an installed `@getknext/*` at a version other than the workspace's is a
 *      REFUSAL, not a note;
 *   2. an `@getknext/*` that did not land at all is a REFUSAL — "absent" must
 *      not read as "nothing to compare";
 *   3. the install passes `--ignore-scripts`, and the pack dirs are removed on
 *      the FAILURE path, not only the success one.
 *
 * Each is one `throw`, one flag or one `finally`. Nothing in a review diff looks
 * different when they go.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'apps/file-manager/shipped-runner.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'a version mismatch stops being a refusal — npm silently swapped in the PUBLISHED package ' +
      'and the runtime-hardening gate proves bytes nobody in this repo built',
    subject: 'src',
    anchor: '      if (actual !== expected) {',
    replacement: '      if (false && actual !== expected) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'an @getknext/* that never landed is SKIPPED instead of refused — "absent" reading as ' +
      '"nothing to compare" is exactly how the presence-only assertion failed in the first place',
    subject: 'src',
    anchor: '      if (!existsSync(installed)) {',
    replacement:
      '      if (!existsSync(installed)) {\n        continue;\n      }\n      if (false) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the install stops passing --ignore-scripts — every lifecycle script in the closure runs ' +
      'inside a gate that fires on every PR',
    subject: 'src',
    anchor:
      "      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs],",
    replacement: "      ['install', '--omit=dev', '--no-audit', '--no-fund', ...tarballs],",
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'cleanup moves back out of `finally` — a pack that fails on the third package leaks the ' +
      'two temp dirs created before it, the pre-T6a behaviour exactly',
    subject: 'src',
    anchor: '  } finally {',
    replacement: '  } catch (rethrow) {\n    throw rethrow;\n  }\n  if (false) {',
  },
];

/**
 * NEGATIVE CONTROL. The refusal MESSAGES are long and advisory — they explain to
 * a maintainer which changeset probably caused the skew. Rewording one must
 * leave the guard GREEN.
 *
 * Without it, all four reds above are equally explained by the spec asserting on
 * the helper's TEXT rather than on its behaviour, which would make it a tripwire
 * that reds on every improvement to an error message — the first thing anyone
 * would then weaken.
 */
const NEGATIVE = {
  id: 'M5',
  expect: 'green',
  claim: 'a refusal MESSAGE is reworded — the guard asserts behaviour, not prose',
  subject: 'src',
  anchor: "            'land, so whatever the e2e proves, it is not the shipped closure.',",
  replacement:
    "            'land (reworded by the negative control), so whatever the e2e proves, it is not the shipped closure.',",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { src: 'apps/file-manager/e2e-support/shipped-runner.ts' },
});

console.log(`=== mutation proof: ${SPEC} (T6a shipped-runner provenance) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary drops the workspace version the comparison is made AGAINST, so
// every provenance check compares to `undefined`. The spec's "accepts a matching
// install" case then fails, which also proves the runner is pointed at the right
// spec.
prover.proveCanSeeRed({
  subject: 'src',
  anchor: '      workspaceVersions.set(manifest.name, manifest.version);',
  replacement: "      workspaceVersions.set(manifest.name, 'canary-not-a-version');",
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
