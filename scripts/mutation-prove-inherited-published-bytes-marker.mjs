#!/usr/bin/env node
/**
 * Mutation proof for #2342 — a `publishedBytesBumpMarker` that reaches a PR
 * through a MERGED-IN branch must not exempt it from the published-bytes
 * freeze check (the rule #2325 added to the credential freeze guard).
 *
 * Four specs, one per layer:
 *   * the shared match + collection, `scripts/lib/merged-in-pins.mjs`, proved
 *     against `tests/merged-in-pins.test.ts` (real git repos);
 *   * the decision, `scripts/lib/published-bytes-freeze-check.mjs`
 *     (`overrideMarkerArrivedViaMerge`, the `overrideMarkerIntroducedByPr`
 *     short-circuit, the `decidePublishedBytesScope` branch), proved against
 *     `tests/published-bytes-freeze-check.test.ts`;
 *   * the CLI, `scripts/published-bytes-freeze-check.mjs` (required,
 *     array-typed `--inherited-pins-file`, inheritedPins handed to the
 *     decision, the ignored-marker warning), proved against
 *     `tests/published-bytes-freeze-check-cli.test.ts`;
 *   * the wiring — the workflow's "Collect the pins at merged-in parents" step,
 *     the flag on the check invocation, the collection CLI's output and the
 *     CLI's hand-off to `main()` — proved against
 *     `tests/published-bytes-freeze-guard-workflow.test.ts`, whose #2342 block
 *     runs the workflow's steps verbatim in real git fixture repos.
 *
 * Each mutation removes one piece of behaviour and must turn its spec RED by
 * EXIT CODE (`scripts/lib/guard-prover.mjs`: baseline green, canary red,
 * every anchor exactly once, clean tree between mutations). Commit first: the
 * harness refuses a dirty tree.
 *
 * Deliberately NOT a row: dropping `inheritedPins` from the
 * `overrideMarkerIntroducedByPr` call inside `decidePublishedBytesScope`. The
 * `overrideMarkerArrivedViaMerge` branch above it already refuses the same
 * input, so that mutation survives by design (defence in depth), and a row
 * for it would be a known survivor — the same call #2325's prover made.
 *
 * Usage:  node scripts/mutation-prove-inherited-published-bytes-marker.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_LIB = resolve(REPO_ROOT, 'scripts/lib/merged-in-pins.mjs');
const DECISION_LIB = resolve(REPO_ROOT, 'scripts/lib/published-bytes-freeze-check.mjs');
const CHECK_CLI = resolve(REPO_ROOT, 'scripts/published-bytes-freeze-check.mjs');
const COLLECT_CLI = resolve(REPO_ROOT, 'scripts/collect-merged-in-pins.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/published-bytes-freeze-guard.yml');

/** A mutated workflow must still parse, or its red is for the wrong reason. */
function validYaml(text) {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `YAML no longer parses: ${err.message}`;
  }
}

const SHARED_MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim: 'the match drops `reason` — a merge PR that re-authorizes with a new reason is refused',
    subject: 'lib',
    anchor: '  return x.date === y.date && x.reason === y.reason;',
    replacement: '  return x.date === y.date;',
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'the match drops `date` — a re-dated authorization still reads as inherited',
    subject: 'lib',
    anchor: '  return x.date === y.date && x.reason === y.reason;',
    replacement: '  return x.reason === y.reason;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the match stops being field-specific — a merged-in rcBumpMarker counts against a ' +
      'publishedBytesBumpMarker',
    subject: 'lib',
    anchor: '  return inheritedPins.some((pin) => sameAuthorization(markerAt(pin, field), head));',
    replacement:
      "  return inheritedPins.some((pin) => sameAuthorization(markerAt(pin, field) ?? markerAt(pin, 'rcBumpMarker'), head));",
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      "merge_group stops skipping the queue's own merges — the queued PR's own marker reads " +
      'as inherited',
    subject: 'lib',
    anchor: '    if (queueMerges.has(merge)) continue;',
    replacement: `    /* ${MUTATION_MARKER} */ void 0;`,
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the queue-merge skip applies to pull_request too — a merge PR skips its own merge ' +
      'commit and the merged-in marker exempts again',
    subject: 'lib',
    anchor: "    eventName === 'merge_group'",
    replacement: `    /* ${MUTATION_MARKER} */ true`,
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'no merged-in parent is read — the collection is always empty',
    subject: 'lib',
    anchor: '    for (const parent of mergedIn) {',
    replacement: `    for (const parent of mergedIn.slice(0, 0)) { /* ${MUTATION_MARKER} */`,
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'the walk covers no commits (head..head) — the collection is always empty',
    subject: 'lib',
    anchor: "'--merges', '--parents', `${mergeBase}..${headSha}`",
    replacement: `'--merges', '--parents', \`\${headSha}..\${headSha}\` /* ${MUTATION_MARKER} */`,
  },
  {
    id: 'M8',
    expect: 'red',
    claim: 'the collection stops de-duplicating — the same marker is reported once per parent',
    subject: 'lib',
    anchor: '      if (seen.has(key)) continue;',
    replacement: `      /* ${MUTATION_MARKER} */ void 0;`,
  },
];

