#!/usr/bin/env node

/**
 * Mutation proof for the #1771 release-prep fix to
 * `scripts/lib/scaffold-npm10-resolve.mjs`.
 *
 * WHAT IS BEING PROVED
 * ---------------------
 * `decideResolveStrategy` and its helpers decide whether a failed npm-10
 * `--package-lock-only` resolve is exactly the release-prep shape (every
 * ETARGET is a `@getknext/*` package at the WORKSPACE version) — the only
 * case `verify-scaffold-resolves-npm10.mjs` is allowed to retry against local
 * tarballs instead of staying red. Every load-bearing branch must actually
 * gate:
 *
 *   1. the `edgesOut` arborist crash (the #985 class this guard exists to
 *      catch) must still be classified as such, even if ETARGET-shaped text
 *      appears nearby — losing that check would let a real crash slip
 *      through as a retryable ETARGET;
 *   2. an ETARGET for a package OUTSIDE `@getknext/*` must NOT be treated as
 *      release-prep — losing the scope check would retry (and mask) a
 *      genuinely missing third-party dependency;
 *   3. an ETARGET for a `@getknext/*` package whose requested version does
 *      NOT equal the workspace version must NOT be treated as release-prep —
 *      losing the version-equality check would retry (and mask) a real
 *      version typo in the template;
 *   4. `applyLocalResolutions` must rewrite ONLY the named packages — losing
 *      that scoping would overwrite an unrelated dependency's range.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 *   - Every verdict branches on the runner's EXIT CODE. Output is never parsed.
 *   - STEP 0 proves the harness can SEE RED before any green is trusted.
 *   - Edits go through `scripts/lib/mutation-harness.mjs`: each anchor must
 *     occur EXACTLY ONCE, and restores are byte-identical.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/scaffold-npm10-resolve.test.ts';
const SUBJECT = resolve(REPO_ROOT, 'scripts/lib/scaffold-npm10-resolve.mjs');

const MUTATIONS = [
  {
    label: 'decideResolveStrategy: stop checking edgesOut before ETARGET parsing',
    anchor: "if (/edgesOut/.test(output)) return { kind: 'edgesOut' };",
    replacement: '',
  },
  {
    label: 'isReleasePrepEtarget: drop the @getknext/* scope check',
    anchor: '(e) => isGetknextScoped(e.name) && stripRangePrefix(e.range) === workspaceVersion,',
    replacement: '(e) => stripRangePrefix(e.range) === workspaceVersion,',
  },
  {
    label: 'isReleasePrepEtarget: drop the workspace-version equality check',
    anchor: '(e) => isGetknextScoped(e.name) && stripRangePrefix(e.range) === workspaceVersion,',
    replacement: '(e) => isGetknextScoped(e.name),',
  },
  {
    label: 'applyLocalResolutions: rewrite every dependency, not just the named ones',
    anchor:
      'for (const [name, tarball] of tarballsByName) {\n      if (name in nextDeps) {\n        nextDeps[name] = `file:${tarball}`;\n        changed = true;\n      }\n    }',
    replacement:
      'for (const name of Object.keys(nextDeps)) {\n      const tarball = [...tarballsByName.values()][0];\n      nextDeps[name] = `file:${tarball}`;\n      changed = true;\n    }',
  },
];

declareMutations(MUTATIONS.length);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
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
  const snap = snapshot(SUBJECT);
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
