#!/usr/bin/env node
/**
 * compat-window-audit — compute the v1.0 compat window from the run ledgers.
 *
 * WHAT THIS IS FOR (#545 AC 1 + AC 3).
 * The v1.0 gate is fourteen consecutive scheduled node-lane nights
 * (docs/compat/window-node-lane.md, docs/V1_ROADMAP.md). Until this script the
 * only way to know how many had accrued was to download every scheduled run's
 * `compat-run-ledger` artifact by hand and read it. That reconstruction has now
 * been done twice by hand — once for docs/wayfinder/w6-compat-flakiness.md
 * (window ending 2026-08-05) and once for the 2026-08-24 release-readiness
 * audit — and two hand reconstructions of the same number is the definition of
 * the folklore #545 asks to replace with "a number someone can watch".
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not make any night count. Every
 * rule here either matches window-node-lane.md or is strictly stricter than it;
 * none is looser. The gate is not weakened to produce a streak.
 *
 * THE RULES, and where each comes from:
 *
 *   1. FINGERPRINT CONTINUITY (window-node-lane.md rule 1). A streak is a run
 *      of nights sharing one `windowFingerprint`. Any change restarts it at
 *      zero. There is no "that change didn't really matter" exception.
 *
 *      Note, because it is easy to miss and it matters when reading a restart:
 *      window-node-lane.md's rule 3 ("zero net new quarantine entries") is
 *      SUBSUMED by rule 1. The frozen harness set
 *      (scripts/compat-window-fingerprint.mjs, HARNESS_ROOTS) includes
 *      `test/deploy-tests-manifest.*.json`, so a quarantine added mid-window
 *      moves the harness digest and restarts the count under rule 1 anyway.
 *      Rule 3 is therefore not separately computable from a ledger, and does
 *      not need to be.
 *
 *   2. EVERY SHARD GREEN (window-node-lane.md rule 2), with the shard-COUNT
 *      assertion that file says the rule needs. An absent shard is not
 *      `failed:1`; it is missing, so a rule read over the shards the ledger
 *      CONTAINS is satisfied vacuously. Run 30790778590 (2026-08-03) is the
 *      live instance: fifteen green shards, the sixteenth lost to a runner
 *      disconnect, ledger totals 730/0/0 — a clean sheet for a night the gate
 *      went red. #695 added `shardsExpected`/`shardsSeen`; this grades on them,
 *      and fails closed when they disagree even if `complete` claims true.
 *
 *   3. FIRST ATTEMPT ONLY (#545's own architecture note: "a shard that needed a
 *      retry is not the same as a shard that passed, and the matrix should not
 *      treat them as equal"). A re-attempted run is not a qualifying night,
 *      whatever it concluded. This is stricter than window-node-lane.md, which
 *      is silent on reruns — and it is the direct mechanical answer to #545's
 *      central worry that "re-running until green is exactly how an unverified
 *      parity claim becomes a ✅".
 *
 *   4. A RECORDED FINGERPRINT (ADR-0039). A night with none has no provable
 *      harness and cannot count.
 *
 *   5. NO SILENTLY-DROPPED NIGHT. A scheduled run whose ledger cannot be
 *      obtained — artifact expired, artifact never uploaded, API or download
 *      failure, unreadable JSON — is recorded as an UNRESOLVED night and
 *      disqualified. It is never an absence.
 *
 *      This is the same rule compat-run-ledger.mjs already states about shards
 *      ("the expected shard count is DECLARED ... and NEVER inferred from what
 *      arrived — inference is the bug"), applied one level up to NIGHTS. An
 *      absent night is not neutral: `auditWindow` would join the nights either
 *      side of it into one streak, so a run that merely failed to download
 *      would report a LONGER streak than reality — the one direction that
 *      flatters us. Failing closed costs nothing: the worst case is a reported
 *      streak shorter than the truth.
 *
 *      Fail-closed used to carry a consequence that only looked free while
 *      there was ONE scheduled lane: the lane of an unresolved night was read
 *      from the ledger — the very thing we could not get — so the night was
 *      admitted to EVERY lane's window, and a lost bun night broke the NODE
 *      streak. #1147 activated a second nightly cron, which put a real price on
 *      that: a runner loss on the bun lane would restart the v1.0 credential
 *      streak for a failure on the other lane.
 *
 *      So the lane is now knowable WITHOUT the ledger. Every run uploads a
 *      LANE MARKER artifact named `compat-lane-<lane>`; `fetchLedgers` reads
 *      that name out of the artifacts LISTING and never downloads it. Two
 *      properties make this sound rather than a softening of rule 5:
 *
 *        * the listing names EXPIRED artifacts too (it is how `artifact-expired`
 *          is already told apart from `no-ledger`), so attribution outlives the
 *          90-day retention the ledger itself does not;
 *        * when the marker cannot be read — the artifacts API is unreachable, or
 *          two markers disagree — the lane stays `null` and the ORIGINAL
 *          fail-closed rule applies unchanged: the night is admitted to every
 *          lane's window.
 *
 *      A night attributed to a lane still disqualifies THAT lane. This buys
 *      cross-lane independence, never a lane laundering its own lost nights.
 *
 *   6. A CREDENTIAL NIGHT RAN ON A FROZEN RC TAG (#850, ADR-0056). The v1.0
 *      credential is earned against a release-candidate tag, not `main`. A
 *      `main` (early-warning) night is EXCLUDED from a credential window the
 *      way a bun night is excluded from the node window — it neither extends a
 *      streak nor restarts one. A night that CLAIMS credential by any one
 *      signal (`credential`, `compatMode`, or an RC-shaped `knextRef`) is
 *      selected and must satisfy all of them, so a forged or half-wired claim
 *      is disqualified (and restarts the count) rather than banked. Streak
 *      continuity stays keyed on the FINGERPRINT, not the ref: cutting rc.N+1
 *      restarts only the cells whose fingerprint moved.
 *
 *      Unresolved nights follow rule 5's shape one axis over: every run also
 *      publishes a `compat-mode-<mode>` marker, so a lost early-warning night
 *      cannot restart a credential window, while a lost night of UNKNOWN mode
 *      is admitted (fail closed).
 *
 *      `--scope early-warning` reports the `main` streak instead. It is a
 *      report about `main`, never a credential: its `met` is always false.
 *
 *   7. BYTECODE CACHING PROVEN LIVE (founder rule, #1221). Bytecode caching
 *      is mandatory in every runtime×builder cell, and a credential night
 *      counts only if EVERY shard carries evidence that every deploy's
 *      caching was live at runtime — bun: the verified compiled exec booted;
 *      node: V8 accepted the compile cache above a floor
 *      (scripts/e2e-bytecode-liveness.mjs holds the one definition). Absent
 *      evidence disqualifies: a ledger from before the rule, or a shard that
 *      dropped the field, cannot credential. Keyed on the cell's RUNTIME, so a
 *      lane wired later inherits it. Credential scope only — the early-warning
 *      report stays comparable across the rule's introduction; its shard jobs
 *      still go red through the workflow's own liveness check.
 *
 *   8. NO SILENTLY-DROPPED NIGHT, CALENDAR EDITION (#1607). Rule 5 disqualifies a
 *      scheduled run whose LEDGER could not be obtained — but a run GitHub never
 *      fires at all (a scheduled-workflow drop under load, a workflow disabled
 *      after 60 days of repo inactivity, an outage) produces no run, no
 *      artifacts, no marker — nothing rule 5 has anything to disqualify. Before
 *      this rule, `auditWindow` only checked SEQUENCE adjacency between the
 *      nights it was handed (did night N+1 share night N's fingerprint?), never
 *      CALENDAR adjacency (was night N+1 the very next scheduled UTC date?), so
 *      a dropped night on an unchanged fingerprint would silently bridge two
 *      streaks into one that never actually ran on the day in between.
 *
 *      The fix derives the expected calendar from the lane's own credential
 *      cron, READ from its workflow file (`parseCredentialCronsFromWorkflow`)
 *      rather than hardcoded here — a moved cron is picked up automatically, a
 *      workflow that stops naming a lane's cron makes the check fail loud
 *      (`credentialCronForLane` throws on a malformed/ambiguous expression)
 *      rather than silently trusting a stale mapping. For every UTC date from
 *      the earliest graded night through a bounded "cutoff" (today only counts
 *      once its cron time plus a `MISSING_NIGHT_GRACE_HOURS` grace window has
 *      passed — a night still plausibly in flight is never called missing), a
 *      date with no graded night at all becomes a synthetic `missing-night`
 *      stand-in, graded exactly like any other unresolved night: disqualified,
 *      restarting the streak (`night-missing`, distinct from `night-unresolved`
 *      so the report does not conflate "we lost the ledger" with "nothing ever
 *      ran"), never silently skipped.
 *
 *      Scope, stated honestly: this check needs a `scheduledAt` timestamp on
 *      every graded night to place it on the calendar. `--fetch` supplies one
 *      (`gh run list`'s `createdAt`); `--dir` ledgers and most existing test
 *      fixtures do not, and offline input mixing dated and undated nights is
 *      refused rather than guessed at. Either way `auditWindow` reports
 *      `calendarChecked` and, when false, `calendarSkippedReason`, so a caller
 *      can never mistake an unchecked window for a verified one. Restricted to
 *      `scope: 'credential'` — the four v1.0 cells' own crons are what a
 *      "fourteen consecutive nights" claim is ever made against; an
 *      early-warning `main` streak is a forecast with no such claim to protect
 *      (`docs/compat/window-node-lane.md`'s own words), so extending the same
 *      cron-derived calendar there is additional blast radius for no bar
 *      currently gated on it.
 *
 * USAGE
 *   node scripts/compat-window-audit.mjs --dir <dir-of-ledger-json>
 *   node scripts/compat-window-audit.mjs --fetch --limit 100  # needs `gh`
 *   node scripts/compat-window-audit.mjs --fetch --lane bun --json
 *   node scripts/compat-window-audit.mjs --fetch --scope early-warning
 *   node scripts/compat-window-audit.mjs --fetch --matrix   # every supported cell
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPAT_MODES, isRcRef } from './compat-credential-ref.mjs';
import { isShardBytecodeLive } from './e2e-bytecode-liveness.mjs';

/** The v1.0 gate: fourteen consecutive qualifying nights. */
export const WINDOW_REQUIRED_NIGHTS = 14;

