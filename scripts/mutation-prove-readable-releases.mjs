#!/usr/bin/env node
/**
 * Mutation proof for the ONE-READABLE-RELEASE-PER-VERSION flow (#2153).
 *
 * Three specs claim the flow works and cannot be quietly undone:
 *   - tests/release-notes-body.test.ts          the release body + latest/prerelease decision
 *   - tests/release-github-release-workflow.test.ts   per-package releases are OFF; the notes
 *     job holds `contents: write` only, never sees the npm credential, runs only after a
 *     successful publish; the credentialed job refuses to publish without notes
 *   - tests/operator-release-notes-body.test.ts the operator release body and its wiring
 *
 * A guard that stays green when its subject is removed is decoration, so each mutation
 * removes or loosens one piece and REQUIRES the named spec to go red. Graded on the
 * spec's EXIT CODE only. The negative control (a comment edit) must stay GREEN, or
 * every red is equally explained by a harness that can only see red.
 *
 * Restoration is from a BYTE SNAPSHOT (scripts/lib/mutation-harness.mjs); the harness
 * refuses an anchor that does not occur exactly once.
 *
 * Usage:  node scripts/mutation-prove-readable-releases.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BODY_SPEC = 'tests/release-notes-body.test.ts';
const WORKFLOW_SPEC = 'tests/release-github-release-workflow.test.ts';
const OPERATOR_SPEC = 'tests/operator-release-notes-body.test.ts';

const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/release.yml');
const OPERATOR_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');
const BODY = resolve(REPO_ROOT, 'scripts/release-notes-body.mjs');
const OPERATOR_BODY = resolve(REPO_ROOT, 'scripts/operator-release-notes-body.mjs');

/** `subjects:` as a map of consts so tests/mutation-prover-lane.test.ts can resolve each anchor. */
const LANE = {
  subjects: {
    workflow: WORKFLOW,
    operatorWorkflow: OPERATOR_WORKFLOW,
    body: BODY,
    operatorBody: OPERATOR_BODY,
  },
};

const PUBLISH_FLAG =
  '          # `changeset publish` still pushes the `@getknext/<pkg>@X` git tags.\n' +
  '          create-github-releases: false\n';
const VERSION_FLAG =
  '          # the one readable release after a successful publish.\n' +
  '          create-github-releases: false\n';
const NOTES_PERMS =
  '    permissions:\n      contents: write\n    concurrency:\n      group: github-release-${{ github.ref }}\n';
const NOTES_IF =
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n      && needs.release.result == 'success'\n";
const RELEASE_NEEDS =
  '    needs: [publish-lane-guard, audit, version-pr, publish-preflight, ga-tarball-diff, pack]\n';
const NOTES_SETUP_NODE =
  '      - name: Setup Node.js\n' +
  '        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n' +
  "        with:\n          node-version: '24'\n\n" +
  '      # No install step: scripts/release-notes-body.mjs reaches only node:\n';
const NOTES_GH_ENV =
  '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          TAG: ${{ steps.notes.outputs.tag }}\n';

