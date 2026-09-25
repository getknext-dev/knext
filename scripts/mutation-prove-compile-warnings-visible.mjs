#!/usr/bin/env node
/**
 * Mutation proof for #1385: the vinext compile step's stdout (build
 * warnings `apps/docs/content/docs/build-pipeline.mdx` quotes verbatim) was
 * silently discarded by `runQuiet`'s fully-quiet default, so those warnings
 * never reached `kn-next build` users.
 *
 * Two specs, both proved here:
 *   - `packages/kn-next/src/__tests__/exec.test.ts` (the `surfaceStdoutPrefix`
 *     describe block) — `runQuiet`'s own new filtering behaviour.
 *   - `packages/kn-next/src/__tests__/vinext-build-compile-warnings.test.ts`
 *     — `buildVinextExecutable`'s DEFAULT `run` wires the compile step's
 *     `runQuiet` call with `surfaceStdoutPrefix: COMPILE_LOG_PREFIX`.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-compile-warnings-visible.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXEC_SPEC = 'packages/kn-next/src/__tests__/exec.test.ts';
const WIRING_SPEC = 'packages/kn-next/src/__tests__/vinext-build-compile-warnings.test.ts';

const PROOF = {
  subjects: {
    execTs: 'packages/kn-next/src/cli/exec.ts',
    vinextBuildTs: 'packages/kn-next/src/cli/vinext-build.ts',
  },
};

const RUNNER_EXEC = resolveSpecRunner(REPO_ROOT, EXEC_SPEC);
const RUNNER_WIRING = resolveSpecRunner(REPO_ROOT, WIRING_SPEC);

function specPasses(runner, spec) {
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'runQuiet: stop honouring surfaceStdoutPrefix at all (always fully quiet)',
    subject: 'execTs',
    spec: EXEC_SPEC,
    anchor: '    const { surfaceStdoutPrefix } = options;\n    if (!surfaceStdoutPrefix) {',
    replacement: '    const { surfaceStdoutPrefix } = options;\n    if (true) {',
  },
  {
    label: 'surfacePrefixedLines: print EVERY line, not just ones matching the prefix',
    subject: 'execTs',
    spec: EXEC_SPEC,
    anchor: 'if (line.startsWith(prefix)) {\n            console.log(line);\n        }',
    replacement: 'console.log(line);',
  },
  {
    label:
      'runQuiet: stop surfacing captured stdout when the child exits non-zero (only surface on success)',
    subject: 'execTs',
    spec: EXEC_SPEC,
    anchor:
      '        const captured = (error as { stdout?: string | Buffer }).stdout;\n        if (typeof captured === "string") {\n            surfacePrefixedLines(captured, surfaceStdoutPrefix);\n        } else if (Buffer.isBuffer(captured)) {\n            surfacePrefixedLines(\n                captured.toString("utf-8"),\n                surfaceStdoutPrefix,\n            );\n        }\n        throw error;',
    replacement: '        throw error;',
  },
  {
    label:
      'buildVinextExecutable: default run falls back to the plain runQuiet (no surfacing wired)',
    subject: 'vinextBuildTs',
    spec: WIRING_SPEC,
    anchor:
      '    const run =\n        opts.run ??\n        ((argv: readonly string[]) =>\n            runQuiet(argv, { surfaceStdoutPrefix: COMPILE_LOG_PREFIX }));',
    replacement: '    const run = opts.run ?? runQuiet;',
  },
  {
    label: 'COMPILE_LOG_PREFIX: drift from the real vinext-compile.mjs literal',
    subject: 'vinextBuildTs',
    spec: WIRING_SPEC,
    anchor: 'export const COMPILE_LOG_PREFIX = "[knext compile]";',
    replacement: 'export const COMPILE_LOG_PREFIX = "[knext compiled]";',
  },
];

declareMutations(5);

if (MUTATIONS.length !== 5) {
  console.error(`FATAL: declared 5 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: both specs must be GREEN before anything is mutated.');
if (!specPasses(RUNNER_EXEC, EXEC_SPEC) || !specPasses(RUNNER_WIRING, WIRING_SPEC)) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const runner = m.spec === EXEC_SPEC ? RUNNER_EXEC : RUNNER_WIRING;

  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(runner, m.spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(runner, m.spec)) {
    console.error(`   FATAL: ${m.spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
