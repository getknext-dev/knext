#!/usr/bin/env node

/**
 * Mutation proof for the upstream-runtime-defect ledger (ADR-0007 amendment 2026-11-05):
 * `tests/compat-upstream-runtime-defects.test.ts`, its run-time half in
 * `tests/compat-manifest-for-ref.test.ts`, the snapshot coverage in
 * `tests/compat-ref-pinned-cases.test.ts`, and the derived counts in
 * `apps/docs/content-hygiene.test.ts`.
 *
 * WHAT THIS PROVES
 *   Every rule the amendment claims is a rule a spec can see go missing. Each mutation removes ONE
 *   behaviour (or plants one bad datum) and the specs must exit non-zero. Exit codes only, never
 *   output. Every anchor must occur EXACTLY ONCE or the harness refuses; restoration is by content
 *   hash, and the specs must be green again after every restore.
 *
 * Usage:  node scripts/mutation-prove-upstream-runtime-defects.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-upstream-runtime-defects.test.ts';
const SCOPE_SPEC = 'tests/compat-manifest-for-ref.test.ts';
const REF_SPEC = 'tests/compat-ref-pinned-cases.test.ts';
const DOCS_SPEC = 'apps/docs/content-hygiene.test.ts';
const LIB = resolve(REPO_ROOT, 'scripts/lib/upstream-runtime-defects.mjs');
const SCOPE = resolve(REPO_ROOT, 'scripts/compat-manifest-for-ref.mjs');
const SNAP = resolve(REPO_ROOT, 'scripts/compat-ref-pinned-cases-snapshot.mjs');
const MANIFEST = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');
const DOCS = resolve(REPO_ROOT, 'apps/docs/content/docs/compat-suite.mdx');
const WF_E2E = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

declareMutations(71);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** Exit code of the given specs run together: 0 = all green. */
function specsExit(specs) {
  return spawnSync(RUNNER.command, [...RUNNER.args, ...specs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).status;
}

let pass = 0;
let fail = 0;

function prove(label, target, anchor, replacement, { specs = [SPEC], commentPrefix, mark } = {}) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(target);
  try {
    mutate(snap, anchor, replacement, { commentPrefix, mark });
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

/**
 * One mutation made of several edits, possibly across files (each anchor exactly once at the time
 * it is applied). Every touched file is restored by content hash, whatever happens.
 */
function proveMulti(label, edits, { specs = [SPEC] } = {}) {
  console.log(`── mutation: ${label}`);
  const snaps = new Map();
  try {
    for (const [target, anchor, replacement, opts = {}] of edits) {
      if (!snaps.has(target)) snaps.set(target, snapshot(target));
      mutate(snaps.get(target), anchor, replacement, opts);
    }
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
    for (const snap of snaps.values()) restore(snap);
  }
  if (specsExit(specs) !== 0) {
    console.error(`   FATAL: ${specs.join(' ')} did not go green again after restore`);
    process.exit(1);
  }
}

const ALL_SPECS = [SPEC, SCOPE_SPEC, REF_SPEC, DOCS_SPEC];
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
      "export const UPSTREAM_RUNTIME_DEFECT_KEY = '$knextUpstreamRuntimeDefects';",
      "export const UPSTREAM_RUNTIME_DEFECT_KEY = '$nope';",
    );
    if (specsExit([SPEC]) === 0) {
      console.error('FATAL: canary mutation stayed green — the harness cannot see red');
      process.exit(1);
    }
    console.log('   ok canary went red\n');
  } finally {
    restore(snap);
  }
}

