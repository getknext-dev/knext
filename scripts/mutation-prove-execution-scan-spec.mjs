#!/usr/bin/env node
/**
 * Mutation proof for the #1422 named-exception guards INSIDE
 * `tests/compat-window-fingerprint-execution-scan.test.ts`.
 *
 * `NAMED_EXCEPTIONS` there must stay SCOPED PER SOURCE FILE via
 * `isNamedException` (exact (source, path) pair), never per lane or global,
 * and its stale/dead checks must be exact. Six mutations, each of which must
 * turn that spec RED:
 *   1. the helper ignoring `source`;
 *   2. the helper ignoring `path`;
 *   3. the workflow scan call site reverted to a global exemption;
 *   4. the harness scan call site reverted to a global exemption;
 *   5. `sources: []` no longer being rejected (`deadExceptions`);
 *   6. the stale check matching a BASENAME instead of the full path
 *      (`staleExceptions`).
 *
 * Its own prover (not a helper inside `mutation-prove-compat-cell-fingerprint.mjs`)
 * because the fleet-wide anchor-drift guard reads EVERY literal anchor in a
 * prover against that prover's single subject file; these anchors live in the
 * spec, so the spec is this prover's one subject.
 *
 * Judged on the spec's EXIT CODE, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-execution-scan-spec.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(REPO_ROOT, 'tests/compat-window-fingerprint-execution-scan.test.ts');
const SPEC_REL = 'tests/compat-window-fingerprint-execution-scan.test.ts';

declareMutations(6);

const runner = resolveSpecRunner(REPO_ROOT, SPEC_REL);

/** True when the spec passed. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(SPEC_REL)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(SPEC);
  try {
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC_REL} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC_REL} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const IS_NAMED_ANCHOR =
  'return NAMED_EXCEPTIONS.some((e) => e.path === ref && e.sources.includes(source));';
prove(
  'isNamedException stops checking the source file: any file referencing a named path is exempt',
  IS_NAMED_ANCHOR,
  'return NAMED_EXCEPTIONS.some((e) => e.path === ref);',
);
prove(
  'isNamedException stops checking the path: any reference from a named source is exempt',
  IS_NAMED_ANCHOR,
  'return NAMED_EXCEPTIONS.some((e) => e.sources.includes(source));',
);
prove(
  'workflow scan call site reverts to a global exemption',
  'isNamedException(`.github/workflows/${workflowFile}`, ref)',
  'true',
);
prove(
  'harness scan call site reverts to a global exemption',
  'isNamedException(relPath, ref)',
  'true',
);
prove(
  'a named exception with sources: [] is no longer rejected as dead',
  'return entries.filter((e) => e.sources.length === 0).map((e) => e.path);',
  'return entries.filter((e) => false).map((e) => e.path);',
);
prove(
  'the stale check matches the BASENAME instead of the full path',
  'else if (!text.includes(path)) stale.push',
  'else if (!text.includes(path.split("/").pop())) stale.push',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