const MUTATIONS = [
  // ── per-package releases off ──────────────────────────────────────────────
  {
    id: 'W1',
    claim: 'the publish step creates per-package GitHub releases again',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: PUBLISH_FLAG,
    replacement: PUBLISH_FLAG.replace('false', 'true'),
    expect: 'red',
  },
  {
    id: 'W2',
    claim: 'the version-pr step creates per-package GitHub releases',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: VERSION_FLAG,
    replacement: VERSION_FLAG.replace('false', 'true'),
    expect: 'red',
  },
  {
    id: 'W3',
    claim: 'the publish step drops the input, falling back to the action default (true)',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: PUBLISH_FLAG,
    replacement: '          # `changeset publish` still pushes the `@getknext/<pkg>@X` git tags.\n',
    expect: 'red',
  },
  // ── the notes job's privilege ─────────────────────────────────────────────
  {
    id: 'W4',
    claim: 'the notes job gains pull-requests: write',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_PERMS,
    replacement: NOTES_PERMS.replace(
      '      contents: write\n',
      '      contents: write\n      pull-requests: write\n',
    ),
    expect: 'red',
  },
  {
    id: 'W5',
    claim: 'the notes job gains id-token: write',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_PERMS,
    replacement: NOTES_PERMS.replace(
      '      contents: write\n',
      '      contents: write\n      id-token: write\n',
    ),
    expect: 'red',
  },
  {
    id: 'W6',
    claim: 'the notes job is handed the npm credential',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_GH_ENV,
    replacement: `${NOTES_GH_ENV}          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
    expect: 'red',
  },
  {
    id: 'W7',
    claim: 'the notes job runs in the npm-publish environment',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_PERMS,
    replacement: `    environment: npm-publish\n${NOTES_PERMS}`,
    expect: 'red',
  },
  {
    id: 'W8',
    claim: 'the notes job uses a third-party action instead of gh',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_SETUP_NODE,
    replacement: NOTES_SETUP_NODE.replace(
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
      'softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64 # v3.0.3',
    ),
    expect: 'red',
  },
  // ── when the notes job runs ───────────────────────────────────────────────
  {
    id: 'W9',
    claim: 'the notes job no longer needs the release (publish) job',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: '    needs: [publish-lane-guard, release]\n',
    replacement: '    needs: [publish-lane-guard]\n',
    expect: 'red',
  },
  {
    id: 'W10',
    claim: 'the notes job gains always(), so it starts after a FAILED publish',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: NOTES_IF,
    replacement: NOTES_IF.replace('    if: >-\n', '    if: >-\n      always()\n      && '),
    expect: 'red',
  },
  {
    id: 'W11',
    claim: 'the notes job checks out without tags, so the highest-stable decision is blind',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: '          fetch-tags: true\n          persist-credentials: false\n',
    replacement: '          persist-credentials: false\n',
    expect: 'red',
  },
  // ── the credentialed job keeps its gates and refuses to publish without notes
  {
    id: 'W12',
    claim: 'the credentialed release job loses the audit edge',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: RELEASE_NEEDS,
    replacement: RELEASE_NEEDS.replace(' audit,', ''),
    expect: 'red',
  },
  {
    id: 'W13',
    claim: 'the pre-publish notes check is neutered',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: '        run: node scripts/release-notes-body.mjs --check\n',
    replacement: '        run: echo "notes not checked"\n',
    expect: 'red',
  },
  // ── the body script ───────────────────────────────────────────────────────
  {
    id: 'B1',
    claim: 'a higher stable tag no longer stops a version being latest',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: '    .some((m) => compareSemver(m[1], version) > 0);\n',
    replacement: '    .some(() => false);\n',
    expect: 'red',
  },
  {
    id: 'B2',
    claim: 'a prerelease is marked latest',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: '  if (prerelease) return { prerelease: true, latest: false };\n',
    replacement: '  if (prerelease) return { prerelease: true, latest: true };\n',
    expect: 'red',
  },
  {
    id: 'B3',
    claim: 'versions are compared lexically (1.9.0 > 1.10.0)',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: '    if (pa[i] !== pb[i]) return pa[i] - pb[i];\n',
    replacement: '    if (pa[i] !== pb[i]) return String(pa[i]) < String(pb[i]) ? -1 : 1;\n',
    expect: 'red',
  },
  {
    id: 'B4',
    claim: 'a missing notes file no longer fails with the clear message',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: '  if (!existsSync(full)) {\n',
    replacement: '  if (false) {\n',
    expect: 'red',
  },
  {
    id: 'B5',
    claim: 'an empty notes file is accepted',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: "  if (notes.trim() === '')",
    replacement: '  if (false)',
    expect: 'red',
  },
  {
    id: 'B6',
    claim: 'the Packages table loses the db row',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: "  { name: '@getknext/db', dir: 'packages/db' },\n",
    replacement: '',
    expect: 'red',
  },
  {
    id: 'B7',
    claim: 'the version is no longer validated as semver (it becomes a path and a URL)',
    subject: 'body',
    spec: BODY_SPEC,
    anchor: "  if (typeof version !== 'string' || !SEMVER.test(version)) {\n",
    replacement: '  if (false) {\n',
    expect: 'red',
  },
  // ── operator release ──────────────────────────────────────────────────────
  {
    id: 'O1',
    claim: 'a bundle with no digest-pinned operator image is accepted',
    subject: 'operatorBody',
    spec: OPERATOR_SPEC,
    anchor: '  if (images.size === 0) {\n',
    replacement: '  if (false) {\n',
    expect: 'red',
  },
  {
    id: 'O2',
    claim: 'the CRD API version takes the first served version, not the storage version',
    subject: 'operatorBody',
    spec: OPERATOR_SPEC,
    anchor: '  const chosen = versions.find((v) => v.storage) ?? versions[0];\n',
    replacement: '  const chosen = versions[0];\n',
    expect: 'red',
  },
  {
    id: 'O3',
    claim: 'the upgrade-order line is dropped from the body',
    subject: 'operatorBody',
    spec: OPERATOR_SPEC,
    anchor: '**Upgrade order:** upgrade the operator and CRD first, then the CLI.',
    replacement: 'Upgrade whenever.',
    expect: 'red',
  },
  {
    id: 'O4',
    claim: 'the workflow stops handing the generated body to the release step',
    subject: 'operatorWorkflow',
    spec: OPERATOR_SPEC,
    anchor: '          body_path: ${{ steps.release_body.outputs.path }}\n',
    replacement: '',
    expect: 'red',
  },
  {
    id: 'O5',
    claim: 'the body step also runs for the rolling operator-edge release',
    subject: 'operatorWorkflow',
    spec: OPERATOR_SPEC,
    anchor:
      " && steps.trivy.outcome == 'success' && steps.channel.outputs.is_version_tag == 'true'\n        env:\n          RELEASE_TAG:",
    replacement: " && steps.trivy.outcome == 'success'\n        env:\n          RELEASE_TAG:",
    expect: 'red',
  },
  // ── tag placement (round 2) ───────────────────────────────────────────────
  {
    id: 'T1',
    claim: 'the release is created without --target, so the tag lands on the default branch tip',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: 'gh release create "${TAG}" --target "${GITHUB_SHA}" "${args[@]}"\n',
    replacement: 'gh release create "${TAG}" "${args[@]}"\n',
    expect: 'red',
  },
  {
    id: 'T2',
    claim: 'the notes job force-moves the tag after creating the release',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: 'gh release create "${TAG}" --target "${GITHUB_SHA}" "${args[@]}"\n',
    replacement:
      'gh release create "${TAG}" --target "${GITHUB_SHA}" "${args[@]}"\n            git push --force origin "${TAG}"\n',
    expect: 'red',
  },
  {
    id: 'O6',
    claim: 'the operator-latest step takes the Latest badge from the knext release',
    subject: 'operatorWorkflow',
    spec: 'tests/operator-semver-release-workflow.test.ts',
    anchor: '          name: kn-next-operator (latest)\n          make_latest: "false"\n',
    replacement: '          name: kn-next-operator (latest)\n          make_latest: "true"\n',
    expect: 'red',
  },
  {
    id: 'NEG',
    claim: 'NEGATIVE CONTROL: a comment sentence is reworded (must stay GREEN)',
    subject: 'workflow',
    spec: WORKFLOW_SPEC,
    anchor: '      # No install step: scripts/release-notes-body.mjs reaches only node:\n',
    replacement: '      # No install step: scripts/release-notes-body.mjs only reaches node:\n',
    expect: 'green',
  },
];

declareMutations(MUTATIONS.length);

/** The spec's exit code — the only signal graded. */
function specExit(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const result = spawnSync(process.execPath, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

for (const spec of [BODY_SPEC, WORKFLOW_SPEC, OPERATOR_SPEC]) {
  const code = specExit(spec);
  console.log(`Baseline ${spec}: exit=${code}`);
  if (code !== 0) {
    console.error(`FATAL: ${spec} is not green before anything is mutated`);
    process.exit(1);
  }
}

let pass = 0;
let fail = 0;
for (const m of MUTATIONS) {
  const file = LANE.subjects[m.subject];
  if (file === undefined) {
    console.error(`FATAL: ${m.id} names an unknown subject ${JSON.stringify(m.subject)}`);
    process.exit(1);
  }
  const snap = snapshot(file);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = specExit(m.spec);
  } finally {
    restore(snap);
  }
  const red = code !== 0;
  const ok = m.expect === 'red' ? red : !red;
  console.log(
    `${m.id} ${ok ? 'ok  ' : 'FAIL'} exit=${code} (expected ${m.expect}) — ${m.claim} [${m.spec}]`,
  );
  if (ok) pass += 1;
  else fail += 1;
  recordMutation();
  const after = specExit(m.spec);
  if (after !== 0) {
    console.error(`FATAL: ${m.spec} exit=${after} after restoring ${m.id}`);
    process.exit(1);
  }
}

console.log(`\n${pass} of ${MUTATIONS.length} graded as expected, ${fail} not.`);
process.exit(fail === 0 ? 0 : 1);