// ── PR time: entry rules ───────────────────────────────────────────────────────────────────────
prove('a glob test path is accepted', LIB, '!CONCRETE_TEST_PATH.test(e.test) ||', 'false ||');
prove(
  'a dot segment in the test path is accepted',
  LIB,
  "e.test.split('/').some((seg) => seg === '..' || seg === '.')",
  'false',
);
prove(
  'any lane string is accepted',
  LIB,
  'if (!nonEmpty(e?.lane) || !LANE_PATTERN.test(e.lane)) {',
  'if (false) {',
);
prove(
  'the lane pattern admits a runtime-wide lane',
  LIB,
  'export const LANE_PATTERN = /^(node|bun)\\/(turbopack|webpack)$/;',
  'export const LANE_PATTERN = /^(node|bun)(\\/.*)?$/;',
);
prove(
  'the ref pin is ignored',
  LIB,
  '} else if (!refPinAdmissible(e.nextjsRef, laneRefs ?? [], shippedRef)) {',
  '} else if (false) {',
);
prove('a "reaudited" escape is allowed', LIB, 'if (e?.reaudited !== undefined) {', 'if (false) {');
prove(
  'a bun entry with no bunVersion is accepted',
  LIB,
  'if (!nonEmpty(e.bunVersion) || !BUN_VERSION_SHAPE.test(e.bunVersion)) {',
  'if (false) {',
);
prove(
  'a Bun the lane no longer pins is accepted (the bump does not red)',
  LIB,
  '} else if (e.bunVersion !== laneBun) {',
  '} else if (false) {',
);
prove(
  'an in-house or free-text upstream issue is accepted',
  LIB,
  "if (!e?.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.issue ?? '')) {",
  'if (false) {',
);
prove(
  'a free-text upstream fix is accepted',
  LIB,
  "if (!e?.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.fix ?? '')) {",
  'if (false) {',
);
prove(
  'the upstream pattern admits getknext-dev',
  LIB,
  'export const UPSTREAM_REF_PATTERN = /^(?!getknext-dev\\/)[\\w.-]+\\/[\\w.-]+#\\d+$/;',
  'export const UPSTREAM_REF_PATTERN = /^[\\w.-]+\\/[\\w.-]+#\\d+$/;',
);
prove(
  'an empty removal condition is accepted',
  LIB,
  'if (!nonEmpty(e?.removeWhen)) {',
  'if (false) {',
);
prove(
  'a removal condition that does not name the fix is accepted',
  LIB,
  '} else if (nonEmpty(e.upstream?.fix) && !e.removeWhen.includes(e.upstream.fix)) {',
  '} else if (false) {',
);
prove('an empty refusal is accepted', LIB, 'if (!nonEmpty(e?.knextRefusal)) {', 'if (false) {');
prove(
  'a refusal naming no real file is accepted',
  LIB,
  '} else if (!namesRealGuard(e.knextRefusal, ctx)) {',
  '} else if (false) {',
);
prove(
  'a refusal naming a symbol the file lacks is accepted',
  LIB,
  'if (symbol === undefined) return true;',
  'return true;',
);
prove(
  'a refusal is "verified" with no repository context',
  LIB,
  '} else if (!ctx) {',
  '} else if (false) {',
);
prove(
  'a one-word mechanism is accepted',
  LIB,
  'if (!nonEmpty(e?.mechanism) || e.mechanism.trim().length < MIN_MECHANISM_CHARS) {',
  'if (!nonEmpty(e?.mechanism)) {',
);
prove(
  'a provenance that is not a URL is accepted',
  LIB,
  'if (!nonEmpty(e?.provenance) || !PROVENANCE_URL.test(e.provenance)) {',
  'if (!nonEmpty(e?.provenance)) {',
);
prove(
  'an entry with no cases is accepted',
  LIB,
  'if (!Array.isArray(e?.cases) || e.cases.length === 0) {',
  'if (!Array.isArray(e?.cases)) {',
);
prove(
  'a file with no upstream snapshot is accepted',
  LIB,
  'if (!snap) out.push(',
  'if (false) out.push(',
);
prove(
  'a snapshot at another ref is accepted',
  LIB,
  'else if (snapshot.ref !== e.nextjsRef) {',
  'else if (false) {',
);
prove(
  'a case name upstream does not have is accepted',
  LIB,
  'if (!snap.literals.some((l) => literalProduces(l, part))) {',
  'if (false) {',
);
prove(
  'the describe path is no longer checked',
  LIB,
  'for (const part of [...c.path, c.title]) {',
  'for (const part of [c.title]) {',
);
prove('a duplicate case is accepted', LIB, 'if (seen.has(name)) out.push(', 'if (false) out.push(');
prove(
  'an entry with no runs is accepted',
  LIB,
  'if (!Array.isArray(e?.runs) || e.runs.length === 0) {',
  'if (!Array.isArray(e?.runs)) {',
);
prove(
  'a run id that is not one is accepted',
  LIB,
  "if (!/^\\d{8,}$/.test(String(r?.run ?? '')))",
  'if (false)',
);
prove('a run on an unknown cell is accepted', LIB, 'if (!CELLS.includes(r?.cell))', 'if (false)');
prove('a run at another ref is accepted', LIB, 'if (r?.ref !== e.nextjsRef)', 'if (false)');
prove(
  'an entry with no run on its own cell is accepted',
  LIB,
  'if (nonEmpty(e.lane) && !e.runs.some((r) => r?.cell === laneCell(e.lane))) {',
  'if (false) {',
);
prove(
  'the lane Bun pin is read loosely (two disagreeing pins pass)',
  LIB,
  'if (pins.length !== 1 || !BUN_VERSION_SHAPE.test(pins[0])) {',
  'if (pins.length === 0) {',
);
prove('a missing ledger parses as empty', LIB, 'if (!Array.isArray(list)) {', 'if (false) {');

