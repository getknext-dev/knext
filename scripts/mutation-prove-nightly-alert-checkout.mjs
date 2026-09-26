#!/usr/bin/env node
/**
 * Mutation proof for #1406's checkout-before-script guard:
 *   - `tests/nightly-alert-checkout.test.ts` — every job that EXECUTES a
 *     `scripts/*` file has an earlier `actions/checkout` (or tar-extract)
 *     step in the same job.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-nightly-alert-checkout.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/nightly-alert-checkout.test.ts';

const PROOF = {
  subjects: {
    actionPinWorkflow: '.github/workflows/action-pin-resolution-nightly.yml',
    checkoutTest: 'tests/nightly-alert-checkout.test.ts',
    compatVinextWorkflow: '.github/workflows/compat-vinext.yml',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** The whole `SCRIPT_EXEC_RE` declaration, verbatim, as the spec carries it. */
const SCRIPT_EXEC_BLOCK = [
  'const SCRIPT_EXEC_RE = new RegExp(',
  '  [',
  '    String.raw`\\b(?:node|bash|sh|python3?|bun(?:[ \\t]+run)?|bunx|tsx|source)[ \\t]+${OPTIONS}"?(?:${WORKSPACE_PREFIX})?${SCRIPT_PATH}"?\\b`,',
  '    String.raw`(?:^|\\s)"?\\.[ \\t]+${OPTIONS}"?(?:${WORKSPACE_PREFIX})?${SCRIPT_PATH}\\b`,',
  '    String.raw`(?:^|\\s)"?\\.\\/${SCRIPT_PATH}\\b`,',
  '    String.raw`(?:^|\\s)"?${WORKSPACE_PREFIX}${SCRIPT_PATH}"?\\b`,',
  "  ].join('|'),",
  "  'm',",
  ');',
].join('\n');

/** The options-only skip between verb and path, verbatim. */
const OPTIONS_DECL =
  'const OPTIONS = String.raw`(?:${OPTION_FLAG}(?:[ \\t]+${OPTION_ARG})?[ \\t]+)*`;';

