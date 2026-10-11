#!/usr/bin/env node
/**
 * Mutation proof for the `kn-next` bin removal: the output-scan guard
 * (`packages/kn-next/src/__tests__/no-kn-next-command-guidance.test.ts`) and the
 * manifest assertion (`publish-surface.test.ts`) must go RED when a user-facing
 * surface starts telling the user to run `kn-next` again, or the bin comes back.
 *
 * Harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs EXACTLY ONCE and aborts otherwise
 *     (never perl: a silently failed substitution proves nothing);
 *   * judged on EXIT CODES, never on grepped output;
 *   * the baseline must be green before anything is mutated, and every subject
 *     must be green again after its restore.
 *
 * Usage:  node scripts/mutation-prove-no-kn-next-guidance.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GUARD_SPEC = 'packages/kn-next/src/__tests__/no-kn-next-command-guidance.test.ts';
const SURFACE_SPEC = 'packages/kn-next/src/__tests__/publish-surface.test.ts';
const DOCS_SPEC = 'apps/docs/content-hygiene.test.ts';

const PROOF = {
  subjects: {
    initCiTs: 'packages/kn-next/src/cli/ci/init-ci.ts',
    helpTs: 'packages/kn-next/src/cli/help.ts',
    actionYml: 'action.yml',
    quickstartMd: 'docs/QUICKSTART.md',
    cliMdx: 'apps/docs/content/docs/cli.mdx',
    packageJson: 'packages/kn-next/package.json',
  },
};

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
    label: 'CLI source: init-ci guidance tells the user to run `kn-next init-ci` again',
    subject: 'initCiTs',
    spec: GUARD_SPEC,
    anchor: '`       knext init-ci --provider gitlab --namespace ${namespace} ` +',
    replacement: '`       kn-next init-ci --provider gitlab --namespace ${namespace} ` +',
  },
  {
    label: 'CLI --help output: the usage line names `kn-next deploy`',
    subject: 'helpTs',
    spec: GUARD_SPEC,
    anchor: '"  knext deploy          deploy the app in the current directory",',
    replacement: '"  kn-next deploy        deploy the app in the current directory",',
  },
  {
    label: 'GitHub Action: the doctor step runs `npx --yes kn-next doctor` again',
    subject: 'actionYml',
    spec: GUARD_SPEC,
    anchor: 'npx --yes @getknext/core doctor',
    replacement: 'npx --yes kn-next doctor',
  },
  {
    label: 'repo docs: the quickstart tells the user to run `kn-next doctor`',
    subject: 'quickstartMd',
    spec: GUARD_SPEC,
    anchor: '## Step 0 — Preflight the cluster with `knext doctor`',
    replacement: '## Step 0 — Preflight the cluster with `kn-next doctor`',
  },
  {
    label: 'docs site: the CLI reference shows `npx kn-next gc` as a command',
    subject: 'cliMdx',
    spec: GUARD_SPEC,
    anchor: 'knext gc --dry-run                # print the full reap/keep plan, delete nothing',
    replacement:
      'npx kn-next gc --dry-run          # print the full reap/keep plan, delete nothing',
  },
  {
    label: 'docs site: the same stale command is also caught by the docs hygiene test',
    subject: 'cliMdx',
    spec: DOCS_SPEC,
    anchor: 'knext gc --dry-run                # print the full reap/keep plan, delete nothing',
    replacement: 'kn-next gc --dry-run            # print the full reap/keep plan, delete nothing',
  },
  {
    label: 'package.json: the `kn-next` bin comes back',
    subject: 'packageJson',
    spec: SURFACE_SPEC,
    anchor: '    "knext": "./dist/cli/kn-next.js"\n',
    replacement: '    "knext": "./dist/cli/kn-next.js",\n    "kn-next": "./dist/cli/kn-next.js"\n',
  },
];

declareMutations(MUTATIONS.length);

console.log('Baseline: every spec must be GREEN before anything is mutated.');
for (const spec of new Set(MUTATIONS.map((m) => m.spec))) {
  if (!specPasses(spec)) {
    console.error(`FATAL: baseline is not green: ${spec}`);
    process.exit(1);
  }
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
