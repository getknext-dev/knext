#!/usr/bin/env node
/**
 * compat-line-tracker — the audit + tracker issue for a release line's OWN
 * credential window (the v1.3 lane; see scripts/compat-credential-line.mjs).
 *
 * SEPARATION FROM v1.0, BY CONSTRUCTION.
 *   * Nights come only from the line's derived workflow. `fetchLedgers` (the
 *     v1.0 audit's fetcher, imported unchanged) hardcodes
 *     `--workflow test-e2e-deploy.yml`; `lineGh` rewrites exactly that one
 *     argument to the line's workflow file and THROWS on any `run list` call
 *     shape it does not recognise, so a drift in the v1.0 fetcher can never
 *     silently point this audit back at v1.0's runs.
 *   * Grading is `auditWindow` — the same rules (fingerprint continuity, every
 *     shard green, first attempt only, credential mode on an RC tag, bytecode
 *     live, the rule-8 calendar) — with the calendar crons read from the
 *     line's OWN workflow text, never from test-e2e-deploy.yml.
 *   * On top: a night whose `knextRef` is not a tag ON THIS LINE holds its cell
 *     unmet (`offLineNights`). The resolver already refuses such a night; this
 *     is the audit's fail-closed second look.
 *   * Its own issue (title + label disjoint from v1.0's), and it is NEVER
 *     pinned: GitHub's 3-pin cap belongs to the v1.0 tracker, which fails its
 *     job when it cannot pin — taking a slot here could redden v1.0's tracker.
 *
 * Usage (compat-credential-v1.3-tracker.yml):
 *   node scripts/compat-line-tracker.mjs --line v1.3 --fetch --run-url <url>
 *   node scripts/compat-line-tracker.mjs --line v1.3 --dir <ledgers> --dry-run
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLineRef, lineSpec } from './compat-credential-line.mjs';
import { formatCellRow, looksLikeFetchFailure } from './compat-matrix-tracker.mjs';
import {
  auditWindow,
  DEFAULT_FETCH_LIMIT,
  fetchLedgers,
  parseCredentialCronsFromWorkflow,
  readLedgerDir,
} from './compat-window-audit.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const V10_WORKFLOW = 'test-e2e-deploy.yml';

function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Wrap `gh` so the v1.0 fetcher lists the LINE's workflow. Only a
 * `run list … --workflow test-e2e-deploy.yml …` call is rewritten; any other
 * `run list` shape throws. `api` / `run download` calls are keyed by run id
 * (which came from the rewritten listing) and pass through.
 *
 * @param {ReturnType<typeof lineSpec>} spec
 * @param {(args: string[]) => string} gh
 */
export function lineGh(spec, gh) {
  return (args) => {
    if (args[0] === 'run' && args[1] === 'list') {
      const at = args.flatMap((a, i) => (a === '--workflow' ? [i] : []));
      if (at.length !== 1 || args[at[0] + 1] !== V10_WORKFLOW) {
        throw new Error(
          `compat-line-tracker: unexpected run-list shape ${JSON.stringify(args)} — refusing rather than reading another line's runs`,
        );
      }
      const out = [...args];
      out[at[0] + 1] = spec.workflowFile;
      return gh(out);
    }
    return gh(args);
  };
}

/**
 * @param {string} line
 * @param {number} limit
 * @param {{gh?: (args: string[]) => string, readDir?: (dir: string) => any[]}} [deps]
 */
export function fetchLineLedgers(line, limit, deps = {}) {
  const spec = lineSpec(line);
  return fetchLedgers(limit, {
    gh: lineGh(spec, deps.gh ?? runGh),
    ...(deps.readDir ? { readDir: deps.readDir } : {}),
  });
}

/**
 * One independent window per cell, graded by `auditWindow` against the
 * line's own crons, plus the off-line-ref check.
 *
 * @param {Array<Record<string, any>>} ledgers
 * @param {{line: string, workflowText: string, now?: Date, requiredNights?: number}} opts
 */
export function auditLine(ledgers, { line, workflowText, now, requiredNights }) {
  const spec = lineSpec(line);
  const lanes = spec.cells.map((c) => c.lane);
  let laneToCron = null;
  let cronError = null;
  try {
    laneToCron = parseCredentialCronsFromWorkflow(workflowText, { requiredLanes: lanes });
  } catch (err) {
    cronError = err;
  }
  const findCron = (lane) => {
    if (cronError) throw cronError; // auditWindow turns this into calendarChecked: false
    return laneToCron.get(lane) ?? null;
  };
  /** @type {Record<string, any>} */
  const cells = {};
  for (const lane of lanes) {
    const a = auditWindow(ledgers, {
      lane,
      scope: 'credential',
      now,
      requiredNights,
      credentialCronForLane: findCron,
    });
    const offLineNights = (a.nights ?? []).filter(
      (n) => n.knextRef !== null && n.knextRef !== undefined && !isLineRef(line, n.knextRef),
    );
    cells[lane] = { ...a, offLineNights, met: a.met && offLineNights.length === 0 };
  }
  return {
    line,
    cells,
    allMet: lanes.every((l) => cells[l].met),
    calendarUnverified: lanes.filter((l) => cells[l].calendarChecked !== true),
  };
}

