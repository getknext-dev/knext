#!/usr/bin/env node
/**
 * Mutation proof for the runtime-image `NODE_ENV=production` guard.
 *
 * WHY THIS GUARD EXISTS, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * T6b made the published cache-handler seams refuse UNCONDITIONALLY under
 * `NODE_ENV=production`. That control is worth exactly as much as `NODE_ENV`
 * being set in the image — and `examples/bun-exec/Dockerfile`, the ONE image CI
 * actually builds and boots (`alpine-image.docker-e2e.test.ts`), did not set it.
 * Three sibling Dockerfiles did, which made the omission look deliberate. So a
 * security control was present in source and inert in the only artifact that
 * ever exercised it, and nothing reddened, because nothing compared them.
 *
 * The guard's claims, each of which fails silently if wrong:
 *
 *   1. every app runtime image sets it — a missing `ENV` is a FAILURE, not a
 *      note;
 *   2. the set of images is DISCOVERED, so a fifth Dockerfile is covered the day
 *      it lands rather than the day someone remembers;
 *   3. the scan is not vacuous — an empty discovery must not report zero
 *      offenders and pass;
 *   4. the pattern is not satisfied by a DIFFERENT value (`NODE_ENV=development`).
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/runtime-image-node-env.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the image CI actually boots loses NODE_ENV=production — the T6b published-seam refusal is ' +
      'then inert in the only place it is ever exercised, which is exactly the state this guard ' +
      'was written to end',
    subject: 'exampleDockerfile',
    // A Dockerfile has no extension, so the harness cannot infer its comment
    // syntax from the filename the way it does for .ts/.mjs/.md.
    options: { commentPrefix: '#' },
    anchor: '    METRICS_PORT=9091 \\\n    NODE_ENV=production',
    replacement: '    METRICS_PORT=9091',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the TEMPLATE loses it — every app scaffolded from now on ships with the refusal inert, ' +
      'which is the widest possible blast radius for this defect',
    subject: 'template',
    options: { commentPrefix: '#' },
    anchor: '    NODE_ENV=production',
    replacement: '    NODE_ENV=development',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the discovery scan stops finding Dockerfiles — zero subjects means zero offenders, and a ' +
      'vacuous scan reports a pass forever',
    subject: 'spec',
    anchor:
      "    .filter((f) => /(^|\\/)Dockerfile(\\.[A-Za-z0-9]+)?$/.test(f) || f.endsWith('Dockerfile.hbs'))",
    replacement: '    .filter(() => false)',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the exclusion list swallows the app images — stating what is NOT an app runtime is the ' +
      'safe direction only while the list stays small; widening it silently drops subjects',
    subject: 'spec',
    anchor: "const NOT_APP_RUNTIMES = ['packages/kn-next-operator/', 'packages/scale-zero-pg/'];",
    replacement: "const NOT_APP_RUNTIMES = ['packages/', 'apps/', 'examples/'];",
  },
];

/**
 * NEGATIVE CONTROL. The Dockerfiles carry long comments explaining WHY the
 * variable is load-bearing. Rewording one must leave the guard GREEN — otherwise
 * the four reds above are equally explained by the spec asserting on the file's
 * prose rather than on the `ENV` instruction, and it would red on every comment
 * improvement.
 */
const NEGATIVE = {
  id: 'M5',
  expect: 'green',
  claim: 'the explanatory COMMENT is reworded — the guard asserts the ENV, not the prose',
  subject: 'exampleDockerfile',
  options: { commentPrefix: '#' },
  anchor: '# image CI actually builds and boots. Without it that control is inert in the',
  replacement:
    '# image CI builds and boots (reworded by the negative control). Without it it is inert in the',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    exampleDockerfile: 'examples/bun-exec/Dockerfile',
    template: 'packages/kn-next/templates/app/Dockerfile.hbs',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (runtime images set NODE_ENV=production) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary breaks the PATTERN itself, so no Dockerfile can satisfy it. Every
// image becomes an offender, which must red — and it proves the runner is
// pointed at this spec rather than exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'spec',
  anchor: 'return !/\\bNODE_ENV\\s*=\\s*production\\b/.test(text);',
  replacement: 'return !/\\bNODE_ENV_CANARY\\s*=\\s*production\\b/.test(text);',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
