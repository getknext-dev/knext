#!/usr/bin/env node

/**
 * Mutation proof for the ref-pinned per-case ledger (ADR-0007 amendment 2026-11-04):
 * `tests/compat-ref-pinned-cases.test.ts`, the carve-out in `tests/deploy-manifest.test.ts`,
 * and the derived-count check in `apps/docs/content-hygiene.test.ts`.
 *
 * WHAT THIS PROVES
 *   Every bar the amendment claims is a bar a spec can see go missing. Each mutation removes
 *   ONE behaviour (or plants one bad datum) and the specs must exit non-zero. Exit codes only,
 *   never output: an output grep once certified fourteen decorative mutations all-green.
 *   Every anchor must occur EXACTLY ONCE or the harness refuses; restoration is by content hash.
 *
 *   Code mutations (the guard is removed):
 *     ref pin ignored / pin widened / "reaudited" escape / run at another ref / snapshot at
 *     another ref / stale title / stale describe / missing citation / anchor unchecked / category
 *     unchecked / unmeasured cell claim / failure count unchecked / file cap off / case cap off /
 *     caps raised / suites.failed drift both ways / unledgered failed list / file also excluded /
 *     duplicate file / no runs / unreachable API passes / drift ignored / two refs allowed.
 *   Data mutations (a bad datum is planted in the real manifest):
 *     pin moved / title renamed / anchor wrong / cited line absent / unmeasured cell / reaudited /
 *     unledgered failed list / suites name drift.
 *
 * Usage:  node scripts/mutation-prove-compat-ref-pinned-cases.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF_SPEC = 'tests/compat-ref-pinned-cases.test.ts';
const MANIFEST_SPEC = 'tests/deploy-manifest.test.ts';
const DOCS_SPEC = 'apps/docs/content-hygiene.test.ts';
const SCOPE_SPEC = 'tests/compat-manifest-for-ref.test.ts';
const VERIFY_WF_SPEC = 'tests/compat-ref-pinned-cases-verify-workflow.test.ts';
const SCOPE = resolve(REPO_ROOT, 'scripts/compat-manifest-for-ref.mjs');
const WF_E2E = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const WF_VINEXT = resolve(REPO_ROOT, '.github/workflows/compat-vinext.yml');
const WF_V13 = resolve(REPO_ROOT, '.github/workflows/compat-credential-v1.3.yml');
const WF_VERIFY = resolve(REPO_ROOT, '.github/workflows/compat-ref-pinned-cases-verify.yml');
const LIB = resolve(REPO_ROOT, 'scripts/lib/ref-pinned-cases.mjs');
const SNAP = resolve(REPO_ROOT, 'scripts/compat-ref-pinned-cases-snapshot.mjs');
const MANIFEST = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');
const DOCS = resolve(REPO_ROOT, 'apps/docs/content/docs/compat-suite.mdx');
const ADR = resolve(REPO_ROOT, 'docs/adr/0007-compat-suite.md');

declareMutations(52);

const RUNNER = resolveSpecRunner(REPO_ROOT, REF_SPEC);

/** Exit code of the given specs run together: 0 = all green. */
function specsExit(specs) {
  return spawnSync(RUNNER.command, [...RUNNER.args, ...specs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).status;
}

let pass = 0;
let fail = 0;

function prove(label, target, anchor, replacement, { specs = [REF_SPEC], commentPrefix } = {}) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(target);
  try {
    mutate(snap, anchor, replacement, { commentPrefix });
    const code = specsExit(specs);
    if (code === 0) {
      console.log('   x DECORATION: the specs stayed GREEN (exit 0) with the behaviour removed');
      fail += 1;
    } else {
      console.log(`   ok went RED as required (exit ${code})`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (specsExit(specs) !== 0) {
    console.error(`   FATAL: ${specs.join(' ')} did not go green again after restore`);
    process.exit(1);
  }
}

const ALL_SPECS = [REF_SPEC, MANIFEST_SPEC, DOCS_SPEC, SCOPE_SPEC, VERIFY_WF_SPEC];
console.log('Baseline: every spec must be GREEN (exit 0) before anything is mutated.');
if (specsExit(ALL_SPECS) !== 0) {
  console.error('FATAL: the specs are not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

// Canary: a spec that cannot see red proves nothing.
{
  const snap = snapshot(LIB);
  try {
    mutate(
      snap,
      'export const REF_SHAPE = /^v\\d+\\.\\d+\\.\\d+$/;',
      'export const REF_SHAPE = /^nope$/;',
    );
    if (specsExit([REF_SPEC]) === 0) {
      console.error('FATAL: canary mutation stayed green — the harness cannot see red');
      process.exit(1);
    }
    console.log('   ok canary went red\n');
  } finally {
    restore(snap);
  }
  if (specsExit([REF_SPEC]) !== 0) {
    console.error('FATAL: spec not green after the canary restore');
    process.exit(1);
  }
}

// ── bar 1: the ref pin ──────────────────────────────────────────────────────
prove(
  'the ref pin is ignored',
  LIB,
  '} else if (!refPinAdmissible(e.nextjsRef, laneRefs, shippedRef)) {',
  '} else if (false) {',
);
prove(
  'the pin stays admissible after the default moves past the shipped pin',
  LIB,
  'return ref === shippedRef && laneRefs.every((lane) => numericRefCompare(shippedRef, lane) > 0);',
  'return ref === shippedRef;',
);
prove('a "reaudited" escape is allowed', LIB, "if ('reaudited' in e) {", 'if (false) {');
prove('a run at another ref is accepted', LIB, 'if (r?.ref !== e.nextjsRef) {', 'if (false) {');
prove(
  'a snapshot at another ref is accepted',
  LIB,
  'if (snapshot.ref !== e.nextjsRef) {',
  'if (false) {',
);

// ── bar 2: exact names that still exist ─────────────────────────────────────
prove(
  'a stale case title is accepted',
  LIB,
  'if (!literals.some((l) => literalProduces(l, c.title))) {',
  'if (false) {',
);
prove(
  'a stale describe element is accepted',
  LIB,
  'if (!literals.some((l) => literalProduces(l, p))) {',
  'if (false) {',
);
prove(
  'a ledgered name missing from suites.failed is accepted',
  LIB,
  'if (!failed.includes(n))',
  'if (false)',
);
prove('an extra suites.failed name is accepted', LIB, 'if (!want.includes(n))', 'if (false)');
prove(
  'an unledgered suites.failed list is accepted',
  LIB,
  'if ((s.failed ?? []).length > 0 && !ledgerFiles.has(file)) {',
  'if (false) {',
);
prove(
  'a per-case file that is also file-excluded is accepted',
  LIB,
  'if (rulesExclude?.includes(e.test)) {',
  'if (false) {',
);
prove(
  'two entries for one file are accepted',
  LIB,
  'if (seenFiles.has(e.test)) errs.push(',
  'if (false) errs.push(',
);

// ── bar 3: citation and mechanism ───────────────────────────────────────────
prove(
  'a missing citation is accepted',
  LIB,
  'if (cites.length === 0) errs.push(',
  'if (false) errs.push(',
);
prove(
  'a citation anchor that is not on the line is accepted',
  LIB,
  '} else if (!text.includes(cite.anchor)) {',
  '} else if (false) {',
);
prove(
  'a mechanism category outside the closed set is accepted',
  LIB,
  'if (!MECHANISM_CATEGORIES.includes(e.mechanismCategory)) {',
  'if (false) {',
);

// ── bar 4: run IDs and measured cells ───────────────────────────────────────
prove(
  'an entry with no runs is accepted',
  LIB,
  'if (runs.length === 0) errs.push(',
  'if (false) errs.push(',
);
prove(
  'a case claiming an UNMEASURED cell is accepted',
  LIB,
  'if (!measuredCells.has(cell)) {',
  'if (false) {',
);
prove(
  'claims that do not match the measured failure count are accepted',
  LIB,
  'if (m && Number.isInteger(m.failed) && (claimed[cell] ?? 0) !== m.failed) {',
  'if (false) {',
);

// ── bar 5: the cap ──────────────────────────────────────────────────────────
prove(
  'the file cap is not enforced',
  LIB,
  'if (seenFiles.size > REF_PINNED_FILE_CAP) {',
  'if (false) {',
);
prove(
  'the case cap is not enforced',
  LIB,
  'if (caseTotal > REF_PINNED_CASE_CAP) {',
  'if (false) {',
);
prove(
  'the file cap is raised',
  LIB,
  'export const REF_PINNED_FILE_CAP = 10;',
  'export const REF_PINNED_FILE_CAP = 30;',
);
prove(
  'the case cap is raised',
  LIB,
  'export const REF_PINNED_CASE_CAP = 20;',
  'export const REF_PINNED_CASE_CAP = 60;',
);

// ── the snapshot tool ───────────────────────────────────────────────────────
prove(
  'an unreachable upstream passes',
  SNAP,
  'if (res.status !== 200) throw new Error(',
  'if (false) throw new Error(',
);
prove(
  'upstream drift is ignored',
  SNAP,
  'else if (JSON.stringify(a) !== JSON.stringify(b))',
  'else if (false)',
);
prove('a ledger pinned at two refs is accepted', SNAP, 'if (refs.length !== 1) {', 'if (false) {');

// ── data mutations against the REAL manifest ────────────────────────────────
const TPF =
  '"test": "test/e2e/transpile-packages-typescript-foreign/index.test.ts",\n      "nextjsRef": "v16.4.3",';
prove(
  'DATA: an entry is pinned at a different ref',
  MANIFEST,
  TPF,
  '"test": "test/e2e/transpile-packages-typescript-foreign/index.test.ts",\n      "nextjsRef": "v16.4.0",',
);
prove(
  'DATA: a case title no longer exists upstream',
  MANIFEST,
  '"title": "should fail",',
  '"title": "should fail renamed",',
);
prove(
  'DATA: a citation anchor is not on its line',
  MANIFEST,
  '"anchor": "vercel.json uses pnpm so file: dependencies are installed inside node_modules."',
  '"anchor": "text that is not on that line"',
);
prove('DATA: a cited line is not in the snapshot', MANIFEST, '"line": 3,', '"line": 4,');
prove(
  'DATA: a case claims a cell nobody measured',
  MANIFEST,
  '"title": "should render /blog/first correctly",\n          "cells": ["bun-webpack"]',
  '"title": "should render /blog/first correctly",\n          "cells": ["bun-webpack", "node-webpack"]',
);
prove(
  'DATA: a "reaudited" stamp is added to an entry',
  MANIFEST,
  '"mechanismCategory": "harness-package-manager",',
  '"mechanismCategory": "harness-package-manager",\n      "reaudited": "v16.4.3",',
);
prove(
  'DATA: a suites.failed name drifts from the ledger',
  MANIFEST,
  '"transpile-packages-typescript-foreign without transpilePackages should fail"',
  '"transpile-packages-typescript-foreign without transpilePackages should fail quietly"',
);
prove(
  'DATA: an unledgered deterministic failed list is planted',
  MANIFEST,
  '"test/e2e/edge-async-local-storage/index.test.ts": {',
  '"test/e2e/edge-async-local-storage/index.test.ts": {\n      "failed": ["injected deterministic case"],',
  { specs: [REF_SPEC, MANIFEST_SPEC] },
);

// ── the carve-out in the deploy-manifest spec, proved on its own ────────────
// The ledger validator is also muted here, so only tests/deploy-manifest.test.ts can see the
// planted list. Two files are mutated together, so this block drives the harness by hand.
{
  console.log('── mutation: the deploy-manifest guard alone must catch an unledgered failed list');
  const libSnap = snapshot(LIB);
  const manSnap = snapshot(MANIFEST);
  try {
    mutate(libSnap, 'if ((s.failed ?? []).length > 0 && !ledgerFiles.has(file)) {', 'if (false) {');
    mutate(
      manSnap,
      '"test/e2e/edge-async-local-storage/index.test.ts": {',
      '"test/e2e/edge-async-local-storage/index.test.ts": {\n      "failed": ["injected deterministic case"],',
    );
    const code = specsExit([MANIFEST_SPEC]);
    if (code === 0) {
      console.log('   x DECORATION: tests/deploy-manifest.test.ts stayed GREEN');
      fail += 1;
    } else {
      console.log(`   ok went RED as required (exit ${code})`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(libSnap);
    restore(manSnap);
  }
  if (specsExit([REF_SPEC, MANIFEST_SPEC]) !== 0) {
    console.error('   FATAL: specs did not go green again after restore');
    process.exit(1);
  }
}

// ── docs and the ADR ────────────────────────────────────────────────────────
prove(
  'DOCS: the page states a wrong per-case count',
  DOCS,
  'currently holds 9 files (19 test cases)',
  'currently holds 12 files (40 test cases)',
  { specs: [DOCS_SPEC], commentPrefix: '<!--' },
);
prove(
  'DOCS: the page claims a cap other than the real one',
  DOCS,
  'hard ceiling of 10 files and 20 cases',
  'hard ceiling of 50 files and 90 cases',
  { specs: [DOCS_SPEC], commentPrefix: '<!--' },
);
prove(
  'ADR: the amendment drops what the runner does with a listed case',
  ADR,
  'is **silent** at the',
  'is noticed at the',
);
prove(
  'ADR: the amendment states a different cap',
  ADR,
  '**10 files and 20 cases**',
  '**12 files and 30 cases**',
);

// ── review round 2: run-time scoping, --verify, and the v1.3 lane ───────────
// Stale ref still deselecting: the filter keeps every entry whatever the ref.
prove(
  'RUN TIME: a ledgered entry measured at another ref still deselects',
  SCOPE,
  'if (e.nextjsRef === ref) {',
  'if (true) {',
  {
    specs: [SCOPE_SPEC],
  },
);
// Missing / unparseable ref: the filter no longer refuses.
prove(
  'RUN TIME: a missing or unparseable NEXTJS_REF no longer fails the filter',
  SCOPE,
  "if (typeof ref !== 'string' || !SCOPE_REF_SHAPE.test(ref)) {",
  'if (false) {',
  { specs: [SCOPE_SPEC] },
);
prove(
  'RUN TIME: an entry with no parseable ref no longer fails the filter',
  SCOPE,
  "if (typeof e.nextjsRef !== 'string' || !REF_SHAPE.test(e.nextjsRef)) {",
  'if (false) {',
  { specs: [SCOPE_SPEC] },
);
prove(
  'RUN TIME: a failed filter leaves a stale copy behind',
  SCOPE,
  'rmSync(outPath, { force: true });',
  'void 0;',
  { specs: [SCOPE_SPEC] },
);
const RAW_FILTER = 'NEXT_EXTERNAL_TESTS_FILTERS: ${{ runner.temp }}/knext-deploy-manifest.json';
prove(
  'WIRING: test-e2e-deploy.yml hands the harness the RAW manifest again',
  WF_E2E,
  RAW_FILTER,
  'NEXT_EXTERNAL_TESTS_FILTERS: ${{ github.workspace }}/knext/test/${{ env.KNEXT_DEPLOY_MANIFEST }}',
  { specs: [SCOPE_SPEC] },
);
prove(
  'WIRING: compat-vinext.yml hands the harness the RAW manifest again',
  WF_VINEXT,
  RAW_FILTER,
  'NEXT_EXTERNAL_TESTS_FILTERS: ${{ github.workspace }}/knext/test/deploy-tests-manifest.knext.json',
  { specs: [SCOPE_SPEC] },
);
prove(
  'WIRING: a checkout with the ledger but no script no longer fails closed (e2e)',
  WF_E2E,
  `elif grep -Eq '"[$]knextRefPinnedCases"[[:space:]]*:' "\${SCOPE_SOURCE_MANIFEST}"; then`,
  'elif false; then',
  { specs: [SCOPE_SPEC] },
);
prove(
  'WIRING: a checkout with the ledger but no script no longer fails closed (vinext)',
  WF_VINEXT,
  `elif grep -Eq '"[$]knextRefPinnedCases"[[:space:]]*:' "\${SCOPE_SOURCE_MANIFEST}"; then`,
  'elif false; then',
  { specs: [SCOPE_SPEC] },
);
// v1.3 bump: the lane that runs 16.4.3 moves, the entries must go red.
prove(
  'BAR 1: the v1.3 credential lane is bumped to another ref',
  WF_V13,
  "NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.4.3' }}",
  "NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.4.4' }}",
);
prove(
  'BAR 1: the v1.3 workflow is dropped from the lanes bar 1 reads',
  LIB,
  "  '.github/workflows/compat-credential-v1.3.yml',\n",
  '',
);
// --verify
prove(
  '--verify: a difference between snapshot and upstream no longer fails',
  SNAP,
  'if (drift.length > 0) return',
  'if (false) return',
);
prove(
  '--verify: an unreachable upstream no longer fails',
  SNAP,
  'return { code: 1, lines: [`cannot build the upstream snapshot: ${err.message}`] };',
  'return { code: 0, lines: [`cannot build the upstream snapshot: ${err.message}`] };',
);
prove(
  'VERIFY WORKFLOW: --verify exit is swallowed',
  WF_VERIFY,
  'run: node scripts/compat-ref-pinned-cases-snapshot.mjs --verify',
  'run: node scripts/compat-ref-pinned-cases-snapshot.mjs --verify || true',
  { specs: [VERIFY_WF_SPEC] },
);
prove(
  'VERIFY WORKFLOW: it no longer runs on a ledger change',
  WF_VERIFY,
  "      - 'test/deploy-tests-manifest.knext.json'\n",
  '',
  { specs: [VERIFY_WF_SPEC] },
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