const DECISION_MUTATIONS = [
  {
    id: 'D1',
    expect: 'red',
    claim:
      'overrideMarkerIntroducedByPr stops consulting the merged-in pins — an exported caller ' +
      'reads a merged-in marker as introduced again',
    subject: 'decision',
    anchor: '  if (overrideMarkerArrivedViaMerge(headPin, inheritedPins)) return false;\n',
    replacement: '  void 0;\n',
  },
  {
    id: 'D2',
    expect: 'red',
    claim: 'overrideMarkerArrivedViaMerge never matches — every merged-in marker exempts',
    subject: 'decision',
    anchor: '  return markerArrivedViaMerge(headPin, inheritedPins, OVERRIDE_MARKER_FIELD);',
    replacement: '  return false;',
  },
  {
    id: 'D3',
    expect: 'red',
    claim:
      'decidePublishedBytesScope loses its merged-in branch — the note blames the merge base, ' +
      'pointing the author at the wrong fix',
    subject: 'decision',
    anchor: '  if (marker.valid && overrideMarkerArrivedViaMerge(headPin, inheritedPins)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'D4',
    expect: 'red',
    claim: 'a proceed decision drops markerNote — the ignored marker is never explained',
    subject: 'decision',
    anchor: '    ...(markerNote ? { markerNote } : {}),\n',
    replacement: `    /* ${MUTATION_MARKER} */\n`,
  },
];

const CLI_MUTATIONS = [
  {
    id: 'C1',
    expect: 'red',
    claim: 'the CLI no longer requires --inherited-pins-file — the fail-closed message is gone',
    subject: 'check',
    anchor: '  if (!inheritedPinsFile) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'C2',
    expect: 'red',
    claim:
      'the CLI accepts a non-array --inherited-pins-file — a malformed collection is silently ' +
      'treated as "no merges"',
    subject: 'check',
    anchor: '  if (!Array.isArray(inheritedPins)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'C3',
    expect: 'red',
    claim: 'main() never hands inheritedPins to the decision — a merged-in marker exempts again',
    subject: 'check',
    anchor: '    mergeBasePin,\n    inheritedPins,\n    changedFiles,\n',
    replacement: '    mergeBasePin,\n    changedFiles,\n',
  },
  {
    id: 'C4',
    expect: 'red',
    claim: 'main() stops announcing the ignored marker — a fail-closed exit hides why',
    subject: 'check',
    anchor:
      "  if (decision.markerNote) announce('warning', 'MARKER IGNORED', decision.markerNote);",
    replacement: `  /* ${MUTATION_MARKER} */ void 0;`,
  },
];