/** The default lane for a single-lane audit (the node × turbopack cell). */
export const CREDENTIAL_LANE = 'node';

/**
 * The v1.0 credential matrix (#1218, ADR-0056): every SUPPORTED runtime×builder
 * cell earns its own 14-night window. `lane` is the cell's window key — the id
 * its runs publish as `compat-lane-<lane>` and record in the ledger. The two
 * lanes that exist today keep their historical ids (`node`, `bun`); new cells
 * take `<runtime>-<builder>`. `wired` says whether a credential cron produces
 * nights for the cell yet. An unwired cell simply has no nights, so it is NOT
 * met — `auditCredentialMatrix` never treats it as vacuously passing.
 *
 * `workflowFile` (#1294) is the `.github/workflows/*.yml` BASENAME that
 * actually EXECUTES the cell's run — the single declared table
 * `scripts/compat-window-fingerprint.mjs` reads to pick which workflow's bytes
 * are the frozen-set `harness` entry for a given `--lane`. Before this field
 * existed, that entry was hardcoded to `test-e2e-deploy.yml` for every lane, so
 * editing `compat-vinext.yml` never moved the vinext cells' fingerprint — a
 * changed harness there could carry a 14-night window (ADR-0056 D3). A cell
 * with no workflow wired yet (node×vinext) has `null` on purpose, so a caller
 * that tries to fingerprint one fails loudly rather than guessing a file that
 * does not exist. The webpack cells share `test-e2e-deploy.yml` (#1245).
 *
 * `extraFiles` (#1294 round 3) is the DECLARED source of truth for files a
 * cell's run EXECUTES via subprocess (a workflow `run:` step invoking
 * `node knext/scripts/X.mjs`) or READS directly (a JSON pin file), rather than
 * `import`ing/`source`ing them from a closure-entry script — the import/source
 * closure (`compat-window-fingerprint.mjs`) cannot discover these on its own,
 * because nothing in the harness scripts references them as a module or a
 * shell source. `tests/compat-window-fingerprint-execution-scan.test.ts`
 * independently scans the real workflow `run:` steps and every harness
 * script for `node`/`bash`/`${SCRIPT_DIR}`/`${KNEXT_REPO_ROOT}` references and
 * fails if any repo-relative reference it finds is missing from here (or from
 * its own small, reasoned exceptions list) — so a future one of these left
 * undeclared goes red instead of silently unfrozen.
 */
// #1257 — the committed musl-native-addon lockfiles e2e-deploy.sh mounts
// (each file individually, not the directory — extraFiles freezes FILE
// content, and this repo's convention is that adding a new pinned lockfile
// is itself a reviewed, credential-window-affecting change). Shared across
// every cell below since e2e-deploy.sh (and the lookup mechanism it wires
// in) is common harness code, not lane-specific.
const MUSL_NATIVE_LOCKFILE_FILES = Object.freeze([
  'scripts/musl-native-lockfiles/img-sharp-linuxmusl-x64-0.34.5/package.json',
  'scripts/musl-native-lockfiles/img-sharp-linuxmusl-x64-0.34.5/package-lock.json',
  'scripts/musl-native-lockfiles/img-sharp-libvips-linuxmusl-x64-1.2.4/package.json',
  'scripts/musl-native-lockfiles/img-sharp-libvips-linuxmusl-x64-1.2.4/package-lock.json',
  // #1426: sqlite3 is the ORIGINAL motivating case for the musl rebuild
  // script (see its own header's ROUND 2/ROUND 7 notes) but had no
  // committed lockfile pin until now.
  'scripts/musl-native-lockfiles/sqlite3-5.0.2/package.json',
  'scripts/musl-native-lockfiles/sqlite3-5.0.2/package-lock.json',
]);

export const CREDENTIAL_CELLS = Object.freeze([
  Object.freeze({
    runtime: 'node',
    builder: 'turbopack',
    lane: 'node',
    wired: true,
    workflowFile: 'test-e2e-deploy.yml',
    // test-e2e-deploy.yml's credential-ref job runs compat-credential-ref.mjs
    // (reads the RC pin) on EVERY night of this lane; compat-run-ledger.mjs
    // runs at the end of every night, credential or early-warning.
    // scripts/lib/musl-lockfile-lookup.sh (#1257): e2e-deploy.sh bind-mounts
    // it into the musl-rebuild container — a shell `.` source, not something
    // the JS import-closure scanner can discover on its own.
    extraFiles: Object.freeze([
      'scripts/compat-credential-ref.mjs',
      'scripts/compat-run-ledger.mjs',
      '.github/compat-credential-ref.json',
      'scripts/lib/musl-lockfile-lookup.sh',
      // #1530 — the free-disk-floor pre-check the workflow invokes via a
      // `node scripts/compat-disk-floor-check.mjs …` subprocess call, not an
      // `import`/`source` the closure scanner can discover on its own.
      'scripts/compat-disk-floor-check.mjs',
      ...MUSL_NATIVE_LOCKFILE_FILES,
    ]),
  }),
  Object.freeze({
    runtime: 'bun',
    builder: 'turbopack',
    lane: 'bun',
    wired: true,
    workflowFile: 'test-e2e-deploy.yml',
    extraFiles: Object.freeze([
      'scripts/compat-credential-ref.mjs',
      'scripts/compat-run-ledger.mjs',
      '.github/compat-credential-ref.json',
      'scripts/lib/musl-lockfile-lookup.sh',
      // #1530 — the free-disk-floor pre-check the workflow invokes via a
      // `node scripts/compat-disk-floor-check.mjs …` subprocess call, not an
      // `import`/`source` the closure scanner can discover on its own.
      'scripts/compat-disk-floor-check.mjs',
      ...MUSL_NATIVE_LOCKFILE_FILES,
    ]),
  }),
  // #1245: the webpack cells run on the SAME shared credential workflow as the
  // turbopack cells (their own credential crons, '17 22' / '47 23'), so they
  // execute the same script closure.
  Object.freeze({
    runtime: 'node',
    builder: 'webpack',
    lane: 'node-webpack',
    wired: true,
    workflowFile: 'test-e2e-deploy.yml',
    extraFiles: Object.freeze([
      'scripts/compat-credential-ref.mjs',
      'scripts/compat-run-ledger.mjs',
      '.github/compat-credential-ref.json',
      'scripts/lib/musl-lockfile-lookup.sh',
      // #1530 — the free-disk-floor pre-check the workflow invokes via a
      // `node scripts/compat-disk-floor-check.mjs …` subprocess call, not an
      // `import`/`source` the closure scanner can discover on its own.
      'scripts/compat-disk-floor-check.mjs',
      ...MUSL_NATIVE_LOCKFILE_FILES,
    ]),
  }),
  Object.freeze({
    runtime: 'bun',
    builder: 'webpack',
    lane: 'bun-webpack',
    wired: true,
    workflowFile: 'test-e2e-deploy.yml',
    extraFiles: Object.freeze([
      'scripts/compat-credential-ref.mjs',
      'scripts/compat-run-ledger.mjs',
      '.github/compat-credential-ref.json',
      'scripts/lib/musl-lockfile-lookup.sh',
      // #1530 — the free-disk-floor pre-check the workflow invokes via a
      // `node scripts/compat-disk-floor-check.mjs …` subprocess call, not an
      // `import`/`source` the closure scanner can discover on its own.
      'scripts/compat-disk-floor-check.mjs',
      ...MUSL_NATIVE_LOCKFILE_FILES,
    ]),
  }),
  Object.freeze({
    runtime: 'node',
    builder: 'vinext',
    lane: 'node-vinext',
    wired: false,
    // #1294 round 2: `compat-vinext.yml` hardcodes `KNEXT_RUNTIME: bun` — the
    // nitro bun-preset entry calls that runtime's global `serve()`, so there
    // is no node arm to select (see the workflow's own header comment). It is
    // NOT this cell's workflow, and mapping it here would fingerprint a file
    // that runs the WRONG runtime for the cell. `null` until #1260 wires a
    // real node×vinext workflow.
    workflowFile: null,
    extraFiles: Object.freeze([]),
  }),
  Object.freeze({
    runtime: 'bun',
    builder: 'vinext',
    lane: 'bun-vinext',
    wired: false,
    workflowFile: 'compat-vinext.yml',
    // compat-vinext.yml has no credential mode yet (#1294 round 2 note), so it
    // runs compat-run-ledger.mjs but never compat-credential-ref.mjs. It also
    // runs the quarantine ledger (#1321), which reclassifies this cell's
    // results, so the script and the ledger it reads are frozen for THIS cell
    // only (named outside the shared e2e-*/deploy-tests-manifest.* roots).
    extraFiles: Object.freeze([
      'scripts/compat-run-ledger.mjs',
      'scripts/compat-vinext-ledger.mjs',
      'test/compat-vinext-ledger.json',
      'scripts/lib/musl-lockfile-lookup.sh',
      ...MUSL_NATIVE_LOCKFILE_FILES,
    ]),
  }),
]);