const MUTATIONS = [
  {
    // Remove the fix itself: drop the checkout step this PR added back out
    // of a real workflow, so the job again runs a repo script cold.
    label:
      'action-pin-resolution-nightly.yml: drop the checkout step from nightly-red-alert (reintroduce #1406)',
    subject: 'actionPinWorkflow',
    anchor:
      '      # #1406 — this job\'s own steps shell out to scripts/nightly-alert-issue.mjs,\n      # which requires the repo to be checked out; nothing upstream shares a\n      # checkout across jobs. Anonymous, same as the sibling job above: this\n      # step reads nothing GH_TOKEN-scoped from the checkout itself.\n      - name: Checkout code\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n      - name: Create or update the "Action pin SHA↔tag mismatch" issue (idempotent)',
    replacement:
      '      - name: Create or update the "Action pin SHA↔tag mismatch" issue (idempotent)',
  },
  {
    // #1422 round 2 — the exact replacement the reviewer used as proof the
    // scan was blind to `node knext/scripts/…`: delete shard-ledger's own
    // checkout in compat-vinext.yml. Its steps then run
    // `node knext/scripts/compat-run-ledger.mjs` cold, and the scan must see it.
    label:
      "compat-vinext.yml: drop shard-ledger's checkout (its `node knext/scripts/…` steps run cold)",
    subject: 'compatVinextWorkflow',
    anchor:
      '      - name: Checkout knext (the ledger script + its guards)\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          path: knext\n\n',
    replacement: '',
  },
  {
    // Drop the execution-verb requirement from the detector: a bare mention
    // of a scripts/ path (e.g. inside a message string) would then falsely
    // trip the guard on the tree as it stands today (test-e2e-deploy.yml has
    // such a mention), turning "0 findings" into a nonempty list.
    label: 'runsRepoScript: drop the execution-verb requirement (bare-mention false positive)',
    subject: 'checkoutTest',
    anchor: SCRIPT_EXEC_BLOCK,
    replacement: "const SCRIPT_EXEC_RE = new RegExp(SCRIPT_PATH, 'm');",
  },
  {
    // #1422 — revert to the pre-#1422 invoker set (node/bash/sh/python3 and
    // `./scripts/…` only): bun/bun run/tsx/bunx/source, flags, the workspace prefixes
    // and the knext/ prefix all go invisible.
    label: 'SCRIPT_EXEC_RE: revert to the pre-#1422 invoker/path set',
    subject: 'checkoutTest',
    anchor: SCRIPT_EXEC_BLOCK,
    replacement:
      'const SCRIPT_EXEC_RE =\n  /\\b(?:node|bash|sh|python3?)\\s+scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b|(?:^|\\s)\\.\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b/m;',
  },
  {
    // #1422 round 2 — drop ONLY the optional `knext/` checkout-dir prefix:
    // the dominant real shape (`node knext/scripts/…`) goes invisible again.
    label: 'SCRIPT_PATH: drop the optional knext/ prefix',
    subject: 'checkoutTest',
    anchor:
      'const SCRIPT_PATH = String.raw`(?:knext\\/)?scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts|cjs|mts|py)`;',
    replacement:
      'const SCRIPT_PATH = String.raw`scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts|cjs|mts|py)`;',
  },
  {
    // #1422 round 4 — drop the flag tolerance: nothing may sit between the
    // verb and the path, so `node --test scripts/x.mjs` and
    // `bash -euo pipefail scripts/x.sh` go invisible again.
    label: 'OPTIONS: drop the flag tolerance (no options between verb and path)',
    subject: 'checkoutTest',
    anchor: OPTIONS_DECL,
    replacement: "const OPTIONS = '';",
  },
  {
    // #1422 round 4 — widen the skip back to ANY tokens, operators and
    // newlines included: `node --version && cat scripts/x.sh` becomes an
    // "execution" again (the round-3 bare-mention false positive).
    label: 'OPTIONS: skip ANY tokens (crosses &&, ;, | and newlines)',
    subject: 'checkoutTest',
    anchor: OPTIONS_DECL,
    replacement: 'const OPTIONS = String.raw`(?:[^\\s"]+\\s+)*`;',
  },
  {
    // Drop the tar-extract recognition entirely: the guard would then
    // falsely accuse `deploy-tests` (which restores the repo from the
    // downloaded workspace tarball, never `actions/checkout`).
    label: 'providesRepoContent: stop recognising the tar-extract workspace-restore pattern',
    subject: 'checkoutTest',
    anchor:
      'function providesRepoContent(step: YamlStep, downloaded: ReadonlySet<string>): boolean {\n  return isCheckoutStep(step) || isTarExtractStep(step, downloaded);\n}',
    replacement:
      'function providesRepoContent(step: YamlStep, _downloaded: ReadonlySet<string>): boolean {\n  return isCheckoutStep(step);\n}',
  },
  {
    // #1422 — revert to a bare `tar x…f` (any tarball at all is
    // "repo-providing", with or without a download).
    label: 'isTarExtractStep: revert to bare tar x…f, ignoring what was downloaded',
    subject: 'checkoutTest',
    anchor:
      '  for (const m of stripBashCommentLines(step.run).matchAll(TAR_EXTRACT_ARCHIVE_RE)) {\n    if (downloaded.has(basename(m[2]))) return true;\n  }\n  return false;',
    replacement: '  return /\\btar\\s+x[a-z]*f\\b/.test(step.run);',
  },
  {
    // #1422 round 2 — un-tie the tar exception from the artifact NAME: any
    // download-artifact step makes every tarball this workflow uploads
    // "available" (the round-1 "any earlier download" shape).
    label: 'downloadedTarballs: ignore the downloaded artifact name (any download counts)',
    subject: 'checkoutTest',
    anchor: "  return typeof name === 'string' ? [...(uploads.get(name) ?? [])] : [];",
    replacement: '  return [...uploads.values()].flatMap((s) => [...s]);',
  },
];

declareMutations(10);

if (MUTATIONS.length !== 10) {
  console.error(`FATAL: declared 10 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
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
