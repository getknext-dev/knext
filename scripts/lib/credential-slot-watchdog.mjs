/**
 * credential-slot-watchdog — pure decision + attribution logic (#1640).
 *
 * PROBLEM. GitHub fires scheduled runs late: the compat credential crons in
 * `.github/workflows/test-e2e-deploy.yml` ran 2.5-6.6h after their slot in one
 * observed week (the bun credential slot, 05:47 UTC, ran at 12:00). The window
 * audit's missing-night grace (`MISSING_NIGHT_GRACE_HOURS`,
 * `scripts/compat-window-audit.mjs`) is 6h, so a late-enough or genuinely
 * dropped scheduled run can void a credential night — and nobody hears about
 * it until the audit reads the gap, which can be days later.
 *
 * SCOPE. This module is READ-ONLY logic: it never dispatches a workflow run.
 * It exists to let a standalone workflow (`.github/workflows/
 * credential-slot-watchdog.yml`, deliberately NOT test-e2e-deploy.yml, which
 * is frozen) check, a few hours after each credential slot, whether that
 * lane's scheduled run exists and has started — and raise the standard
 * pinned alert (`scripts/nightly-alert-issue.mjs`) when it has not.
 *
 * WHY NOT HARDCODE THE CRON LITERALS. test-e2e-deploy.yml already encodes,
 * in its own `env.KNEXT_COMPAT_MODE` and `env.KNEXT_LANE` expressions, both
 * of the facts this module needs: which cron literals are CREDENTIAL nights
 * (vs. the two early-warning crons, which must never alert), and which lane
 * name each credential cron maps to. `resolveCredentialLaneCrons` parses
 * those two expressions (plus the declared `schedule:` cron list) out of the
 * workflow file at RUN TIME, so a future lane added to test-e2e-deploy.yml
 * (a fifth credential cron, say) is picked up automatically without a second
 * edit here.
 *
 * FAILS CLOSED ON A PARSE FAILURE (#1650 round 2, finding 1).
 * `resolveCredentialLanes` used to catch a parsing failure and silently
 * substitute `DEFAULT_CREDENTIAL_LANES`, with only a `console.warn`. `main()`
 * (scripts/credential-slot-watchdog.mjs) never surfaced that fallback, so a
 * workflow restructured enough to break parsing would make the watchdog keep
 * reporting "quiet" against a table that no longer matches reality — silent,
 * not safe. `resolveCredentialLanes` now THROWS on any parsing failure
 * instead: the CLI's top-level handler turns that into
 * `::error::credential-slot-watchdog: cannot read slots — <reason>` and a
 * non-zero exit, which the companion workflow's `needs.<job>.result ==
 * 'failure'` gate already treats as an alert — the same path a `missing`
 * verdict takes. `DEFAULT_CREDENTIAL_LANES` below is retained ONLY as a
 * static drift-detection fixture: `tests/credential-slot-watchdog.test.ts`
 * asserts the REAL, currently-checked-in test-e2e-deploy.yml parses to
 * exactly this table, so drift between the live workflow and this comment is
 * caught at PR time. It is never consulted at runtime.
 *
 * LANE ATTRIBUTION — exact signal first, conservative heuristic only as a
 * fallback (#1650 round 2, finding 2).
 *
 * test-e2e-deploy.yml's root job (`credential-ref`) unconditionally publishes
 * two marker artifacts as its very first step, before anything that could
 * lose the run: `compat-lane-<lane>` and `compat-mode-<credential|
 * early-warning>` (see that job's "Record the lane + mode markers" step).
 * `scripts/compat-window-audit.mjs` already reads these — from the artifacts
 * LISTING, never downloaded — to attribute a run whose ledger is gone
 * (`laneFromArtifacts` / `modeFromArtifacts`). This module's CLI layer
 * (`scripts/credential-slot-watchdog.mjs`'s `attachExactLanes`) reuses those
 * exact same functions to fetch each run's markers and hands
 * `attributeRunsToLanes` a `run.exactLane` whenever the mode marker reads
 * `credential` (an early-warning run's lane marker is deliberately never
 * trusted here — `node`/`bun` early-warning nights publish the SAME lane
 * names as their credential counterparts, so mode is what disambiguates).
 * When the marker is present and unambiguous, attribution is exact — no
 * time-based guessing, no cross-lane risk.
 *
 * The heuristic below is now a FALLBACK ONLY — used when the marker is
 * missing, unreadable, or the artifacts API call itself fails. GitHub's
 * workflow-run API gives no other field naming which cron fired a run — only
 * `created_at` and `run_started_at` (null while queued) — so a fallback run
 * is matched to the CREDENTIAL lane whose own expected slot is the nearest
 * declared slot (credential OR early-warning) at or before `created_at`,
 * exactly as before. What changed: this nearest-slot match is no longer
 * trusted blindly. `detectAmbiguousAttribution` checks whether the run also
 * falls inside the IMMEDIATELY PRECEDING credential lane's own grace window
 * AND that lane has no other evidence of its own — i.e. whether this run
 * could equally be that earlier lane's very-late run rather than the nearer
 * lane's on-time one. When it could, the run satisfies NEITHER lane's
 * "quiet" verdict; both lanes alert (`ambiguous`, not silently `quiet`).
 * Traced against the real cron literals (node 01:17, bun 05:47, node-webpack
 * 22:17, bun-webpack 23:47 UTC): the inter-lane gaps are 4.5h/16.5h/1.5h/1.5h
 * against an 8h default grace, so 3 of the 4 adjacent pairs are within this
 * risk — not only the two webpack lanes a purely time-based heuristic would
 * suggest. The dangerous direction is a false "quiet", never a false alert,
 * so the fallback errs toward alerting whenever it cannot be sure.
 */

