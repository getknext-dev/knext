#!/usr/bin/env node
/**
 * Mutation proof for #1663 — the published-bytes freeze check + its
 * Dependabot pause companion:
 *
 *   - `scripts/lib/published-bytes-freeze-check.mjs` — the pure scope/marker/
 *     decision logic;
 *   - `scripts/published-bytes-freeze-check.mjs` — the CLI wrapper (skip/
 *     fail-closed/run announcements, exit code propagation);
 *   - `scripts/dependabot-published-bytes-pause.mjs` — reuses the same
 *     decision to auto-close a Dependabot PR.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one piece of behaviour and requires
 * the spec to go RED, then GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * ROUND 2 (PR #1680 review): added mutations proving the base-vs-head pin fix
 * — `decidePublishedBytesScope` must read the "is a window open" question
 * from `basePin`, never `headPin` (a PR could otherwise skip the whole check
 * by closing the window in the same diff that changes published bytes) — and
 * the "#1635 rule" fix for `overrideMarkerIntroducedByPr` — a marker must be
 * INTRODUCED by the PR under test, not merely present or inherited.
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
 * Usage:  node scripts/mutation-prove-published-bytes-freeze-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every spec that exercises the three subjects below — run together so a
// mutation caught only by the CLI spec (say) is not missed because this
// prover picked the wrong single file.
const SPECS = [
  'tests/published-bytes-freeze-check.test.ts',
  'tests/published-bytes-freeze-check-cli.test.ts',
  'tests/dependabot-published-bytes-pause.test.ts',
  'tests/published-bytes-freeze-guard-workflow.test.ts',
];

/** The files every mutation below lands in, repo-relative. */
const PROOF = {
  subjects: {
    lib: 'scripts/lib/published-bytes-freeze-check.mjs',
    cli: 'scripts/published-bytes-freeze-check.mjs',
    dependabot: 'scripts/dependabot-published-bytes-pause.mjs',
    workflow: '.github/workflows/published-bytes-freeze-guard.yml',
  },
};

