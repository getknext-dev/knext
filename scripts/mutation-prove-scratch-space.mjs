#!/usr/bin/env node
/**
 * Mutation proof for D9 / #918 — the scratch-space guard's two new halves.
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * `tests/temp-dirs-outside-the-repo.test.ts` asserted, for months, exactly one
 * thing: that a `mkdtemp` PREFIX is rooted at `tmpdir()`. During those months
 * `tests/tomatchobject-mutation-guard.test.ts` wrote transient dot-prefixed
 * `.ts` files into the repo's own `tests/` directory and raced the typecheck
 * gate into a deterministic CI red — and the guard was green the whole time,
 * because the write was a `writeFileSync` inside a `node -e` string rather than
 * a `mkdtemp`. A guard that stayed green through a live instance of its own
 * subject is the definition of the thing this repo mutation-proves.
 *
 * So the five reds below are not "does the regex work". Each one restores a
 * state the tree was ACTUALLY in, or removes a distinction the scan was
 * ACTUALLY measured to need:
 *
 *   M1 puts #918 back, verbatim from the commit that fixed it (c3a8ca51).
 *   M2 leaks a temp directory — the half that did not exist at all before D9.
 *   M3 removes the destination-argument distinction, without which
 *      `copyFileSync(<repo>, <tmp>)` — reading a tracked file INTO scratch, the
 *      correct direction — reads as a repo write. Two live call sites do this.
 *   M4 removes the embedded pass, which is the ONLY pass that can see #918.
 *   M5 adds a baseline entry for a file that does not leak, proving the ratchet
 *      is asserted in both directions and cannot rot into a permanent licence.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/temp-dirs-outside-the-repo.test.ts';

/** JSON that no longer parses would red for the wrong reason. */
const parses = (text) => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return `not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      '#918 is put back verbatim — the scratch `.ts` returns to `tests/`, where a concurrent ' +
      "spec's disk walk reds the typecheck gate on a schedule nobody controls",
    subject: 'victim',
    anchor: "const tmp = join(tmpdir(), 'knext-tomatchobject-guard-sample.tmp.ts');",
    replacement: "const tmp = resolve(repoRoot, 'tests/.tomatchobject-guard-sample.tmp.ts');",
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a temp directory is created and never removed — correctly PLACED and still a leak, ' +
      'one directory per run on every machine that runs the suite',
    subject: 'victim',
    anchor: 'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ',
    replacement:
      "const leaked = mkdtempSync(join(tmpdir(), 'knext-d9-leak-'));\nconst repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ",
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'every write is judged on argument 0, so `copyFileSync(<tracked file>, <tmp>)` — the ' +
      'CORRECT direction, used by two live call sites — reads as a write into the checkout',
    subject: 'scan',
    anchor: '  copyFileSync: 1,',
    replacement: '  copyFileSync: 0,',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the embedded pass is removed — a write inside a `node -e` string becomes invisible, ' +
      'which is precisely how #918 shipped under a guard named for it',
    subject: 'scan',
    anchor: '  for (const [from, to] of literalSpans(blanked)) {',
    replacement: '  for (const [from, to] of []) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the leak baseline gains an entry for a file that does not leak — a ratchet asserted ' +
      'in one direction only becomes a list nobody ever shortens',
    subject: 'baseline',
    anchor: '      "tests/verify-phase-gates.test.ts": 1',
    replacement:
      '      "tests/root-typecheck-gate.test.ts": 1,\n      "tests/verify-phase-gates.test.ts": 1',
    validate: parses,
  },
];

/**
 * NEGATIVE CONTROL. The failure message explains #914 to whoever hits it in CI.
 * Rewording it must leave the guard GREEN — otherwise the five reds above are
 * equally explained by the spec asserting on its own prose, and every
 * improvement to the diagnostics would red the guard.
 */
const NEGATIVE = {
  id: 'M6',
  expect: 'green',
  claim: 'the diagnostic is reworded — the guard asserts behaviour, not its own message text',
  subject: 'scan',
  anchor: ' * Every write whose destination resolves inside the checkout.',
  replacement: ' * Every write whose destination resolves inside the checkout (reworded).',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    scan: 'scripts/lib/scratch-space-scan.mjs',
    victim: 'tests/tomatchobject-mutation-guard.test.ts',
    baseline: 'tests/scratch-space-exceptions.json',
  },
});

console.log(`=== mutation proof: ${SPEC} (D9 + #918 scratch space) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary blinds the write scan outright. Every #918 case keys on it, so
// this must red — and it proves the runner is pointed at this spec rather than
// exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'scan',
  anchor: '  // PASS 1 — structural, over blanked source.',
  replacement: '  return found;\n  // PASS 1 — structural, over blanked source.',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