/** Default grace period (hours) if no override is supplied. */
export const DEFAULT_GRACE_HOURS = 8;

/**
 * Static drift-detection fixture — NEVER consulted at runtime (see the
 * "FAILS CLOSED" section of the module header). Mirrors test-e2e-deploy.yml's
 * 4 credential crons as of #1640. `tests/credential-slot-watchdog.test.ts`
 * asserts live parsing of the real workflow file produces exactly this
 * table, so drift between the two is caught at PR time, not by a runtime
 * fallback silently masking it.
 */
export const DEFAULT_CREDENTIAL_LANES = Object.freeze([
  Object.freeze({ cron: '17 1 * * *', lane: 'node', hour: 1, minute: 17 }),
  Object.freeze({ cron: '47 5 * * *', lane: 'bun', hour: 5, minute: 47 }),
  Object.freeze({ cron: '17 22 * * *', lane: 'node-webpack', hour: 22, minute: 17 }),
  Object.freeze({ cron: '47 23 * * *', lane: 'bun-webpack', hour: 23, minute: 47 }),
]);

const SIMPLE_DAILY_CRON = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/;

/** Parse a simple "M H * * *" (once-daily UTC) cron string. */
export function parseSimpleDailyCron(cron) {
  const m = SIMPLE_DAILY_CRON.exec(String(cron).trim());
  if (!m) {
    throw new Error(
      `credential-slot-watchdog: cron "${cron}" is not a supported once-daily "M H * * *" form`,
    );
  }
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    throw new Error(`credential-slot-watchdog: cron "${cron}" has an out-of-range minute/hour`);
  }
  return { minute, hour };
}

/**
 * Extract every `- cron: '...'` literal declared under the workflow's
 * `schedule:` key, by scanning lines rather than a full YAML parse (keeps
 * this module dependency-free — no `yaml` package needed at runtime, mirrors
 * the sibling nightly scripts' "dependency-free ESM on the runner's built-in
 * Node" convention). Stops at the first line that is blank, a comment, or a
 * `- cron:` entry no longer holds — i.e. the first dedent back out of the
 * `schedule:` block.
 */
export function extractScheduleCrons(yamlText) {
  const lines = String(yamlText).split('\n');
  const startIdx = lines.findIndex((l) => /^\s*schedule:\s*$/.test(l));
  if (startIdx === -1) {
    throw new Error('credential-slot-watchdog: no `schedule:` key found in the workflow YAML');
  }
  const crons = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break; // dedented to column 0 — the schedule block ended
    if (/^\s*#/.test(line)) continue; // a comment line inside the block
    const m = /^\s*-\s*cron:\s*'([^']+)'/.exec(line);
    if (m) {
      crons.push(m[1]);
      continue;
    }
    break; // some other indented, non-comment, non-cron line — block ended
  }
  if (crons.length === 0) {
    throw new Error(
      'credential-slot-watchdog: `schedule:` key found but no `- cron:` entries parsed under it',
    );
  }
  return crons;
}

