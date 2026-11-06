#!/usr/bin/env node
/**
 * Mutation proof for the checkBearer timingSafeEqual guards (#2728).
 *
 * Driven through the shared mutation harness: exactly-once anchors, a residue
 * marker on every mutation, byte-exact restore. The test file is run through
 * resolveSpecRunner and only its EXIT CODE is read, never its output. Exits 0
 * only when every mutation reddened its guard.
 *
 *   node scripts/mutation-prove-2728-checkbearer.mjs
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const COMPARE = '!timingSafeEqual(provided, expected)';
const LENGTH_CHECK = 'provided.length !== expected.length || ';
const IMPORT_LINE = "import { timingSafeEqual } from 'node:crypto';\n";
const SCAN_SPEC = 'tests/runtime-contract-bearer-timingsafe.test.ts';
const BEHAVIOUR_SPEC = 'examples/bun-exec/test/runtime-contract.test.ts';
const BUN_EXEC_COPY = resolve(ROOT, 'examples/bun-exec/runtime-contract.mjs');
const TEMPLATE = resolve(ROOT, 'packages/kn-next/templates/app/runtime-contract.mjs.hbs');
const DOCS_COPY = resolve(ROOT, 'apps/docs/runtime-contract.mjs');
const FILE_MANAGER_COPY = resolve(ROOT, 'apps/file-manager/runtime-contract.mjs');

declareMutations(4);

const RUNNER = resolveSpecRunner(ROOT, SCAN_SPEC);
// `/*` so the residue marker cannot comment out the rest of a mid-line expression.
const OPTS = { commentPrefix: '/*' };

function runSpec(spec, filter) {
  return spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec, filter)], {
    cwd: ROOT,
    stdio: 'ignore',
  }).status;
}

let failures = 0;
function prove(name, snap, plant, spec, filter) {
  let status;
  try {
    plant();
    status = runSpec(spec, filter);
    recordMutation();
  } finally {
    restore(snap);
  }
  const red = status !== 0;
  console.log(`${red ? 'RED (guard live)' : 'GREEN (DECORATIVE)'}  ${name}`);
  if (!red) failures++;
}

// The srvx e2e block fails without installed deps regardless of mutation;
// narrow to the checkBearer block so only its verdict is read.
const bunExec = snapshot(BUN_EXEC_COPY);
prove(
  'always-true compare (auth bypass) is caught by the behavioural tests',
  bunExec,
  () => mutate(bunExec, COMPARE, 'false', OPTS),
  BEHAVIOUR_SPEC,
  'checkBearer',
);

const template = snapshot(TEMPLATE);
prove(
  'a hand-rolled helper reintroduced in a template is caught by the scan guard',
  template,
  () => mutate(template, COMPARE, '!constantTimeEqual(provided, expected)', OPTS),
  SCAN_SPEC,
);

const docs = snapshot(DOCS_COPY);
prove(
  'dropping the length check in an app copy is caught by the scan guard',
  docs,
  () => mutate(docs, LENGTH_CHECK, '', OPTS),
  SCAN_SPEC,
);

const fileManager = snapshot(FILE_MANAGER_COPY);
prove(
  'dropping the import in an app copy is caught by the scan guard',
  fileManager,
  () => mutate(fileManager, IMPORT_LINE, '', OPTS),
  SCAN_SPEC,
);

process.exit(failures === 0 ? 0 : 1);
