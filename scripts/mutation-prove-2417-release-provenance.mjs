#!/usr/bin/env node
/**
 * Mutation prover for the release-lane OIDC / provenance guard.
 *
 * The guard is `tests/release-provenance-scope.test.ts`. Each row plants one
 * regression and requires the guard to go RED, by exit code:
 *
 *   R1  release.yml's workflow-level permissions regain `id-token: write`, so
 *       every job inherits the OIDC token-request credential again.
 *   R2  ... regain `contents: write` at workflow level.
 *   R3  the Version PR job is granted `id-token: write`.
 *   R4  the publish job loses `id-token: write`, so provenance cannot be minted.
 *   R5  the Publish step stops exporting NPM_CONFIG_PROVENANCE.
 *   R6  the Heal step stops exporting it.
 *   R7  the Publish step sets it to 'false'.
 *   R8  a published package's manifest drops `publishConfig.provenance`.
 *   R9  another workflow starts referencing secrets.NPM_TOKEN.
 *   R10 the GitHub-release job is granted `id-token: write`.
 *   N1  negative control: the publish job's concurrency group renamed. The
 *       guard must stay GREEN, or the rows above would be reds for "any edit".
 *
 * Every mutated YAML subject is checked to still PARSE before it is graded.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-2417-release-provenance.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/release-provenance-scope.test.ts';

const parses = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `workflow is not valid YAML: ${err.message}`;
  }
};
const validJson = (text) => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return `manifest is not valid JSON: ${err.message}`;
  }
};

const WF_PERMS = 'permissions:\n  contents: read\n\njobs:';
const VERSION_PR_PERMS =
  '    permissions:\n      contents: write\n      pull-requests: write\n    concurrency:';
const PUBLISH_JOB_PERMS =
  '      pull-requests: write\n      id-token: write\n    # Publish-BLOCKING';
const PUBLISH_ENV =
  "          # manifest without that opt-in is still attested.\n          NPM_CONFIG_PROVENANCE: 'true'";
const HEAL_ENV =
  "          # group, so the heal step requests it exactly as the Publish step does.\n          NPM_CONFIG_PROVENANCE: 'true'";

const MUTATIONS = [
  {
    id: 'R1',
    claim: 'release.yml workflow-level permissions regain id-token: write',
    subject: 'rel',
    anchor: WF_PERMS,
    replacement: 'permissions:\n  contents: read\n  id-token: write\n\njobs:',
  },
  {
    id: 'R2',
    claim: 'release.yml workflow-level permissions regain contents: write',
    subject: 'rel',
    anchor: WF_PERMS,
    replacement: 'permissions:\n  contents: write\n\njobs:',
  },
  {
    id: 'R3',
    claim: 'the Version PR job is granted id-token: write',
    subject: 'rel',
    anchor: VERSION_PR_PERMS,
    replacement:
      '    permissions:\n      contents: write\n      pull-requests: write\n      id-token: write\n    concurrency:',
  },
  {
    id: 'R4',
    claim: 'the publish job loses id-token: write',
    subject: 'rel',
    anchor: PUBLISH_JOB_PERMS,
    replacement: '      pull-requests: write\n    # Publish-BLOCKING',
  },
  {
    id: 'R5',
    claim: 'the Publish step stops exporting NPM_CONFIG_PROVENANCE',
    subject: 'rel',
    anchor: PUBLISH_ENV,
    replacement: '          # manifest without that opt-in is still attested.',
  },
  {
    id: 'R6',
    claim: 'the Heal step stops exporting NPM_CONFIG_PROVENANCE',
    subject: 'rel',
    anchor: HEAL_ENV,
    replacement:
      '          # group, so the heal step requests it exactly as the Publish step does.',
  },
  {
    id: 'R7',
    claim: "the Publish step sets NPM_CONFIG_PROVENANCE to 'false'",
    subject: 'rel',
    anchor: PUBLISH_ENV,
    replacement:
      "          # manifest without that opt-in is still attested.\n          NPM_CONFIG_PROVENANCE: 'false'",
  },
  {
    id: 'R8',
    claim: "a published package's manifest drops publishConfig.provenance",
    subject: 'pkg',
    anchor: '"provenance": true',
    replacement: `"provenance": false, "_mutation": "${MUTATION_MARKER}"`,
    validate: validJson,
  },
  {
    id: 'R9',
    claim: 'another workflow starts referencing secrets.NPM_TOKEN',
    subject: 'other',
    anchor: '    timeout-minutes: 10\n    steps:\n',
    replacement:
      '    timeout-minutes: 10\n    env:\n      T: ${{ secrets.NPM_TOKEN }}\n    steps:\n',
  },
  {
    id: 'R10',
    claim: 'the GitHub-release job is granted id-token: write',
    subject: 'rel',
    anchor:
      '    permissions:\n      contents: write\n    concurrency:\n      group: github-release-',
    replacement:
      '    permissions:\n      contents: write\n      id-token: write\n    concurrency:\n      group: github-release-',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: "the publish job's concurrency group renamed",
    subject: 'rel',
    anchor: 'group: release-publish-${{ github.ref }}',
    replacement: 'group: release-npm-publish-${{ github.ref }}',
  },
].map((m) => ({ expect: 'red', validate: parses, ...m }));

const CANARY = {
  subject: 'rel',
  anchor: WF_PERMS,
  replacement: 'permissions:\n  contents: read\n  id-token: write\n  packages: write\n\njobs:',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    rel: '.github/workflows/release.yml',
    pkg: 'packages/lib/package.json',
    other: '.github/workflows/scaffold-resolve-check.yml',
  },
});

console.log('=== mutation proof: release-lane OIDC scope + npm provenance ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