/** Which nights a window is built from. `credential` is the v1.0 gate. */
export const AUDIT_SCOPES = Object.freeze(['credential', 'early-warning']);

/**
 * How many runs `--fetch` asks `gh run list` for by default.
 *
 * `gh run list` spans ALL events, not just schedules, so this is not a count of
 * nights. It was 40 while there was one scheduled lane; #1147 added a second
 * nightly cron, which roughly halves the per-lane horizon a given limit buys —
 * a 14-night node window could fall off the end of the list and read as shorter
 * than it is. Sized for both lanes' full windows with headroom for pushes, PRs
 * and dispatches; `tests/compat-window-audit.test.ts` pins the relation rather
 * than the number.
 */
export const DEFAULT_FETCH_LIMIT = 100;

/**
 * Prefix of the per-run artifact whose NAME carries the lane.
 *
 * Read from the artifacts listing, never downloaded — so it attributes a night
 * whose ledger is gone (rule 5). The workflow uploads `compat-lane-${KNEXT_RUNTIME}`;
 * `tests/compat-bun-lane-lockstep.test.ts` locksteps that name to this prefix.
 */
export const LANE_MARKER_PREFIX = 'compat-lane-';

/**
 * The lane a run declares through its marker artifact, or `null` when the
 * markers are absent or disagree (fail closed — see rule 5).
 *
 * @param {Array<{name?: string}>} artifacts
 */
export function laneFromArtifacts(artifacts) {
  const lanes = new Set(
    (Array.isArray(artifacts) ? artifacts : [])
      .map((a) => (typeof a?.name === 'string' ? a.name : ''))
      .filter((name) => name.startsWith(LANE_MARKER_PREFIX))
      .map((name) => name.slice(LANE_MARKER_PREFIX.length))
      .filter((lane) => lane.length > 0),
  );
  return lanes.size === 1 ? [...lanes][0] : null;
}

/**
 * Prefix of the per-run artifact whose NAME carries the run's mode
 * (credential | early-warning). Same contract as the lane marker: read from the
 * listing, never downloaded, so it attributes a night whose ledger is gone.
 */
export const MODE_MARKER_PREFIX = 'compat-mode-';

/**
 * The mode a run declares through its marker artifact, or `null` when absent,
 * unknown or conflicting (fail closed: the night is admitted to credential
 * windows).
 *
 * @param {Array<{name?: string}>} artifacts
 */
export function modeFromArtifacts(artifacts) {
  const modes = new Set(
    (Array.isArray(artifacts) ? artifacts : [])
      .map((a) => (typeof a?.name === 'string' ? a.name : ''))
      .filter((name) => name.startsWith(MODE_MARKER_PREFIX))
      .map((name) => name.slice(MODE_MARKER_PREFIX.length)),
  );
  if (modes.size !== 1) return null;
  const [mode] = [...modes];
  return COMPAT_MODES.includes(mode) ? mode : null;
}

/**
 * Does this ledger CLAIM to be a credential night, by ANY signal? Deliberately
 * a union: a night that says so by one signal is selected into the credential
 * window and then graded on all of them, so a half-wired claim is disqualified
 * rather than silently dropped or silently banked.
 */
export function claimsCredential(ledger) {
  return (
    ledger?.credential === true || ledger?.compatMode === 'credential' || isRcRef(ledger?.knextRef)
  );
}

const REPO = 'getknext-dev/knext';
const WORKFLOW = 'test-e2e-deploy.yml';
const LEDGER_ARTIFACT = 'compat-run-ledger';

/**
 * How many times to try each `gh` call before a night is declared unresolved.
 * Retrying a READ is not the retry ADR-0007 forbids — that rule is about
 * re-running TESTS until they are green. Nothing here can change a verdict; it
 * can only change whether we managed to read one.
 */
const FETCH_ATTEMPTS = 3;

/**
 * Sum a shard's counts, treating a null/absent count as UNKNOWN rather than
 * zero. #695's "missing" rows carry nulls precisely so they cannot be summed
 * into a clean sheet; `null + 0` is 0 in JS and that is the trap.
 *
 * @returns {{value: number, unknown: boolean}}
 */