// ── PR time: ledger rules ──────────────────────────────────────────────────────────────────────
prove('the cap is off', LIB, 'if (entries.length > UPSTREAM_RUNTIME_DEFECT_CAP) {', 'if (false) {');
prove(
  'the cap is raised',
  LIB,
  'export const UPSTREAM_RUNTIME_DEFECT_CAP = 5;',
  'export const UPSTREAM_RUNTIME_DEFECT_CAP = 6;',
);
prove('a duplicate entry is accepted', LIB, 'if (seen.has(key)) out.push(', 'if (false) out.push(');
prove(
  'a file-level exclusion is accepted',
  LIB,
  'if (exclude.has(e?.test) || exclusions.has(e?.test)) {',
  'if (false) {',
);
prove('a section (h) overlap is accepted', LIB, 'if (quarantined.has(e?.test))', 'if (false)');
prove('a ref-pinned overlap is accepted', LIB, 'if (refPinned.has(e?.test))', 'if (false)');
prove(
  'a committed deselection (every cell) is accepted',
  LIB,
  'if (committed.has(caseName(c))) {',
  'if (false) {',
);

// ── Run time: the scope ────────────────────────────────────────────────────────────────────────
const RUN_SPECS = [SPEC, SCOPE_SPEC];
prove('the lane is ignored at run time', LIB, 'if (e.lane !== lane) {', 'if (false) {', {
  specs: RUN_SPECS,
});
prove('the ref is ignored at run time', LIB, 'if (e.nextjsRef !== ref) {', 'if (false) {', {
  specs: RUN_SPECS,
});
prove(
  'the Bun version is ignored at run time',
  LIB,
  'if (observedBun !== e.bunVersion) {',
  'if (false) {',
  {
    specs: RUN_SPECS,
  },
);
prove(
  'the Bun gate is skipped (runtime check removed)',
  LIB,
  "if (runtime === 'bun') {",
  'if (false) {',
  {
    specs: RUN_SPECS,
  },
);
prove(
  'an unreadable Bun no longer fails closed',
  LIB,
  'if (!nonEmpty(observedBun)) {',
  'if (false) {',
  {
    specs: RUN_SPECS,
  },
);
prove(
  'an unknown lane no longer fails closed',
  LIB,
  'if (ledger.length > 0 && (!nonEmpty(runtime) || !nonEmpty(builder))) {',
  'if (false) {',
  { specs: RUN_SPECS },
);
prove(
  'an entry with no parseable lane no longer fails closed',
  LIB,
  "if (typeof e.lane !== 'string' || !LANE_PATTERN.test(e.lane)) {",
  'if (false) {',
  { specs: RUN_SPECS },
);
prove(
  'an entry with no parseable ref no longer fails closed',
  LIB,
  "if (typeof e.nextjsRef !== 'string' || !REF_SHAPE.test(e.nextjsRef)) {",
  'if (false) {',
  { specs: RUN_SPECS },
);
prove(
  'an entry with no cases no longer fails closed',
  LIB,
  'if (!Array.isArray(e.cases) || e.cases.length === 0) {',
  'if (false) {',
  { specs: RUN_SPECS },
);
prove(
  'a matching entry deselects nothing',
  LIB,
  'for (const name of e.cases.map(caseName)) if (!failed.includes(name)) failed.push(name);',
  'for (const name of []) failed.push(name);',
  { specs: RUN_SPECS },
);
prove(
  'SCRIPT: the ledger is never applied',
  SCOPE,
  '    applyUpstreamRuntimeDefects(scoped, {',
  '    ((..._a) => {})(scoped, {',
  { specs: RUN_SPECS },
);
prove(
  'SCRIPT: the runtime is no longer read from the workflow env',
  SCOPE,
  "runtime: arg(argv, 'runtime') ?? process.env.KNEXT_RUNTIME,",
  "runtime: arg(argv, 'runtime'),",
  { specs: RUN_SPECS },
);
prove(
  'SCRIPT: the builder is no longer read from the workflow env',
  SCOPE,
  "builder: arg(argv, 'builder') ?? process.env.KNEXT_BUILDER,",
  "builder: arg(argv, 'builder'),",
  { specs: RUN_SPECS },
);
prove(
  'SCRIPT: the Bun under test is assumed, not read',
  SCOPE,
  "return r.status === 0 ? String(r.stdout).trim() : '';",
  "return '1.4.2';",
  { specs: RUN_SPECS },
);
prove(
  'SCRIPT: --bun-version is ignored',
  SCOPE,
  'bunVersion: () => flagBun ?? observedBunVersion(),',
  'bunVersion: () => observedBunVersion(),',
  { specs: RUN_SPECS },
);
prove(
  'WORKFLOW: the workflow-level KNEXT_BUILDER the scope step inherits is gone',
  WF_E2E,
  '  KNEXT_BUILDER: ${{ github.event.inputs.builder ||',
  '  KNEXT_BUILDER_RENAMED: ${{ github.event.inputs.builder ||',
  { specs: [SPEC] },
);