const MUTATIONS = [
  // ── touchesPublishableScope: the "cheap on every PR" fast path ────────────
  {
    label: 'scope: stop matching root build-input files (bun.lock, root package.json, ...)',
    subject: 'lib',
    anchor:
      'const matched = changedFiles.filter(\n    (f) => rootSet.has(f) || packageDirs.some((dir) => f === dir || f.startsWith(`${dir}/`)),\n  );',
    replacement:
      'const matched = changedFiles.filter(\n    (f) => packageDirs.some((dir) => f === dir || f.startsWith(`${dir}/`)),\n  );',
  },
  {
    label: 'scope: stop matching files under a publishable package directory',
    subject: 'lib',
    anchor:
      'const matched = changedFiles.filter(\n    (f) => rootSet.has(f) || packageDirs.some((dir) => f === dir || f.startsWith(`${dir}/`)),\n  );',
    replacement: 'const matched = changedFiles.filter((f) => rootSet.has(f));',
  },

  // ── overrideMarkerValidity: the reviewed rc.N+1 escalation ────────────────
  {
    label: 'marker: treat an absent marker as valid (skips the freeze check unconditionally)',
    subject: 'lib',
    anchor:
      '  if (marker === null || marker === undefined) {\n    return { valid: false, reason: `no ${OVERRIDE_MARKER_FIELD} present in the pin file` };\n  }',
    replacement:
      '  if (marker === null || marker === undefined) {\n    return { valid: true, reason: `no ${OVERRIDE_MARKER_FIELD} present in the pin file` };\n  }',
  },
  {
    label: 'marker: stop rejecting an expired marker',
    subject: 'lib',
    anchor:
      '  if (today > expires) {\n    return {\n      valid: false,\n      reason: `${OVERRIDE_MARKER_FIELD} expired on ${expires} (today is ${today})`,\n    };\n  }',
    replacement: '  if (false) {\n    return { valid: false, reason: "unreachable" };\n  }',
  },
  {
    label: 'marker: stop rejecting a future-dated marker',
    subject: 'lib',
    anchor:
      '  if (date > today) {\n    return {\n      valid: false,\n      reason: `${OVERRIDE_MARKER_FIELD}.date (${date}) is in the future (today is ${today})`,\n    };\n  }',
    replacement: '  if (false) {\n    return { valid: false, reason: "unreachable" };\n  }',
  },
  {
    label: 'marker: stop enforcing the 14-day span cap',
    subject: 'lib',
    anchor: '  if (!(spanFromTodayDays <= MAX_OVERRIDE_MARKER_SPAN_DAYS)) {',
    replacement: '  if (false) {',
  },

  // ── decidePublishedBytesScope: the three-outcome decision itself ─────────
  {
    label: 'decision: stop skipping when rcTag is null at base (would pack on every PR)',
    subject: 'lib',
    anchor:
      "  if (rcTag === null || rcTag === undefined) {\n    return {\n      action: 'skip',\n      reason: `${PIN_FILE}'s rcTag is null at this PR's base — no credential window was open before this PR`,\n    };\n  }",
    replacement: "  if (false) {\n    return { action: 'skip', reason: 'unreachable' };\n  }",
  },
  {
    label: 'decision: let a valid, PR-introduced override marker fall through to proceed anyway',
    subject: 'lib',
    anchor: '  if (marker.valid && overrideMarkerIntroducedByPr(mergeBasePin, headPin)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'decision: round-2 bypass — read rcTag from headPin instead of basePin (the #1680 finding)',
    subject: 'lib',
    anchor:
      "  const rcTag =\n    basePin && typeof basePin === 'object' ? /** @type {any} */ (basePin).rcTag : undefined;",
    replacement:
      "  const rcTag =\n    headPin && typeof headPin === 'object' ? /** @type {any} */ (headPin).rcTag : undefined;",
  },
  {
    label:
      'decision: honour ANY structurally-valid marker regardless of who introduced it (the #1635-class bypass)',
    subject: 'lib',
    anchor: '  if (marker.valid && overrideMarkerIntroducedByPr(mergeBasePin, headPin)) {',
    replacement: '  if (marker.valid) {',
  },
  {
    label: 'decision: proceed even when the PR touches no publishable scope',
    subject: 'lib',
    anchor: '  if (!scope.touches) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'overrideMarkerIntroducedByPr: treat an identical (date+reason-matching) merge-base marker as introduced anyway',
    subject: 'lib',
    anchor: '  return base.date !== head.date || base.reason !== head.reason;',
    replacement: '  return true;',
  },

  // ── published-bytes-freeze-check.mjs (CLI wrapper) ────────────────────────
  {
    label: 'cli: stop announcing/returning on a SKIP decision (would always attempt to pack)',
    subject: 'cli',
    anchor:
      "  if (decision.action === 'skip') {\n    announce('notice', 'SKIP', decision.reason);\n    return 0;\n  }",
    replacement:
      "  if (false) {\n    announce('notice', 'SKIP', decision.reason);\n    return 0;\n  }",
  },
  {
    label: 'cli: stop failing closed on an unresolved rcTag',
    subject: 'cli',
    anchor: '  if (!tagResolves(repoRoot, decision.rcTag)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'cli: stop requiring changedFiles to be provided explicitly',
    subject: 'cli',
    anchor:
      "  if (!Array.isArray(changedFiles)) {\n    throw new Error('main() requires changedFiles: string[] — the files this PR touched');\n  }",
    replacement: '  if (false) {\n    throw new Error("unreachable");\n  }',
  },
  {
    label: 'cli: stop propagating the diff exit code (would always report PASS)',
    subject: 'cli',
    anchor: '  return code;',
    replacement: '  return 0;',
  },

  // ── dependabot-published-bytes-pause.mjs ──────────────────────────────────
  {
    label: 'dependabot: never close, regardless of the decision (action === "proceed" ignored)',
    subject: 'dependabot',
    anchor: "  const shouldClose = decision.action === 'proceed';",
    replacement: '  const shouldClose = false;',
  },

  // ── #2004: base-ref scope (1.3-line PRs skip; main-line PRs stay guarded) ──
  {
    label: 'base-ref: never skip an integration/* base (the always-red 1.3 job returns)',
    subject: 'lib',
    anchor: '  if (isUnfrozenLineBaseRef(baseRef)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'base-ref: skip EVERY base (a main-base PR changing published bytes escapes the freeze)',
    subject: 'lib',
    anchor: ".startsWith('integration/');",
    replacement: '.length >= 0;',
  },
  {
    label: 'base-ref: CLI stops passing baseRef to the decision',
    subject: 'cli',
    anchor: '    packageDirs,\n    baseRef,\n    now,\n  });',
    replacement: '    packageDirs,\n    now,\n  });',
  },
  {
    label: 'base-ref: workflow stops passing --base-ref to the check',
    subject: 'workflow',
    anchor: ' \\\n            --base-ref "${BASE_REF}"',
    replacement: '',
  },
];

declareMutations(21);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPECS[0]);

/** True when EVERY spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...SPECS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 21) {
  console.error(`FATAL: declared 21 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the specs must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPECS.join(', ')} are not green to begin with`);
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
    console.error(`   FATAL: ${SPECS.join(', ')} did not go green again after restore`);
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
