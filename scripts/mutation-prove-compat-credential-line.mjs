#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-credential-line.test.ts` — the parallel
 * v1.3 credential lane. Both halves the lane promises are proved:
 *
 *   A. the v1.3 lane resolves the v1.3 RC tag and NEVER the v1.0 tag (nor
 *      main): delete a refusal, widen the line, mis-wire the derived workflow
 *      or its tracker — the spec must go RED;
 *   B. the v1.0 lane is unchanged and nothing collides with it: put a v1.3
 *      file into the v1.0 frozen set, move a v1.0 cron, point the v1.0 audit
 *      at the v1.3 workflow, or give the v1.3 lane a v1.0 name — RED.
 *   C. the v1.3 slots stay clear of v1.0's measured late-start tail (start
 *      >= 14:00 UTC, >= 90 min apart, tracker after the last slot's grace);
 *   D. the main-side guard scripts (resolver, derivation gate, tracker) are
 *      folded into the fingerprinted executing file, so editing one restarts
 *      the window — drop the digest, the header check or a script: RED.
 *
 * Shared harness, same rules as every prover here:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell 18-of-19 from 19;
 *   * the `{ subject, anchor }` table shape the prover lane's static
 *     anchor-liveness audit reads (scripts/lib/prover-lane.mjs);
 *   * judged on EXIT CODES, never on grepped output; baseline green first, and
 *     green again after every restore.
 *
 * Usage:  node scripts/mutation-prove-compat-credential-line.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-credential-line.test.ts';

/** The files the mutations land in, repo-relative. */
const PROOF = {
  subjects: {
    line: 'scripts/compat-credential-line.mjs',
    derive: 'scripts/compat-line-workflow.mjs',
    tracker: 'scripts/compat-line-tracker.mjs',
    derived: '.github/workflows/compat-credential-v1.3.yml',
    trackerWorkflow: '.github/workflows/compat-credential-v1.3-tracker.yml',
    v10workflow: '.github/workflows/test-e2e-deploy.yml',
    v10audit: 'scripts/compat-window-audit.mjs',
    freezeGuard: 'scripts/compat-credential-freeze-guard.mjs',
  },
};