function count(shard, key) {
  const raw = shard?.[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { value: 0, unknown: true };
  return { value: raw, unknown: false };
}

/**
 * Whether a shard's redness is ENTIRELY attributable to `kind: 'deploy'`
 * failures (#1520, raised from #1515) — a `createNext` deploy-script/harness
 * failure (`Custom deploy script failed: …` / `…returned invalid URL: …`).
 * Run 36312054519 is the motivating case: 419 files failed this way and the
 * ledger read as "the binary serves wrong responses" until the shard logs
 * were checked by hand.
 *
 * USED FOR LABELLING ONLY (round 2, #1550, lead-directed) — NOT for grading.
 * A round-1 review found that a `createNext` failure is NOT reliably
 * evidence-free: `scripts/e2e-deploy.sh` runs `next build` through the knext
 * adapter under test and boots the knext server, so "Custom deploy script
 * failed" is also what an adapter build crash or a server crash-on-boot
 * reports. Grading such a night VOID (bridged over the streak, per the
 * original #1520 design) let a real product regression go uncounted. The
 * credential's integrity wins: this function only decides whether a red
 * shard's disqualifier text is prefixed `deploy-classified:` for readability
 * — the shard still counts as a real red either way (see `gradeNight`).
 * Whether a proven-safe subset of deploy failures should someday be exempted
 * from counting is tracked as #1553, undecided here.
 *
 * Fails CLOSED, deliberately stricter than it needs to be for the happy path:
 *   - no `shard.failures` attribution at all → NOT deploy-only (an
 *     unattributed red is a real red; older ledgers predate #545 attribution);
 *   - `shard.failures.length` disagreeing with the shard's own `failed` count
 *     → NOT deploy-only (the attribution does not cover every failure, so it
 *     cannot vouch for all of them);
 *   - `notRun > 0` → NEVER deploy-only. `notRun` is the PRE-EXISTING
 *     jest-infra-abort category (A3-3, #147) — a different harness failure
 *     mode #1520 is not scoped to, and conflating the two would mislabel an
 *     ordinary "jest could not locate the file" abort.
 *
 * @param {any} shard
 * @param {number} failedCount
 * @param {number} notRunCount
 * @returns {boolean}
 */
function isDeployOnlyRedShard(shard, failedCount, notRunCount) {
  if (notRunCount > 0 || failedCount === 0) return false;
  const failures = Array.isArray(shard?.failures) ? shard.failures : null;
  if (!failures || failures.length !== failedCount) return false;
  return failures.every((f) => f?.kind === 'deploy');
}

/**
 * Whether a shard's redness is an INFRA fault (#1530) — the runner's
 * free-disk floor breached before the shard ran a single test
 * (`scripts/compat-disk-floor-check.mjs`), never a real test regression.
 *
 * USED FOR LABELLING ONLY, exactly like `isDeployOnlyRedShard` above: the
 * shard still counts as a real red either way (a disk-exhausted shard proved
 * nothing about the knext ref under test, so it must never be a green night
 * either — see the doc comment there for why "never a pass" and "still
 * disqualifies" are the correct combination). This only decides whether the
 * disqualifier text is prefixed `infra-classified:` for readability, so
 * triage is not misdirected at a phantom assertion regression.
 *
 * Deliberately requires `failedCount === 0` (unlike the deploy check, which
 * requires `notRunCount === 0`): a disk-floor abort reports its outage as
 * `notRun`, never `failed` — there is no genuine test failure to attribute,
 * only a runner precondition that was never met. Any REAL `failed` count
 * alongside an infra marker disqualifies the label, same fail-closed
 * direction as the deploy check.
 *
 * @param {any} shard
 * @param {number} failedCount
 * @returns {boolean}
 */
function isInfraOnlyRedShard(shard, failedCount) {
  if (failedCount > 0) return false;
  const failures = Array.isArray(shard?.failures) ? shard.failures : null;
  if (!failures || failures.length === 0) return false;
  return failures.every((f) => f?.kind === 'infra');
}

/**
 * The reasons a scheduled run can end up with no gradeable ledger. Every one of
 * them produces a DISQUALIFIED night (rule 5), never a gap in the record.
 */
export const UNRESOLVED_REASONS = Object.freeze([
  'no-ledger', // the run uploaded no `compat-run-ledger` artifact at all
  'artifact-expired', // it did, and GitHub has since expired it
  'artifact-api-unreachable', // the artifacts API call failed
  'artifact-download-failed', // listed as live, but the download failed
  'ledger-unreadable', // downloaded, but nothing in it parses as a ledger
  // #1607 — distinct from every reason above: those all describe a run that
  // EXISTED (gh run list named it) but left no gradeable ledger. This one is a
  // scheduled UTC date with NO RUN AT ALL — GitHub never fired the cron, so
  // there is nothing to list, download or fail to read. Synthesized by
  // `auditWindow`'s calendar check (rule 8), never produced by `fetchLedgers`.
  'missing-night',
]);

/**
 * A stand-in for a scheduled run whose ledger could not be obtained — or, with
 * reason `missing-night`, for a scheduled UTC date on which no run happened at
 * all (rule 8, #1607).
 *
 * `lane` is what the run's MARKER artifact declared, or `null` when even that
 * could not be read. A `null` lane keeps the original fail-closed behaviour —
 * `selectLaneNights` admits the night into every lane's window (rule 5) — while
 * a known lane confines the damage to the lane that actually lost the night.
 *
 * @param {string|number} runId
 * @param {typeof UNRESOLVED_REASONS[number]} reason
 * @param {string|null} [lane] the lane declared by the marker artifact
 * @param {string|null} [mode] the mode declared by the mode marker artifact
 * @param {string|null} [scheduledAt] ISO datetime this night was scheduled/observed at (#1607) —
 *   `fetchLedgers` supplies the run's `createdAt`; the calendar check supplies
 *   the lane's cron time on the missing date. `null` when unknown, which keeps
 *   the night invisible to the calendar check (it cannot place an undated
 *   night, so it declines to check rather than guess — see rule 8).
 */
export function unresolvedNight(runId, reason, lane = null, mode = null, scheduledAt = null) {
  if (!UNRESOLVED_REASONS.includes(reason)) {
    throw new Error(`compat-window-audit: unknown unresolved reason ${reason}`);
  }
  return {
    runId: String(runId),
    event: 'schedule',
    lane: typeof lane === 'string' && lane.length > 0 ? lane : null,
    compatMode: COMPAT_MODES.includes(mode) ? mode : null,
    unresolved: reason,
    scheduledAt: typeof scheduledAt === 'string' && scheduledAt.length > 0 ? scheduledAt : null,
    shards: [],
  };
}

/** Is this entry a stand-in for a run whose ledger we never got? */
export function isUnresolved(ledger) {
  return typeof ledger?.unresolved === 'string' && ledger.unresolved.length > 0;
}

/**
 * The UTC calendar date (`YYYY-MM-DD`) `ledger.scheduledAt` places this night
 * on, or `null` when absent/unparseable (#1607). This is the ONLY place a night
 * is dated — `fetchLedgers` stamps real nights with the run's `createdAt`, and
 * the calendar check stamps a synthetic `missing-night` with the lane's own
 * cron time on the missing date, so both flow through the same function here.
 *
 * @param {Record<string, any>} ledger
 * @returns {string|null}
 */
function nightDateOf(ledger) {
  const raw = ledger?.scheduledAt;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Grade ONE run ledger against every rule a single night can be judged on
 * alone (rule 1 is cross-night and lives in `auditWindow`).
 *
 * @param {Record<string, any>} ledger a parsed `compat-run-ledger` artifact
 * @param {{lane?: string, scope?: string}} [opts]
 */
export function gradeNight(ledger, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
  const scope = opts.scope ?? 'credential';
  // A night we could not read is disqualified on that fact alone. Grading it
  // against the other rules would be theatre — every field it would be judged
  // on is missing precisely because the ledger is.
  if (isUnresolved(ledger)) {
    return {
      runId: String(ledger.runId ?? ''),
      lane: null,
      event: ledger.event ?? null,
      runAttempt: null,
      ref: null,
      knextRef: null,
      knextSha: null,
      compatMode: ledger.compatMode ?? null,
      fingerprint: null,
      fingerprintComponents: null,
      shardsExpected: null,
      shardsSeen: 0,
      passed: 0,
      failed: 0,
      notRun: 0,
      disqualifiers: [ledger.unresolved],
      eligible: false,
      unresolved: ledger.unresolved,
      date: nightDateOf(ledger),
    };
  }
  const disqualifiers = [];
  const shards = Array.isArray(ledger?.shards) ? ledger.shards : [];

  let passed = 0;
  let failed = 0;
  let notRun = 0;
  for (const shard of shards) {
    const p = count(shard, 'passed');
    const f = count(shard, 'failed');
    const n = count(shard, 'notRun');
    passed += p.value;
    failed += f.value;
    notRun += n.value;
    const id = shard?.shard ?? '(unnamed shard)';
    if (p.unknown || f.unknown || n.unknown || shard?.status === 'missing') {
      disqualifiers.push(`shard ${id} has no recorded result`);
    } else if (f.value > 0 || n.value > 0) {
      // Round 2 (#1550): a deploy-classified red is labelled for readability
      // but disqualifies the night exactly like any other red — see
      // `isDeployOnlyRedShard`'s doc comment for why the original VOID grade
      // was removed.
      disqualifiers.push(
        isDeployOnlyRedShard(shard, f.value, n.value)
          ? `deploy-classified: shard ${id} red (failed=${f.value} notRun=${n.value}) — every ` +
              'named failure is kind:deploy (a harness/deploy-script failure; #1520/#1553)'
          : isInfraOnlyRedShard(shard, f.value)
            ? `infra-classified: shard ${id} red (failed=${f.value} notRun=${n.value}) — the ` +
              'free-disk floor aborted this shard before it ran a single test (#1530); it ' +
              'still disqualifies the night (a runner fault proves nothing either way about ' +
              'the ref under test) but is never mistaken for kind:assertion'
            : `shard ${id} red (failed=${f.value} notRun=${n.value})`,
      );
    }
  }

  if (ledger?.lane !== lane) {
    disqualifiers.push(`lane ${String(ledger?.lane)} is not the ${lane} lane`);
  }
  if (ledger?.event !== 'schedule') {
    disqualifiers.push(`event ${String(ledger?.event)} is not a scheduled night`);
  }
  if (String(ledger?.runAttempt ?? '1') !== '1') {
    // Listed as the bare token `rerun` so a caller can branch on it: this is
    // #545's re-run-until-green vector and deserves to be distinguishable from
    // an ordinary red.
    disqualifiers.push('rerun');
  }
  if (typeof ledger?.windowFingerprint !== 'string' || ledger.windowFingerprint.length === 0) {
    disqualifiers.push('no-fingerprint');
  }
  // Rule 6 (ADR-0056): a credential night ran on a frozen RC tag, says so, and
  // names the commit. All three, because a claim by any one of them is what
  // selected the night — anything less is a half-wired claim.
  if (scope === 'credential') {
    if (!isRcRef(ledger?.knextRef)) {
      disqualifiers.push(
        `non-credential-ref: ${String(ledger?.knextRef ?? null)} is not an RC tag`,
      );
    }
    if (ledger?.credential !== true || ledger?.compatMode !== 'credential') {
      disqualifiers.push('not-a-credential-run');
    }
    if (!/^[0-9a-f]{40}$/.test(String(ledger?.knextSha ?? ''))) {
      disqualifiers.push('no-knext-sha');
    }
    // Rule 7: bytecode caching proven LIVE on every shard, for the CELL's
    // runtime. Keyed on the runtime (not the lane or builder) so a cell wired
    // later inherits it. A lane that is not a credential cell has no runtime to
    // prove against, and fails closed like missing evidence does.
    const cellRuntime = CREDENTIAL_CELLS.find((c) => c.lane === lane)?.runtime ?? null;
    for (const shard of shards) {
      if (shard?.status === 'missing') continue; // already disqualified above
      const verdict = isShardBytecodeLive(shard?.bytecode, cellRuntime);
      if (!verdict.live) {
        disqualifiers.push(
          `bytecode-not-live: shard ${shard?.shard ?? '(unnamed shard)'} — ${verdict.reason}`,
        );
      }
    }
  }

  // The shard-COUNT assertion. `shardsExpected` is what the run intended to
  // produce; `shardsSeen` and the actual row count are what it did. Any
  // disagreement is a short ledger, and a short ledger is not a green night —
  // whatever `complete` says about itself.
  const expected = typeof ledger?.shardsExpected === 'number' ? ledger.shardsExpected : null;
  const seen = typeof ledger?.shardsSeen === 'number' ? ledger.shardsSeen : shards.length;
  if (expected !== null && (seen !== expected || shards.length !== expected)) {
    disqualifiers.push(
      `short-ledger: ${Math.min(seen, shards.length)} of ${expected} shards recorded`,
    );
  } else if (expected === null) {
    // Ledgers produced before #695 carry no shardsExpected. Fall back to the
    // shard ids' own denominator ("6/16") rather than assuming the run was
    // whole — the pre-#695 artifacts are exactly the ones that could be short.
    const denominators = new Set(
      shards.map((s) => String(s?.shard ?? '').split('/')[1]).filter(Boolean),
    );
    const denom = denominators.size === 1 ? Number([...denominators][0]) : null;
    if (denom && shards.length !== denom) {
      disqualifiers.push(`short-ledger: ${shards.length} of ${denom} shards recorded`);
    }
  }
  if (ledger?.complete === false) {
    disqualifiers.push('incomplete-ledger');
  }
  for (const missing of ledger?.missingShards ?? []) {
    disqualifiers.push(`shard ${missing} missing`);
  }

  return {
    runId: String(ledger?.runId ?? ''),
    lane: ledger?.lane ?? null,
    event: ledger?.event ?? null,
    runAttempt: String(ledger?.runAttempt ?? '1'),
    ref: ledger?.ref ?? null,
    knextRef: ledger?.knextRef ?? null,
    knextSha: ledger?.knextSha ?? null,
    compatMode: ledger?.compatMode ?? null,
    fingerprint: ledger?.windowFingerprint ?? null,
    // ADR-0039's two halves — `harness` (the workflow, scripts/e2e-*, the deploy
    // manifest) and `packed` (the built @getknext/* closure). Kept because
    // "what must be frozen to reach 14 nights" is answerable ONLY from these:
    // a move attributable to `harness` alone is not prevented by freezing
    // `dist/**`.
    fingerprintComponents:
      ledger?.windowFingerprintComponents && typeof ledger.windowFingerprintComponents === 'object'
        ? { ...ledger.windowFingerprintComponents }
        : null,
    shardsExpected: expected,
    shardsSeen: shards.length,
    passed,
    failed,
    notRun,
    disqualifiers: [...new Set(disqualifiers)],
    eligible: disqualifiers.length === 0,
    unresolved: null,
    date: nightDateOf(ledger),
  };
}

/**
 * The runs that are candidate nights for THIS window: scheduled runs of this
 * lane, oldest first.
 *
 * The bun weekly interleaves with the node nightly in the same workflow, and it
 * is NOT a failed node night — it is not a node night at all. Filtering before
 * grading is what keeps a red bun weekly from resetting the node credential's
 * streak, which is the lane separation ADR-0007 §g draws in the ledger.
 *
 * UNRESOLVED runs (rule 5) are the one exception, and they split in two:
 *
 *   * one whose MARKER artifact named its lane belongs to that lane only. It
 *     still disqualifies a night THERE — the marker buys cross-lane
 *     independence, not amnesty.
 *   * one with NO knowable lane is admitted into EVERY lane, because its lane
 *     is exactly what we failed to read. Excluding it "because it is probably
 *     the other lane" is the inference the ledger forbids, and it is the
 *     inference that merges two streaks into one.
 */
export function selectLaneNights(ledgers, lane = CREDENTIAL_LANE, scope = 'credential') {
  if (!AUDIT_SCOPES.includes(scope)) {
    throw new Error(`compat-window-audit: unknown scope ${scope}`);
  }
  return ledgers
    .filter(
      (l) => l?.event === 'schedule' && (l?.lane === lane || (isUnresolved(l) && l?.lane == null)),
    )
    .filter((l) => inScope(l, scope))
    .sort((a, b) => Number(a.runId) - Number(b.runId));
}

/**
 * Rule 6's selection half. A `main` night is NOT a failed credential night — it
 * is not a credential night at all — so it is filtered out BEFORE grading,
 * exactly as a bun night is filtered out of the node window. Were it graded
 * instead, a red `main` night would restart the credential count; were it
 * counted, `main` would advance it. Neither may happen.
 *
 * An unresolved night is placed by its MODE marker; with no readable mode it is
 * admitted to BOTH scopes, because its mode is exactly what we failed to read.
 */
function inScope(ledger, scope) {
  if (isUnresolved(ledger)) {
    const mode = ledger?.compatMode ?? null;
    if (mode === null) return true;
    return scope === 'credential' ? mode === 'credential' : mode === 'early-warning';
  }
  if (scope !== 'credential') return !claimsCredential(ledger);
  if (claimsCredential(ledger)) return true;
  // #1605: a resolved ledger reaching this point has ALREADY matched this
  // window's `lane` and `event: 'schedule'` — selectLaneNights's own first
  // filter runs before `inScope` is ever called. So this is never "some
  // other lane's night" the way a bun weekly or a workflow_dispatch run is.
  //
  // An EXPLICIT `compatMode: 'early-warning'` night IS a real, different
  // night (a main run) and stays excluded here — never graded, never a
  // disqualifier — exactly as rule 6 requires: it must neither advance nor
  // break the credential streak.
  if (ledger?.compatMode === 'early-warning') return false;
  // Everything else that reaches here claims nothing: `compatMode` is absent
  // or `null` — a workflow run that never wrote `KNEXT_COMPAT_MODE`, or a
  // ledger produced before ADR-0056 existed (nothing in a ledger's shape
  // tells the two apart, and treating them differently would reopen this
  // same hole for old runs still inside the fetch horizon). The OLD
  // behaviour excluded it here too, which removed it from `nights` entirely
  // and let `auditWindow` bridge the streaks either side of it as if it had
  // never run (13 green + 30 mode-less + 1 green read as one 14-night
  // streak). It must instead stay IN the sequence and be GRADED — which
  // disqualifies it via `gradeNight`'s existing `not-a-credential-run`/
  // `non-credential-ref` checks — the same "disqualify, never skip" shape
  // rule 5 already uses for a night whose ledger could not be read at all.
  return true;
}

// ── Rule 8 — the missing-night calendar (#1607) ─────────────────────────────
//
// Deliberately regex-based, NOT a YAML parse: the one production caller that
// matters (`.github/workflows/compat-matrix-tracker-nightly.yml`) runs this
// script with only `actions/setup-node` — no `npm ci`/`bun install` step — so
// `node_modules` does not exist there and an `import 'yaml'` would throw on
// the exact path this rule protects. Reading the two `env:` expression lines
// this script already depends on staying in sync with (`KNEXT_COMPAT_MODE`,
// `KNEXT_LANE` — both named in the file header's rule 8 note) is a documented,
// narrow read of real workflow text, not a hardcoded cron↔lane table.

const KNEXT_COMPAT_MODE_LINE_RE = /KNEXT_COMPAT_MODE:\s*\$\{\{([^\n]+)\}\}/;
const KNEXT_LANE_LINE_RE = /KNEXT_LANE:\s*\$\{\{([^\n]+)\}\}/;
const SCHEDULE_CREDENTIAL_CRON_RE = /github\.event\.schedule == '([^']+)' && 'credential'/g;
const SCHEDULE_LANE_PAIR_RE = /github\.event\.schedule == '([^']+)' && '([^']+)'/g;
const LANE_DEFAULT_RE = /\|\|\s*'([^']+)'\s*$/;

