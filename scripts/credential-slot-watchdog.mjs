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

/** Per-listing page size (the API maximum) and the page cap that bounds the walk. */
export const RUNS_PER_PAGE = 100;
export const MAX_RUN_PAGES = 5;

function mapRun(r) {
  return {
    id: r.id,
    event: r.event,
    status: r.status,
    created_at: r.created_at,
    run_started_at: r.run_started_at ?? null,
    html_url: r.html_url,
  };
}

/**
 * List the workflow's runs (read-only), newest first, walking pages until the
 * window is exhausted. Injectable `gh` for offline testing.
 *
 * `event` defaults to `'schedule'` (the API's server-side event filter); pass
 * `null` for the UNFILTERED listing. `since` (ISO time) bounds the walk with the
 * API's `created` filter and stops paging once a page's oldest run predates it.
 *
 * @param {(args: string[]) => string} gh
 * @param {{repo?: string, workflowFile?: string, perPage?: number, event?: string|null, since?: string|null, maxPages?: number}} [opts]
 */
export function fetchScheduledRuns(
  gh,
  {
    repo = REPO,
    workflowFile = WORKFLOW_FILE,
    perPage = RUNS_PER_PAGE,
    event = 'schedule',
    since = null,
    maxPages = MAX_RUN_PAGES,
  } = {},
) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const query = [`per_page=${perPage}`, `page=${page}`];
    if (event) query.push(`event=${event}`);
    if (since) query.push(`created=%3E%3D${since}`);
    const raw = gh([
      'api',
      `repos/${repo}/actions/workflows/${workflowFile}/runs?${query.join('&')}`,
    ]);
    const parsed = JSON.parse(raw);
    const runs = Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [];
    out.push(...runs.map(mapRun));
    if (runs.length < perPage) break;
    const oldest = runs[runs.length - 1]?.created_at;
    if (since && oldest && new Date(oldest).getTime() < new Date(since).getTime()) break;
  }
  return out;
}

/**
 * The runs that can satisfy a slot, from TWO independent listings unioned by
 * run id: the server-side `event=schedule` listing and the UNFILTERED listing
 * (filtered to schedule client-side). One listing is never authoritative: the
 * 2026-10-05 false positive (all four night-4 lanes "missing" though their
 * runs existed) came from a single `event=schedule` response that did not
 * contain them, and a "missing" verdict is only safe when NEITHER listing has
 * the run. The unfiltered walk is also paginated, so crowding by
 * `workflow_dispatch` runs cannot push a scheduled run out of view. Either
 * listing failing is tolerated; both failing throws (fail closed).
 *
 * @param {(args: string[]) => string} gh
 * @param {{since?: string|null, repo?: string, workflowFile?: string}} [opts]
 */
export function fetchWindowRuns(gh, { since = null, ...rest } = {}) {
  const listings = [];
  const errors = [];
  for (const event of ['schedule', null]) {
    try {
      listings.push(fetchScheduledRuns(gh, { ...rest, since, event }));
    } catch (err) {
      errors.push(err);
    }
  }
  if (listings.length === 0) throw errors[0];

  const seen = new Set();
  const merged = [];
  for (const run of listings.flat()) {
    if (run.event && run.event !== 'schedule') continue;
    if (since && new Date(run.created_at).getTime() < new Date(since).getTime()) continue;
    const key = run.id ?? `${run.created_at}|${run.html_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(run);
  }
  return merged;
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

  // ADR-0056 Amendment 5 — check each lane's latest DUE fire (the latest at
  // or before now - grace). A lane fires every 8 h, so its latest fire at or
  // before NOW is never past an 8 h grace; checking that one could never
  // alert. The watchdog fires every 8 h, so every fire is checked once.
  const nowDate = now instanceof Date ? now : new Date(now);
  const lanes = computeExpectedSlots(
    resolveCredentialLanes(workflowYamlText, { defaultGraceHours: resolvedGraceHours }),
    new Date(nowDate.getTime() - resolvedGraceHours * 60 * 60 * 1000),
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
    allSlots = lanes.flatMap(({ cron, hour, hours, minute }) =>
      (hours ?? [hour]).map((h) => ({ cron, hour: h, minute })),
    );
  }

  const since = lanes.map((l) => l.expectedSlotTime).sort()[0];
  const rawRuns = fetchWindowRuns(gh, { since });
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