/** Find the single-line value of a top-level `env.<key>: ...` entry. */
export function extractEnvExpressionLine(yamlText, envKey) {
  const re = new RegExp(`^\\s*${envKey}:\\s*(.+)$`, 'm');
  const m = re.exec(String(yamlText));
  if (!m) {
    throw new Error(`credential-slot-watchdog: env key "${envKey}" not found in the workflow YAML`);
  }
  return m[1].trim();
}

/** Cron literals the `KNEXT_COMPAT_MODE` expression maps to `'credential'`. */
export function parseCredentialCronsFromCompatMode(expr) {
  const re = /github\.event\.schedule\s*==\s*'([^']+)'\s*&&\s*'credential'/g;
  const crons = [];
  let m = re.exec(expr);
  while (m) {
    crons.push(m[1]);
    m = re.exec(expr);
  }
  if (crons.length === 0) {
    throw new Error(
      'credential-slot-watchdog: no `credential`-mode cron comparisons found in KNEXT_COMPAT_MODE',
    );
  }
  return crons;
}

/**
 * Cron -> lane-name map explicit in the `KNEXT_LANE` expression, plus its
 * trailing default-lane literal (the final `|| '<lane>' }}` fallback) — the
 * lane a credential cron resolves to when it is NOT one of the explicit
 * `github.event.schedule == '<cron>' && '<lane>'` comparisons (true of the
 * plain node credential cron today, which relies on the default).
 */
export function parseLaneMapFromKnextLane(expr) {
  const re = /github\.event\.schedule\s*==\s*'([^']+)'\s*&&\s*'([^']+)'/g;
  const map = new Map();
  let m = re.exec(expr);
  while (m) {
    map.set(m[1], m[2]);
    m = re.exec(expr);
  }
  const fallbackMatch = /\|\|\s*'([^']+)'\s*\}\}\s*$/.exec(expr);
  if (!fallbackMatch) {
    throw new Error(
      'credential-slot-watchdog: could not find the trailing default-lane literal in KNEXT_LANE',
    );
  }
  return { map, fallbackLane: fallbackMatch[1] };
}

/**
 * Resolve the credential lanes by parsing the live workflow text. Throws on
 * any parsing failure — callers that want the documented fallback behaviour
 * use `resolveCredentialLanes` below, not this function directly.
 */
export function resolveCredentialLaneCrons(yamlText) {
  const declaredCrons = new Set(extractScheduleCrons(yamlText));
  const compatModeExpr = extractEnvExpressionLine(yamlText, 'KNEXT_COMPAT_MODE');
  const laneExpr = extractEnvExpressionLine(yamlText, 'KNEXT_LANE');
  const credentialCrons = parseCredentialCronsFromCompatMode(compatModeExpr);
  const { map: laneMap, fallbackLane } = parseLaneMapFromKnextLane(laneExpr);

  return credentialCrons.map((cron) => {
    if (!declaredCrons.has(cron)) {
      throw new Error(
        `credential-slot-watchdog: KNEXT_COMPAT_MODE names cron "${cron}" as credential, ` +
          'but it is not declared under `schedule:`',
      );
    }
    const { hour, minute } = parseSimpleDailyCron(cron);
    return { cron, lane: laneMap.get(cron) ?? fallbackLane, hour, minute };
  });
}

/**
 * Resolve credential lanes by parsing the live workflow text, attaching
 * `graceHours` to each. FAILS CLOSED (#1650 round 2, finding 1): throws —
 * never falls back to `DEFAULT_CREDENTIAL_LANES` — on any parsing failure.
 * The thrown message always starts with "cannot read slots" so the CLI's
 * generic top-level handler (`::error::<message>` + exit 1) reads as a clear
 * alert without needing to special-case this error.
 */