/**
 * Read `KNEXT_COMPAT_MODE`/`KNEXT_LANE` out of a workflow's raw text and
 * return the ONE credential cron each lane runs on. Throws rather than
 * guessing on anything it cannot parse confidently — the two lines it needs,
 * a lane claiming two credential crons — because a wrong answer here silently
 * points the calendar check at the wrong dates.
 *
 * @param {string} workflowText
 * @returns {Map<string, string>} lane → cron (`'m h * * *'`)
 */
export function parseCredentialCronsFromWorkflow(workflowText) {
  const modeLine = workflowText.match(KNEXT_COMPAT_MODE_LINE_RE);
  if (!modeLine) {
    throw new Error(
      'compat-window-audit: no KNEXT_COMPAT_MODE env line found — cannot derive credential crons',
    );
  }
  const credentialCrons = new Set(
    [...modeLine[1].matchAll(SCHEDULE_CREDENTIAL_CRON_RE)].map((m) => m[1]),
  );

  const laneLine = workflowText.match(KNEXT_LANE_LINE_RE);
  if (!laneLine) {
    throw new Error(
      'compat-window-audit: no KNEXT_LANE env line found — cannot derive a cron`s lane',
    );
  }
  const laneExpr = laneLine[1];
  const explicitLaneByCron = new Map(
    [...laneExpr.matchAll(SCHEDULE_LANE_PAIR_RE)].map((m) => [m[1], m[2]]),
  );
  const defaultLaneMatch = laneExpr.match(LANE_DEFAULT_RE);
  if (!defaultLaneMatch) {
    throw new Error(
      'compat-window-audit: KNEXT_LANE has no trailing default lane literal — cannot derive the ' +
        'lane of a credential cron it does not name explicitly',
    );
  }
  const defaultLane = defaultLaneMatch[1];

  /** @type {Map<string, string>} */
  const laneToCron = new Map();
  for (const cron of credentialCrons) {
    const lane = explicitLaneByCron.get(cron) ?? defaultLane;
    if (laneToCron.has(lane)) {
      throw new Error(
        `compat-window-audit: both '${laneToCron.get(lane)}' and '${cron}' map to lane '${lane}' — ` +
          'the calendar check assumes exactly one credential cron per lane',
      );
    }
    laneToCron.set(lane, cron);
  }
  return laneToCron;
}

const workflowCronCache = new Map();

/**
 * The credential cron for `lane`, read from its cell's `workflowFile`, or
 * `null` when the cell is unwired / names no workflow / the workflow names no
 * cron for it. Cached per workflow file (the file does not change mid-process).
 *
 * @param {string} lane
 * @param {{ readWorkflow?: (workflowFile: string) => string }} [deps] injectable for tests
 * @returns {string|null}
 */
