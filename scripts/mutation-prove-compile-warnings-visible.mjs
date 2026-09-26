#!/usr/bin/env node
/**
 * Mutation proof for #1385: the vinext compile step's stdout (build
 * warnings `apps/docs/content/docs/build-pipeline.mdx` quotes verbatim) was
 * silently discarded by `runQuiet`'s fully-quiet default, so those warnings
 * never reached `kn-next build` users.
 *
 * Three specs, all proved here:
 *   - `packages/kn-next/src/__tests__/exec.test.ts` (the `surfaceStdoutPrefix`
 *     describe block) — `runQuiet`'s own new filtering behaviour.
 *   - `packages/kn-next/src/__tests__/vinext-build-compile-warnings.test.ts`
 *     — `buildVinextExecutable`'s DEFAULT `run` wires the compile step's
 *     `runQuiet` call with `surfaceStdoutPrefix: COMPILE_LOG_PREFIX`.
 *   - `packages/kn-next/src/__tests__/vinext-compile-log-prefix.test.ts`
 *     (#1421 review round 1, jev 0.66) — the REAL `vinext-compile.mjs`
 *     carries `COMPILE_LOG_PREFIX` on every own-message console call. The
 *     original "drift guard" (mutation 5 below) only ever compared the
 *     constant to a literal written in ITS OWN test — the reviewer renamed
 *     all 16 `[knext compile]` prefixes in the real `.mjs` file and every
 *     spec stayed green. This third spec is what actually reads that file.
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
const SCAN_SPEC = 'packages/kn-next/src/__tests__/vinext-compile-log-prefix.test.ts';

const PROOF = {
  subjects: {
    execTs: 'packages/kn-next/src/cli/exec.ts',
    vinextBuildTs: 'packages/kn-next/src/cli/vinext-build.ts',
    vinextCompileMjs: 'packages/kn-next/src/adapters/vinext-compile.mjs',
  },
};

// resolveSpecRunner's return is spec-agnostic (always runs
// scripts/bun-test.mjs, which takes the spec as its own runtime arg) — ONE
// shared runner, the spec string varies per call to specPasses below.
const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
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
  {
    // #1421 review round 1 (jev 0.66) — the exact repro: rename a real
    // vinext-compile.mjs literal so it no longer starts with
    // COMPILE_LOG_PREFIX. Targets the LAST console.log call (unique in the
    // file), proving the scan catches even a SINGLE offending line, not
    // just a wholesale rename of all 16.
    label:
      'vinext-compile.mjs: rename one real console.log prefix so it drifts from COMPILE_LOG_PREFIX (#1421 review repro)',
    subject: 'vinextCompileMjs',
    spec: SCAN_SPEC,
    anchor:
      '`[knext compile] wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})`,',
    replacement:
      '`[knext compiled] wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})`,',
  },
  {
    // #1421 review round 2 (jev 0.82), bypass 1 — the OLD scanner silently
    // SKIPPED a non-literal first argument instead of treating it as an
    // offender. Break the exact-match allowlist for the one legitimate
    // non-literal site (an extra space inside `String( log)`) so it is no
    // longer `console.error(String(log))` verbatim — the fixed scanner must
    // now flag it (null literalPrefix, not allowlisted); the old "exclude
    // every null" scanner would have stayed silently green forever.
    label:
      'vinext-compile.mjs: break the exact allowlist match on the one legitimate non-literal call (#1421 review round 2, bypass 1)',
    subject: 'vinextCompileMjs',
    spec: SCAN_SPEC,
    anchor: 'for (const log of result.logs) console.error(String(log));',
    replacement: 'for (const log of result.logs) console.error(String( log));',
  },
  {
    // #1421 review round 2, bypass 2 — the OLD regex only matched
    // console.(log|warn|error), so console.info/console.debug were never
    // scanned at all. Switch one real, prefixed console.log call to
    // console.info AND drop its prefix — the fixed scanner (any console
    // method) must catch it; the old regex would never have looked.
    label:
      'vinext-compile.mjs: console.info call with no prefix, a method the old regex never matched (#1421 review round 2, bypass 2)',
    subject: 'vinextCompileMjs',
    spec: SCAN_SPEC,
    anchor:
      '    console.log(\n' +
      '        `[knext compile] bundling ${PLAN.embed.size} package(s) the server output loads ` +\n' +
      '            `via createRequire(import.meta.url): ${describeSpecs(PLAN.embed)}`,\n' +
      '    );',
    replacement:
      '    console.info(\n' +
      '        `bundling ${PLAN.embed.size} package(s) the server output loads ` +\n' +
      '            `via createRequire(import.meta.url): ${describeSpecs(PLAN.embed)}`,\n' +
      '    );',
  },
  {
    // #1421 review round 2, bypass 3 — process.stdout.write was never
    // scanned at all, an entirely different call shape from console.*.
    // Replace the final, prefixed console.log with an unprefixed
    // process.stdout.write — the fixed scanner must catch it.
    label:
      'vinext-compile.mjs: process.stdout.write with no prefix, a call shape console.* scanning cannot cover (#1421 review round 2, bypass 3)',
    subject: 'vinextCompileMjs',
    spec: SCAN_SPEC,
    anchor:
      'console.log(\n' +
      '    `[knext compile] wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})`,\n' +
      ');',
    replacement:
      'process.stdout.write(\n' +
      '    `wrote ${OUTFILE} (bytecode: on${TARGET ? `, target: ${TARGET}` : ""})\\n`,\n' +
      ');',
  },
];

declareMutations(9);

if (MUTATIONS.length !== 9) {
  console.error(`FATAL: declared 9 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

const ALL_SPECS = [EXEC_SPEC, WIRING_SPEC, SCAN_SPEC];

console.log('Baseline: every spec must be GREEN before anything is mutated.');
if (!ALL_SPECS.every((s) => specPasses(s))) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);

  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(m.spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(m.spec)) {
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