export function resolveCredentialLanes(yamlText, { defaultGraceHours = DEFAULT_GRACE_HOURS } = {}) {
  let lanes;
  try {
    lanes = resolveCredentialLaneCrons(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`credential-slot-watchdog: cannot read slots — ${message}`);
  }
  return lanes.map((l) => ({ ...l, graceHours: defaultGraceHours }));
}

/** Every declared schedule slot (credential and early-warning alike). */
export function parseAllDeclaredSlots(yamlText) {
  return extractScheduleCrons(yamlText).map((cron) => ({ cron, ...parseSimpleDailyCron(cron) }));
}

/** The most recent UTC occurrence of `H:M` at or before `referenceDate`. */
export function mostRecentSlotAtOrBefore(hour, minute, referenceDate) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const slot = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hour, minute, 0, 0),
  );
  if (slot.getTime() > ref.getTime()) {
    slot.setUTCDate(slot.getUTCDate() - 1);
  }
  return slot;
}

/** Attach each lane's expected slot time (this cycle's occurrence) as of `now`. */
export function computeExpectedSlots(lanes, now) {
  return lanes.map((l) => ({
    ...l,
    expectedSlotTime: mostRecentSlotAtOrBefore(l.hour, l.minute, now).toISOString(),
  }));
}

/**
 * The credential lane whose own most-recent occurrence immediately precedes
 * `laneDef`'s own current-cycle slot — computed relative to `laneDef`'s OWN
 * slot time (never the global `now` the whole `lanes` array was resolved
 * for), so it is correct across the day-boundary wraparound (e.g. node's
 * 01:17 predecessor is bun-webpack's PREVIOUS day 23:47, not bun-webpack's
 * own current-cycle occurrence, which is later the same day).
 */
function findPredecessorLane(laneDef, lanes) {
  const justBeforeOwnSlot = new Date(new Date(laneDef.expectedSlotTime).getTime() - 1);
  let best = null;
  for (const other of lanes) {
    if (other.lane === laneDef.lane) continue;
    const occurrence = mostRecentSlotAtOrBefore(other.hour, other.minute, justBeforeOwnSlot);
    if (!best || occurrence.getTime() > best.occurrence.getTime()) {
      best = { laneDef: other, occurrence };
    }
  }
  return best;
}

/**
 * For heuristically-attributed runs ONLY (never the exact-marker path —
 * ground truth is never ambiguous): find lanes whose nearest-slot-attributed
 * run could equally be an earlier, currently-unattributed lane's very-late
 * run (see the module header's "LANE ATTRIBUTION" section).
 *
 * A run assigned to lane `L` is ambiguous with `L`'s immediately preceding
 * credential lane `P` (via `findPredecessorLane`, wrapping across the day)
 * when BOTH:
 *   - `P` has no OTHER heuristically-attributed run of its own (if it does,
 *     `P` is independently covered and this run unambiguously belongs to `L`);
 *   - the run's `created_at` also falls inside `P`'s own grace window
 *     (`P`'s slot .. `P`'s slot + `P`'s graceHours) — i.e. it would still be
 *     a timely-enough run to satisfy `P`, had it been `P`'s.
 *
 * An ambiguous run is dropped from BOTH lanes' evidence (never credited to
 * either) and both lane names are returned in `ambiguousLanes`, so
 * `decideCredentialSlotVerdicts` can alert `ambiguous` instead of silently
 * `quiet` or a bare `missing`.
 *
 * @param {{lane: string, status: string, created_at: string, run_started_at: string|null}[]} heuristicRuns
 * @param {{lane: string, hour: number, minute: number, expectedSlotTime: string, graceHours: number}[]} lanes
 * @returns {{kept: typeof heuristicRuns, ambiguousLanes: Set<string>}}
 */