export function credentialCronForLane(lane, deps = {}) {
  const cell = CREDENTIAL_CELLS.find((c) => c.lane === lane);
  if (!cell?.wired || !cell.workflowFile) return null;
  const readWorkflow =
    deps.readWorkflow ??
    ((workflowFile) =>
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', workflowFile),
        'utf8',
      ));
  let laneToCron = workflowCronCache.get(cell.workflowFile);
  if (!laneToCron) {
    laneToCron = parseCredentialCronsFromWorkflow(readWorkflow(cell.workflowFile));
    workflowCronCache.set(cell.workflowFile, laneToCron);
  }
  return laneToCron.get(lane) ?? null;
}

/** `'m h * * *'` → `{hour, minute}` (UTC). Throws on anything but a daily cron. */
function cronTimeUTC(cron) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`compat-window-audit: '${cron}' is not a 5-field cron expression`);
  }
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*' || dow !== '*') {
    throw new Error(
      `compat-window-audit: '${cron}' is not a daily '* * *' cron — the calendar check assumes ` +
        'exactly one expected credential run per UTC day',
    );
  }
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
    throw new Error(`compat-window-audit: '${cron}' has a non-numeric or out-of-range hour/minute`);
  }
  return { hour: h, minute: m };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `Date` → its UTC calendar date, `YYYY-MM-DD`. */
function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` + a day offset (may be negative) → `YYYY-MM-DD`, in UTC. */
function addUTCDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateString(d);
}

/** Every UTC date from `from` to `to`, inclusive, one per day. */
function datesInclusive(from, to) {
  const out = [];
  let cur = from;
  // A guard, not a real limit: at one row/day this is ~27 years before it
  // fires, so it can only mean `to` < `from` was passed by mistake.
  for (let i = 0; cur <= to && i < 10000; i += 1) {
    out.push(cur);
    cur = addUTCDays(cur, 1);
  }
  return out;
}

/**
 * How long, after a night's cron time, before its absence counts as
 * "missing" rather than "still plausibly running". `test-e2e-deploy.yml`'s own
 * comment says a credential run "takes the better part of an hour"; this adds
 * generous headroom on top for queueing/runner-availability delay before
 * declaring a silent night rather than a slow one — chosen deliberately larger
 * than the measured run length so a night that is merely late is never
 * mistaken for one that never happened.
 */
export const MISSING_NIGHT_GRACE_HOURS = 6;

/**
 * The latest UTC date a lane's night is REQUIRED to exist by, given `now`: today,
 * if its cron time plus the grace window has already passed; yesterday
 * otherwise (today's night has not had its full chance yet).
 *
 * @param {string} cron
 * @param {Date} now
 * @returns {string}
 */
function cutoffDate(cron, now) {
  const { hour, minute } = cronTimeUTC(cron);
  const today = utcDateString(now);
  const todayCronMs = Date.parse(`${today}T${pad2(hour)}:${pad2(minute)}:00.000Z`);
  const dueMs = todayCronMs + MISSING_NIGHT_GRACE_HOURS * 60 * 60 * 1000;
  return now.getTime() >= dueMs ? today : addUTCDays(today, -1);
}

/**
 * Rule 8: find every UTC date, between the earliest real night and the
 * lane's cutoff, that no real night landed on — and synthesize a disqualified
 * `missing-night` stand-in for each. Returns the ORIGINAL ledgers unchanged
 * when the check cannot run (see the returned `reason`), and never partially
 * applies it.
 *
 * @param {Array<Record<string, any>>} selected real ledgers already filtered to this lane+scope
 * @param {string} lane
 * @param {string} scope
 * @param {Date} now
 * @param {{ credentialCronForLane?: typeof credentialCronForLane }} [deps]
 */
function missingNightLedgers(selected, lane, scope, now, deps = {}) {
  const findCron = deps.credentialCronForLane ?? credentialCronForLane;
  if (scope !== 'credential') {
    return {
      checked: false,
      reason: 'the calendar check is scoped to credential nights only (rule 8)',
      extra: [],
    };
  }
  const cron = findCron(lane);
  if (!cron) {
    return {
      checked: false,
      reason: `lane '${lane}' has no discovered credential cron (unwired, or the workflow names no cron for it)`,
      extra: [],
    };
  }
  const dated = selected.map((l) => nightDateOf(l));
  if (selected.length === 0 || dated.some((d) => d === null)) {
    return {
      checked: false,
      reason:
        selected.length === 0
          ? 'no graded night to anchor a calendar against'
          : `${dated.filter((d) => d === null).length} of ${selected.length} graded night(s) carry no ` +
            'scheduling date (offline --dir input, or fixtures without scheduledAt) — the calendar ' +
            'check is skipped rather than applied to a partial calendar',
      extra: [],
    };
  }
  const known = new Set(dated);
  const first = dated.reduce((min, d) => (d < min ? d : min), dated[0]);
  const cutoff = cutoffDate(cron, now);
  const expected = first <= cutoff ? datesInclusive(first, cutoff) : [];
  const missing = expected.filter((d) => !known.has(d));
  const { hour, minute } = cronTimeUTC(cron);
  const extra = missing.map((d) =>
    unresolvedNight(
      `missing:${lane}:${d}`,
      'missing-night',
      lane,
      scope === 'credential' ? 'credential' : null,
      `${d}T${pad2(hour)}:${pad2(minute)}:00.000Z`,
    ),
  );
  return { checked: true, reason: null, extra };
}

/**
 * Compute the window: every night graded, grouped into fingerprint-stable
 * streaks of qualifying nights.
 *
 * @param {Array<Record<string, any>>} ledgers
 * @param {{lane?: string, requiredNights?: number, scope?: string, now?: Date}} [opts]
 */
export function auditWindow(ledgers, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
  const requiredNights = opts.requiredNights ?? WINDOW_REQUIRED_NIGHTS;
  const scope = opts.scope ?? 'credential';
  const now = opts.now ?? new Date();

  const selected = selectLaneNights(ledgers ?? [], lane, scope);
  // Rule 8 (#1607): a date with no run at all leaves nothing for rule 5's
  // fail-closed handling to catch, because there is no run for it to attach
  // to. Synthesize the missing dates as their own disqualified stand-ins
  // BEFORE grading, so they sort into the sequence exactly like a real
  // unresolved night and break a streak that sequence-adjacency alone would
  // have silently bridged.
  const calendar = missingNightLedgers(selected, lane, scope, now);
  const merged = calendar.extra.length === 0 ? selected : [...selected, ...calendar.extra];
  const dateKey = (l) => nightDateOf(l) ?? '';
  merged.sort((a, b) => {
    const da = dateKey(a);
    const db = dateKey(b);
    if (da !== db) return da < db ? -1 : 1;
    return Number(a.runId ?? 0) - Number(b.runId ?? 0);
  });
  const nights = merged.map((l) => gradeNight(l, { lane, scope }));

  /** @type {Array<{fingerprint: string, nights: number, runIds: string[], startRunId: string, endRunId: string, restartCause: string|null}>} */
  const streaks = [];
  let open = null;
  // Why the NEXT streak restarted, carried across the disqualified nights that
  // caused it. Without this a red night followed by a green one would report
  // "fingerprint-changed", blaming the wrong rule for the reset.
  let pendingCause = null;
  for (const night of nights) {
    if (!night.eligible) {
      // A disqualified night restarts the count. It does not pause it — and an
      // UNRESOLVED night (rule 5) is disqualified, not absent, which is what
      // stops the nights either side of it merging into one longer streak.
      // A rule-8 MISSING night (no run at all) gets its own cause so the
      // report never conflates "we lost the ledger" with "nothing ever ran".
      open = null;
      pendingCause =
        night.unresolved === 'missing-night'
          ? 'night-missing'
          : night.unresolved
            ? 'night-unresolved'
            : 'night-disqualified';
      continue;
    }
    if (open && open.fingerprint === night.fingerprint) {
      open.nights += 1;
      open.runIds.push(night.runId);
      open.endRunId = night.runId;
      continue;
    }
    // The very first streak of the window was not "restarted" by anything.
    const restartCause =
      pendingCause ??
      (open ? 'fingerprint-changed' : streaks.length > 0 ? 'fingerprint-changed' : null);
    pendingCause = null;
    open = {
      fingerprint: night.fingerprint,
      nights: 1,
      runIds: [night.runId],
      startRunId: night.runId,
      endRunId: night.runId,
      restartCause,
    };
    streaks.push(open);
  }

  // ── The arithmetic, computed here so nobody has to do it by hand ──────────
  //
  // Every count a reader might otherwise derive from the table above is
  // produced here instead. `window-node-lane.md` and W6 §8 both state their
  // restart and fingerprint numbers as "the audit's output"; that is only true
  // if the audit actually emits them. Three of those numbers were previously
  // hand-arithmetic that disagreed with this script.
  //
  // Note the two are NOT the same count and must not be conflated:
  //   * a fingerprint MOVE is a property of the fingerprint sequence;
  //   * a streak RESTART is a property of the streak sequence.
  // A move that lands on a night which was disqualified anyway (2026-08-03) is
  // one move but is booked as a `night-disqualified` restart, because that is
  // the rule that actually reset the count.
  const restartsByCause = {};
  for (const s of streaks) {
    if (!s.restartCause) continue;
    restartsByCause[s.restartCause] = (restartsByCause[s.restartCause] ?? 0) + 1;
  }

  const fingerprinted = nights.filter((n) => n.fingerprint);
  /** @type {Array<{runId: string, from: string, to: string, componentsChanged: string[]}>} */
  const fingerprintMoves = [];
  for (let i = 1; i < fingerprinted.length; i += 1) {
    const prev = fingerprinted[i - 1];
    const now = fingerprinted[i];
    if (prev.fingerprint === now.fingerprint) continue;
    const a = prev.fingerprintComponents ?? {};
    const b = now.fingerprintComponents ?? {};
    const componentsChanged = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => a[k] !== b[k])
      .sort();
    fingerprintMoves.push({
      runId: now.runId,
      from: prev.fingerprint,
      to: now.fingerprint,
      componentsChanged,
    });
  }
  // How many moves each frozen component participated in. This is what decides
  // whether a freeze scoped to one component would have been sufficient — a
  // move with `componentsChanged: ['harness']` is one no `dist/**` freeze
  // prevents.
  const movesByComponent = {};
  for (const m of fingerprintMoves) {
    for (const k of m.componentsChanged) movesByComponent[k] = (movesByComponent[k] ?? 0) + 1;
  }

  const empty = { fingerprint: null, nights: 0, runIds: [], startRunId: null, endRunId: null };
  const longest = streaks.reduce((best, s) => (s.nights > best.nights ? s : best), empty);
  // "Current" is the streak that is still open — i.e. one that runs to the last
  // graded night. A streak broken by a later red is history, not the count.
  const last = streaks.at(-1);
  const current = last && last.endRunId === nights.at(-1)?.runId ? last : empty;

  // The two fields below deliberately read DIFFERENT streaks, and which one
  // each reads is the answer to a different question:
  //
  //   `met`      — has a window of the required length EVER completed on this
  //                lane? That is a property of history, so it reads `longest`.
  //                A completed window is a credential that was earned; the
  //                compat matrix's own flip-back policy is what revokes it on a
  //                later red, not this script retroactively un-earning it.
  //   `shortfall`— how many more nights from HERE? That is a property of the
  //                streak still running, so it reads `current`.
  //
  // So `met: true` with a non-zero `shortfall` is a real and meaningful state
  // (a window completed, then a fingerprint moved), not a contradiction —
  // `formatReport` prints both numbers whenever they disagree so the verdict
  // line can never be read as "we are fourteen nights green right now".
  return {
    lane,
    scope,
    requiredNights,
    nights,
    streaks,
    longest,
    current,
    restartsByCause,
    fingerprintsRecorded: fingerprinted.length,
    distinctFingerprints: new Set(fingerprinted.map((n) => n.fingerprint)).size,
    fingerprintMoves,
    movesByComponent,
    // Rule 5: surfaced separately so a caller cannot mistake a night we could
    // not read for a night that did not happen.
    unresolvedNights: nights
      .filter((n) => n.unresolved)
      .map((n) => ({
        runId: n.runId,
        reason: n.unresolved,
        ...(n.date ? { date: n.date } : {}),
      })),
    // Rule 8 (#1607). `checked: false` means exactly what it says — no
    // calendar claim was verified for this window, never "verified and clean".
    // `formatReport`/every caller must read `calendarChecked` before trusting
    // consecutiveness beyond what `restartsByCause` already reports.
    calendarChecked: calendar.checked,
    calendarSkippedReason: calendar.reason,
    missingNights: calendar.extra.map((l) => ({ date: nightDateOf(l), lane, runId: l.runId })),
    // Only a CREDENTIAL window can meet the gate. An early-warning streak on
    // `main` is a forecast, however long it runs.
    met: scope === 'credential' && longest.nights >= requiredNights,
    shortfall: Math.max(0, requiredNights - current.nights),
  };
}

/**
 * The v1.0 verdict over the whole matrix: one independent credential window per
 * cell (ADR-0056 D2). Cells never share a streak — each is audited from its own
 * lane's nights, so a fingerprint move in one cannot touch another.
 *
 * `cells` defaults to EVERY supported cell, wired or not, so an unwired cell
 * holds `allMet` false rather than being left out of the question.
 *
 * @param {Array<Record<string, any>>} ledgers
 * @param {{cells?: string[], requiredNights?: number}} [opts]
 */
