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
 * edit here. `DEFAULT_CREDENTIAL_LANES` below is a fallback table only —
 * used when parsing throws (a malformed or unrecognisably restructured
 * workflow file) — never the primary source of truth. A dedicated test
 * (`tests/credential-slot-watchdog.test.ts`) asserts the REAL,
 * currently-checked-in test-e2e-deploy.yml parses successfully and matches
 * the fallback table exactly, so parsing drift is caught, not silently
 * masked by an always-available fallback.
 *
 * LANE-ATTRIBUTION CAVEAT (documented, not hidden). GitHub's workflow-run API
 * gives no field that names which `schedule:` cron literal fired a given
 * run — only `created_at` (when the run object was created) and
 * `run_started_at` (when it actually began executing, null while queued).
 * `attributeRunsToLanes` therefore matches each run to the CREDENTIAL lane
 * whose own expected slot is the nearest declared slot (credential OR
 * early-warning) at or before the run's `created_at`. Two credential crons
 * sit only 1.5h apart (22:17 / 23:47 UTC, the webpack lanes) — a run delayed
 * past the OTHER lane's slot time would be attributed to the wrong lane by
 * this heuristic. Nothing in this week's observed data (worst case 6.6h late)
 * crosses that particular 1.5h gap in the wrong direction, but it is a real,
 * acknowledged limitation of time-based attribution, not a solved problem.
 */

/** Default grace period (hours) if no override is supplied. */
export const DEFAULT_GRACE_HOURS = 8;

/**
 * Fallback lane table — used ONLY when `resolveCredentialLaneCrons` throws.
 * Mirrors test-e2e-deploy.yml's 4 credential crons as of #1640. Keeping this
 * in sync is a fallback-of-last-resort concern, not the primary contract:
 * `tests/credential-slot-watchdog.test.ts` asserts live parsing of the real
 * workflow file produces exactly this table, so drift between the two is
 * caught at PR time rather than discovered the night parsing silently falls
 * back.
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
 * Resolve credential lanes, falling back to `DEFAULT_CREDENTIAL_LANES` (with
 * a warning) on any parsing failure — the "never hardcode a duplicate copy
 * ... except as a fallback/default if parsing fails" contract from #1640.
 */
export function resolveCredentialLanes(
  yamlText,
  { defaultGraceHours = DEFAULT_GRACE_HOURS, warn = console.warn } = {},
) {
  let lanes;
  try {
    lanes = resolveCredentialLaneCrons(yamlText);
  } catch (err) {
    warn(
      `credential-slot-watchdog: falling back to the hardcoded default lane table — ${err.message}`,
    );
    lanes = DEFAULT_CREDENTIAL_LANES;
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
 * Attribute schedule-triggered runs to credential lanes by nearest-prior-slot
 * matching (see the module header caveat). `lanes` must already carry
 * `expectedSlotTime` (i.e. have gone through `computeExpectedSlots`).
 *
 * @param {{event?: string, status: string, created_at: string, run_started_at: string|null}[]} runs
 * @param {{lane: string, cron: string, expectedSlotTime: string}[]} lanes already resolved for the CURRENT cycle (via `computeExpectedSlots`)
 * @param {{cron: string, hour: number, minute: number}[]} allSlots every declared cron (credential + early-warning)
 */
export function attributeRunsToLanes(runs, lanes, allSlots) {
  const expectedByLane = new Map(lanes.map((l) => [l.lane, l.expectedSlotTime]));
  const laneByCron = new Map(lanes.map((l) => [l.cron, l.lane]));
  const out = [];

  for (const run of runs) {
    if (run.event && run.event !== 'schedule') continue;
    const createdAt = new Date(run.created_at);

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

    out.push({
      lane,
      status: run.status,
      created_at: run.created_at,
      run_started_at: run.run_started_at ?? null,
    });
  }
  return out;
}

/**
 * THE pure decision function (#1640 acceptance criterion): given
 * lane-attributed inputs and `now`, decide each lane's verdict.
 *
 * - `missing`          — no run recorded for the slot, and the grace window has elapsed.
 * - `queued-too-long`  — a run exists but has not started, and the grace window has elapsed.
 * - `quiet`            — started on time, already resolved, or still within grace.
 *
 * @param {{lanes: {lane: string, expectedSlotTime: string, graceHours: number}[], runs: {lane: string, status: string, created_at: string, run_started_at: string|null}[], now: Date|string}} args
 * @returns {{lane: string, verdict: 'missing'|'queued-too-long'|'quiet', reason: string}[]}
 */
export function decideCredentialSlotVerdicts({ lanes, runs, now }) {
  const nowTime = (now instanceof Date ? now : new Date(now)).getTime();

  return lanes.map((laneDef) => {
    const slotTime = new Date(laneDef.expectedSlotTime).getTime();
    const deadline = slotTime + laneDef.graceHours * 60 * 60 * 1000;
    const graceElapsed = nowTime >= deadline;

    const candidates = runs.filter((r) => r.lane === laneDef.lane);
    const started = candidates.find((r) => r.run_started_at);
    const relevant = started ?? candidates[0] ?? null;

    if (!relevant) {
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
