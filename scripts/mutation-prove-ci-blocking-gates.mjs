#!/usr/bin/env node
/**
 * Standing mutation proof for the ci.yml BLOCKING-GATE guards (#672 item 1).
 *
 * `scripts/mutation-prove-blocking-gate.mjs` proves the audit ENGINE cannot be
 * gutted. This one proves the opposite direction, on the real workflow: every
 * guard that claims "this ci.yml job runs unconditionally on a PR and its
 * failure fails the run" must go RED when that claim is actually falsified.
 *
 * It exists because #672 measured the gap it closes. Before the conversion,
 * `tests/compile-cache-health-bun-ci.test.ts` asked the question as TEXT
 * (`not.toMatch(/continue-on-error:\s*true/)` over the job's lines) and stayed
 * GREEN under all four disarms below — the same four #661 measured on the
 * bun-exec guards. A guard that stays green while its subject is removed is
 * decoration, and the only way to know which of those a guard is, is to remove
 * the subject and look.
 *
 * PRE-CONVERSION BASELINE, per guard — recorded here because #672's own PR body
 * UNDER-CLAIMED it and a commit message cannot be corrected in place. The
 * round-2 review caught the error; the number below was then re-measured by
 * replaying the five disarms against the HEAD~1 text guard:
 *
 *   - `compile-cache-bun-probe` (compile-cache-health-bun-ci): GREEN under all
 *     five.
 *   - `typecheck-root` (root-typecheck-gate): GREEN under FOUR — `"if": false`,
 *     `'if': false`, `needs: <skippable>`, and the zero-expansion `strategy:`.
 *     The PR body listed only the quoted key and `strategy:`. Its one catch was
 *     `continue-on-error: ${{ true }}`, and only by accident of breadth: that
 *     guard matched a bare `/continue-on-error/` rather than the
 *     `/continue-on-error:\s*true/` its siblings used. Understating a guard's
 *     blind spots is the same failure as overstating its coverage, so the
 *     measured figure lives in the tree rather than in a PR body.
 *
 * The mutations are applied to `.github/workflows/ci.yml` through the byte-
 * snapshot harness, so the workflow is restored content-addressed rather than by
 * replaying inverse edits, and every mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-ci-blocking-gates.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');

/**
 * A job that CAN skip, used for the `needs:` disarm.
 *
 * `docs-drift-reminder` carries `if: github.event_name == 'pull_request'`, so it
 * is skipped on a push — and a job that `needs:` a skipped job is itself
 * skipped, and a skipped job does not fail the run. That is the indirection the
 * text guards missed entirely: the gate disappears without its own definition
 * ever being touched.
 */
const SKIPPABLE_JOB = 'docs-drift-reminder';

/**
 * The name every converted blocking-gate assertion carries. The proof runs ONLY
 * that test (`vitest -t`), which is not a convenience — it is what keeps the
 * result attributable.
 *
 * `tests/mutation-residue-scan.test.ts` proved that the hard way: it also scans
 * every tracked file for the residue marker, and the harness stamps that marker
 * into `ci.yml` on every mutation. Run whole, that spec goes RED under all five
 * disarms — including ones it cannot see — because the marker it just found is
 * its own. A proof that cannot tell "the gate is disarmed" from "the mutation
 * marker is present" proves nothing, so the run is narrowed to the one assertion
 * whose subject is being removed.
 */
const GATE_TEST_NAME = 'runs unconditionally on a PR and its failure fails the run';

/**
 * Every ci.yml job whose guard claims it is a blocking gate, and the spec that
 * makes the claim. Adding a converted guard here is what keeps this proof from
 * describing only the jobs someone remembered.
 */
const GATES = [
  { jobId: 'compile-cache-bun-probe', spec: 'tests/compile-cache-health-bun-ci.test.ts' },
  { jobId: 'typecheck-root', spec: 'tests/root-typecheck-gate.test.ts' },
  { jobId: 'lint-and-test', spec: 'tests/mutation-residue-scan.test.ts' },
  { jobId: 'bun-exec-hardcap', spec: 'tests/bun-exec-hardcap-ci.test.ts' },
  { jobId: 'bun-exec-alpine-image', spec: 'tests/bun-exec-alpine-image-ci.test.ts' },
];

/**
 * The disarms. Each is a single valid-YAML edit that neutralises the job while
 * leaving its definition otherwise intact — four measured in #661, plus the two
 * the fail-closed allowlist caught that nobody had enumerated.
 */
const DISARMS = [
  { label: 'a quoted "if": false key', inject: '    "if": false' },
  { label: "a single-quoted 'if': false key", inject: "    'if': false" },
  {
    label: 'continue-on-error as an EXPRESSION, not a literal true',
    inject: '    continue-on-error: ${{ true }}',
  },
  { label: `needs: ${SKIPPABLE_JOB} (a job that can skip)`, inject: `    needs: ${SKIPPABLE_JOB}` },
  {
    label: 'a matrix strategy that can expand to zero jobs',
    inject: '    strategy:\n      matrix:\n        shard: []',
  },
];

/**
 * SGR colour codes in vitest's output, so the summary line can be parsed.
 *
 * Built with `String.fromCharCode(27)` rather than written as `\x1b` in a regex
 * literal: biome's `noControlCharactersInRegex` is an ERROR here, and the point
 * of that rule (a control character nobody intended) does not apply to a
 * deliberate ANSI strip.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

let pass = 0;
let fail = 0;

/**
 * Run the ONE blocking-gate assertion in `spec`.
 *
 * Returns how many tests actually ran alongside the verdict, because `vitest -t`
 * with a name that matches nothing exits 0 — so "green" and "there was nothing
 * to run" are the same status code, and a renamed assertion would turn this
 * whole proof into a no-op that reports success.
 */
function runGateTest(spec) {
  const res = spawnSync('pnpm', ['exec', 'vitest', 'run', spec, '-t', GATE_TEST_NAME], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(ANSI, '');
  const passed = Number(out.match(/Tests\s+(\d+) passed/)?.[1] ?? 0);
  const failed = Number(out.match(/Tests\s+.*?(\d+) failed/)?.[1] ?? 0);
  return { ok: res.status === 0, ran: passed + failed };
}

/** The assertion must be RED while the job is disarmed, and GREEN once restored. */
function prove(jobId, spec, disarm) {
  console.log(`── ${spec} :: ${jobId} :: ${disarm.label}`);
  const anchor = `  ${jobId}:\n`;
  const snap = snapshot(CI_YML);
  try {
    // The anchor is the job KEY, so the injection lands at job level whatever
    // the job's body looks like — no dependence on which line happens to be
    // first, which is how an anchored-on-a-neighbour mutation silently no-ops.
    mutate(snap, anchor, `${anchor}${disarm.inject}\n`);
    const { ok, ran } = runGateTest(spec);
    if (ran === 0) {
      console.error(`   FATAL: no test named ${JSON.stringify(GATE_TEST_NAME)} ran in ${spec}`);
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the guard stayed GREEN with the gate disarmed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!runGateTest(spec).ok) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: every gate assertion must be GREEN against the real ci.yml.');
for (const { spec } of GATES) {
  const { ok, ran } = runGateTest(spec);
  if (ran === 0) {
    console.error(`FATAL: ${spec} has no test named ${JSON.stringify(GATE_TEST_NAME)}`);
    process.exit(1);
  }
  if (!ok) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

for (const { jobId, spec } of GATES) {
  for (const disarm of DISARMS) prove(jobId, spec, disarm);
}

console.log(`\n${pass} disarm(s) went red as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