export function auditCredentialMatrix(ledgers, opts = {}) {
  const cells = opts.cells ?? CREDENTIAL_CELLS.map((c) => c.lane);
  /** @type {Record<string, ReturnType<typeof auditWindow>>} */
  const out = {};
  for (const lane of cells) {
    out[lane] = auditWindow(ledgers, {
      lane,
      scope: 'credential',
      requiredNights: opts.requiredNights,
      now: opts.now,
    });
  }
  return {
    cells: out,
    allMet: cells.length > 0 && cells.every((lane) => out[lane].met),
  };
}

/** Human-readable report. The CLI's default output. */
export function formatReport(audit) {
  const lines = [];
  lines.push(
    audit.scope === 'early-warning'
      ? `compat window — ${audit.lane} lane, EARLY WARNING scope (main nightlies — never a credential)`
      : `compat window — ${audit.lane} lane, CREDENTIAL scope (RC-tag nights only), gate = ${audit.requiredNights} nights`,
  );
  lines.push('');
  lines.push('run          fingerprint  shards  passed/failed/notRun  verdict');
  for (const n of audit.nights) {
    const fp = (n.fingerprint ?? '(none)').replace(/^sha256:/, '').slice(0, 8);
    const shards = `${n.shardsSeen}/${n.shardsExpected ?? '?'}`;
    const verdict = n.eligible ? 'counts' : `NO — ${n.disqualifiers.join('; ')}`;
    lines.push(
      `${n.runId.padEnd(12)} ${fp.padEnd(12)} ${shards.padEnd(7)} ${String(n.passed).padStart(4)}/${n.failed}/${n.notRun}${' '.repeat(12)}${verdict}`,
    );
  }
  lines.push('');
  for (const s of audit.streaks) {
    const cause = s.restartCause ? ` (restarted: ${s.restartCause})` : '';
    lines.push(
      `streak ${String(s.nights).padStart(2)} night(s)  fp=${String(s.fingerprint)
        .replace(/^sha256:/, '')
        .slice(0, 8)}  ${s.startRunId} → ${s.endRunId}${cause}`,
    );
  }
  lines.push('');
  // The arithmetic, printed. Anything a doc states as "the audit's output"
  // must be a line here — otherwise it is hand arithmetic wearing the script's
  // authority, which is how three numbers went wrong at once.
  lines.push('');
  const restartTotal = Object.values(audit.restartsByCause).reduce((a, b) => a + b, 0);
  const byCause = Object.entries(audit.restartsByCause)
    .sort()
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  lines.push(
    `streak restarts: ${restartTotal}${byCause ? ` — ${byCause}` : ''}  (over ${audit.nights.length} graded night(s))`,
  );
  lines.push(
    `fingerprint moves: ${audit.fingerprintMoves.length} across ${audit.fingerprintsRecorded} night(s) carrying one; ${audit.distinctFingerprints} distinct fingerprint(s)`,
  );
  if (audit.fingerprintMoves.length > 0) {
    const byComponent = Object.entries(audit.movesByComponent)
      .sort()
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    lines.push(`  moves involving each frozen component: ${byComponent || '(not recorded)'}`);
    // Named individually because "freeze X" is only a sufficient remedy if X is
    // in EVERY move. A move listing a single component is a counter-example to
    // freezing any other one.
    for (const m of audit.fingerprintMoves) {
      if (m.componentsChanged.length === 1) {
        lines.push(
          `  ${m.runId}: ${m.componentsChanged[0]} ONLY — no freeze of the other component(s) prevents this move`,
        );
      }
    }
  }

  if (audit.unresolvedNights.length > 0) {
    lines.push('');
    lines.push(
      `UNRESOLVED: ${audit.unresolvedNights.length} scheduled run(s) had no gradeable ledger and are`,
    );
    lines.push(
      '            counted as disqualified nights, never skipped — a skipped night would merge',
    );
    lines.push(
      '            the streaks either side of it and report a LONGER streak than reality.',
    );
    for (const u of audit.unresolvedNights) {
      lines.push(`            ${u.runId}  ${u.reason}${u.date ? `  (${u.date})` : ''}`);
    }
  }

  lines.push('');
  lines.push(
    audit.calendarChecked
      ? `calendar check (rule 8): verified — every scheduled UTC date has a graded night ` +
          `(${audit.missingNights.length} missing night(s) found and disqualified)`
      : `calendar check (rule 8): SKIPPED — ${audit.calendarSkippedReason}`,
  );

  lines.push('');
  lines.push(`longest qualifying streak: ${audit.longest.nights} / ${audit.requiredNights}`);
  lines.push(`current  qualifying streak: ${audit.current.nights} / ${audit.requiredNights}`);
  // `met` reads `longest` and `shortfall` reads `current` on purpose (see the
  // comment in `auditWindow`). Print both whenever they disagree, so "GATE MET"
  // can never be misread as "the lane is fourteen nights green right now".
  if (audit.scope === 'early-warning') {
    lines.push(
      `EARLY WARNING — non-credentialing. ${audit.current.nights} consecutive qualifying main night(s); main nights never advance the v1.0 credential (ADR-0056).`,
    );
    return lines.join('\n');
  }
  lines.push(
    audit.met
      ? audit.shortfall > 0
        ? `GATE MET — a window of ${audit.longest.nights} qualifying nights completed (${audit.longest.startRunId} → ${audit.longest.endRunId}). The CURRENT streak is ${audit.current.nights} / ${audit.requiredNights}; re-earning it from here needs ${audit.shortfall} more.`
        : 'GATE MET — a window of the required length exists, and it is the streak still running.'
      : `GATE NOT MET — ${audit.shortfall} more consecutive qualifying night(s) needed on the CURRENT fingerprint.`,
  );
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Read a directory of ledger JSON. A file that will not parse, or that is not
 * shaped like a ledger, THROWS — it is never dropped.
 *
 * Rule 5 again: the old `.filter(Boolean)` here was a silent skip, and a
 * silently-skipped night is bridged by `auditWindow` into the streak on either
 * side. Loud is the only safe direction.
 */
export function readLedgerDir(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = join(dir, f);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new Error(
          `compat-window-audit: ${path} is not readable JSON (${err.message}). A ledger that ` +
            'cannot be read is a hard failure, not a skipped night.',
        );
      }
      if (!parsed || !Array.isArray(parsed.shards)) {
        throw new Error(
          `compat-window-audit: ${path} has no \`shards\` array, so it is not a compat-run-ledger. ` +
            'Refusing to drop it silently.',
        );
      }
      return parsed;
    });
}

