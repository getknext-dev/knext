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
 * #1514 ADDITIONS — the SUITE server served from the empty dir. Three
 * guards, each proved against every mechanism it depends on (13–31 below; #1515 adds 32–36):
 *   (a) text: both deploy scripts' SC suite boot cds into EMPTY_DIR (the
 *       standalone container mounts only EMPTY_DIR), records SERVED_FROM,
 *       and runs the isolation check before handing the URL over;
 *   (b) runtime: ed_assert_suite_isolated's four checks, the hide itself,
 *       and restore-on-every-exit-path (EXIT trap, TERM conversion,
 *       stop-before-restore, the hand-off gate, e2e-cleanup.sh's restore);
 *   (c) fingerprint: a self-contained digest requires the harness to
 *       declare served_from=empty-dir, and folds it.
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
// ROUND-3: ed_probe_http's actual HTTP request moved out of an inline
// `node -e` string into this real file (see its own header) — the apply-
// safety scanner's exactly-once REMOTE_FETCH_ALLOWLIST constraint can't
// otherwise be satisfied by a probe with two call sites × two callers.
// Mutations 5 and 8 below target ITS content, not e2e-empty-dir.sh's.
const PROBE_TARGET = resolve(REPO_ROOT, 'scripts/lib/e2e-probe-http.mjs');
// ROUND-3 non-blocking (a): the two deploy-script CALL SITES of
// ed_refuse_self_contained_noop, mutated directly (removing `|| exit 1`) to
// prove the text-scan test in tests/e2e-empty-dir.test.ts actually notices —
// ed_refuse_self_contained_noop's own logic (mutation 10) says nothing about
// whether either caller still propagates its failure.
const DEPLOY_TARGET = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const VINEXT_TARGET = resolve(REPO_ROOT, 'scripts/e2e-deploy-vinext.sh');
// #1514: the teardown restore and the fingerprint's served_from gate.
const CLEANUP_TARGET = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');
const FINGERPRINT_TARGET = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');
// PR #1521 round-2 review additions: the basePath read is now its own file
// (scripts/lib/e2e-read-base-path.mjs, review finding 2), same reasoning as
// PROBE_TARGET above for why it is a separate snapshot target.
const READ_BASE_PATH_TARGET = resolve(REPO_ROOT, 'scripts/lib/e2e-read-base-path.mjs');
const SPEC = 'tests/e2e-empty-dir.test.ts';

declareMutations(58);

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

/**
 * Shared mutate/restore body. Takes an already-snapshotted `snap`, not a
 * file path — see the four thin wrappers below for why: this repo's
 * PR-time prover audit (tests/mutation-prover-lane.test.ts, #912/#927)
 * statically greps for a literal `snapshot(<CONST_NAME>)` call to bind each
 * mutation to the file it proves against. A single generic helper taking a
 * `target` PARAMETER (tried first, in round 3) calls `snapshot(target)` —
 * that string never matches ANY of TARGET/PROBE_TARGET/DEPLOY_TARGET/
 * VINEXT_TARGET by name, so the audit sees zero bindings and zero resolved
 * anchors for this whole file: exactly the "invisible to both extractors"
 * defect class #912/#927 exist to catch, reintroduced by trying to be DRY
 * about it. Four one-line wrappers, each with its OWN literal
 * `snapshot(CONST)` call, are the fix.
 */
function report(label, snap, anchor, replacement) {
  console.log(`── mutation: ${label}`);
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

function prove(label, anchor, replacement) {
  report(label, snapshot(TARGET), anchor, replacement);
}
function proveProbe(label, anchor, replacement) {
  report(label, snapshot(PROBE_TARGET), anchor, replacement);
}
function proveDeploy(label, anchor, replacement) {
  report(label, snapshot(DEPLOY_TARGET), anchor, replacement);
}
function proveVinext(label, anchor, replacement) {
  report(label, snapshot(VINEXT_TARGET), anchor, replacement);
}
function proveCleanup(label, anchor, replacement) {
  report(label, snapshot(CLEANUP_TARGET), anchor, replacement);
}
function proveFingerprint(label, anchor, replacement) {
  report(label, snapshot(FINGERPRINT_TARGET), anchor, replacement);
}
function proveReadBasePath(label, anchor, replacement) {
  report(label, snapshot(READ_BASE_PATH_TARGET), anchor, replacement);
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
//    ROUND-3: targets e2e-probe-http.mjs (moved out of e2e-empty-dir.sh —
//    see PROBE_TARGET above).
proveProbe(
  'ed_probe_http status requirement: accept any status again',
  "const ok = mode === '2xx3xx' ? status >= 200 && status < 300 : status < 500 || status >= 600;",
  'const ok = true;',
);

// 5. ROUND-3 BLOCKING-1: the HEALTH branch specifically, independent of
//    mutation 4 above. Widening only the health threshold (not the whole
//    line) must still be caught — by the health-only-500 and 302 fixtures in
//    tests/e2e-empty-dir.test.ts, which answer the health path and every
//    OTHER route differently, unlike round 2's onlyStatus fixture.
proveProbe(
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
proveProbe(
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

// 11. Round-3 non-blocking (a): scripts/e2e-deploy.sh's call site. Removing
//     `|| exit 1` must red the call-site text-scan test.
proveDeploy(
  'e2e-deploy.sh call site: drop || exit 1',
  'ed_refuse_self_contained_noop "RUNTIME=${RUNTIME}, KNEXT_SANDBOX_FETCH_DEBUG=${KNEXT_SANDBOX_FETCH_DEBUG:-0} — needs RUNTIME=bun and KNEXT_SANDBOX_FETCH_DEBUG unset/0" || exit 1',
  'ed_refuse_self_contained_noop "RUNTIME=${RUNTIME}, KNEXT_SANDBOX_FETCH_DEBUG=${KNEXT_SANDBOX_FETCH_DEBUG:-0} — needs RUNTIME=bun and KNEXT_SANDBOX_FETCH_DEBUG unset/0"',
);

// 12. Round-3 non-blocking (a): scripts/e2e-deploy-vinext.sh's call site.
//     Removing `|| exit 1` must red the call-site text-scan test.
proveVinext(
  'e2e-deploy-vinext.sh call site: drop || exit 1',
  'ed_refuse_self_contained_noop "KNEXT_COMPILE=0 — needs KNEXT_COMPILE unset/1" || exit 1',
  'ed_refuse_self_contained_noop "KNEXT_COMPILE=0 — needs KNEXT_COMPILE unset/1"',
);

// ── #1514 (a): the SC suite boot runs from EMPTY_DIR (text scan) ────────────

// 13. vinext: the suite server's cwd pointed back at APP_DIR.
proveVinext(
  '#1514 (a) vinext SC suite boot: cd APP_DIR instead of EMPTY_DIR',
  '    cd "${EMPTY_DIR}"\n    PORT="${PORT}"',
  '    cd "${APP_DIR}"\n    PORT="${PORT}"',
);

// 14. standalone: the suite container's cwd pointed back at the disk tree.
proveDeploy(
  '#1514 (a) standalone SC suite boot: cd STANDALONE_APP_DIR instead of EMPTY_DIR',
  '    cd "${EMPTY_DIR}"\n    exec docker run --rm --name "${ED_SUITE_CONTAINER}"',
  '    cd "${STANDALONE_APP_DIR}"\n    exec docker run --rm --name "${ED_SUITE_CONTAINER}"',
);

// 15. standalone: the suite container also mounts the standalone root.
proveDeploy(
  '#1514 (a) standalone SC suite container: mount STANDALONE_ROOT beside EMPTY_DIR',
  '      -v "${EMPTY_DIR}:${EMPTY_DIR}" \\\n      -w "${EMPTY_DIR}" \\\n      "${STANDALONE_BUN_IMAGE}" \\\n      "./$(basename "${EMPTY_DIR_STAGED}")"\n  fi',
  '      -v "${EMPTY_DIR}:${EMPTY_DIR}" \\\n      -v "${STANDALONE_ROOT}:/knext-standalone-root" \\\n      -w "${EMPTY_DIR}" \\\n      "${STANDALONE_BUN_IMAGE}" \\\n      "./$(basename "${EMPTY_DIR_STAGED}")"\n  fi',
);

// 16. vinext: the SC branch records served_from=disk.
proveVinext(
  '#1514 (a) vinext SC branch: record SERVED_FROM=disk',
  '  SERVED_FROM="${ED_SUITE_SERVED_FROM_SC}"\n  log "KNEXT_SELF_CONTAINED=1 — booting the SUITE server',
  '  SERVED_FROM="disk"\n  log "KNEXT_SELF_CONTAINED=1 — booting the SUITE server',
);

// 17. standalone: SERVED_FROM dropped from the persisted metadata.
proveDeploy(
  '#1514 (a) standalone metadata: drop SERVED_FROM',
  '  echo "SERVED_FROM=${SERVED_FROM}"\n',
  '',
);

// 18. standalone: the isolation check never runs before hand-off.
proveDeploy(
  '#1514 (a) standalone: skip the isolation check before handing the URL over',
  'if ! ed_assert_suite_isolated "${EMPTY_DIR}" "${APP_DIR}"; then',
  'if false; then',
);

// 19. vinext: the isolation check never runs before hand-off.
proveVinext(
  '#1514 (a) vinext: skip the isolation check before handing the URL over',
  'if ! ed_assert_suite_isolated "${EMPTY_DIR}" "${APP_DIR}"; then',
  'if false; then',
);

// ── #1514 (b): runtime isolation + restore on every exit path ───────────────

// 20. The cwd check (node_modules / .next/server / .output/server).
prove(
  '#1514 (b) ed_assert_suite_isolated: never check the cwd paths',
  'for rel in node_modules .next/server .output/server; do',
  'for rel in; do',
);

// 21. The ancestor walk (module resolution walks up).
prove(
  '#1514 (b) ed_assert_suite_isolated: never check ancestors for node_modules',
  '    if [ -e "${d}/node_modules" ] || [ -L "${d}/node_modules" ]; then',
  '    if false; then',
);

// 22. The symlink sweep under the cwd.
prove(
  '#1514 (b) ed_assert_suite_isolated: never sweep the cwd for symlinks',
  '  leak="$(find "${cwd}" -type l -print -quit 2>/dev/null)"',
  '  leak=""',
);

// 23. The hidden-APP_DIR re-exposure check.
prove(
  '#1514 (b) ed_assert_suite_isolated: never re-check the hidden APP_DIR',
  '    p="${app_dir}/${rel}"\n    if [ -e "${p}" ] || [ -L "${p}" ]; then\n      ed_log "ERROR: suite: ${p} is reachable while',
  '    p="${app_dir}/${rel}"\n    if false; then\n      ed_log "ERROR: suite: ${p} is reachable while',
);

// 24. The hide itself.
prove(
  '#1514 (b) ed_suite_hide_app_dir: never actually hide',
  '      mv "${p}" "${p}.ed-hidden" || {\n        ed_log "ERROR: suite: failed to hide ${p}"',
  '      true || {\n        ed_log "ERROR: suite: failed to hide ${p}"',
);

// 25. The EXIT trap's restore.
prove(
  '#1514 (b) EXIT trap: never restore APP_DIR on a failed deploy',
  '  ed_suite_restore_app_dir "${ED__SUITE_APP_DIR}" || true',
  '  true',
);

// 26. TERM converted into an exit (so the EXIT trap runs on it).
prove('#1514 (b) arm: drop the TERM → exit conversion', "  trap 'exit 143' TERM\n", '');

// 27. Stop the server BEFORE restoring.
prove(
  '#1514 (b) EXIT trap: never stop the suite server before restoring',
  '  if [ -n "${ED_SUITE_SERVER_PID:-}" ] && kill -0 "${ED_SUITE_SERVER_PID}" 2>/dev/null; then',
  '  if false; then',
);

// 28. The hand-off gate: after hand-off the tree must STAY hidden.
prove(
  '#1514 (b) EXIT trap: restore even after hand-off',
  '  if [ "${ED_SUITE_HANDED_OFF:-0}" = "1" ]; then\n    return 0\n  fi\n',
  '',
);

// 29. e2e-cleanup.sh's teardown restore.
proveCleanup(
  '#1514 (b) e2e-cleanup.sh: never restore APP_DIR at teardown',
  'ed_suite_restore_app_dir "${APP_DIR}" || echo',
  'true || echo',
);

// ── #1514 (c): the fingerprint's served_from gate ───────────────────────────

// 30. The gate itself: served_from missing/disk no longer fails.
proveFingerprint(
  '#1514 (c) fingerprint: never assert served_from under --self-contained',
  '  if (selfContained) assertSelfContainedServedFrom(servedFrom);\n',
  '',
);

// 31. The fold: back to the pre-#1514 marker (a disk-served window's digest).
proveFingerprint(
  '#1514 (c) fingerprint: fold the pre-#1514 marker (no servedFrom)',
  'sha256(`selfContained\\ttrue\\nservedFrom\\t${SC_SERVED_FROM}`)',
  "sha256('selfContained\\ttrue')",
);

// ── #1515: the pre-check probe measured nothing in run 36312054519 ──────────

// 32. The probe server's banner back on the caller's STDOUT (the URL line).
prove(
  '#1515 probe server stdout: no longer redirected to stderr',
  '  ( exec "$@" ) >&2 &',
  '  ( exec "$@" ) &',
);

// 33. The `/` (non-5xx) branch accepting a 5xx.
proveProbe(
  '#1515 probe non-5xx branch: accept a 5xx at /',
  ': status < 500 || status >= 600;',
  ': true;',
);

// 34. vinext lane back to demanding /api/health.
proveVinext(
  '#1515 vinext pre-check: hardcode /api/health again',
  '"${KNEXT_EMPTY_DIR_HEALTH_PATH:-${ED_STATIC_PROBE}}" / "${EMPTY_DIR_PORT}"',
  '/api/health / "${EMPTY_DIR_PORT}"',
);

// 35. standalone lane back to demanding /api/health.
proveDeploy(
  '#1515 standalone pre-check: hardcode /api/health again',
  'EMPTY_DIR_HEALTH="${KNEXT_EMPTY_DIR_HEALTH_PATH:-${ED_STATIC_PROBE}}"',
  'EMPTY_DIR_HEALTH="/api/health"',
);

// 36. The staged-static-file resolution never happens (the sentinel is probed literally).
prove(
  '#1515 ed_check_or_die: never resolve the static-file sentinel',
  '  if [ "${health_path}" = "${ED_STATIC_PROBE}" ]; then',
  '  if false; then',
);

// ── PR #1521 round-2 review (review-1521.md) — findings 1-4 ─────────────────

// 37. Finding 1 (mutation R16): e2e-cleanup.sh must STOP the server before
//     restoring APP_DIR — restoring first lets a still-running server read
//     the restored tree. Move the restore ahead of the stop; the R16
//     order-sensitive test must red (it records, in the SIGTERM handler
//     itself, whether the tree was restored before the signal arrived).
proveCleanup(
  '#1521 round-2 finding 1: restore APP_DIR BEFORE stopping the server',
  'echo "[e2e-cleanup] stopping deployment pid=${PID:-?} port=${PORT:-?}" >&2\n',
  'ed_suite_restore_app_dir "${APP_DIR}" || true\necho "[e2e-cleanup] stopping deployment pid=${PID:-?} port=${PORT:-?}" >&2\n',
);

// 38. Finding 2 (mutation R14): ed_probe_http must resolve its helper
//     ABSOLUTELY (ED__LIB_DIR, computed once at source time), never via a
//     BASH_SOURCE-relative path — the latter breaks once the caller has cd'd
//     away from wherever the lib was sourced FROM, if it was sourced by a
//     relative path (exactly the scenario the round-2 relative-source test
//     sets up).
prove(
  '#1521 round-2 finding 2 (R14): ed_probe_http back to a BASH_SOURCE-relative helper path',
  'node "${ED__LIB_DIR}/e2e-probe-http.mjs"',
  'node "$(dirname "${BASH_SOURCE[0]}")/e2e-probe-http.mjs"',
);

// 39. Finding 2 (R13's root cause): an UNREADABLE/malformed manifest must
//     fail LOUD (exit 1), never silently resolve to an empty basePath.
proveReadBasePath(
  '#1521 round-2 finding 2: swallow a read/parse error into "" again',
  '} catch (err) {\n  process.stderr.write(\n    `ERROR: could not read/parse ${manifestPath} for basePath: ${err.message}\\n`,\n  );\n  process.exit(1);\n}',
  '} catch (err) {\n  parsed = {};\n}',
);

// 40. Finding 2 (R13): a configured basePath must actually be read out, not
//     hardcoded away.
proveReadBasePath(
  '#1521 round-2 finding 2 (R13): hardcode the resolved basePath to ""',
  "process.stdout.write(String(parsed?.config?.basePath || ''));",
  "process.stdout.write('');",
);

// 41. Finding 3 (runner disk): e2e-cleanup.sh must remove SERVED_FROM_DIR
//     (the suite's staged empty-dir copy) once teardown is done.
proveCleanup(
  '#1521 round-2 finding 3: never remove SERVED_FROM_DIR',
  'if [ -n "${SERVED_FROM_DIR:-}" ] && [ -d "${SERVED_FROM_DIR}" ]; then\n  rm -rf "${SERVED_FROM_DIR}"',
  'if false; then\n  rm -rf "${SERVED_FROM_DIR}"',
);

// ── PR #1521 round 3 — self-owned staging dirs (the round-2 sweep is gone) ──

// 42. The round-2 orphan sweep deleted a CONCURRENT deploy's live suite and
//     pre-check dirs (reviewer attack A1). Re-introduce the worst form of it —
//     every knext-empty-dir* under RUNNER_TEMP, on the no-metadata path — and
//     the "live concurrent deploy survives both teardown paths" test must red.
proveCleanup(
  '#1521 round-3: no-metadata teardown sweeps every knext-empty-dir* again',
  '  ed_suite_restore_app_dir "${APP_DIR}" || true\n',
  '  ed_suite_restore_app_dir "${APP_DIR}" || true\n  for d in "${RUNNER_TEMP:-/tmp}"/knext-empty-dir*; do rm -rf "${d}"; done\n',
);

// 43. Same, on the metadata-present path (after removing its OWN SERVED_FROM_DIR).
proveCleanup(
  '#1521 round-3: metadata teardown also sweeps every knext-empty-dir*',
  '  echo "[e2e-cleanup] removed the suite\'s staged empty dir ${SERVED_FROM_DIR}" >&2\nfi\n',
  '  echo "[e2e-cleanup] removed the suite\'s staged empty dir ${SERVED_FROM_DIR}" >&2\nfi\nfor d in "${RUNNER_TEMP:-/tmp}"/knext-empty-dir*; do rm -rf "${d}"; done\n',
);

// 44. ed_own_dir never registers the dir: nothing removes it on exit.
prove(
  '#1521 round-3: ed_own_dir never registers the dir',
  '  ED_OWNED_DIRS+=("${1:?ed_own_dir needs a dir}")\n',
  '  : "${1:?ed_own_dir needs a dir}"\n',
);

// 45. The owned-dir removal removes nothing.
prove(
  '#1521 round-3: ed__remove_owned_dirs never removes anything',
  '    rm -rf "${d}" || true\n',
  '    : "${d}"\n',
);

// 46. Hand-off no longer disowns the served dir: the deploy's own exit 0
//     would delete the dir the handed-off server is running from.
prove(
  '#1521 round-3: ed_suite_hand_off keeps owning the served dir',
  '  ed_disown_dir "${1:?ed_suite_hand_off needs the served dir}"\n',
  '  : "${1:?ed_suite_hand_off needs the served dir}"\n',
);

// 47. ed_own_dir registers but never arms the EXIT trap (pre-check exits leak).
prove(
  '#1521 round-3: ed_own_dir never arms the EXIT trap',
  '  ED_OWNED_DIRS+=("${1:?ed_own_dir needs a dir}")\n  ed__arm_exit_trap\n',
  '  ED_OWNED_DIRS+=("${1:?ed_own_dir needs a dir}")\n',
);

// 48. The shared EXIT trap drops the owned-dir removal (suite exits leak).
prove(
  '#1521 round-3: the EXIT trap no longer removes owned dirs',
  "  trap 'ed__suite_on_exit; ed__remove_owned_dirs' EXIT\n",
  "  trap 'ed__suite_on_exit' EXIT\n",
);

// 49-52. Each deploy script owns each of its two staged dirs on the line after the mktemp.
proveDeploy(
  '#1521 round-3: e2e-deploy.sh no longer owns the suite dir',
  'knext-empty-dir-suite.XXXXXX")"\n  ed_own_dir "${EMPTY_DIR}"\n',
  'knext-empty-dir-suite.XXXXXX")"\n',
);
proveDeploy(
  '#1521 round-3: e2e-deploy.sh no longer owns the pre-check dir',
  'knext-empty-dir.XXXXXX")"\n      ed_own_dir "${EMPTY_DIR}"\n',
  'knext-empty-dir.XXXXXX")"\n',
);
proveVinext(
  '#1521 round-3: e2e-deploy-vinext.sh no longer owns the suite dir',
  'knext-empty-dir-suite.XXXXXX")"\n  ed_own_dir "${EMPTY_DIR}"\n',
  'knext-empty-dir-suite.XXXXXX")"\n',
);
proveVinext(
  '#1521 round-3: e2e-deploy-vinext.sh no longer owns the pre-check dir',
  'knext-empty-dir.XXXXXX")"\n    ed_own_dir "${EMPTY_DIR}"\n',
  'knext-empty-dir.XXXXXX")"\n',
);

// 53-56. The structural "removed on every exit from the pre-check block" guard:
//        the success path (reviewer attack A2) and a failure branch, both lanes.
proveDeploy(
  '#1521 round-3 (A2): standalone pre-check success path drops its removal',
  '      log "KNEXT_SELF_CONTAINED=1 — empty-dir lane check passed"\n      docker rm -f "${EMPTY_DIR_CONTAINER}" >/dev/null 2>&1 || true\n      rm -rf "${EMPTY_DIR}"\n',
  '      log "KNEXT_SELF_CONTAINED=1 — empty-dir lane check passed"\n      docker rm -f "${EMPTY_DIR_CONTAINER}" >/dev/null 2>&1 || true\n',
);
proveDeploy(
  '#1521 round-3: standalone pre-check "not clean" branch drops its removal',
  '        log "ERROR: KNEXT_SELF_CONTAINED=1 — the staged empty dir is not clean — see above"\n        rm -rf "${EMPTY_DIR}"\n',
  '        log "ERROR: KNEXT_SELF_CONTAINED=1 — the staged empty dir is not clean — see above"\n',
);
proveVinext(
  '#1521 round-3: vinext pre-check success path drops its removal',
  '    log "KNEXT_SELF_CONTAINED=1 — empty-dir lane check passed"\n    rm -rf "${EMPTY_DIR}"\n',
  '    log "KNEXT_SELF_CONTAINED=1 — empty-dir lane check passed"\n',
);
proveVinext(
  '#1521 round-3: vinext pre-check failure branch drops its removal',
  '      # below, and nothing else was ever removing it.\n      rm -rf "${EMPTY_DIR}"\n',
  '      # below, and nothing else was ever removing it.\n',
);

// 57-58. The suite staging-failure branch removes its own dir before exit 1.
proveDeploy(
  '#1521 round-3: standalone suite staging failure drops its removal',
  '    log "ERROR: KNEXT_SELF_CONTAINED=1 — staging the suite\'s empty dir failed"\n    rm -rf "${EMPTY_DIR}"\n',
  '    log "ERROR: KNEXT_SELF_CONTAINED=1 — staging the suite\'s empty dir failed"\n',
);
proveVinext(
  '#1521 round-3: vinext suite staging failure drops its removal',
  '    log "ERROR: KNEXT_SELF_CONTAINED=1 — staging the suite\'s empty dir failed"\n    rm -rf "${EMPTY_DIR}"\n',
  '    log "ERROR: KNEXT_SELF_CONTAINED=1 — staging the suite\'s empty dir failed"\n',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