export function detectAmbiguousAttribution(heuristicRuns, lanes) {
  const byLane = new Map(lanes.map((l) => [l.lane, []]));
  for (const r of heuristicRuns) {
    byLane.get(r.lane)?.push(r);
  }
  const predecessors = new Map(lanes.map((l) => [l.lane, findPredecessorLane(l, lanes)]));

  const ambiguousLanes = new Set();
  const kept = [];
  for (const r of heuristicRuns) {
    const pred = predecessors.get(r.lane);
    const predHasOwnEvidence = pred && (byLane.get(pred.laneDef.lane)?.length ?? 0) > 0;
    if (!pred || predHasOwnEvidence) {
      kept.push(r);
      continue;
    }
    const predSlotTime = pred.occurrence.getTime();
    const predDeadline = predSlotTime + pred.laneDef.graceHours * 60 * 60 * 1000;
    const createdAt = new Date(r.created_at).getTime();
    if (createdAt >= predSlotTime && createdAt <= predDeadline) {
      ambiguousLanes.add(r.lane);
      ambiguousLanes.add(pred.laneDef.lane);
      continue; // cannot safely credit either lane with this run
    }
    kept.push(r);
  }
  return { kept, ambiguousLanes };
}

/**
 * Attribute schedule-triggered runs to credential lanes. `lanes` must already
 * carry `expectedSlotTime` (i.e. have gone through `computeExpectedSlots`).
 *
 * EXACT SIGNAL FIRST: a run carrying `run.exactLane` (set by the CLI layer's
 * `attachExactLanes` from the workflow's own `compat-lane-<lane>` /
 * `compat-mode-<mode>` marker artifacts, only when the mode marker reads
 * `credential`) is attributed directly to that lane — no time-based guessing,
 * so it is never ambiguous. It is still checked against the CURRENT cycle's
 * `expectedSlotTime` so a stale prior-day run is not credited to today.
 *
 * FALLBACK HEURISTIC: a run with no usable exact signal is matched to the
 * CREDENTIAL lane whose own expected slot is the nearest declared slot
 * (credential OR early-warning) at or before the run's `created_at`, exactly
 * as before — then passed through `detectAmbiguousAttribution` (see the
 * module header's "LANE ATTRIBUTION" section) before being trusted.
 *
 * @param {{event?: string, status: string, created_at: string, run_started_at: string|null, exactLane?: string|null}[]} runs
 * @param {{lane: string, cron: string, hour: number, minute: number, expectedSlotTime: string, graceHours: number}[]} lanes already resolved for the CURRENT cycle (via `computeExpectedSlots`)
 * @param {{cron: string, hour: number, minute: number}[]} allSlots every declared cron (credential + early-warning)
 * @returns {{attributed: {lane: string, status: string, created_at: string, run_started_at: string|null}[], ambiguousLanes: Set<string>}}
 */
export function attributeRunsToLanes(runs, lanes, allSlots) {
  const expectedByLane = new Map(lanes.map((l) => [l.lane, l.expectedSlotTime]));
  const laneByCron = new Map(lanes.map((l) => [l.cron, l.lane]));
  const laneDefByName = new Map(lanes.map((l) => [l.lane, l]));

  const exact = [];
  const heuristicCandidates = [];

  for (const run of runs) {
    if (run.event && run.event !== 'schedule') continue;
    const createdAt = new Date(run.created_at);

    if (run.exactLane && laneDefByName.has(run.exactLane)) {
      const laneDef = laneDefByName.get(run.exactLane);
      const occurrence = mostRecentSlotAtOrBefore(laneDef.hour, laneDef.minute, createdAt);
      if (occurrence.toISOString() === expectedByLane.get(run.exactLane)) {
        exact.push({
          lane: run.exactLane,
          status: run.status,
          created_at: run.created_at,
          run_started_at: run.run_started_at ?? null,
        });
      }
      // The exact marker already resolved this run's identity — never falls
      // through to the nearest-slot heuristic below, ambiguous or not.
      continue;
    }

    let best = null;
    for (const slotDef of allSlots) {
      const t = mostRecentSlotAtOrBefore(slotDef.hour, slotDef.minute, createdAt);
      if (!best || t.getTime() > best.time.getTime()) {
        best = { cron: slotDef.cron, time: t };
      }
    }
    if (!best) continue;

    const lane = laneByCron.get(best.cron);
    // A single check does both jobs: `expectedByLane` only has keys for real
    // credential lane names, so `expectedByLane.get(undefined)` is always
    // `undefined` — never equal to a real ISO timestamp — which means an
    // early-warning nearest-slot (`lane` undefined) is filtered out by the
    // SAME comparison that filters out a stale prior-day occurrence. A
    // separate `if (!lane) continue` was proved decorative (mutation-proof):
    // this line already subsumes it in every reachable case.
    if (best.time.toISOString() !== expectedByLane.get(lane)) continue;

    heuristicCandidates.push({
      lane,
      status: run.status,
      created_at: run.created_at,
      run_started_at: run.run_started_at ?? null,
    });
  }

  const { kept, ambiguousLanes } = detectAmbiguousAttribution(heuristicCandidates, lanes);
  return { attributed: [...exact, ...kept], ambiguousLanes };
}

