#!/usr/bin/env node
/**
 * Mutation proof for the PUBLISH-LANE SUPPLY-CHAIN GUARD (#2044, v2 task R8).
 *
 * `tests/publish-lane-supply-chain.test.ts` claims that every workflow job that
 * publishes to npm transitively `needs` the npm-audit gate and the SBOM job, and
 * that it finds lanes by SCANNING (a newly added one is covered) and fails
 * closed on a workflow it cannot read. A guard that stays green when its subject
 * is removed is decoration, so each mutation below removes or loosens one piece
 * of that protection and REQUIRES the spec to go red.
 *
 * Four classes, all graded on the spec's EXIT CODE (never on its output — a grep
 * over coloured test output once certified fourteen decorative mutations red):
 *
 *   1. the real `release.yml` loses a gate (audit need dropped, SBOM upload
 *      dropped, audit softened, `always()` on the lane);
 *   2. a NEW workflow appears with a publish lane and neither gate (one per
 *      discovery path), or a workflow the scan cannot read appears;
 *   3. the engine itself is weakened (transitivity, status-bypass, discovery of
 *      `changesets/action`, the unparseable-file branch) — proves the fixture
 *      tests, not just the real-tree test, have teeth;
 *   4. controls that must stay GREEN: dropping only the DIRECT audit need (the
 *      transitive path still gates), a comment edit, and a harmless new workflow.
 *      Without them every red above is equally explained by a harness that can
 *      only see red.
 *
 * Anchors are asserted to occur exactly once by scripts/lib/mutation-harness.mjs
 * (it refuses otherwise), the snapshot restores byte-identically, and every
 * mutation carries the residue marker. Injected files (class 2) are written by
 * this script alone, refused if they already exist, and removed in `finally`.
 *
 * Usage:  node scripts/mutation-prove-publish-lane-supply-chain.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const WORKFLOW = resolve(WORKFLOW_DIR, 'release.yml');
const ENGINE = resolve(REPO_ROOT, 'tests/helpers/publish-lane-supply-chain.ts');
const SPEC = 'tests/publish-lane-supply-chain.test.ts';

/**
 * The files mutated, keyed by the `subject` each mutation names. Spelled as a
 * `subjects:` map so `tests/mutation-prover-lane.test.ts` can resolve every
 * anchor below against its file at PR time.
 */
const LANE = { subjects: { workflow: WORKFLOW, engine: ENGINE } };

const DIRECT_NEEDS =
  '    needs: [publish-lane-guard, audit, version-pr, publish-preflight, ga-tarball-diff, pack]\n';
const VERSION_PR_NEEDS = '    needs: [publish-lane-guard, audit]\n';
const RELEASE_IF =
  "    if: >-\n      github.repository == 'getknext-dev/knext'\n" +
  "      && needs.version-pr.outputs.has_changesets == 'false'\n" +
  "      && needs.publish-preflight.outputs.should_publish == 'true'\n";
const AUDIT_RUN = '        run: node scripts/audit-published.mjs\n';

const NEW_LANE = (publishStep) =>
  `# ${MUTATION_MARKER}\nname: mutation-injected publish lane\non: workflow_dispatch\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n${publishStep}`;

