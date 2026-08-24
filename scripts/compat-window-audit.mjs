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
 * USAGE
 *   node scripts/compat-window-audit.mjs --dir <dir-of-ledger-json>
 *   node scripts/compat-window-audit.mjs --fetch --limit 40   # needs `gh`
 *   node scripts/compat-window-audit.mjs --fetch --lane bun --json
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The v1.0 gate: fourteen consecutive qualifying nights. */
export const WINDOW_REQUIRED_NIGHTS = 14;

/** The lane whose streak is the compat-matrix credential. */
export const CREDENTIAL_LANE = 'node';

const REPO = 'getknext-dev/knext';
const WORKFLOW = 'test-e2e-deploy.yml';
const LEDGER_ARTIFACT = 'compat-run-ledger';

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
 * Grade ONE run ledger against every rule a single night can be judged on
 * alone (rule 1 is cross-night and lives in `auditWindow`).
 *
 * @param {Record<string, any>} ledger a parsed `compat-run-ledger` artifact
 * @param {{lane?: string}} [opts]
 */
export function gradeNight(ledger, opts = {}) {
  const lane = opts.lane ?? CREDENTIAL_LANE;
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
    shardsExpected: expected,
    shardsSeen: shards.length,
    passed,
    failed,
    notRun,
    disqualifiers: [...new Set(disqualifiers)],
    eligible: disqualifiers.length === 0,
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
 */
export function selectLaneNights(ledgers, lane = CREDENTIAL_LANE) {
  return ledgers
    .filter((l) => l?.lane === lane && l?.event === 'schedule')
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
      // A disqualified night restarts the count. It does not pause it.
      open = null;
      pendingCause = 'night-disqualified';
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

  const empty = { fingerprint: null, nights: 0, runIds: [], startRunId: null, endRunId: null };
  const longest = streaks.reduce((best, s) => (s.nights > best.nights ? s : best), empty);
  // "Current" is the streak that is still open — i.e. one that runs to the last
  // graded night. A streak broken by a later red is history, not the count.
  const last = streaks.at(-1);
  const current = last && last.endRunId === nights.at(-1)?.runId ? last : empty;

  return {
    lane,
    requiredNights,
    nights,
    streaks,
    longest,
    current,
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
  lines.push(`longest qualifying streak: ${audit.longest.nights} / ${audit.requiredNights}`);
  lines.push(`current  qualifying streak: ${audit.current.nights} / ${audit.requiredNights}`);
  lines.push(
    audit.met
      ? 'GATE MET — a window of the required length exists.'
      : `GATE NOT MET — ${audit.shortfall} more consecutive qualifying night(s) needed on the CURRENT fingerprint.`,
  );
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function readDir(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((l) => l && Array.isArray(l.shards));
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr?.slice(0, 400)}`);
  return r.stdout;
}

function fetchLedgers(limit) {
  const runs = JSON.parse(
    gh([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      String(limit),
      '--json',
      'databaseId,status',
    ]),
  ).filter((r) => r.status === 'completed');

  const out = [];
  for (const run of runs) {
    let artifacts;
    try {
      artifacts = JSON.parse(
        gh(['api', `repos/${REPO}/actions/runs/${run.databaseId}/artifacts`]),
      ).artifacts;
    } catch {
      continue;
    }
    const art = artifacts.find((a) => a.name === LEDGER_ARTIFACT && !a.expired);
    if (!art) continue;
    // `gh run download` writes the unzipped artifact into a directory; use it
    // rather than unzipping by hand so no zip dependency is needed.
    const tmp = `.compat-window-audit-${run.databaseId}`;
    try {
      gh(['run', 'download', String(run.databaseId), '-n', LEDGER_ARTIFACT, '-D', tmp]);
      for (const l of readDir(tmp)) out.push(l);
    } catch {
      /* a run whose artifact vanished between listing and download is skipped */
    }
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
    ledgers = readDir(dir);
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
