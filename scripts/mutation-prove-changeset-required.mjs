#!/usr/bin/env node
/**
 * Mutation proof for the changeset-required guard (#1615).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each mutation below removes one piece of the
 * detection or one of the exclusion/escape rules and REQUIRES
 * `changeset-required.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT CODE
 * only, baseline green first, a canary that must go red, anchors that must
 * occur exactly once, byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-changeset-required.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/changeset-required.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the dist->src convention is dropped — a `files: ["dist"]` package would watch the ' +
      'UNCOMMITTED dist/ output instead of src/, so real source edits stop counting and a stray ' +
      'dist/ diff (which cannot happen in a PR) would',
    subject: 'guard',
    anchor: "const watchDir = entry === 'dist' ? `${dir}/src/` : `${dir}/${entry}/`;",
    replacement: 'const watchDir = `${dir}/${entry}/`;',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      "a fixed-group package's package.json is no longer watched at all — a bin/exports/files " +
      'change with no src/templates edit would silently require nothing',
    subject: 'guard',
    anchor: '    roots.push({ name: manifest.name, dir, manifestPath: `${dir}/package.json` });',
    replacement: '    // manifest root intentionally dropped',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the markdown exclusion is removed from isTestOrDocsOnly — a docs-only .md edit under a ' +
      'watched root would wrongly require a changeset',
    subject: 'guard',
    anchor: '  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path) || MARKDOWN_RE.test(path);',
    replacement: '  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path);',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the __tests__-directory exclusion is removed — a test FIXTURE whose own filename does not ' +
      'match *.test.*/*.spec.* would wrongly require a changeset',
    subject: 'guard',
    anchor: '  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path) || MARKDOWN_RE.test(path);',
    replacement: '  return TEST_FILE_RE.test(path) || MARKDOWN_RE.test(path);',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      "the .changeset/README.md exclusion is dropped from hasChangesetEntry — the tool's own " +
      'README would be mistaken for a real changeset entry, letting a PR satisfy the check by ' +
      'accident',
    subject: 'guard',
    anchor: '/^\\.changeset\\/(?!README\\.md$)[^/]+\\.md$/',
    replacement: '/^\\.changeset\\/[^/]+\\.md$/',
  },
  {
    id: 'M6',
    expect: 'red',
    claim:
      'the no-changeset label match stops trimming/lowercasing — a label applied with different ' +
      'case or stray whitespace (both of which GitHub allows) would no longer be recognised',
    subject: 'guard',
    anchor: '  return (labels ?? []).some((l) => l.trim().toLowerCase() === NO_CHANGESET_LABEL);',
    replacement: '  return (labels ?? []).some((l) => l === NO_CHANGESET_LABEL);',
  },
  {
    id: 'M7',
    expect: 'red',
    claim:
      'a package.json PUBLIC-surface change (bin/exports/files) no longer counts as touching the ' +
      'package when no src/templates file changed alongside it',
    subject: 'guard',
    anchor:
      '  for (const [name, changed] of Object.entries(manifestChanged ?? {})) {\n' +
      '    if (changed) hit.add(name);\n' +
      '  }',
    replacement: '  void manifestChanged;',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'the changeset-present branch of decide() is removed — a PR that DOES carry a ' +
      '.changeset/*.md would still be reported as failing',
    subject: 'guard',
    anchor: "  if (hasChangeset) return { required: true, ok: true, via: 'changeset', packages };",
    replacement: '  // changeset branch intentionally dropped',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    guard: 'scripts/check-changeset-required.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (changeset-required guard, #1615) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'guard',
  anchor: "export const NO_CHANGESET_LABEL = 'no-changeset';",
  replacement: "export const NO_CHANGESET_LABEL = 'no-changeset-canary';",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
