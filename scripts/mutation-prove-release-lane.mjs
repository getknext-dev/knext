#!/usr/bin/env node
/**
 * Mutation proof for the RELEASE-LANE LIVENESS guards.
 *
 * `tests/release-lane-liveness.test.ts` claims that `release.yml` can no longer
 * starve itself the way it did between 2026-07-26 and 2026-08-25 — one parked,
 * un-approved run holding a workflow-level concurrency group while 99 later runs
 * were cancelled in the queue with zero jobs each.
 *
 * A guard that stays green when its subject is removed is decoration. So each
 * mutation below RESTORES one piece of the original defect — the workflow-level
 * group, the shared group, the environment on the version lane, the credential
 * on the version lane, a publish job that starts before it knows it has work —
 * and REQUIRES the spec to go red.
 *
 * The preflight's own decision logic gets the same treatment against
 * `tests/publish-preflight.test.ts`, because a wrong "nothing to publish" SKIPS
 * the publish job, and a skipped job reports nothing at all.
 *
 * Restoration is from a BYTE SNAPSHOT via scripts/lib/mutation-harness.mjs, and
 * every mutation carries the residue marker, so a stall between mutate and
 * restore is findable by `scripts/scan-mutation-residue.mjs` rather than by luck.
 *
 * Usage:  node scripts/mutation-prove-release-lane.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/release.yml');
const PREFLIGHT = resolve(REPO_ROOT, 'scripts/publish-preflight.mjs');
const MANIFEST = resolve(REPO_ROOT, 'package.json');
const LOCKFILE = resolve(REPO_ROOT, 'pnpm-lock.yaml');
const LIVENESS_SPEC = 'tests/release-lane-liveness.test.ts';
const PREFLIGHT_SPEC = 'tests/publish-preflight.test.ts';
const PINS_SPEC = 'tests/release-action-pins.test.ts';
const COMPAT_SPEC = 'tests/changesets-cli-action-compat.test.ts';

/**
 * The mutations below are inline `prove()` calls rather than a list, so this is
 * a literal. The lane compares declared against run in BOTH directions, so an
 * extra `prove()` that does not bump this reddens rather than passing quietly.
 */
declareMutations(22);

let pass = 0;
let fail = 0;

/**
 * `pnpm exec vitest` resolves NOTHING in a tree without its own `node_modules`
 * — a git worktree, a fresh clone before install — and this prover was written
 * in exactly such a worktree.
 */
const RUNNER = resolveTestRunner(REPO_ROOT);

function vitest(spec) {
  return (
    spawnSync(RUNNER.command, [...RUNNER.args, 'run', spec], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).status === 0
  );
}