const MUTATIONS = [
  // ── 1. the real release.yml loses a gate ────────────────────────────────
  {
    id: 'M1',
    claim:
      'the audit need is dropped EVERYWHERE (release direct + version-pr), so no path reaches it',
    subject: 'workflow',
    anchor: DIRECT_NEEDS,
    replacement:
      '    needs: [publish-lane-guard, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    expect: 'red',
  },
  {
    id: 'M1',
    claim: '(second edit of M1: version-pr stops needing the audit too)',
    subject: 'workflow',
    anchor: VERSION_PR_NEEDS,
    replacement: '    needs: [publish-lane-guard]\n',
    expect: 'red',
  },
  {
    id: 'M2',
    claim: 'the SBOM is no longer uploaded (the job keeps running the audit script)',
    subject: 'workflow',
    anchor: '          path: sbom/*.cdx.json\n',
    replacement: '          path: sbom/*.txt\n',
    expect: 'red',
  },
  {
    id: 'M3',
    claim: 'the audit step is softened with continue-on-error',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: `        continue-on-error: true\n${AUDIT_RUN}`,
    expect: 'red',
  },
  {
    id: 'M4',
    claim: "the credentialed `release` job's if: gains always(), so it starts after a FAILED audit",
    subject: 'workflow',
    anchor: RELEASE_IF,
    replacement: RELEASE_IF.replace('    if: >-\n', '    if: >-\n      always()\n      && '),
    expect: 'red',
  },
  {
    id: 'M5',
    claim: 'the audit job no longer runs scripts/audit-published.mjs at all',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: '        run: echo skipped-the-audit\n',
    expect: 'red',
  },
  {
    id: 'M6',
    claim: 'the audit invocation is followed by `|| true`',
    subject: 'workflow',
    anchor: AUDIT_RUN,
    replacement: `${AUDIT_RUN.trimEnd()} || true\n`,
    expect: 'red',
  },

  // ── 2. a workflow the scan has never seen ───────────────────────────────
  {
    id: 'M7',
    claim: 'a NEW workflow adds an `npm publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-npm-publish.yml',
      content: NEW_LANE('      - run: npm publish --access public\n'),
    },
    expect: 'red',
  },
  {
    id: 'M8',
    claim: 'a NEW workflow adds a `changeset publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-changeset-publish.yml',
      content: NEW_LANE('      - run: bunx changeset publish\n'),
    },
    expect: 'red',
  },
  {
    id: 'M9',
    claim: 'a NEW workflow adds a `pnpm publish` lane with neither gate',
    inject: {
      name: 'zz-mutation-new-pnpm-publish.yml',
      content: NEW_LANE('      - run: pnpm publish --no-git-checks\n'),
    },
    expect: 'red',
  },
  {
    id: 'M10',
    claim: 'a NEW workflow publishes through a changesets/action `publish-script` input',
    inject: {
      name: 'zz-mutation-new-changesets-action.yml',
      content: NEW_LANE(
        '      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2\n        with:\n          publish-script: bun run release\n',
      ),
    },
    expect: 'red',
  },
  {
    id: 'M11',
    claim: 'a workflow file that does not parse is injected (fail closed)',
    inject: {
      name: 'zz-mutation-unparseable.yml',
      content: `# ${MUTATION_MARKER}\njobs: [unclosed\n  - : :\n`,
    },
    expect: 'red',
  },
  {
    id: 'M12',
    claim: 'a workflow entry that cannot be read (a directory named *.yml) is injected',
    inject: { name: 'zz-mutation-unreadable.yml', directory: true },
    expect: 'red',
  },

  // ── 3. the engine is weakened ───────────────────────────────────────────
  {
    id: 'M13',
    claim: 'the `needs` closure stops being transitive',
    subject: 'engine',
    anchor: '        stack.push(dep);\n',
    replacement: '        void dep;\n',
    expect: 'red',
  },
  {
    id: 'M14',
    claim: 'a status-bypassing `if` (always()/failure()/cancelled()) no longer severs an edge',
    subject: 'engine',
    anchor:
      "    if (STATUS_BYPASS.test(String(job.if ?? ''))) continue; // starts after a FAILED need\n",
    replacement: "    if (STATUS_BYPASS.test('')) continue;\n",
    expect: 'red',
  },
  {
    id: 'M15',
    claim: 'discovery stops recognising a changesets/action publish input',
    subject: 'engine',
    anchor: '    if (/^changesets\\/action(@|$)/.test(uses)) {\n',
    replacement: '    if (/^changesets-disabled\\/action(@|$)/.test(uses)) {\n',
    expect: 'red',
  },
  {
    id: 'M16',
    claim: 'an unparseable workflow is skipped silently instead of failing the guard',
    subject: 'engine',
    anchor:
      "      problems.push(`${file}: cannot be read/parsed (${String(err).split('\\n')[0]})`);\n",
    replacement: '      void err;\n',
    expect: 'red',
  },
  {
    id: 'M17',
    claim: 'a softened audit step (continue-on-error / `||`) still counts as a gate',
    subject: 'engine',
    anchor:
      "        neutralised ??= jobSoftened ? 'job has continue-on-error' : stepNeutralisation(step);\n",
    replacement: '        void jobSoftened;\n',
    expect: 'red',
  },
  {
    id: 'M18',
    claim: '`.yaml` workflow files are no longer scanned',
    subject: 'engine',
    anchor: ".filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))\n",
    replacement: ".filter((f) => f.endsWith('.yml'))\n",
    expect: 'red',
  },

  // ── 4. controls: these must stay GREEN ──────────────────────────────────
  {
    id: 'NEG1',
    claim:
      'NEGATIVE CONTROL: only the DIRECT audit need is dropped (still reached via version-pr) — must stay GREEN',
    subject: 'workflow',
    anchor: DIRECT_NEEDS,
    replacement:
      '    needs: [publish-lane-guard, version-pr, publish-preflight, ga-tarball-diff, pack]\n',
    expect: 'green',
  },
  {
    id: 'NEG2',
    claim:
      'NEGATIVE CONTROL: a doc-comment sentence in the audit job is reworded — must stay GREEN',
    subject: 'workflow',
    anchor: '  # npm/JS supply-chain gate (v4-P3). The image Trivy gate scans containers; this\n',
    replacement:
      '  # npm/JS supply-chain gate (v4-P3). The image Trivy gate scans containers, while this\n',
    expect: 'green',
  },
  {
    id: 'NEG3',
    claim: 'NEGATIVE CONTROL: a NEW workflow with no publish at all — must stay GREEN',
    inject: {
      name: 'zz-mutation-harmless.yml',
      content: NEW_LANE('      - run: echo nothing is published here\n'),
    },
    expect: 'green',
  },
];

