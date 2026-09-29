#!/usr/bin/env node
/**
 * Mutation proof for #1638 item 2's decision + fetch logic
 * (`scripts/lib/npm-publish-drift-check.mjs`, `tests/npm-publish-drift-check.test.ts`).
 *
 * Same shared harness/discipline as `scripts/mutation-prove-nightly-alert-pin-policy.mjs`:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from M-of-M;
 *   * judged on EXIT CODES, never on grepped output;
 *   * every mutation is scored against the whole spec file, snapshotted and
 *     restored independently, so the order they run in cannot matter.
 *
 * The property this proves that matters most for #1638's acceptance criterion
 * ("mutation-proved against a fixture"): every mutation below either (a) makes
 * a genuinely-missing setting read as present, or (b) collapses the
 * `permission-error` / `missing` distinction the module exists to keep apart —
 * both are exactly the ways this guard could quietly become decoration.
 *
 * Usage: node scripts/mutation-prove-npm-publish-drift-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/npm-publish-drift-check.test.ts';

// #912/#927 shape: a `subjects: { key: 'repo/relative/path' }` map plus a
// `{ subject: 'key', anchor: '…' }` mutation table — the shape both static
// liveness extractors in `scripts/lib/prover-lane.mjs` read (mirrors
// `scripts/mutation-prove-credential-slot-watchdog.mjs`). The PREVIOUS shape
// here (a bare `SUBJECT` constant used only inside `resolve(REPO_ROOT,
// SUBJECT)`, with `m.anchor`/`m.replacement` read off the loop variable) was
// invisible to both extractors: `auditAnchorLiveness`'s inline scan cannot
// resolve `snap` (bound at runtime inside the loop, not `const X =
// snapshot(PATH)`) or `m.anchor` (a property read, not a literal), and
// `proverPathBindings` requires a binding to be passed DIRECTLY to
// `readFileSync`/`snapshot` — `snapshot(resolve(REPO_ROOT, SUBJECT))` nests
// `SUBJECT` inside `resolve(...)`, so it never counted as "read". Round 2 of
// #1648 hit exactly that: `tests/mutation-prover-lane.test.ts`'s #912 check
// ("EVERY prover resolves at least one anchor or one read-subject") failed —
// zero of either, the review's own diagnosis, reproduced here rather than
// exempted.
const PROOF = {
  subjects: {
    lib: 'scripts/lib/npm-publish-drift-check.mjs',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'evaluateReviewerProtection: the required_reviewers rule lookup always "finds" one',
    subject: 'lib',
    anchor: "  const rule = protectionRules.find((r) => r && r.type === 'required_reviewers');",
    replacement: "  const rule = { type: 'required_reviewers', reviewers: [{ id: 1 }] };",
  },
  {
    label:
      'evaluateReviewerProtection: zero-reviewers check disarmed (an empty reviewers[] passes)',
    subject: 'lib',
    anchor: '  if (reviewers.length === 0) {',
    replacement: '  if (false) {',
  },
  {
    label:
      "matchesVStarGlob: the ~ALL special-case is dropped (GitHub's own all-tags literal stops matching)",
    subject: 'lib',
    anchor: "  if (pattern === '~ALL') return true;",
    replacement: '',
  },
  {
    label: 'matchesVStarGlob: the regex test always returns true (any pattern "covers" v*)',
    subject: 'lib',
    anchor: '  return new RegExp(`^${escaped}$`).test(SAMPLE_V_TAG);',
    replacement: '  return true;',
  },
  {
    // #1650 round 2, finding 3 — the exclude-carve-out gap.
    label:
      'tagRulesetCoversVStar: stop checking conditions.ref_name.exclude — a carved-out v* still reads as covered',
    subject: 'lib',
    anchor:
      '  const excludes = ruleset?.conditions?.ref_name?.exclude;\n  if (Array.isArray(excludes) && excludes.some((pattern) => matchesVStarGlob(pattern))) {\n    return false;\n  }',
    replacement: '',
  },
  {
    // #1650 round 2, finding 3 — the enforcement-mode gap (evaluate-only rulesets).
    label:
      'tagRulesetCoversVStar: stop requiring enforcement === "active" — a disabled/evaluate-only ruleset reads as covering',
    subject: 'lib',
    anchor: "  if (ruleset?.enforcement !== 'active') return false;",
    replacement: '',
  },
  {
    label: 'evaluateTagRulesetProtection: the empty-candidate-list finding text is dropped',
    subject: 'lib',
    anchor: "    return { ok: false, reason: 'no enabled ruleset targets tags' };",
    replacement: "    return { ok: false, reason: 'wrong reason on purpose' };",
  },
  {
    label:
      'fetchReviewerProtection: 403/404 is no longer routed to permission-error (silently becomes api-error)',
    subject: 'lib',
    anchor: '  if (PERMISSION_ERROR_STATUSES.has(res.status)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'fetchTagRulesetProtection: the RULESETS-LIST 403/404 is no longer routed to permission-error',
    subject: 'lib',
    anchor: '  if (PERMISSION_ERROR_STATUSES.has(listRes.status)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'fetchTagRulesetProtection: a RULESET-DETAIL 403/404 is no longer routed to permission-error',
    subject: 'lib',
    anchor: '    if (PERMISSION_ERROR_STATUSES.has(detailRes.status)) {',
    replacement: '    if (false) {',
  },
  {
    label:
      'describeFinding: a permission-error is relabelled as "missing" (the exact conflation #1638 forbids)',
    subject: 'lib',
    anchor:
      "      kind: 'permission-error',\n      message: `${setting}: UNVERIFIED (insufficient token permission) — ${result.message}`,",
    replacement:
      "      kind: 'missing',\n      message: `${setting}: UNVERIFIED (insufficient token permission) — ${result.message}`,",
  },
  {
    label: 'runDriftCheck: the tag-ruleset finding is never pushed (only the reviewer is checked)',
    subject: 'lib',
    anchor:
      "  if (tagRuleset.kind !== 'ok') {\n    findings.push(describeFinding('v*-covering tag ruleset', tagRuleset));\n  }",
    replacement:
      "  if (false) {\n    findings.push(describeFinding('v*-covering tag ruleset', tagRuleset));\n  }",
  },
];

declareMutations(12);

if (MUTATIONS.length !== 12) {
  console.error(`FATAL: declared 12 mutations, table has ${MUTATIONS.length}`);
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
