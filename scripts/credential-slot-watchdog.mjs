#!/usr/bin/env node
/**
 * credential-slot-watchdog — CLI entry point (#1640).
 *
 * Thin fetch/attribution layer around `scripts/lib/credential-slot-watchdog.mjs`'s
 * pure decision function. READ-ONLY: it lists scheduled runs of
 * `test-e2e-deploy.yml` via the GitHub API and never dispatches, cancels, or
 * writes anything. Exits 1 when any credential lane needs the standard
 * pinned alert (`missing` or `queued-too-long`), so the companion workflow
 * job (`.github/workflows/credential-slot-watchdog.yml`) can gate its alert
 * step on this job's result — the same `needs.<job>.result == 'failure'`
 * pattern every other nightly alert in this repo uses.
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
    event: r.event,
    status: r.status,
    created_at: r.created_at,
    run_started_at: r.run_started_at ?? null,
    html_url: r.html_url,
  }));
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
    // Same fallback spirit as resolveCredentialLanes: if the FULL schedule
    // block cannot be parsed, attribution degrades to "every declared slot
    // IS a credential slot" (the lanes themselves), which is strictly safer
    // than crashing the watchdog — it can only make an early-warning run
    // look like it satisfies a credential lane, never the reverse.
    allSlots = lanes.map(({ cron, hour, minute }) => ({ cron, hour, minute }));
  }

  const rawRuns = fetchScheduledRuns(gh);
  const attributed = attributeRunsToLanes(rawRuns, lanes, allSlots);
  return decideCredentialSlotVerdicts({ lanes, runs: attributed, now });
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
