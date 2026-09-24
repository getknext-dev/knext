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
 * USAGE
 *   node scripts/compat-window-audit.mjs --dir <dir-of-ledger-json>
 *   node scripts/compat-window-audit.mjs --fetch --limit 100  # needs `gh`
 *   node scripts/compat-window-audit.mjs --fetch --lane bun --json
 *   node scripts/compat-window-audit.mjs --fetch --scope early-warning
 *   node scripts/compat-window-audit.mjs --fetch --matrix   # every supported cell
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
    extraFiles: Object.freeze([
      'scripts/compat-credential-ref.mjs',
      'scripts/compat-run-ledger.mjs',
      '.github/compat-credential-ref.json',
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
    // runs compat-run-ledger.mjs but never compat-credential-ref.mjs.
    extraFiles: Object.freeze(['scripts/compat-run-ledger.mjs']),
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
 * The reasons a scheduled run can end up with no gradeable ledger. Every one of
 * them produces a DISQUALIFIED night (rule 5), never a gap in the record.
 */
export const UNRESOLVED_REASONS = Object.freeze([
  'no-ledger', // the run uploaded no `compat-run-ledger` artifact at all
  'artifact-expired', // it did, and GitHub has since expired it
  'artifact-api-unreachable', // the artifacts API call failed
  'artifact-download-failed', // listed as live, but the download failed
  'ledger-unreadable', // downloaded, but nothing in it parses as a ledger
]);

/**
 * A stand-in for a scheduled run whose ledger could not be obtained.
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
 */
export function unresolvedNight(runId, reason, lane = null, mode = null) {
  if (!UNRESOLVED_REASONS.includes(reason)) {
    throw new Error(`compat-window-audit: unknown unresolved reason ${reason}`);
  }
  return {
    runId: String(runId),
    event: 'schedule',
    lane: typeof lane === 'string' && lane.length > 0 ? lane : null,
    compatMode: COMPAT_MODES.includes(mode) ? mode : null,
    unresolved: reason,
    shards: [],
  };
}

/** Is this entry a stand-in for a run whose ledger we never got? */
export function isUnresolved(ledger) {
  return typeof ledger?.unresolved === 'string' && ledger.unresolved.length > 0;
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
      disqualifiers.push(`shard ${id} red (failed=${f.value} notRun=${n.value})`);
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
  return scope === 'credential' ? claimsCredential(ledger) : !claimsCredential(ledger);
}

/**
 * Compute the window: every night graded, grouped into fingerprint-stable
 * streaks of qualifying nights.
 *
 * @param {Array<Record<string, any>>} ledgers
 * @param {{lane?: string, requiredNights?: number, scope?: string}} [opts]
 */
export function auditWindow(ledgers, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
  const requiredNights = opts.requiredNights ?? WINDOW_REQUIRED_NIGHTS;
  const scope = opts.scope ?? 'credential';

  const nights = selectLaneNights(ledgers ?? [], lane, scope).map((l) =>
    gradeNight(l, { lane, scope }),
  );

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
      open = null;
      pendingCause = night.unresolved ? 'night-unresolved' : 'night-disqualified';
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
      })),
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
      lines.push(`            ${u.runId}  ${u.reason}`);
    }
  }
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
      'databaseId,status,event',
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
    const unresolved = (reason) =>
      out.push(unresolvedNight(run.databaseId, reason, markerLane, markerMode));

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
    for (const l of fetched) out.push(l);
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
