#!/usr/bin/env node
/**
 * credential-slot-watchdog — CLI entry point (#1640).
 *
 * Thin fetch/attribution layer around `scripts/lib/credential-slot-watchdog.mjs`'s
 * pure decision function. READ-ONLY: it lists scheduled runs of
 * `test-e2e-deploy.yml` and their artifact-marker listings via the GitHub API
 * and never dispatches, cancels, or writes anything. Exits 1 when any
 * credential lane needs the standard pinned alert (`missing`,
 * `queued-too-long`, or `ambiguous` — see the lib module's header), so the
 * companion workflow job (`.github/workflows/credential-slot-watchdog.yml`)
 * can gate its alert step on this job's result — the same
 * `needs.<job>.result == 'failure'` pattern every other nightly alert in
 * this repo uses. Also exits 1 (via the generic handler below) when the
 * workflow's cron shape cannot be parsed at all — see
 * `resolveCredentialLanes`'s fail-closed contract in the lib module.
 *
 * Env:
 *   WATCHDOG_GRACE_HOURS  optional override for the grace-period hours
 *                         (default: DEFAULT_GRACE_HOURS, currently 8).
 *   GH_TOKEN / GITHUB_TOKEN  read by the `gh` CLI itself, not read directly
 *                            here.
 *
 * Usage:  node scripts/credential-slot-watchdog.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneFromArtifacts, modeFromArtifacts } from './compat-window-audit.mjs';
import {
  attributeRunsToLanes,
  computeExpectedSlots,
  DEFAULT_GRACE_HOURS,
  decideCredentialSlotVerdicts,
  parseAllDeclaredSlots,
  resolveCredentialLanes,
} from './lib/credential-slot-watchdog.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'getknext-dev/knext';
export const WORKFLOW_FILE = 'test-e2e-deploy.yml';
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows', WORKFLOW_FILE);

function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${String(r.stderr).slice(0, 500)}`);
  }
  return r.stdout;
}

/**
 * List the workflow's own scheduled runs (read-only). Injectable `gh` for
 * offline testing.
 *
 * @param {(args: string[]) => string} gh
 * @param {{repo?: string, workflowFile?: string, perPage?: number}} [opts]
 */
export function fetchScheduledRuns(
  gh,
  { repo = REPO, workflowFile = WORKFLOW_FILE, perPage = 50 } = {},
) {
  const raw = gh([
    'api',
    `repos/${repo}/actions/workflows/${workflowFile}/runs?event=schedule&per_page=${perPage}`,
  ]);
  const parsed = JSON.parse(raw);
  const runs = Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [];
  return runs.map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    created_at: r.created_at,
    run_started_at: r.run_started_at ?? null,
    html_url: r.html_url,
  }));
}

/**
 * Enrich each run with `exactLane` — the CREDENTIAL lane its own
 * `compat-lane-<lane>` marker artifact names, or `null` when the marker is
 * absent, unreadable, ambiguous, or (deliberately) not a `credential`-mode
 * run. See the lib module header's "LANE ATTRIBUTION" section: an
 * early-warning run publishes the SAME lane names as its credential
 * counterpart, so the mode marker is what makes this trustworthy — a lane
 * marker read without a matching `credential` mode marker is never used.
 * Read-only (a `gh api ... /artifacts` GET, same call
 * `scripts/compat-window-audit.mjs` already makes) and reuses that module's
 * own `laneFromArtifacts`/`modeFromArtifacts` rather than a second copy of
 * the marker-parsing contract.
 *
 * Any failure to fetch/parse a given run's artifacts (network error,
 * malformed response) leaves that run's `exactLane` unset — it degrades to
 * the conservative nearest-slot heuristic in `attributeRunsToLanes`, never
 * to a crash.
 *
 * @template {{id?: number, event?: string}} T
 * @param {(args: string[]) => string} gh
 * @param {T[]} runs
 * @param {{repo?: string}} [opts]
 * @returns {(T & {exactLane?: string|null})[]}
 */
export function attachExactLanes(gh, runs, { repo = REPO } = {}) {
  return runs.map((run) => {
    if (run.event && run.event !== 'schedule') return run;
    if (run.id == null) return run;
    let artifacts;
    try {
      const raw = gh(['api', `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`]);
      const parsed = JSON.parse(raw);
      artifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
    } catch {
      return run;
    }
    const lane = laneFromArtifacts(artifacts);
    const mode = modeFromArtifacts(artifacts);
    return { ...run, exactLane: lane && mode === 'credential' ? lane : null };
  });
}

/**
 * Run the full check: parse lanes, fetch runs, attribute, decide. Pure given
 * its inputs (`gh` and `now` are both injectable), so this is what the CLI
 * `main()` and the offline tests both call.
 *
 * @param {{workflowYamlText: string, gh: (args: string[]) => string, now?: Date, graceHours?: number}} args
 */
export function evaluateWatchdog({ workflowYamlText, gh, now = new Date(), graceHours }) {
  const resolvedGraceHours =
    graceHours ?? (Number(process.env.WATCHDOG_GRACE_HOURS) || DEFAULT_GRACE_HOURS);

  const lanes = computeExpectedSlots(
    resolveCredentialLanes(workflowYamlText, { defaultGraceHours: resolvedGraceHours }),
    now,
  );

  let allSlots;
  try {
    allSlots = parseAllDeclaredSlots(workflowYamlText);
  } catch {
    // NOTE: by this point `resolveCredentialLanes` above already succeeded
    // (it fails closed — see the lib module header — so a failure there
    // never reaches this line). This narrower fallback covers the case where
    // `resolveCredentialLanes` only needed the CREDENTIAL crons to parse
    // (and they did) but some OTHER declared cron in the `schedule:` block is
    // not a simple once-daily shape `parseAllDeclaredSlots` requires.
    // Degrading `allSlots` to just the lanes themselves is strictly safer
    // than crashing the watchdog: it can only make an early-warning run look
    // like it satisfies a credential lane in the fallback heuristic, never
    // the reverse, and `detectAmbiguousAttribution` still runs on the result.
    allSlots = lanes.map(({ cron, hour, minute }) => ({ cron, hour, minute }));
  }

  const rawRuns = fetchScheduledRuns(gh);
  const runsWithExactLane = attachExactLanes(gh, rawRuns);
  const { attributed, ambiguousLanes } = attributeRunsToLanes(runsWithExactLane, lanes, allSlots);
  return decideCredentialSlotVerdicts({ lanes, runs: attributed, now, ambiguousLanes });
}

function main() {
  const workflowYamlText = readFileSync(WORKFLOW_PATH, 'utf8');
  const verdicts = evaluateWatchdog({ workflowYamlText, gh: runGh, now: new Date() });

  for (const v of verdicts) {
    console.log(`${v.lane}: ${v.verdict} — ${v.reason}`);
  }

  const alerting = verdicts.filter((v) => v.verdict !== 'quiet');
  if (alerting.length > 0) {
    console.error(
      `\n${alerting.length} lane(s) need alerting: ${alerting.map((v) => v.lane).join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('\nAll credential-lane slots are quiet.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