const WIRING_MUTATIONS = [
  {
    id: 'W1',
    expect: 'red',
    claim: 'the check invocation stops passing --inherited-pins-file',
    subject: 'workflow',
    // The residue marker rides as an ignored `--x-…` argument rather than a
    // `#` comment: a comment line inside a backslash-continued command would
    // end the command and red the step for the wrong reason.
    anchor: '            --inherited-pins-file inherited-pins.json \\\n',
    replacement: `            --x-${MUTATION_MARKER} \\\n`,
    validate: validYaml,
  },
  {
    id: 'W2',
    expect: 'red',
    claim:
      'the step collects the wrong marker field — a merged-in publishedBytesBumpMarker is missed',
    subject: 'workflow',
    anchor: '            --field publishedBytesBumpMarker \\\n',
    replacement: `            --field rcBumpMarker --x-${MUTATION_MARKER} \\\n`,
    validate: validYaml,
  },
  {
    id: 'W3',
    expect: 'red',
    claim: 'the step reads a pin file other than the one selected for the base line',
    subject: 'workflow',
    anchor: '            --pin-file "${PIN_FILE_SELECTED}" \\\n',
    replacement: `            --pin-file .github/compat-credential-ref-v1.3.json --x-${MUTATION_MARKER} \\\n`,
    validate: validYaml,
  },
  {
    id: 'W4',
    expect: 'red',
    claim:
      "the step stops passing the event name — on merge_group the queue's own merge makes a " +
      "queued PR's own marker read as inherited",
    subject: 'workflow',
    anchor: '            --event-name "${GITHUB_EVENT_NAME}" \\\n',
    replacement: `            --event-name pull_request --x-${MUTATION_MARKER} \\\n`,
    validate: validYaml,
  },
  {
    id: 'W5',
    expect: 'red',
    claim: 'the collection CLI writes an empty array regardless of what it found',
    subject: 'collect',
    anchor: '    writeFileSync(out, JSON.stringify(pins));',
    replacement: "    void pins; writeFileSync(out, '[]');",
  },
  {
    id: 'W6',
    expect: 'red',
    claim: 'the CLI reads the inherited pins but never hands them to main()',
    subject: 'check',
    anchor:
      'main({ changedFiles, basePin, headPin, mergeBasePin, inheritedPins, baseVersion, baseSha })',
    replacement: 'main({ changedFiles, basePin, headPin, mergeBasePin, baseVersion, baseSha })',
  },
];

declareMutations(
  SHARED_MUTATIONS.length +
    DECISION_MUTATIONS.length +
    CLI_MUTATIONS.length +
    WIRING_MUTATIONS.length,
);

const provers = [
  {
    title: 'tests/merged-in-pins.test.ts (#2342 shared match + collection)',
    prover: createGuardProver({
      repoRoot: REPO_ROOT,
      spec: 'tests/merged-in-pins.test.ts',
      subjects: { lib: SHARED_LIB },
    }),
    mutations: SHARED_MUTATIONS,
    canary: {
      subject: 'lib',
      anchor: '  if (!head) return false;\n  return inheritedPins.some(',
      replacement: '  if (!head) return true;\n  return inheritedPins.some(',
    },
  },
  {
    title: 'tests/published-bytes-freeze-check.test.ts (#2342 decision)',
    prover: createGuardProver({
      repoRoot: REPO_ROOT,
      spec: 'tests/published-bytes-freeze-check.test.ts',
      subjects: { decision: DECISION_LIB },
    }),
    mutations: DECISION_MUTATIONS,
    canary: {
      subject: 'decision',
      anchor: '  if (!base) return true;',
      replacement: '  if (!base) return false;',
    },
  },
  {
    title: 'tests/published-bytes-freeze-check-cli.test.ts (#2342 CLI)',
    prover: createGuardProver({
      repoRoot: REPO_ROOT,
      spec: 'tests/published-bytes-freeze-check-cli.test.ts',
      subjects: { check: CHECK_CLI },
    }),
    mutations: CLI_MUTATIONS,
    canary: {
      subject: 'check',
      anchor: "    announce('notice', 'SKIP', decision.reason);\n    return 0;",
      replacement: "    announce('notice', 'SKIP', decision.reason);\n    return 1;",
    },
  },
  {
    title: 'tests/published-bytes-freeze-guard-workflow.test.ts (#2342 wiring, real git)',
    prover: createGuardProver({
      repoRoot: REPO_ROOT,
      spec: 'tests/published-bytes-freeze-guard-workflow.test.ts',
      subjects: { workflow: WORKFLOW, collect: COLLECT_CLI, check: CHECK_CLI },
    }),
    mutations: WIRING_MUTATIONS,
    canary: {
      subject: 'collect',
      anchor: '    const pins = collectMergedInPins(',
      replacement: '    process.exit(3);\n    const pins = collectMergedInPins(',
    },
  },
];

for (const { title, prover, mutations } of provers) {
  console.log(`=== preflight: ${title} ===`);
  prover.preflight(mutations);
}
for (const { title, prover, mutations, canary } of provers) {
  console.log(`\n=== ${title} ===`);
  prover.baseline();
  prover.proveCanSeeRed(canary);
  for (const m of mutations) {
    prover.run(m);
    recordMutation();
  }
  prover.finish(mutations.length);
}