function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr?.slice(0, 400)}`);
  return r.stdout;
}

/**
 * Fetch the ledger of every SCHEDULED run in the last `limit` runs, and
 * reconcile what came back against what `gh run list` said exists (rule 5).
 *
 * The run list — not the set of artifacts that happened to download — is the
 * denominator. Every completed scheduled run in it leaves this function as
 * either a real ledger or an `unresolvedNight`. Nothing leaves as nothing.
 *
 * `deps` exists so the reconciliation can be tested without a network: the
 * property under test is "a run the list named cannot vanish", and that is a
 * property of this loop, not of `gh`.
 *
 * @param {number} limit
 * @param {{gh?: (args: string[]) => string, readDir?: (dir: string) => any[]}} [deps]
 */
export function fetchLedgers(limit, deps = {}) {
  const gh = deps.gh ?? runGh;
  const readDir = deps.readDir ?? readLedgerDir;
  const attempts = deps.attempts ?? FETCH_ATTEMPTS;
  // Try a few times before declaring a night unresolved. This does NOT soften
  // rule 5 — the night is still recorded as unresolved if every attempt fails.
  // It exists because the transient rate is high enough to matter: one live
  // `--fetch --limit 40` pass on 2026-08-24 hit three `gh api` failures and one
  // `gh run download` failure on artifacts that provably existed, and each one
  // understates a streak. Fail-closed is only useful if it is not also noisy.
  const withRetry = (fn) => {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
  const runs = JSON.parse(
    gh([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      String(limit),
      '--json',
      // #1607 — `createdAt` is the run's scheduling timestamp, threaded through
      // as `scheduledAt` on every ledger and stand-in below so `auditWindow`'s
      // rule-8 calendar check can place this night on a UTC date.
      'databaseId,status,event,createdAt',
    ]),
  );

  const out = [];
  for (const run of runs) {
    // A run still in flight is not yet a night; it will be graded tomorrow.
    // This is the ONLY exclusion, and it is about time, not about evidence.
    if (run.status !== 'completed') continue;
    // Only scheduled runs are candidate nights (gradeNight enforces the same
    // rule for --dir input). A push/PR/dispatch run is not a night that went
    // missing, so it needs no placeholder.
    if (run.event !== 'schedule') continue;

    // The lane a night is attributed to when its ledger cannot be read. It is
    // resolved from the artifacts LISTING below, so it stays `null` for the one
    // reason that precedes the listing — an unreachable API — and that null is
    // what keeps rule 5's fail-closed behaviour for genuinely unknowable nights.
    let markerLane = null;
    let markerMode = null;
    const scheduledAt = typeof run.createdAt === 'string' ? run.createdAt : null;
    const unresolved = (reason) =>
      out.push(unresolvedNight(run.databaseId, reason, markerLane, markerMode, scheduledAt));

    let artifactsResponse;
    try {
      // `per_page=100`: the REST default is 30, and this listing carries no
      // pagination otherwise. Measured (2026-09-22): the latest scheduled run
      // had total_count 19, +1 for the #1147 lane marker = 20 — the shard
      // matrix already went 4→16 once, so crossing 30 is not hypothetical.
      // 100 matches DEFAULT_FETCH_LIMIT's own headroom rationale (>= 2 lanes
      // x 14 nights).
      artifactsResponse = withRetry(() =>
        JSON.parse(
          gh(['api', `repos/${REPO}/actions/runs/${run.databaseId}/artifacts?per_page=100`]),
        ),
      );
    } catch {
      unresolved('artifact-api-unreachable');
      continue;
    }
    const artifacts = Array.isArray(artifactsResponse?.artifacts)
      ? artifactsResponse.artifacts
      : [];
    // `total_count` is GitHub's own count of the FULL set this run has. If it
    // disagrees with what this page actually returned, the listing was
    // truncated (or otherwise incomplete) — treat that the same as an
    // unreachable API: an unresolved, fail-closed-lane night. Proceeding as
    // if a truncated page were complete is exactly how #3's fix (attribute an
    // unresolved night to ONE lane) silently reverts: `laneFromArtifacts`
    // would read a partial listing and could come back `null` or wrong.
    if (
      typeof artifactsResponse?.total_count === 'number' &&
      artifactsResponse.total_count !== artifacts.length
    ) {
      unresolved('artifact-api-unreachable');
      continue;
    }
    // Read from the NAME in the listing — never downloaded, so it survives the
    // artifact's own expiry (an expired artifact is still listed).
    markerLane = laneFromArtifacts(artifacts);
    markerMode = modeFromArtifacts(artifacts);
    const named = artifacts.filter((a) => a.name === LEDGER_ARTIFACT);
    const art = named.find((a) => !a.expired);
    if (!art) {
      unresolved(named.length > 0 ? 'artifact-expired' : 'no-ledger');
      continue;
    }
    // `gh run download` writes the unzipped artifact into a directory; use it
    // rather than unzipping by hand so no zip dependency is needed.
    const tmp = `.compat-window-audit-${run.databaseId}`;
    let fetched;
    try {
      withRetry(() => {
        rmSync(tmp, { recursive: true, force: true });
        return gh(['run', 'download', String(run.databaseId), '-n', LEDGER_ARTIFACT, '-D', tmp]);
      });
    } catch {
      // Measured, not hypothetical: `gh run download` failed transiently on a
      // live, unexpired artifact during the 2026-08-24 review. That transient
      // used to erase a night.
      unresolved('artifact-download-failed');
      continue;
    }
    try {
      fetched = readDir(tmp);
    } catch {
      unresolved('ledger-unreadable');
      continue;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (fetched.length === 0) {
      unresolved('ledger-unreadable');
      continue;
    }
    for (const l of fetched) out.push({ ...l, scheduledAt });
  }
  return out;
}

function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const lane = arg('--lane', CREDENTIAL_LANE);
  const dir = arg('--dir', null);
  let ledgers;
  if (dir) {
    if (!existsSync(dir)) {
      console.error(`compat-window-audit: --dir ${dir} does not exist`);
      process.exit(2);
    }
    // Deliberately unguarded: `readLedgerDir` THROWS on an unreadable file, and
    // that exception is meant to reach the operator. Catching it here would
    // reintroduce exactly the silent skip rule 5 forbids.
    ledgers = readLedgerDir(dir);
  } else if (argv.includes('--fetch')) {
    ledgers = fetchLedgers(Number(arg('--limit', String(DEFAULT_FETCH_LIMIT))));
  } else {
    console.error('compat-window-audit: pass --dir <dir> or --fetch [--limit N]');
    process.exit(2);
  }
  const scope = arg('--scope', 'credential');
  if (!AUDIT_SCOPES.includes(scope)) {
    console.error(`compat-window-audit: --scope must be one of ${AUDIT_SCOPES.join(', ')}`);
    process.exit(2);
  }
  if (argv.includes('--matrix')) {
    const matrix = auditCredentialMatrix(ledgers);
    if (argv.includes('--json')) {
      console.log(JSON.stringify(matrix, null, 2));
    } else {
      for (const cell of CREDENTIAL_CELLS) {
        const a = matrix.cells[cell.lane];
        console.log(
          `${cell.runtime}×${cell.builder}`.padEnd(18) +
            ` lane=${cell.lane.padEnd(13)} ${cell.wired ? 'wired  ' : 'UNWIRED'} current ${a.current.nights}/${a.requiredNights}  ${a.met ? 'MET' : 'not met'}`,
        );
      }
      console.log(
        matrix.allMet
          ? 'v1.0 CREDENTIAL MET — every supported cell banked its window on an RC tag.'
          : 'v1.0 credential NOT met — every supported cell needs its own 14 RC-tag nights.',
      );
    }
    return;
  }
  const audit = auditWindow(ledgers, { lane, scope });
  console.log(argv.includes('--json') ? JSON.stringify(audit, null, 2) : formatReport(audit));
  // Exit 0 always: this is a REPORT, not a gate. Making it fail CI would give
  // someone a reason to want it green, which is how a scoreboard becomes a
  // target. The window's teeth are the fail-on-red gate in the workflow.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
