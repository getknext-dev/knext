#!/usr/bin/env node
/**
 * Mutation proof for the two round-2 (#1649) fixes to
 * `scripts/compat-credential-freeze-guard.mjs`:
 *
 *   1. `isMarkerNarrowingOnly` documents that a narrowing-only pin diff "never
 *      widens `paths`" — but neither the subset check (the guard's own :369)
 *      nor the size-comparison it feeds (:370) had a red test: deleting :369,
 *      or forcing :370's result to `true`, kept every test green (#1649
 *      review, required finding 1).
 *   2. The CLI wrapper used to fall back to `basePin` when
 *      `--merge-base-pin-file` was omitted — fail OPEN, silently treating the
 *      PR base as its own merge base and defeating the #1635 "who introduced
 *      the marker" / narrowing-only checks (#1649 review, non-blocking
 *      finding). It must fail closed: exit non-zero with the argument named.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one piece of behaviour and requires
 * the spec to go RED, then GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * the `{ subject, anchor }` table shape, which the prover lane's static
 *     anchor-liveness audit reads (scripts/lib/prover-lane.mjs), so a stale
 *     anchor is a PR-time finding, not a nightly surprise;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-compat-credential-freeze-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-credential-freeze-guard.test.ts';

/** The file every mutation below lands in, repo-relative. */
const PROOF = {
  subjects: {
    guard: 'scripts/compat-credential-freeze-guard.mjs',
  },
};

const MUTATIONS = [
  // ── #1649 finding 1: isMarkerNarrowingOnly never widens `paths` ──────────
  {
    label: 'never-widens-paths: delete the subset check (:369)',
    subject: 'guard',
    anchor: '      if (!head.paths.every((p) => base.paths.includes(p))) return false;\n',
    replacement: '',
  },
  {
    label: 'never-widens-paths: force pathsNarrowed to true regardless of the sets (:370)',
    subject: 'guard',
    anchor: '      pathsNarrowed = new Set(head.paths).size < new Set(base.paths).size;',
    replacement: '      pathsNarrowed = true;',
  },

  // ── #1649 non-blocking: --merge-base-pin-file must fail closed ───────────
  {
    // Deleting only the explicit check (leaving `mergeBasePin =
    // readPin(mergeBasePinFile)` as-is) still exits non-zero when the flag is
    // omitted — `readPin(null)` throws inside its own try/catch — but with
    // readPin's generic "could not read/parse" message instead of the
    // specific `--merge-base-pin-file is required` one the dedicated CLI
    // test below asserts, so this mutation is still caught. Separately
    // restoring the pre-fix ternary (`mergeBasePinFile ? readPin(...) :
    // basePin`) WITHOUT also deleting this check is inert — the check makes
    // `mergeBasePinFile` non-falsy by construction past this point — so that
    // row was deliberately left out as decorative (verified: it survived).
    label: 'merge-base-pin-file: delete the required-flag check',
    subject: 'guard',
    anchor:
      '  if (!mergeBasePinFile) {\n' +
      '    console.error(\n' +
      '      \'compat-credential-freeze-guard: --merge-base-pin-file is required — without it this would fail OPEN, silently treating the PR base as its own merge base (defeats the #1635 "who introduced the marker" and narrowing-only checks). Pass the pin read at `git merge-base` of the PR base and head, even when it is `{"rcTag": null}`.\',\n' +
      '    );\n' +
      '    process.exit(2);\n' +
      '  }\n',
    replacement: '',
  },
];

declareMutations(3);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 3) {
  console.error(`FATAL: declared 3 mutations, table has ${MUTATIONS.length}`);
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
