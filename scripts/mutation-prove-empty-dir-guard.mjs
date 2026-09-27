#!/usr/bin/env node
/**
 * Mutation proof for the #1455 (F6) empty-dir lane guard,
 * `scripts/lib/e2e-empty-dir.sh`'s `ed_assert_clean` + `ed_probe_http`,
 * exercised by `tests/e2e-empty-dir.test.ts`.
 *
 * ROUND-2 REVIEW REWRITE. Round 1 shipped `ed_assert_clean` as a DENYLIST
 * (`node_modules`/`.output` forbidden outright, `.next` restricted to
 * `static`) and `ed_probe_http` as "any complete HTTP response counts".
 * Round-2 review found both decorative in a real, load-bearing way, not a
 * hypothetical one:
 *
 *   * BLOCKING-2: the denylist forbade `.output` WHOLESALE, so the vinext
 *     lane's own correct staging (`.output/public`) could never pass the
 *     cleanliness assert — the guard was blocking the very shape it was
 *     supposed to allow through to the boot step.
 *   * BLOCKING-4: "any complete response counts" let a server that 500s on
 *     every route pass the boot check.
 *
 * The fix (this PR) is an ALLOWLIST (`ed_assert_clean <dir> <binary_name>`:
 * only `<binary_name>`, `.next`, `public`, `native`, `.output` may exist at
 * the top level; `.next` may hold only `static`, `.output` only `public`)
 * plus a recursive node_modules sweep for nested leaks the allowlist alone
 * cannot see (`native/node_modules`, `.next/static/node_modules`, …), and a
 * status-aware `ed_probe_http` (2xx/3xx on the health path, non-5xx
 * elsewhere).
 *
 * Four mutations, one per independent guard mechanism — independent because
 * round 1's two-mutation table already showed that testing only the
 * "obvious" one leaves the other's regression invisible:
 *
 *   1. The top-level ALLOWLIST itself — disarm it so any unexpected entry
 *      (a stray `package.json`+`server.js` pair, a `.bun` cache dir, a
 *      `server/` directory of nitro chunks, or a top-level `node_modules`)
 *      passes silently.
 *   2. The ".next may hold only static / .output may hold only public"
 *      check — disarm it so `.next/server` or `.output/server` (the
 *      disk-mode tree leaking in one level down) passes silently.
 *   3. The NESTED node_modules sweep — disarm it so `native/node_modules`,
 *      `public/node_modules`, `.next/static/node_modules` or
 *      `.output/public/node_modules` pass silently even though the parent
 *      directory is itself allowlisted.
 *   4. `ed_probe_http`'s status-code requirement — revert to "any complete
 *      response counts" so a server 500-ing on every route passes.
 *
 * (BLOCKING-3's fix — hiding APP_DIR/node_modules and APP_DIR/.output for
 * the duration of a bare boot — is not a single-line guard toggle to mutate;
 * it is proved directly in tests/e2e-empty-dir.test.ts by the paired
 * "hides a leak binary" / "without ED_HIDE_DURING_BOOT ... DOES see" cases,
 * which reproduce the reviewer's synthetic `require('leakpkg')` binary both
 * ways.)
 *
 * ROUND-3 REVIEW ADDITIONS (BLOCKING-1 + three non-blocking items promoted
 * to load-bearing). Five more independent mechanisms, same reason as above —
 * each is a DIFFERENT branch than the four above, so none of them is
 * incidentally covered by another's mutation:
 *
 *   5. `ed_probe_http`'s HEALTH-BRANCH threshold specifically (not the whole
 *      status check mutation 4 already covers) — widen it back toward
 *      "non5xx" so a health path answering 500, or 302, while every OTHER
 *      route stays healthy, passes. Round-2's own fixture answered every
 *      route identically, so THIS exact regression shape went undetected
 *      even though mutation 4 existed (round-3 review, BLOCKING-1).
 *   6. The top-level allowlist's two-dot-name coverage (`..leak`) — drop the
 *      third glob pattern so a name starting with two literal dots is
 *      invisible again, exactly as it was before this round (non-blocking
 *      N2).
 *   7. The symlink sweep — disarm it so a symlinked `native/node_modules`,
 *      a symlinked `public`, a symlinked `.next/static`, or a symlink nested
 *      inside one of them all pass silently again (non-blocking N2).
 *   8. `ed_probe_http`'s 5s timeout — widen it past what a single test's own
 *      bounded timeout can tolerate, so a route that hangs without
 *      responding at all no longer fails within a reasonable time
 *      (non-blocking N4).
 *   9. The `<p>.ed-hidden`-already-exists fail-closed check — disarm it so a
 *      stale hidden copy from a killed prior run is hidden INTO again,
 *      nesting the fresh tree inside it (non-blocking N1).
 *   10. `ed_refuse_self_contained_noop` — the extracted, shared refusal both
 *      deploy scripts now call when `KNEXT_SELF_CONTAINED=1` is requested on
 *      an axis with no compiled binary. Disarm the `return 1` so it reports
 *      the error and returns success anyway (non-blocking N3).
 *
 * Shared harness, for the reasons this repo has already paid for elsewhere
 * (scripts/mutation-prove-compat-cell-fingerprint.mjs):
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * judged on EXIT CODES only, never on grepped/ANSI output;
 *   * both directions proven — a mutation must go RED, and the restore must
 *     go GREEN again, or the restore itself is broken.
 *
 * Usage: node scripts/mutation-prove-empty-dir-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/lib/e2e-empty-dir.sh');
const SPEC = 'tests/e2e-empty-dir.test.ts';

declareMutations(10);

const { command, args, runArgs } = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec passed. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(command, [...args, ...runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(TARGET);
  try {
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
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

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. The top-level ALLOWLIST: a stray package.json+server.js, a .bun cache
//    dir, a server/ chunks dir, or a top-level node_modules must all be
//    invisible once the wildcard swallows everything the allowlist branch
//    would otherwise catch.
prove(
  'top-level allowlist: swallow every name into the allowed branch',
  '"${binary_name}" | .next | public | native | .output) ;;',
  '"${binary_name}" | .next | public | native | .output | *) ;;',
);

// 2. ".next may hold only static / .output may hold only public": a stray
//    .next/server or .output/server (the disk-mode tree one level down)
//    must be invisible once this comparison is disarmed.
prove(
  '.next/.output "only static/public" check: disarm it (`if false`)',
  'if [ "${sub_name}" != "${sub_only}" ]; then',
  'if false; then',
);

// 3. THE exit criterion (#1455), now proved at DEPTH: a planted
//    node_modules nested under an otherwise-allowlisted directory
//    (native/, public/, .next/static/, .output/public/) must be invisible
//    once the recursive sweep is gutted.
prove(
  'nested node_modules sweep: never search',
  'nested="$(find "${dir}" -type d -name node_modules -print -quit 2>/dev/null)"',
  'nested=""',
);

// 4. BLOCKING-4: ed_probe_http's status requirement. A server that 500s on
//    every route must pass once "any complete response" is restored.
prove(
  'ed_probe_http status requirement: accept any status again',
  'const ok = mode === "2xx3xx" ? (status >= 200 && status < 300) : (status < 500 || status >= 600);',
  'const ok = true;',
);

// 5. ROUND-3 BLOCKING-1: the HEALTH branch specifically, independent of
//    mutation 4 above. Widening only the health threshold (not the whole
//    line) must still be caught — by the health-only-500 and 302 fixtures in
//    tests/e2e-empty-dir.test.ts, which answer the health path and every
//    OTHER route differently, unlike round 2's onlyStatus fixture.
prove(
  'ed_probe_http health-branch threshold: widen it back toward non5xx',
  'status >= 200 && status < 300',
  'status >= 200 && status < 600',
);

// 6. Round-3 N2: the two-dot top-level name coverage. Dropping the third
//    glob pattern must let a top-level "..leak" pass silently again.
prove(
  'top-level allowlist: drop the two-dot-name glob',
  '"${dir}"/* "${dir}"/.[!.]* "${dir}"/..?*; do',
  '"${dir}"/* "${dir}"/.[!.]*; do',
);

// 7. Round-3 N2: the symlink sweep. Disarming it must let a symlinked
//    native/node_modules, a symlinked public, a symlinked .next/static, or a
//    symlink nested inside one of them all pass silently again.
prove(
  'symlink sweep: never search',
  'symlink_leak="$(find "${dir}" -type l -print -quit 2>/dev/null)"',
  'symlink_leak=""',
);

// 8. Round-3 N4: ed_probe_http's 5s timeout, widened past what the hanging-
//    route test's own bounded per-test timeout tolerates. bun:test's own
//    per-test timeout (not this repo's harness) is what turns "the probe
//    hangs longer than expected" into a graded RED here — see the test's
//    explicit timeout argument.
prove(
  'ed_probe_http timeout: widen past the hanging-route test bound',
  'port, path, timeout: 5000 }',
  'port, path, timeout: 60000 }',
);

// 9. Round-3 N1: the <p>.ed-hidden-already-exists fail-closed check. Once
//    disarmed, a stale hidden copy from a killed prior run is hidden INTO
//    again — nesting the fresh tree inside it — instead of refusing.
prove(
  '<p>.ed-hidden-already-exists guard: never refuse',
  'if [ -e "${p}.ed-hidden" ]; then\n        ed_log "ERROR: ${label}: ${p}.ed-hidden already exists',
  'if false; then\n        ed_log "ERROR: ${label}: ${p}.ed-hidden already exists',
);

// 10. Round-3 N3: ed_refuse_self_contained_noop. Disarming its `return 1`
//     must let both deploy scripts' "self-contained requested but no
//     compiled binary on this axis" branch report the error and continue
//     anyway, exactly the WARNING-and-continue shape this round removed.
prove(
  'ed_refuse_self_contained_noop: report but do not refuse',
  'disk mode under a self-contained fingerprint."\n  return 1\n}',
  'disk mode under a self-contained fingerprint."\n  return 0\n}',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
