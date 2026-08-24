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
 *      Fail-closed has a deliberate consequence worth stating: the lane of an
 *      unresolved night is UNKNOWABLE (the lane is read from the ledger, which
 *      is the thing we could not get), so an unresolved night disqualifies a
 *      night in EVERY lane's window. A bun weekly that fails to download will
 *      break the node streak. That is the safe direction and it is the one we
 *      take.
 *
 * USAGE
 *   node scripts/compat-window-audit.mjs --dir <dir-of-ledger-json>
 *   node scripts/compat-window-audit.mjs --fetch --limit 40   # needs `gh`
 *   node scripts/compat-window-audit.mjs --fetch --lane bun --json
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The v1.0 gate: fourteen consecutive qualifying nights. */
export const WINDOW_REQUIRED_NIGHTS = 14;

/** The lane whose streak is the compat-matrix credential. */
export const CREDENTIAL_LANE = 'node';

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
 * The `lane` is deliberately `null`: the lane is read FROM the ledger, so an
 * unresolved run has no knowable lane. `selectLaneNights` therefore admits it
 * into every lane's window (see rule 5 in the header) — fail closed.
 *
 * @param {string|number} runId
 * @param {typeof UNRESOLVED_REASONS[number]} reason
 */
export function unresolvedNight(runId, reason) {
  if (!UNRESOLVED_REASONS.includes(reason)) {
    throw new Error(`compat-window-audit: unknown unresolved reason ${reason}`);
  }
  return { runId: String(runId), event: 'schedule', lane: null, unresolved: reason, shards: [] };
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
 * @param {{lane?: string}} [opts]
 */
export function gradeNight(ledger, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
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
 * UNRESOLVED runs (rule 5) are the one exception and are admitted into EVERY
 * lane, because their lane is exactly what we failed to read. Excluding them
 * "because they are probably the other lane" is the inference the ledger
 * forbids, and it is the inference that merges two streaks into one.
 */
export function selectLaneNights(ledgers, lane = CREDENTIAL_LANE) {
  return ledgers
    .filter((l) => l?.event === 'schedule' && (l?.lane === lane || isUnresolved(l)))
    .sort((a, b) => Number(a.runId) - Number(b.runId));
}

/**
 * Compute the window: every night graded, grouped into fingerprint-stable
 * streaks of qualifying nights.
 *
 * @param {Array<Record<string, any>>} ledgers
 * @param {{lane?: string, requiredNights?: number}} [opts]
 */
export function auditWindow(ledgers, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
  const requiredNights = opts.requiredNights ?? WINDOW_REQUIRED_NIGHTS;

  const nights = selectLaneNights(ledgers ?? [], lane).map((l) => gradeNight(l, { lane }));

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
    met: longest.nights >= requiredNights,
    shortfall: Math.max(0, requiredNights - current.nights),
  };
}

/** Human-readable report. The CLI's default output. */
export function formatReport(audit) {
  const lines = [];
  lines.push(`compat window — ${audit.lane} lane, gate = ${audit.requiredNights} nights`);
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

    const unresolved = (reason) => out.push(unresolvedNight(run.databaseId, reason));

    let artifacts;
    try {
      artifacts = withRetry(() =>
        JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${run.databaseId}/artifacts`])),
      ).artifacts;
    } catch {
      unresolved('artifact-api-unreachable');
      continue;
    }
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
    ledgers = fetchLedgers(Number(arg('--limit', '40')));
  } else {
    console.error('compat-window-audit: pass --dir <dir> or --fetch [--limit N]');
    process.exit(2);
  }
  const audit = auditWindow(ledgers, { lane });
  console.log(argv.includes('--json') ? JSON.stringify(audit, null, 2) : formatReport(audit));
  // Exit 0 always: this is a REPORT, not a gate. Making it fail CI would give
  // someone a reason to want it green, which is how a scoreboard becomes a
  // target. The window's teeth are the fail-on-red gate in the workflow.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
