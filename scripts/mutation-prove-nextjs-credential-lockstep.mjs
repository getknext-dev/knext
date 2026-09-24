#!/usr/bin/env node
/**
 * Mutation proof for `tests/nextjs-credential-lockstep.test.ts` (#1376,
 * rev-1379 round 2).
 *
 * The round-1 test read only `test-e2e-deploy.yml`'s `NEXTJS_REF` env
 * fallback, so a bump to `test-e2e-deploy.yml`'s workflow_dispatch DEFAULT,
 * or to EITHER `nextjsRef` site in `compat-vinext.yml`, stayed green. This
 * proof mutates each of those four real sites plus the two docs citations
 * (and the plain-language divergence explanation) added in round 2, and
 * requires every one to turn the spec red.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-nextjs-credential-lockstep.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/nextjs-credential-lockstep.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    testE2eDeploy: '.github/workflows/test-e2e-deploy.yml',
    compatVinext: '.github/workflows/compat-vinext.yml',
    docsMatrixMd: 'docs/compat-matrix.md',
    docsMatrixMdx: 'apps/docs/content/docs/compat-matrix.mdx',
    manifest: '.github/compat-credentialed-next-version.json',
  },
};

const MUTATIONS = [
  // ── Finding 1: the scan must catch every dispatch-default and env-fallback ──
  {
    label: 'test-e2e-deploy.yml: bump the workflow_dispatch nextjsRef DEFAULT to the shipped pin',
    subject: 'testE2eDeploy',
    anchor:
      "        description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.2.0'",
    replacement:
      "        description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.3.3'",
  },
  {
    label: 'compat-vinext.yml: bump the workflow_dispatch nextjsRef DEFAULT to the shipped pin',
    subject: 'compatVinext',
    anchor:
      "        description: 'vercel/next.js git ref to test against (pinned tag >= v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.2.0'",
    replacement:
      "        description: 'vercel/next.js git ref to test against (pinned tag >= v16.2.0; do NOT use canary)'\n        required: false\n        default: 'v16.3.3'",
  },
  {
    label: 'compat-vinext.yml: bump the NEXTJS_REF env FALLBACK to the shipped pin',
    subject: 'compatVinext',
    anchor: "  NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.2.0' }}",
    replacement: "  NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.3.3' }}",
  },

  // ── Finding 2: docs must track the manifest, and explain the divergence ────
  {
    label: 'docs/compat-matrix.md: drift the cited vercel/next.js version from the manifest',
    subject: 'docsMatrixMd',
    anchor: 'against `vercel/next.js` **v16.2.0**, Node runtime.',
    replacement: 'against `vercel/next.js` **v16.3.3**, Node runtime.',
  },
  {
    label: 'compat-matrix.mdx: drift the cited Next.js version from the manifest',
    subject: 'docsMatrixMdx',
    anchor:
      'nightly most recently observed **778 tests passed, 0 failed**, against Next.js v16.2.0.',
    replacement:
      'nightly most recently observed **778 tests passed, 0 failed**, against Next.js v16.3.3.',
  },
  {
    label: 'compat-matrix.mdx: delete the newer-Next-release divergence explanation',
    subject: 'docsMatrixMdx',
    anchor:
      '\n**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\nNext.js 16.3.x, while the numbers on this page were measured against an older pinned release. The\nnewer release currently trips a build-tool bug that is being tracked upstream, so re-measuring\nagainst it would take every Turbopack-based row on this page to zero rather than show real\nprogress. The credentialed numbers will move forward once that is fixed.\n',
    replacement: '\n',
  },
  {
    label: "compat-matrix.mdx: drop the '16.3.x' version from the divergence explanation",
    subject: 'docsMatrixMdx',
    anchor:
      '**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\nNext.js 16.3.x, while',
    replacement:
      '**New apps pin a newer Next.js release than the version measured above.** The scaffold ships\na newer Next.js line, while',
  },
];

declareMutations(7);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 7) {
  console.error(`FATAL: declared 7 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(
      snap,
      m.anchor,
      m.replacement,
      m.subject === 'docsMatrixMdx' ? { commentPrefix: '<!--' } : {},
    );
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
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