// ── Whole-file entries are file exclusions, never a failed list ─────────────────────────────────
prove(
  'a whole-file entry is routed to failed (the file would run no case and be credited passed)',
  LIB,
  '    if (e.wholeFile) {',
  '    if (false) {',
  { specs: RUN_SPECS },
);
prove(
  'a whole-file entry adds nothing to rules.exclude',
  LIB,
  'if (!manifest.rules.exclude.includes(e.test)) manifest.rules.exclude.push(e.test);',
  'if (false) manifest.rules.exclude.push(e.test);',
  { specs: RUN_SPECS },
);
prove(
  'RUN TIME: an entry with no boolean wholeFile no longer fails closed',
  LIB,
  "    if (typeof e.wholeFile !== 'boolean') {\n      throw new DefectScopeError(",
  '    if (false) {\n      throw new DefectScopeError(',
  { specs: RUN_SPECS },
);
prove(
  'an entry with no wholeFile flag is accepted',
  LIB,
  "    if (typeof e.wholeFile !== 'boolean') {\n      out.push(",
  '    if (false) {\n      out.push(',
);
prove(
  'wholeFile true is accepted on a file with other cases',
  LIB,
  'if (e.wholeFile && others.length > 0) {',
  'if (false) {',
);
prove(
  'wholeFile false is accepted on an entry covering every case',
  LIB,
  '} else if (!e.wholeFile && others.length === 0) {',
  '} else if (false) {',
);
prove(
  'DATA: a whole-file entry is marked partial',
  MANIFEST,
  '"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.2",\n      "wholeFile": true,',
  `"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.2",\n      "wholeFile": false, "//${MUTATION_MARKER}": 1,`,
  { specs: [SPEC] },
);