/**
 * A mutation is one or more table rows sharing an `id` (M1 must cut two `needs`
 * edges before the audit becomes unreachable). The rows stay flat, one anchor
 * each, so tests/mutation-prover-lane.test.ts can resolve every anchor.
 */
const CASES = new Map();
for (const row of MUTATIONS) CASES.set(row.id, [...(CASES.get(row.id) ?? []), row]);

declareMutations(CASES.size);

/** The spec's exit code — the only signal graded. */
function specExit() {
  const runner = resolveSpecRunner(REPO_ROOT, SPEC);
  const result = spawnSync(process.execPath, [...runner.args, ...runner.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

/** Run `fn` with the injected workflow present, and remove it no matter what. */
function withInjected(inject, fn) {
  const target = resolve(WORKFLOW_DIR, inject.name);
  if (existsSync(target)) {
    console.error(`FATAL: ${target} already exists — refusing to overwrite or later delete it`);
    process.exit(1);
  }
  try {
    if (inject.directory) mkdirSync(target);
    else writeFileSync(target, inject.content, 'utf8');
    return fn();
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Apply every edit to one file, run the spec, and restore the bytes in `finally`. */
function withEdits(file, rows, fn) {
  const snap = snapshot(file);
  try {
    for (const { anchor, replacement } of rows) mutate(snap, anchor, replacement);
    return fn();
  } finally {
    restore(snap);
  }
}

const baseline = specExit();
console.log(`Baseline ${SPEC}: exit=${baseline}`);
if (baseline !== 0) {
  console.error(`FATAL: ${SPEC} is not green before anything is mutated`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
for (const rows of CASES.values()) {
  const m = rows[0];
  let code;
  if (m.inject) {
    code = withInjected(m.inject, specExit);
  } else {
    const file = LANE.subjects[m.subject];
    if (file === undefined) {
      console.error(`FATAL: ${m.id} names an unknown subject ${JSON.stringify(m.subject)}`);
      process.exit(1);
    }
    code = withEdits(file, rows, specExit);
  }
  const red = code !== 0;
  const ok = m.expect === 'red' ? red : !red;
  console.log(`${m.id} ${ok ? 'ok  ' : 'FAIL'} exit=${code} (expected ${m.expect}) — ${m.claim}`);
  if (ok) pass += 1;
  else fail += 1;
  recordMutation();
  const after = specExit();
  if (after !== 0) {
    console.error(`FATAL: ${SPEC} exit=${after} after restoring ${m.id}`);
    process.exit(1);
  }
}

console.log(`\n${pass} of ${CASES.size} graded as expected, ${fail} not.`);
process.exit(fail === 0 ? 0 : 1);
