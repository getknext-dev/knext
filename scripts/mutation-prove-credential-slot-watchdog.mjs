#!/usr/bin/env node
/**
 * Mutation proof for #1640's credential-slot watchdog:
 *   - `scripts/lib/credential-slot-watchdog.mjs` — the pure decision function
 *     and the parsing/attribution layer around it.
 *   - `scripts/credential-slot-watchdog.mjs` — the fetch/CLI layer.
 * Both proved against `tests/credential-slot-watchdog.test.ts`.
 *
 * Shared harness, per docs/guides/mutation-testing.md:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-credential-slot-watchdog.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/credential-slot-watchdog.test.ts';

const PROOF = {
  subjects: {
    lib: 'scripts/lib/credential-slot-watchdog.mjs',
    cli: 'scripts/credential-slot-watchdog.mjs',
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
    label:
      'decideCredentialSlotVerdicts: "missing" branch always returns quiet, ignoring graceElapsed',
    subject: 'lib',
    anchor: "        verdict: graceElapsed ? 'missing' : 'quiet',",
    replacement: "        verdict: 'quiet',",
  },
  {
    label: 'decideCredentialSlotVerdicts: "queued-too-long" verdict literal replaced with "quiet"',
    subject: 'lib',
    anchor: "        verdict: 'queued-too-long',",
    replacement: "        verdict: 'quiet',",
  },
  {
    label:
      'decideCredentialSlotVerdicts: grace boundary uses > instead of >= (off-by-one at the deadline)',
    subject: 'lib',
    anchor: 'const graceElapsed = nowTime >= deadline;',
    replacement: 'const graceElapsed = nowTime > deadline;',
  },
  {
    label:
      'decideCredentialSlotVerdicts: "started" check inverted (a started run reads as not-started)',
    subject: 'lib',
    anchor: 'if (relevant.run_started_at) {',
    replacement: 'if (!relevant.run_started_at) {',
  },
  {
    // This single check does double duty (see the code comment above it in
    // the lib file): it filters out BOTH a stale prior-day occurrence AND an
    // early-warning nearest-slot match (whose `lane` is undefined, so
    // `expectedByLane.get` never matches a real ISO timestamp). A separate
    // `if (!lane) continue` was measured decorative here — this is the one
    // guard that actually reds when removed, for either failure mode.
    label: 'attributeRunsToLanes: stop excluding a STALE occurrence / an early-warning match',
    subject: 'lib',
    anchor: 'if (best.time.toISOString() !== expectedByLane.get(lane)) continue;',
    replacement: 'if (false) continue;',
  },
  {
    // #1650 round 2, finding 1: `resolveCredentialLanes` used to catch a
    // parse failure and silently substitute DEFAULT_CREDENTIAL_LANES. This
    // mutation reintroduces exactly that regression (bringing the fallback
    // assignment back in place of the fail-closed throw) — it must red the
    // "THROWS — never silently substitutes" test.
    label:
      'resolveCredentialLanes: swallow the parse failure and fall back to DEFAULT_CREDENTIAL_LANES instead of failing closed',
    subject: 'lib',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text of the anchor line, not an interpolation
    anchor: 'throw new Error(`credential-slot-watchdog: cannot read slots — ${message}`);',
    replacement: 'lanes = DEFAULT_CREDENTIAL_LANES;',
  },
  {
    label:
      "parseCredentialCronsFromCompatMode: the 'credential' literal in the regex is renamed, so nothing ever matches",
    subject: 'lib',
    anchor: "const re = /github\\.event\\.schedule\\s*==\\s*'([^']+)'\\s*&&\\s*'credential'/g;",
    replacement:
      "const re = /github\\.event\\.schedule\\s*==\\s*'([^']+)'\\s*&&\\s*'xcredential'/g;",
  },
  {
    label: 'attributeRunsToLanes: stop filtering out non-"schedule" events',
    subject: 'lib',
    anchor: "if (run.event && run.event !== 'schedule') continue;",
    replacement: 'if (false) continue;',
  },
  {
    label: 'fetchScheduledRuns: drop the event=schedule filter from the GitHub API query',
    subject: 'cli',
    anchor: 'runs?event=schedule&per_page=',
    replacement: 'runs?per_page=',
  },
  {
    // #1650 round 2, finding 2 — the cross-lane masking fix.
    label:
      "detectAmbiguousAttribution: stop checking whether the run falls inside the predecessor's grace window — everything looks unambiguous",
    subject: 'lib',
    anchor: 'if (createdAt >= predSlotTime && createdAt <= predDeadline) {',
    replacement: 'if (false) {',
  },
  {
    label:
      "detectAmbiguousAttribution: drop the predecessor's-own-evidence escape hatch — a healthy neighbouring lane's run stops mattering",
    subject: 'lib',
    anchor: 'if (!pred || predHasOwnEvidence) {',
    replacement: 'if (!pred) {',
  },
  {
    label:
      'decideCredentialSlotVerdicts: the "ambiguous" verdict literal replaced with "missing" (loses the distinguishing reason)',
    subject: 'lib',
    anchor: "          verdict: 'ambiguous',",
    replacement: "          verdict: 'missing',",
  },
  {
    // The mode-marker check is what stops an early-warning run's `compat-lane-*`
    // marker (same lane names as its credential counterpart) from being
    // trusted as a credential-lane signal.
    label: 'attachExactLanes: trust the lane marker even when the mode marker is not "credential"',
    subject: 'cli',
    anchor: "exactLane: lane && mode === 'credential' ? lane : null",
    replacement: 'exactLane: lane ? lane : null',
  },
  {
    label:
      "attributeRunsToLanes: stop checking the exact-marker run's occurrence against the CURRENT cycle — a stale exact-marker run is accepted",
    subject: 'lib',
    anchor: 'if (occurrence.toISOString() === expectedByLane.get(run.exactLane)) {',
    replacement: 'if (true) {',
  },
];

declareMutations(14);

if (MUTATIONS.length !== 14) {
  console.error(`FATAL: declared 14 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses(SPEC)) {
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
    if (specPasses(SPEC)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(SPEC)) {
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