// ── "Re-measured" is checked: a run at the entry's Bun on its own cell ──────────────────────────
prove(
  'a Bun-cell run with no recorded Bun is accepted',
  LIB,
  "if (String(r?.cell).startsWith('bun-') && !BUN_VERSION_SHAPE.test(String(r?.bun ?? '')))",
  'if (false)',
);
prove(
  'no own-cell run at the entry Bun is required',
  LIB,
  '!e.runs.some((r) => r?.cell === laneCell(e.lane) && r?.bun === e.bunVersion)',
  'false',
);
// The reviewer's case: the lane pin AND every bunVersion move together to a Bun nobody ran; the
// runs are untouched. The pin check is satisfied, so only the run-measurement rule can catch it.
proveMulti('DATA: lockstep Bun bump (pin + bunVersion move, runs do not)', [
  [
    WF_E2E,
    "          # lane only)` step. Bumping one alone reds compat-bun-lane-lockstep.\n          bun-version: ${{ github.event.inputs.bun-version || '1.4.2' }}",
    "          # lane only)` step. Bumping one alone reds compat-bun-lane-lockstep.\n          bun-version: ${{ github.event.inputs.bun-version || '1.4.3' }}",
  ],
  [
    WF_E2E,
    "          # evidence on its own.\n          bun-version: ${{ github.event.inputs.bun-version || '1.4.2' }}",
    "          # evidence on its own.\n          bun-version: ${{ github.event.inputs.bun-version || '1.4.3' }}",
  ],
  [
    MANIFEST,
    '"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.2",',
    `"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.3", "//${MUTATION_MARKER}": 1,`,
  ],
  [
    MANIFEST,
    '"test": "test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.2",',
    `"test": "test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts",\n      "lane": "bun/turbopack",\n      "nextjsRef": "v16.4.3",\n      "bunVersion": "1.4.3", "//${MUTATION_MARKER}": 2,`,
  ],
]);

// ── The snapshot covers this ledger ────────────────────────────────────────────────────────────
prove(
  'SNAPSHOT: the defect files fall out of the snapshot ledger',
  SNAP,
  '...(manifest.$knextUpstreamRuntimeDefects ?? []).map((e) => ({',
  '...[].map((e) => ({',
  { specs: [REF_SPEC] },
);

// ── Data: a bad datum planted in the real manifest (JSON-legal marker inside a string) ──────────
prove(
  'DATA: the entry is widened to the node cell',
  MANIFEST,
  '"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "bun/turbopack",',
  `"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",\n      "lane": "node/turbopack", "//${MUTATION_MARKER}": 1,`,
  { specs: RUN_SPECS },
);
prove(
  'DATA: a case title is renamed away from upstream',
  MANIFEST,
  '"title": "builds and runs Node.js middleware importing via a star re-export"',
  `"title": "builds and runs Node.js middleware importing via a star re-export ${MUTATION_MARKER}"`,
  { specs: [SPEC] },
);
prove(
  'DATA: a reaudited stamp is planted',
  MANIFEST,
  '"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts",',
  `"test": "test/e2e/app-dir/treeshake-mw/mw.test.ts", "reaudited": "v16.4.3 ${MUTATION_MARKER}",`,
  { specs: [SPEC] },
);

// ── Docs: the user page's counts are derived, not copied ───────────────────────────────────────
prove(
  'DOCS: the page states a wrong count',
  DOCS,
  'This list currently holds 2 files (2 test cases)',
  'This list currently holds 3 files (3 test cases)',
  { specs: [DOCS_SPEC], commentPrefix: '/*' },
);
prove('DOCS: the page states a wrong cap', DOCS, 'its own ceiling of 5.', 'its own ceiling of 6.', {
  specs: [DOCS_SPEC],
  commentPrefix: '/*',
});

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