/** The spec must be RED while the defect is restored, and GREEN once undone. */
function prove(label, file, spec, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (vitest(spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the defect restored');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!vitest(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

/**
 * Anchors for mutations 19-22 are DERIVED from the current file contents rather
 * than typed as literals.
 *
 * Every one of them addresses a value Dependabot moves — the action's pinned SHA
 * and version comment, the `@changesets/cli` caret range, the lockfile's
 * resolution of it. A hardcoded anchor would FATAL on the next correct bump, and
 * "the prover is broken again, edit the anchor" is how a prover decays into
 * something people route around. Deriving them means the proof follows its
 * subject.
 *
 * Not-found is a FAILURE, never a skip: if the shape these read is gone, the
 * mutations below would silently stop proving anything.
 */
function derive(label, text, pattern) {
  const match = pattern.exec(text);
  if (match === null) {
    console.error(`FATAL: could not derive the anchor for ${label} — ${pattern}`);
    process.exit(1);
  }
  return match;
}

const MANIFEST_TEXT = readFileSync(MANIFEST, 'utf8');
const LOCK_TEXT = readFileSync(LOCKFILE, 'utf8');
const WORKFLOW_TEXT = readFileSync(WORKFLOW, 'utf8');

/** e.g. `"@changesets/cli": "^3.0.1"` -> range `^3.0.1`, major `3`. */
const CLI_DECL = derive(
  'the @changesets/cli declaration',
  MANIFEST_TEXT,
  /"@changesets\/cli": "\^(\d+)\.(\d+)\.(\d+)"/,
);
const CLI_MAJOR = Number(CLI_DECL[1]);
/** A DIFFERENT major, whichever way the tree currently points. */
const WRONG_CLI_MAJOR = CLI_MAJOR === 2 ? 3 : 2;

/** The version-pr job's pin line — `id: changesets` makes it uniquely addressable. */
const VERSION_PIN = derive(
  "the version-pr job's changesets/action pin",
  WORKFLOW_TEXT,
  /( {8}id: changesets\n {8}uses: changesets\/action@[0-9a-f]{40} # v)(\d+)(\.\d+\.\d+)/,
);
const PIN_MAJOR = Number(VERSION_PIN[2]);
const WRONG_PIN_MAJOR = PIN_MAJOR === 1 ? 2 : 1;

/**
 * The ROOT importer's resolution. Anchored on the package name AND the
 * `specifier:` key — `specifier:` appears only under `importers:`, and the name
 * alone recurs in `packages:`/`snapshots:`. The trailing peer suffix
 * (`(@types/node@…)`) is deliberately left out of the capture so the anchor is a
 * substring that survives a peer-resolution change.
 */
const LOCK_ENTRY = derive(
  "the lockfile's root-importer resolution of @changesets/cli",
  LOCK_TEXT,
  /( {6}'@changesets\/cli':\n {8}specifier: \^\d+\.\d+\.\d+\n {8}version: )(\d+)(\.\d+\.\d+)/,
);

for (const spec of [LIVENESS_SPEC, PREFLIGHT_SPEC, PINS_SPEC, COMPAT_SPEC]) {
  console.log(`Baseline: ${spec} must be GREEN before anything is mutated.`);
  if (!vitest(spec)) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baselines green\n');

// ── The concurrency half ─────────────────────────────────────────────────────

// 1. THE ORIGINAL DEFECT, restored verbatim: a workflow-level group that a
//    parked run holds forever.
prove(
  'the workflow-level concurrency group comes back',
  WORKFLOW,
  LIVENESS_SPEC,
  '\npermissions:\n  contents: write\n',
  '\nconcurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false\n\npermissions:\n  contents: write\n',
);

// 2. The subtler version: two job-level groups, but the SAME one — a parked
//    publish queues the version lane behind it exactly as before.
prove(
  'the version and publish jobs share one group',
  WORKFLOW,
  LIVENESS_SPEC,
  '      group: release-version-${{ github.ref }}\n',
  '      group: release-publish-${{ github.ref }}\n',
);

// 3. A group that is not ref-scoped, so one branch queues another.
prove(
  'the publish group stops being ref-scoped',
  WORKFLOW,
  LIVENESS_SPEC,
  '      group: release-publish-${{ github.ref }}\n',
  '      group: release-publish\n',
);

// 4. `cancel-in-progress: true` — the obvious wrong fix for a queue, and one
//    that would cancel a half-finished `changeset publish`.
prove(
  'the publish group starts cancelling in progress',
  WORKFLOW,
  LIVENESS_SPEC,
  '      # Its own group, so a publish waiting on the required reviewer serialises\n      # only other publishes. Never cancels: a half-finished `changeset publish`\n      # is worse than a queue.\n      group: release-publish-${{ github.ref }}\n      cancel-in-progress: false\n',
  '      group: release-publish-${{ github.ref }}\n      cancel-in-progress: true\n',
);

// ── The version-lane half ────────────────────────────────────────────────────

// 5. The version lane goes back behind the human approval — the single change
//    that re-creates the month-long outage on its own.
prove(
  'the version job declares the npm-publish environment again',
  WORKFLOW,
  LIVENESS_SPEC,
  '    name: Version PR (no credential, no approval)\n    runs-on: ubuntu-latest\n',
  '    name: Version PR (no credential, no approval)\n    runs-on: ubuntu-latest\n    environment: npm-publish\n',
);

// 6. The publish credential spreads to the lane that runs WITHOUT approval.
//    This must red the pins guard too — that guard's whole subject is which job
//    holds the token.
prove(
  'the version job is handed NODE_AUTH_TOKEN',
  WORKFLOW,
  LIVENESS_SPEC,
  '        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n\n  # Decide whether',
  '        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n\n  # Decide whether',
);

// 7. Same defect, graded by the OTHER guard. Round one proved this mutation
//    only against the liveness spec, which left the pins guard's claim — "only
//    one job may pair the action with the token" — unproved.
prove(
  'the version job is handed NODE_AUTH_TOKEN (graded by the pins guard)',
  WORKFLOW,
  PINS_SPEC,
  '        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n\n  # Decide whether',
  '        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n\n  # Decide whether',
);

// 8. Defence in depth removed: the un-approved lane gains a publish command.
prove(
  'the version job gains a publish-script',
  WORKFLOW,
  LIVENESS_SPEC,
  '          create-github-releases: false\n',
  '          create-github-releases: false\n          publish-script: pnpm run release\n',
);

// ── The "decide before you start" half ───────────────────────────────────────

// 9. Drop the registry half of the gate. `has_changesets == false` alone is
//    true of every ordinary commit to main, so the publish job would request an
//    approval on each one — and each un-clicked request parks a run.
prove(
  'the publish job stops checking whether anything is unpublished',
  WORKFLOW,
  LIVENESS_SPEC,
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n      && needs.version-pr.outputs.has_changesets == 'false'\n      && needs.publish-preflight.outputs.should_publish == 'true'\n",
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n      && needs.version-pr.outputs.has_changesets == 'false'\n",
);

// 10. Drop the changesets half. The publish job would then fire on the very
//     push that opened the Version PR, publishing the PRE-bump versions.
prove(
  'the publish job stops checking for pending changesets',
  WORKFLOW,
  LIVENESS_SPEC,
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n      && needs.version-pr.outputs.has_changesets == 'false'\n      && needs.publish-preflight.outputs.should_publish == 'true'\n",
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n      && needs.publish-preflight.outputs.should_publish == 'true'\n",
);

// ── The preflight's own decision ─────────────────────────────────────────────

// 11. The fail-closed probe becomes a fallthrough: an unreachable registry
//     would answer the question instead of refusing to.
prove(
  'the unreachable-registry probe stops throwing',
  PREFLIGHT,
  PREFLIGHT_SPEC,
  '  if (!viewSucceeds(REACHABILITY_PROBE)) {',
  '  if (false) {',
);

// 12. THE SILENT FAILURE. `decide` always says "nothing to publish". The
//     publish job is then SKIPPED on every push — not failed, skipped — and
//     nothing anywhere reports it. This is the mutation whose absence from CI
//     would be hardest to notice, which is why it is here.
prove(
  'the decision always says nothing-to-publish',
  PREFLIGHT,
  PREFLIGHT_SPEC,
  '  return { shouldPublish: rows.some((row) => !row.published), rows };',
  '  return { shouldPublish: false, rows };',
);

// 13. The publishable set stops excluding private/ignored packages, so the
//     gate would ask the registry about `@getknext/ui` and answer "publish"
//     forever off a package that never publishes.
prove(
  'the publishable set stops filtering private and ignored packages',
  PREFLIGHT,
  PREFLIGHT_SPEC,
  "  return manifests.filter((m) => !m.private && !ignored.has(m.name) && m.version !== '');",
  "  return manifests.filter((m) => m.version !== '');",
);

// ── The wiring between the jobs ──────────────────────────────────────────────
//
// Mutations 14-18 were added in round two. Review of #849 found that all five
// defects below left `release-lane-liveness`, `release-action-pins`,
// `publish-preflight` and `ci-concurrency-group` ALL GREEN — each is a one-token
// edit that re-creates the month-long outage with no signal anywhere. They are
// the OUTPUT-side twin of the `with:`-input class that #750 covers: GitHub
// resolves an unknown `steps.*.outputs.*` to `''` rather than failing, and `''`
// satisfies neither `== 'false'` nor `== 'true'`, so the lane just stops.

// 14. The version job reads changesets/action's V1 output name. `has_changesets`
//     is then '', `publish-preflight` is skipped, `release` is skipped.
//     Dependabot moves this pin, and #831 already took a v1->v2 bump without the
//     matching key migration once.
prove(
  'the version job reads the v1 output name `hasChangesets`',
  WORKFLOW,
  LIVENESS_SPEC,
  "      has_changesets: ${{ steps.changesets.outputs['has-changesets'] }}\n",
  "      has_changesets: ${{ steps.changesets.outputs['hasChangesets'] }}\n",
);

// 15. Same defect one job down: the preflight's own output key. `should_publish`
//     is then '', and `release`'s `if:` is false on every push forever.
prove(
  'the preflight job reads an output key its script never emits',
  WORKFLOW,
  LIVENESS_SPEC,
  "      should_publish: ${{ steps.preflight.outputs['should-publish'] }}\n",
  "      should_publish: ${{ steps.preflight.outputs['shouldPublish'] }}\n",
);

// 16. The other end of that same wire. Mutating the WORKFLOW proves the guard
//     reads the workflow; mutating the SCRIPT proves it is a drift check between
//     two files rather than a literal asserted against itself.
prove(
  'the preflight script renames the key it emits',
  PREFLIGHT,
  LIVENESS_SPEC,
  "  emit('should-publish', shouldPublish ? 'true' : 'false');\n",
  "  emit('shouldPublish', shouldPublish ? 'true' : 'false');\n",
);

// 17. THE POLARITY FLIP. One token. Preflight then runs only on pushes that
//     still HAVE pending changesets — never on the push that merges the Version
//     PR, which is the only push that can publish. Nothing ever ships, and the
//     board stays green because a skipped job reports nothing.
prove(
  "the preflight's own gate polarity is flipped to 'true'",
  WORKFLOW,
  LIVENESS_SPEC,
  "    if: github.repository == 'getknext-dev/knext' && needs.version-pr.outputs.has_changesets == 'false'\n",
  "    if: github.repository == 'getknext-dev/knext' && needs.version-pr.outputs.has_changesets == 'true'\n",
);

// 18. The other half of 17: the condition is asserted, so the EDGE it reads must
//     be asserted too. Without `needs: version-pr` the `if:` above evaluates
//     against a value that is never set — the same '' , the same silent skip.
prove(
  'the preflight drops the `needs` edge whose output its `if:` reads',
  WORKFLOW,
  LIVENESS_SPEC,
  '    needs: version-pr\n',
  '    # needs edge removed\n',
);

// ── The action-major / CLI-major contract ────────────────────────────────────
//
// Mutations 19-22 were added with `tests/changesets-cli-action-compat.test.ts`,
// after the FIRST live release run in a month (32850202919, 2026-08-25) failed
// its Version-PR job on:
//
//   "This version of the Changesets action is designed to work with Changesets
//    CLI v3. Changesets CLI v2 is not supported…"
//
// The action had been bumped v1 -> v2 while `package.json` still said
// `"@changesets/cli": "^2.31.0"`. Every guard in this file stayed GREEN, because
// the mismatch is a relation BETWEEN the workflow and the root manifest and is
// only reachable on a push to `main`. Each mutation below restores one half of
// that mismatch, and each is graded against the compat spec ALONE.

// 19. THE DEFECT, restored: the CLI major goes back to the one the pinned action
//     refuses. This is literally what main shipped on 2026-08-25.
//
//     `.json` has no comment syntax, so the harness cannot mark the mutation for
//     us — the replacement carries the marker itself, as a JSON-legal `//` key.
//     The marker is interpolated, never typed: `scan-mutation-residue.mjs`
//     refuses any TRACKED file containing the literal, and this file is tracked.
prove(
  `the @changesets/cli major goes back to ${WRONG_CLI_MAJOR}`,
  MANIFEST,
  COMPAT_SPEC,
  `"@changesets/cli": "^${CLI_MAJOR}`,
  `"//${MUTATION_MARKER}": "mutation in progress", "@changesets/cli": "^${WRONG_CLI_MAJOR}`,
);

// 20. The other end of the same contract: the ACTION major moves and the CLI
//     does not. Mutating the manifest proves the guard reads the manifest;
//     mutating the workflow proves it is a DRIFT check between two files rather
//     than a literal asserted against itself. Only the version-pr pin moves, so
//     this also grades the "one and the same major in every job" half — the two
//     steps read the same repository, so they cannot legitimately disagree.
prove(
  `the version-pr job's changesets/action pin claims v${WRONG_PIN_MAJOR}`,
  WORKFLOW,
  COMPAT_SPEC,
  `${VERSION_PIN[1]}${PIN_MAJOR}${VERSION_PIN[3]}`,
  `${VERSION_PIN[1]}${WRONG_PIN_MAJOR}${VERSION_PIN[3]}`,
);

// 21. MANIFEST BUMPED, LOCKFILE NOT. `validateChangesetsCliVersion` reads the
//     declared range AND `require.resolve`s the installed package, and CI runs
//     `pnpm install --frozen-lockfile` — so the lockfile, not the manifest,
//     decides what is on disk. A manifest-only assertion would call this green
//     and the live run would still fail with the identical error.
prove(
  'the lockfile still resolves the old @changesets/cli major',
  LOCKFILE,
  COMPAT_SPEC,
  `${LOCK_ENTRY[1]}${LOCK_ENTRY[2]}${LOCK_ENTRY[3]}`,
  `${LOCK_ENTRY[1]}${WRONG_CLI_MAJOR}${LOCK_ENTRY[3]}`,
);

// 22. The renamed-input class (#750) folded into the same spec, because it is
//     the same bump. `validateChangesetsCliVersion` runs BEFORE
//     `throwOnRenamedInputs`, so while the CLI major is wrong the input check
//     can never fire — fix one and the lane is still broken, with a different
//     error. GitHub Actions ignores unknown `with:` keys rather than failing, so
//     nothing else would ever say so.
prove(
  'the v1 input name `version` comes back under a v2 action',
  WORKFLOW,
  COMPAT_SPEC,
  '          version-script: pnpm run changeset:version\n',
  '          version: pnpm run changeset:version\n',
);

console.log(`\n${pass} mutation(s) went red as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
