#!/usr/bin/env node
/**
 * Standing mutation proof for `tests/compat-lane-pointer-resolution.test.ts`.
 *
 * That guard exists because `.github/workflows/ci.yml` and
 * `apps/file-manager/scripts/compat-smoke.mjs` both deflected the reader to a
 * scheduled lane called `compat-suite-full` — a name that denotes nothing in
 * this repo. A release-readiness review grepped `.github/workflows/` for it,
 * found nothing, and concluded the official compat suite had stopped running.
 * It had not: it runs twice a week, and every scheduled run since 2026-07-28
 * has a `compat-run-ledger` artifact on file.
 *
 * Two of the guard's three claims describe a state the CLEAN TREE CANNOT
 * EXHIBIT — there is no dangling lane name left to see it fire on, and there is
 * no deleted cron. That is precisely the profile of a guard that can be
 * written, merged, reviewed, and be decoration. So each claim is planted here
 * and required to go RED.
 *
 * DISCIPLINE, both of which this repo has been burned by:
 *   * every verdict branches on the runner's EXIT CODE, never on scraped
 *     output. ANSI in vitest's reporter once certified fourteen decorative
 *     mutations as all-green;
 *   * every mutation goes through the byte-snapshot harness, whose `mutate`
 *     asserts the anchor occurs EXACTLY ONCE and aborts otherwise — a silently
 *     failed substitution yields a green run that proves nothing.
 *
 * Usage:  node scripts/mutation-prove-compat-lane-pointer.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-lane-pointer-resolution.test.ts';

const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const COMPAT_YML = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const SUPPLY_YML = resolve(REPO_ROOT, '.github/workflows/supply-chain.yml');

/**
 * Five mutations. The lane compares DECLARED against RUN in both directions
 * (#685), so adding a sixth without bumping this reddens rather than passing
 * quietly.
 */
declareMutations(5);

let pass = 0;
let fail = 0;

/**
 * `pnpm exec vitest` resolves nothing in a tree without its own `node_modules`
 * — a fresh worktree, a clone before install — and every run then reports zero
 * tests while naming a cause that is not the cause. #680/#681/#685.
 */
const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/**
 * Run the whole spec file and report ONLY its exit code plus whether the file
 * was collected at all.
 *
 * `--reporter=json` is deliberate: the pass/fail verdict is `res.status`, and
 * the JSON is read for ONE thing the exit code cannot express — did any test
 * actually run. A spec that fails to collect also exits non-zero, and without
 * this a mutation that BROKE the spec would be scored as "the guard fired".
 */
function runSpec() {
  // #902: the SPEC is bun:test, so the runner is scripts/bun-test.mjs and the
  // vitest `--reporter=json` probe is unavailable. The did-anything-run check
  // keeps its teeth through the runner's own contract instead: bun-test.mjs
  // exits 1 on an EMPTY SELECTION (a renamed/uncollected file can never read
  // as "the guard fired"), and with a `-t` of the file's whole run absent we
  // read the forwarded `N pass`/`N fail` summary lines it prints per child.
  const res = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC, '')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const passed = Number(raw.match(/^\s*(\d+) pass\b/m)?.[1] ?? 0);
  const failed = Number(raw.match(/^\s*(\d+) fail\b/m)?.[1] ?? 0);
  return { ok: res.status === 0, ran: passed + failed };
}

/**
 * Plant `replacement` over `anchor` in `file`, require the spec to go RED, then
 * restore and require it to go GREEN again.
 *
 * The restore-and-recheck is not ceremony: mutation residue left in a file that
 * is legitimately modified by the same branch is invisible to `git status`, and
 * this project has twice come within one commit of shipping the inverse of a
 * fix that way.
 */
function prove(label, file, anchor, replacement) {
  console.log(`── planting: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    const { ok, ran } = runSpec();
    if (ran === 0) {
      console.error(`   FATAL: ${SPEC} collected no tests under this mutation`);
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the guard stayed GREEN with its subject broken');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  const after = runSpec();
  if (!after.ok || after.ran === 0) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore (ran ${after.ran})`);
    process.exit(1);
  }
}

console.log(`Baseline: ${SPEC} must be GREEN before anything is planted.`);
const baseline = runSpec();
if (!baseline.ok || baseline.ran === 0) {
  console.error(`FATAL: ${SPEC} is not green to begin with (ran ${baseline.ran})`);
  process.exit(1);
}
console.log(`   ok baseline green (${baseline.ran} tests)\n`);

// ── 1. THE INCIDENT ITSELF. The exact line that was on main, restored. ──────
// A lane nickname that denotes no workflow, job, artifact or file.
prove(
  'the original stale pointer, reinstated verbatim',
  CI_YML,
  '  compat-smoke:\n',
  '  # The official deploy-test harness is a separate scheduled job (A3-2, compat-suite-full).\n  compat-smoke:\n',
);

// ── 2. A DEFLECTION THAT NAMES NOWHERE. ────────────────────────────────────
// The other way a pointer dangles: it does not name a WRONG lane, it names no
// destination at all. Planted in supply-chain.yml, which mentions neither the
// harness nor any compat lane, so nothing within the three-line window can
// satisfy the check by accident.
prove(
  'a deflection with no destination at all',
  SUPPLY_YML,
  'jobs:\n',
  '# The official deploy-test harness is a separate scheduled job.\njobs:\n',
);

// ── 3. THE POSITIVE HALF: the lane itself. ─────────────────────────────────
// If the weekly Bun schedule were deleted, claims (2) and (3) would both stay
// GREEN — with no lane, nothing dangles. This is the mutation that decides
// whether the positive half is load-bearing or ornamental.
// The weekly Bun cron RETIRED with the standalone-under-bun artifact (#710,
// stability sprint) and the guard flipped to assert its ABSENCE — so the
// mutation flips with it: RESURRECT the cron and the guard must go red.
// (The pre-flip form deleted the cron and expected red; planting a deletion
// of something already absent is the anchor-miss the harness aborts on.)
prove(
  'the retired weekly Bun cron resurrected in the schedule',
  COMPAT_YML,
  "    - cron: '17 3 * * *'\n",
  "    - cron: '17 3 * * *'\n    - cron: '17 5 * * 0'\n",
);

// ── 4. The node credential lane, same argument in the other direction. ─────
prove(
  'the nightly Node cron deleted from the schedule',
  COMPAT_YML,
  "    - cron: '17 3 * * *'\n",
  '',
);

// ── 5. BOTH CRONS PRESENT IS NOT ENOUGH. ───────────────────────────────────
// The weekly schedule only reaches the Bun lane because the lane-selection
// expression is now dispatch-input-or-node — the schedule comparison retired
// with the weekly cron, and the guard asserts NO schedule branch exists. So
// the mutation flips: RE-INTRODUCE a schedule comparison and the guard must
// red (a resurrected branch is a second lane hiding in an expression).
prove(
  'a schedule branch re-introduced into the lane-selection expression',
  COMPAT_YML,
  "KNEXT_RUNTIME: ${{ github.event.inputs.runtime || 'node' }}",
  "KNEXT_RUNTIME: ${{ github.event.inputs.runtime || (github.event.schedule == '17 3 * * *' && 'node') || 'node' }}",
);

console.log(`\n${pass} mutation(s) went red as required, ${fail} were survived by the guard.`);
process.exit(fail === 0 ? 0 : 1);