/**
 * @param {ReturnType<typeof auditLine>} audit
 * @param {{runUrl?: string, generatedAt?: string}} [opts]
 */
export function buildLineTrackerBody(audit, opts = {}) {
  const spec = lineSpec(audit.line);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const rows = spec.cells.map((cell) => {
    const entry = audit.cells[cell.lane];
    if (!entry) throw new Error(`compat-line-tracker: audit has no entry for lane "${cell.lane}"`);
    return formatCellRow(cell, entry);
  });
  const offLine = spec.cells
    .filter((cell) => audit.cells[cell.lane].offLineNights.length > 0)
    .map(
      (cell) =>
        `- \`${cell.lane}\`: ${audit.cells[cell.lane].offLineNights.length} night(s) ran a tag OFF the ${audit.line} line — the cell cannot be met`,
    );
  const verdict =
    audit.allMet && audit.calendarUnverified.length === 0
      ? `${audit.line} CREDENTIAL MET — every stable cell banked its window on a ${audit.line} RC tag.`
      : audit.calendarUnverified.length > 0
        ? `${audit.line} credential NOT YET met — CALENDAR UNVERIFIED for ${audit.calendarUnverified.join(', ')}.`
        : `${audit.line} credential NOT YET met — every stable cell needs its own 14 ${audit.line} RC-tag nights.`;
  return `Daily ${audit.line} matrix audit — generated ${generatedAt}${opts.runUrl ? ` by ${opts.runUrl}` : ''}.

The ${audit.line} line earns its credential IN PARALLEL with v1.0, on its own RC tag
(\`${spec.pinFile}\`), its own workflow (\`${spec.workflowFile}\`) and its own nights:
a ${audit.line} red never restarts a v1.0 window and a v1.0 red never restarts a
${audit.line} one. The four stable cells are node/bun × turbopack/webpack; vinext is
Beta and is not credentialed. A per-cell red opens or updates its own
\`${spec.resetLabel}\`-labelled issue. This tracker is deliberately not pinned (the
repository's pin slots belong to the v1.0 tracker).

| Cell | Lane | Wired | Nights (current/required) | Status |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
${offLine.length > 0 ? `\n${offLine.join('\n')}\n` : ''}
**${verdict}**

Open ${audit.line} credential-reset issues: search \`is:issue is:open label:${spec.resetLabel}\`.`;
}

/**
 * Create-or-comment the line's tracker issue. NEVER pins (see the header).
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {string} line
 * @param {string} body
 * @returns {number}
 */
export function upsertLineTracker(gh, repo, line, body) {
  const spec = lineSpec(line);
  gh([
    'label',
    'create',
    spec.trackerLabel,
    '--repo',
    repo,
    '--color',
    '0e8a16',
    '--description',
    `The ${line} credential matrix tracker issue`,
    '--force',
  ]);
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--label',
      spec.trackerLabel,
      '--limit',
      '20',
      '--json',
      'number,title',
    ]) || '[]',
  );
  const match = issues.find((i) => i.title === spec.trackerTitle);
  if (match) {
    gh(['issue', 'comment', String(match.number), '--repo', repo, '--body', body]);
    return match.number;
  }
  const url = gh([
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    spec.trackerTitle,
    '--body',
    body,
    '--label',
    spec.trackerLabel,
  ]).trim();
  return Number(url.split('/').at(-1));
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const line = arg('--line', undefined);
  const spec = lineSpec(line);
  const dir = arg('--dir', null);
  let ledgers;
  if (dir) {
    if (!existsSync(dir)) {
      console.error(`compat-line-tracker: --dir ${dir} does not exist`);
      process.exit(2);
    }
    ledgers = readLedgerDir(dir);
  } else if (argv.includes('--fetch')) {
    ledgers = fetchLineLedgers(line, Number(arg('--limit', String(DEFAULT_FETCH_LIMIT))));
  } else {
    console.error('compat-line-tracker: pass --dir <dir> or --fetch [--limit N]');
    process.exit(2);
  }
  const workflowText = readFileSync(
    join(REPO_ROOT, '.github', 'workflows', spec.workflowFile),
    'utf8',
  );
  const audit = auditLine(ledgers, { line, workflowText });
  if (looksLikeFetchFailure(audit, spec.cells)) {
    console.error(
      `::error::compat-line-tracker: every ${line} cell's nights are fetch failures — refusing to publish a misleading tracker comment`,
    );
    process.exit(1);
  }
  const body = buildLineTrackerBody(audit, { runUrl: arg('--run-url', undefined) });
  if (argv.includes('--dry-run')) {
    console.log(body);
  } else {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) {
      console.error('compat-line-tracker: GITHUB_REPOSITORY is required');
      process.exit(2);
    }
    const n = upsertLineTracker(runGh, repo, line, body);
    console.log(`updated the ${line} tracker issue #${n}`);
  }
}
/* c8 ignore stop */