const MUTATIONS = [
  // ── A. the v1.3 lane resolves the v1.3 tag, never v1.0's ─────────────────
  {
    label: 'A: drop the off-line refusal (a v1.0 tag in the v1.3 pin would run)',
    subject: 'line',
    anchor: '  if (!spec.tagPattern.test(pin.rcTag)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: widen the v1.3 line to ANY RC tag',
    subject: 'line',
    anchor: '    tagPattern: new RegExp(`^v1\\\\.3\\\\.${NUM}-rc\\\\.${NUM}$`),',
    replacement: '    tagPattern: /^v\\d+\\.\\d+\\.\\d+-rc\\.\\d+$/,',
  },
  {
    label: 'A: accept a pin that does not declare the v1.3 line (the v1.0 pin)',
    subject: 'line',
    anchor: '  if (pin.line !== line) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: a dispatch (early-warning) night is marked credential',
    subject: 'line',
    anchor: "    state: credential ? 'resolved' : 'early-warning',\n    credential,\n",
    replacement: "    state: 'resolved',\n    credential: true,\n",
  },
  {
    label: 'A: the derived workflow resolves with the v1.0 resolver',
    subject: 'derived',
    anchor:
      '          node knext/scripts/compat-credential-line.mjs \\\n            --line v1.3 \\\n',
    replacement: '          node knext/scripts/compat-credential-ref.mjs \\\n',
  },
  {
    label: 'A: the derivation hands the v1.3 lane the v1.0 pin (committed file not regenerated)',
    subject: 'derive',
    anchor: '        `            --pin knext/${spec.pinFile} \\\\\\n` +',
    replacement: "        '            --pin knext/.github/compat-credential-ref.json \\\\\\n' +",
  },
  {
    label: 'A: the run-time gate accepts a hand-edited executing workflow',
    subject: 'derive',
    anchor: '  if (derived !== executingText) {',
    replacement: '  if (false) {',
  },
  {
    label: 'A: a substitution whose anchor is missing derives silently',
    subject: 'derive',
    anchor: '    const n = count(text, s.from);\n    if (n !== s.count) {',
    replacement: '    const n = count(text, s.from);\n    if (false) {',
  },
  {
    label: 'A: the v1.3 audit lists the v1.0 workflow (no rewrite)',
    subject: 'tracker',
    anchor: '      out[at[0] + 1] = spec.workflowFile;',
    replacement: '      void out;',
  },
  {
    label: 'A: a night on another line’s tag can bank in the v1.3 window',
    subject: 'tracker',
    anchor: '    cells[lane] = { ...a, offLineNights, met: a.met && offLineNights.length === 0 };',
    replacement: '    cells[lane] = { ...a, offLineNights, met: a.met };',
  },
  {
    label: 'A: the v1.3 tracker pins itself (would take a v1.0 pin slot)',
    subject: 'tracker',
    anchor: '  const match = issues.find((i) => i.title === spec.trackerTitle);',
    replacement:
      "  gh(['issue', 'pin', '1', '--repo', repo]);\n  const match = issues.find((i) => i.title === spec.trackerTitle);",
  },

  // ── B. the v1.0 lane is unchanged and nothing collides with it ───────────
  {
    label: 'B: a v1.3 file enters the v1.0 frozen set',
    subject: 'freezeGuard',
    anchor: "  '.github/workflows/compat-credential-freeze-guard.yml',\n]);",
    replacement:
      "  '.github/workflows/compat-credential-freeze-guard.yml',\n  'scripts/compat-credential-line.mjs',\n]);",
  },
  {
    label: 'B: the v1.0 node credential night moves (v1.0 cron mapping changed)',
    subject: 'v10workflow',
    anchor: "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') ||",
    replacement:
      "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 3 * * *' && 'credential') ||",
  },
  {
    label: 'B: the v1.0 audit reads the v1.3 workflow',
    subject: 'v10audit',
    anchor: "const WORKFLOW = 'test-e2e-deploy.yml';",
    replacement: "const WORKFLOW = 'compat-credential-v1.3.yml';",
  },
  {
    label: 'B: the derived workflow keeps the v1.0 name (shared concurrency groups)',
    subject: 'derived',
    anchor: 'name: Compat suite v1.3 credential (official Next.js deploy harness)\n',
    replacement: 'name: Compat suite (official Next.js deploy harness)\n',
  },
  {
    label: 'B: a v1.3 credential cron lands on a v1.0 slot',
    subject: 'line',
    anchor: "      '17 1 * * *': '17 14 * * *',",
    replacement: "      '17 1 * * *': '17 3 * * *',",
  },
  {
    label: 'B: the v1.3 red alert reuses the v1.0 title',
    subject: 'line',
    anchor: "    alertTitle: 'Compat v1.3 CREDENTIAL RED (${KNEXT_LANE}, RC tag)',",
    replacement: "    alertTitle: 'Compat CREDENTIAL RED (${KNEXT_LANE}, RC tag)',",
  },
  {
    label: 'B: the v1.3 reset label is the v1.0 one',
    subject: 'line',
    anchor: "    resetLabel: 'credential-reset-v1.3',",
    replacement: "    resetLabel: 'credential-reset',",
  },
  {
    label: 'B: the v1.3 tracker label is the v1.0 tracker label',
    subject: 'line',
    anchor: "    trackerLabel: 'credential-matrix-tracker-v1.3',",
    replacement: "    trackerLabel: 'credential-matrix-tracker',",
  },

  // ── C. the v1.3 slots stay clear of v1.0's measured late-start tail ──────
  {
    label: 'C: a v1.3 credential cron moves back inside v1.0’s late-start tail (before 14:00 UTC)',
    subject: 'line',
    anchor: "      '17 1 * * *': '17 14 * * *',",
    replacement: "      '17 1 * * *': '17 11 * * *',",
  },
  {
    label: 'C: two v1.3 crons closer than 90 min (the bun slot 30 min after node)',
    subject: 'line',
    anchor: "      '47 5 * * *': '47 15 * * *',",
    replacement: "      '47 5 * * *': '47 14 * * *',",
  },
  {
    label: 'C: the v1.3 tracker runs before the last slot’s 10 h grace has elapsed',
    subject: 'trackerWorkflow',
    anchor: "    - cron: '31 5 * * *'",
    replacement: "    - cron: '53 1 * * *'",
  },

  // ── D. the main-side guard scripts are folded into the fingerprinted bytes ─
  {
    label: 'D: the guard digests stop reading the scripts (an edit no longer moves the header)',
    subject: 'derive',
    anchor: "    sha256(readFileSync(join(repoRoot, path), 'utf8')),",
    replacement: '    sha256(path),',
  },
  {
    label: 'D: the header no longer has to record every guard script (a dropped line parses)',
    subject: 'derive',
    anchor: '  if (JSON.stringify(guards.map(([p]) => p)) !== JSON.stringify(spec.guardScripts)) {',
    replacement: '  if (false) {',
  },
  {
    label: 'D: a guard script is dropped from the line’s guard list (tracker edits go unseen)',
    subject: 'line',
    anchor:
      "      'scripts/compat-line-workflow.mjs',\n      'scripts/compat-line-tracker.mjs',\n    ]),",
    replacement: "      'scripts/compat-line-workflow.mjs',\n    ]),",
  },
];

declareMutations(25);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 25) {
  console.error(`FATAL: declared 25 mutations, table has ${MUTATIONS.length}`);
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
