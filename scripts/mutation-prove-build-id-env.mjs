#!/usr/bin/env node
/**
 * Mutation proof for the standalone build-id lock-step guard (#1417).
 *
 * On Next >= 16.2.11 a `deploymentId` (filled from `NEXT_DEPLOYMENT_ID`)
 * makes `next build` write the constant `build-TfctsWXpff2fKS` and ignore
 * `generateBuildId`. knext now owns `KNEXT_BUILD_ID`, and the guard in
 * `packages/kn-next/src/cli/build-id-env.ts` names the next.config fix when it
 * sees the constant OR a config that never reads `KNEXT_BUILD_ID`.
 *
 * `workflow.md`: "a guard that stays green when its subject is removed is
 * decoration". Each mutation below removes one detection (or reverts the
 * scaffold template) and REQUIRES `build-id-env.test.ts` to go red. The shared
 * driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by
 * EXIT CODE only, baseline green first, a canary that must go red, anchors
 * that must occur exactly once, sha256-verified byte-exact restore.
 *
 * Usage:  node scripts/mutation-prove-build-id-env.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/build-id-env.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the constant-BUILD_ID detection is removed — a config that already reads KNEXT_BUILD_ID ' +
      'but still lets a deploymentId reach next build gets the plain, non-actionable message',
    subject: 'guard',
    anchor: '    if (builtId === NEXT_CONSTANT_BUILD_ID || !readsKnextBuildId) {',
    replacement: '    if (!readsKnextBuildId) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the "next.config never reads KNEXT_BUILD_ID" detection is removed — an app still on the ' +
      'old generateBuildId line (random id, no constant) loses the one-sentence fix',
    subject: 'guard',
    anchor: '    if (builtId === NEXT_CONSTANT_BUILD_ID || !readsKnextBuildId) {',
    replacement: '    if (builtId === NEXT_CONSTANT_BUILD_ID) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      "the scaffold template's generateBuildId line reverts to NEXT_DEPLOYMENT_ID only — the " +
      'shipped config no longer reads KNEXT_BUILD_ID, so the build mints a random id',
    subject: 'template',
    anchor:
      '    generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,',
    // The residue marker goes on its OWN line: a trailing `// …` would comment out the rest of
    // the one-line config the spec writes and red it for the wrong reason.
    replacement: `    // ${MUTATION_MARKER}\n    generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,`,
    // `.hbs` has no COMMENT_PREFIX entry because its comment syntax depends on
    // what it templates; this one templates TypeScript.
    options: { commentPrefix: '//' },
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the standalone leg stops removing an inherited NEXT_DEPLOYMENT_ID — a CI runner that ' +
      'exports one puts Next back on the constant-id path',
    subject: 'guard',
    anchor: '    delete env[NEXT_DEPLOYMENT_ID_ENV];',
    replacement: '    void 0;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    guard: 'packages/kn-next/src/cli/build-id-env.ts',
    template: 'packages/kn-next/templates/app/next.config.ts.hbs',
  },
});

console.log(`=== mutation proof: ${SPEC} (standalone build-id lock-step) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'guard',
  anchor: '    env[KNEXT_BUILD_ID_ENV] = buildId;',
  replacement: '    env[KNEXT_BUILD_ID_ENV] = `${buildId}-canary`;',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
