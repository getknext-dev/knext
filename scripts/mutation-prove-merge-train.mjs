#!/usr/bin/env node
/**
 * Mutation proof for #1439's merge-train tool:
 *   - `scripts/lib/merge-train.mjs` — pure decision logic (SHA-lock,
 *     poll-state decisions, preflight verdicts, failed-check-run filtering,
 *     stacked-child-deletion refusal).
 *   - `scripts/merge-train.mjs` — the CLI orchestration layer.
 * Proved against `tests/merge-train.test.ts` (lib) and
 * `tests/merge-train-cli.test.ts` (CLI), per mutation.
 *
 * Shared harness, per docs/guides/mutation-testing.md:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-merge-train.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROOF = {
  subjects: {
    lib: 'scripts/lib/merge-train.mjs',
    cli: 'scripts/merge-train.mjs',
  },
};

const SPECS = {
  lib: 'tests/merge-train.test.ts',
  cli: 'tests/merge-train-cli.test.ts',
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
    label: 'isFullSha: accept any length, not just 40 hex chars (SHA-lock bypass)',
    subject: 'lib',
    anchor: 'const FULL_SHA_RE = /^[0-9a-f]{40}$/i;',
    replacement: 'const FULL_SHA_RE = /^[0-9a-f]+$/i;',
  },
  {
    label: 'resolveRemoteSha: skip the isFullSha guard, so a non-SHA still gets sent to gh',
    subject: 'lib',
    anchor: 'if (!isFullSha(sha)) return null;',
    replacement: 'if (false) return null;',
  },
  {
    label:
      'resolveRemoteSha: treat a thrown gh error as success (an agent-reported nonexistent SHA would resolve)',
    subject: 'lib',
    anchor: '  } catch {\n    return null;\n  }',
    replacement: '  } catch {\n    return sha;\n  }',
  },
  {
    label: 'headLockHolds: always true, so a moved head is never detected',
    subject: 'lib',
    anchor: "  return typeof currentHead === 'string' && currentHead === expectedHead;",
    replacement: '  return true;',
  },
  {
    label:
      'decidePollAction: HEAD_MOVED check no longer runs first (a push could ride a merge through)',
    subject: 'lib',
    anchor: '  if (!headLockHolds(observed.currentHead, observed.expectedHead)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'decidePollAction: CLOSED no longer reported as DEQUEUED',
    subject: 'lib',
    anchor: "    return { action: 'DEQUEUED', detail: 'PR closed without merging' };",
    replacement: "    return { action: 'CONTINUE' };",
  },
  {
    label: 'computePreflightVerdict: a red exit code is treated as ok (refusal bypass)',
    subject: 'lib',
    anchor: '  if (result.exitCode === 0) {\n    return { ok: true };\n  }',
    replacement: '  return { ok: true };',
  },
  {
    label: 'failedCheckRuns: stop excluding "success" conclusions (everything looks failed)',
    subject: 'lib',
    anchor: "      c.conclusion !== 'success' &&",
    replacement: "      c.conclusion !== 'xsuccess' &&",
  },
  {
    label:
      'formatBlockedDeletionMessage: drop the retarget-flag hint, so the refusal gives no way out',
    subject: 'lib',
    anchor:
      "'Retarget them to main first (--retarget), or delete manually once they are handled.',",
    replacement: "'',",
  },
  {
    label:
      'deleteBaseBranch: stop refusing when open children exist (the #1406/#1428/#1436 hazard reintroduced)',
    subject: 'cli',
    anchor: 'if (children.length > 0) {\n    if (!opts.retarget) {',
    replacement: 'if (false) {\n    if (!opts.retarget) {',
  },
  {
    label:
      'enqueueAndWait: skip the SHA-lock re-check before merging, so a moved head still gets merged',
    subject: 'cli',
    anchor:
      '  if (cur !== expectedHead) {\n    console.log(`HEAD MOVED: ${cur} != ${expectedHead}`);\n    return 3;\n  }',
    replacement: '  if (false) {\n    return 3;\n  }',
  },
];

declareMutations(MUTATIONS.length);

console.log('Baseline: both specs must be GREEN before anything is mutated.');
for (const spec of Object.values(SPECS)) {
  if (!specPasses(spec)) {
    console.error(`FATAL: baseline is not green for ${spec}`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const spec = SPECS[m.subject];

  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
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