/**
 * THE pure decision function (#1640 acceptance criterion): given
 * lane-attributed inputs and `now`, decide each lane's verdict.
 *
 * - `missing`          — no run recorded for the slot, and the grace window has elapsed.
 * - `queued-too-long`  — a run exists but has not started, and the grace window has elapsed.
 * - `ambiguous`        — no UNAMBIGUOUS run for the slot, grace elapsed, and
 *                        `detectAmbiguousAttribution` flagged this lane (its
 *                        only nearby evidence could equally belong to a
 *                        neighbouring lane — see the module header). Alerts,
 *                        same as `missing`/`queued-too-long`; distinguished
 *                        in the reason so an operator knows to check the
 *                        neighbour too, not just this lane.
 * - `quiet`            — started on time, already resolved, or still within grace.
 *
 * @param {{lanes: {lane: string, expectedSlotTime: string, graceHours: number}[], runs: {lane: string, status: string, created_at: string, run_started_at: string|null}[], now: Date|string, ambiguousLanes?: Set<string>}} args
 * @returns {{lane: string, verdict: 'missing'|'queued-too-long'|'ambiguous'|'quiet', reason: string}[]}
 */
export function decideCredentialSlotVerdicts({ lanes, runs, now, ambiguousLanes = new Set() }) {
  const nowTime = (now instanceof Date ? now : new Date(now)).getTime();

  return lanes.map((laneDef) => {
    const slotTime = new Date(laneDef.expectedSlotTime).getTime();
    const deadline = slotTime + laneDef.graceHours * 60 * 60 * 1000;
    const graceElapsed = nowTime >= deadline;

    const candidates = runs.filter((r) => r.lane === laneDef.lane);
    const started = candidates.find((r) => r.run_started_at);
    const relevant = started ?? candidates[0] ?? null;

    if (!relevant) {
      if (graceElapsed && ambiguousLanes.has(laneDef.lane)) {
        return {
          lane: laneDef.lane,
          verdict: 'ambiguous',
          reason:
            `no run could be unambiguously attributed to the ${laneDef.expectedSlotTime} slot — ` +
            'a neighbouring lane has a late run that could equally belong here; treating as possibly missing',
        };
      }
      return {
        lane: laneDef.lane,
        verdict: graceElapsed ? 'missing' : 'quiet',
        reason: graceElapsed
          ? `no scheduled run recorded for the ${laneDef.expectedSlotTime} slot, and the ${laneDef.graceHours}h grace window has elapsed`
          : `no scheduled run recorded yet for the ${laneDef.expectedSlotTime} slot, but the ${laneDef.graceHours}h grace window has not elapsed`,
      };
    }

    if (relevant.run_started_at) {
      return {
        lane: laneDef.lane,
        verdict: 'quiet',
        reason: `run started at ${relevant.run_started_at}`,
      };
    }

    if (graceElapsed) {
      return {
        lane: laneDef.lane,
        verdict: 'queued-too-long',
        reason: `a run exists (status: ${relevant.status}) but had not started ${laneDef.graceHours}h after the ${laneDef.expectedSlotTime} slot`,
      };
    }

    return {
      lane: laneDef.lane,
      verdict: 'quiet',
      reason: `a run exists (status: ${relevant.status}) and the ${laneDef.graceHours}h grace window has not elapsed yet`,
    };
  });
}

/** True if any lane's verdict warrants the standard pinned alert. */
export function anyLaneNeedsAlert(verdicts) {
  return verdicts.some((v) => v.verdict !== 'quiet');
}
