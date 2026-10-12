#!/usr/bin/env node
/**
 * Mutation proof for the upstream-runtime-defect ledger guards
 * (`tests/deploy-manifest-upstream-runtime-defects.test.ts`, ADR-0007 amendment
 * 2026-10-12).
 *
 * Each row REMOVES one behaviour a guard protects — in the manifest data or in the
 * validator source — and requires the spec to go RED. A guard that stays green is
 * decoration. Shared harness for the reasons this repo has paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise (a
 *     silently failed substitution would certify a decorative guard green);
 *   * `restore` re-asserts the bytes and the anchors; a failure to go green again
 *     after restore is FATAL;
 *   * every verdict is an EXIT CODE, never grepped output;
 *   * the baseline must be green first, and the first mutation (a plain emptied
 *     removal condition) proves the harness can SEE red at all.
 *
 * Usage:  node scripts/mutation-prove-upstream-runtime-defects.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/deploy-manifest-upstream-runtime-defects.test.ts';
const FILES = {
  main: 'test/deploy-tests-manifest.knext.json',
  smoke: 'test/deploy-tests-manifest.smoke.knext.json',
  module: 'tests/compat-upstream-runtime-defects.ts',
};
const CHUNK =
  'test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts';
const MW = 'test/e2e/app-dir/treeshake-mw/mw.test.ts';
const KEY = '"$knextUpstreamRuntimeDefects"';

/** The exact text of one ledger entry, so an edit to it is anchored uniquely. */
function entryBlock(text, testPath) {
  const head = `    {\n      "test": "${testPath}",\n      "lane"`;
  const at = text.indexOf(head);
  if (at === -1 || text.indexOf(head, at + 1) !== -1) {
    throw new Error(`entry block for ${testPath} is not unique`);
  }
  const end = text.indexOf('\n    }', at);
  return text.slice(at, end + '\n    }'.length);
}

const mainText = () => readFileSync(resolve(REPO_ROOT, FILES.main), 'utf8');

/** A row that edits one field of one ledger entry. */
function entryEdit(label, testPath, edit) {
  return {
    label,
    subject: 'main',
    build: () => {
      const block = entryBlock(mainText(), testPath);
      const out = edit(block);
      if (out === block) throw new Error(`edit changed nothing: ${label}`);
      return { anchor: block, replacement: out };
    },
  };
}

const textRow = (label, subject, anchor, replacement) => ({
  label,
  subject,
  build: () => ({ anchor, replacement }),
});

const MUTATIONS = [
  // Data: the entry's own fields.
  entryEdit('entry: removal condition emptied', CHUNK, (b) =>
    b.replace(/"removeWhen": "[^\n]*",/, '"removeWhen": "",'),
  ),
  entryEdit('entry: removal condition whitespace only', MW, (b) =>
    b.replace(/"removeWhen": "[^\n]*",/, '"removeWhen": "  ",'),
  ),
  entryEdit('entry: lane field deleted', CHUNK, (b) =>
    b.replace('      "lane": "bun/turbopack",\n', ''),
  ),
  entryEdit('entry: lane widened to a whole runtime ("bun")', MW, (b) =>
    b.replace('"lane": "bun/turbopack"', '"lane": "bun"'),
  ),
  entryEdit('entry: upstream fix emptied', CHUNK, (b) =>
    b.replace('"fix": "oven-sh/bun#45010"', '"fix": ""'),
  ),
  entryEdit('entry: upstream issue points at a getknext-dev repo', MW, (b) =>
    b.replace('"issue": "oven-sh/bun#45007"', '"issue": "getknext-dev/knext#2225"'),
  ),
  entryEdit('entry: knext build-time refusal emptied', CHUNK, (b) =>
    b.replace(/"knextRefusal": "[^\n]*",/, '"knextRefusal": "",'),
  ),
  entryEdit('entry: evidence cites no CI run', MW, (b) =>
    b.replace(/"evidence": "[^\n]*",/, '"evidence": "it failed once locally",'),
  ),
  entryEdit('entry: knext refusal is free text naming no file', MW, (b) =>
    b.replace(/"knextRefusal": "[^\n]*",/, '"knextRefusal": "x",'),
  ),
  entryEdit('entry: knext refusal names a path that does not exist', CHUNK, (b) =>
    b.replace(
      'packages/kn-next/src/cli/turbopack-fragments-guard.ts#',
      'packages/kn-next/src/cli/no-such-guard.ts#',
    ),
  ),
  entryEdit('entry: knext refusal names a symbol absent from the guard file', MW, (b) =>
    b.replace('#assertNoBunTurbopackFragments', '#assertNoSuchSymbolAnywhere'),
  ),
  entryEdit('entry: removal condition is a placeholder ("TBD")', CHUNK, (b) =>
    b.replace(/"removeWhen": "[^\n]*",/, '"removeWhen": "TBD",'),
  ),
  entryEdit(
    "entry: removal condition waits for a different upstream fix than the entry's own",
    MW,
    (b) => b.replace(/("removeWhen": "[^"\n]*)oven-sh\/bun#45010/, '$1oven-sh/bun#99999'),
  ),
  entryEdit('entry: test path is a glob, not one file', CHUNK, (b) =>
    b.replace(
      `"test": "${CHUNK}"`,
      '"test": "test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/*.test.ts"',
    ),
  ),
  // Data: the file must keep running and must not be a §h quarantine.
  textRow(
    'the file is added to rules.exclude (it would stop running on every lane)',
    'main',
    '      "test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts",\n',
    `      "test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts",\n      "${MW}",\n`,
  ),
  textRow(
    'the file is added to $knextQuarantines (it would count toward §h)',
    'main',
    '"$knextQuarantines": [\n',
    `"$knextQuarantines": [\n    { "test": "${CHUNK}" },\n`,
  ),
  textRow(
    'the smoke manifest loses the ledger',
    'smoke',
    KEY,
    '"$knextUpstreamRuntimeDefectsGone"',
  ),
  // Data: the category's own cap (six entries against a cap of five).
  {
    label: 'ledger grows to six entries (over its own cap)',
    subject: 'main',
    build: () => {
      const block = entryBlock(mainText(), CHUNK);
      const extra = [1, 2, 3, 4]
        .map((i) => block.replace(CHUNK, `test/e2e/app-dir/zz${i}/zz${i}.test.ts`))
        .join(',\n');
      return { anchor: block, replacement: `${block},\n${extra}` };
    },
  },
  // Source: the validator itself.
  textRow(
    'validator: the removal-condition check is removed',
    'module',
    'if (!nonEmpty(e.removeWhen)) {',
    'if (false) {',
  ),
  textRow(
    'validator: the lane check is removed',
    'module',
    'if (!nonEmpty(e.lane) || !LANE_PATTERN.test(e.lane)) {',
    'if (false) {',
  ),
  textRow(
    'validator: the upstream-fix check is removed',
    'module',
    "if (!e.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.fix ?? '')) {",
    'if (false) {',
  ),
  textRow(
    'validator: the knext-refusal check is removed',
    'module',
    'if (!nonEmpty(e.knextRefusal)) {',
    'if (false) {',
  ),
  textRow(
    'validator: the evidence-run check is removed',
    'module',
    'if (!nonEmpty(e.evidence) || !/\\brun \\d{8,}\\b/.test(e.evidence)) {',
    'if (false) {',
  ),
  textRow(
    'validator: the cap check is removed',
    'module',
    'if (entries.length > UPSTREAM_RUNTIME_DEFECT_CAP) {',
    'if (false) {',
  ),
  textRow(
    'validator: the cap is raised',
    'module',
    'UPSTREAM_RUNTIME_DEFECT_CAP = 5;',
    'UPSTREAM_RUNTIME_DEFECT_CAP = 50;',
  ),
  textRow(
    'validator: the duplicate check is removed',
    'module',
    'if (seen.has(key)) out.push(',
    'if (false) out.push(',
  ),
  textRow(
    'validator: the concrete-test-path check is removed',
    'module',
    'if (!nonEmpty(e.test) || !CONCRETE_TEST_PATH.test(e.test)) {',
    'if (!nonEmpty(e.test)) {',
  ),
  textRow(
    'validator: the removal-condition-references-own-fix check is removed',
    'module',
    '} else if (nonEmpty(e.upstream?.fix) && !e.removeWhen.includes(e.upstream.fix)) {',
    '} else if (false) {',
  ),
  textRow(
    'validator: the real-guard (path exists) check is removed',
    'module',
    '} else if (!namesRealGuard(e.knextRefusal, ctx)) {',
    '} else if (false) {',
  ),
  textRow(
    'validator: the guard-symbol-present check is removed',
    'module',
    'if (ctx.read(path)?.includes(symbol)) return true;',
    'return true;',
  ),
  // Source: fail-closed on unreadable input (an injected read error reads as no ledger).
  textRow(
    'parser: unreadable JSON reads as an empty ledger (fails OPEN)',
    'module',
    '    throw new Error(\n      `upstream-runtime-defect ledger: manifest is not readable JSON (${(err as Error).message})`,\n    );',
    '    return [];',
  ),
  textRow(
    'parser: a missing ledger key reads as an empty ledger (fails OPEN)',
    'module',
    '  if (!Array.isArray(list)) {\n    throw new Error(\n      `upstream-runtime-defect ledger: manifest has no ${UPSTREAM_RUNTIME_DEFECT_KEY} array`,\n    );\n  }',
    '  if (!Array.isArray(list)) {\n    return [];\n  }',
  ),
];

declareMutations(MUTATIONS.length);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
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
  const snap = snapshot(resolve(REPO_ROOT, FILES[m.subject]));
  try {
    const { anchor, replacement } = m.build();
    mutate(snap, anchor, replacement, m.subject === 'module' ? { commentPrefix: '//' } : {});
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
